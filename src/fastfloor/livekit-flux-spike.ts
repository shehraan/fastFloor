import { stt, voice } from '@livekit/agents';
import type { llm } from '@livekit/agents';
import { TurnCoordinator } from './turn-coordinator.ts';

type SpikeLog = (event: string, details: Record<string, unknown>) => void;
type FakePrepare = (transcript: string, signal: AbortSignal) => Promise<string>;
type Candidate = {
  generation: number;
  transcript: string;
  task: Promise<void>;
  released: string | null;
  messageId?: string;
  claimed: boolean;
};

/** Opt-in mechanics spike. No provider events are rewritten or consumed separately. */
export class FluxIntegrationSpike {
  private readonly log: SpikeLog;
  private readonly fakePrepare: FakePrepare;
  private readonly coordinator: TurnCoordinator;
  private candidate: Candidate | undefined;
  private latestTranscript: string | null = null;
  private readonly committedMessages = new Set<string>();
  private readonly speeches = new Set<voice.SpeechHandle>();
  private session: voice.AgentSession | undefined;

  constructor(options: { log?: SpikeLog; fakePrepare?: FakePrepare } = {}) {
    this.log = options.log ?? ((event, details) => console.log('[FastFloor]', event, details));
    this.fakePrepare =
      options.fakePrepare ?? (async (text) => `Integration spike. I heard: ${text}`);
    // This callback is invoked ONLY by the existing coordinator's publication gate.
    this.coordinator = new TurnCoordinator((text) => {
      if (this.candidate) this.candidate.released = text;
    });
  }

  speechEvent(event: stt.SpeechEvent): void {
    if (
      event.type === stt.SpeechEventType.PREFLIGHT_TRANSCRIPT ||
      event.type === stt.SpeechEventType.INTERIM_TRANSCRIPT ||
      event.type === stt.SpeechEventType.FINAL_TRANSCRIPT
    ) {
      this.log(stt.SpeechEventType[event.type], {
        transcript: event.alternatives?.[0]?.text ?? '',
        requestId: event.requestId,
        createdAt: event.createdAt,
      });
      const text = event.alternatives?.[0]?.text ?? '';
      this.latestTranscript = text;
      if (this.candidate && text !== this.candidate.transcript) this.invalidate();
      if (event.type === stt.SpeechEventType.PREFLIGHT_TRANSCRIPT && text && !this.candidate) {
        this.startPreparation(text);
      }
    }
    if (event.type === stt.SpeechEventType.START_OF_SPEECH) {
      this.latestTranscript = '';
      this.invalidate();
    }
  }

  private invalidate(): void {
    this.coordinator.onResumed();
    this.candidate = undefined;
    // The coordinator cancels preparation; LiveKit owns already-scheduled output.
    for (const speech of this.speeches) speech.interrupt(true);
    this.speeches.clear();
  }

  private startPreparation(transcript: string): Candidate {
    const candidate: Candidate = {
      generation: this.coordinator.onEager(),
      transcript,
      task: Promise.resolve(),
      released: null,
      claimed: false,
    };
    this.candidate = candidate;
    candidate.task = this.coordinator
      .prepare(candidate.generation, (signal) => this.fakePrepare(transcript, signal))
      .catch((error: unknown) => {
        this.log('PREPARATION_FAILED', { error });
        if (this.candidate === candidate) this.invalidate();
      });
    return candidate;
  }

  private async committed(message: llm.ChatMessage): Promise<void> {
    const text = message.textContent ?? '';
    this.log('USER_TURN_COMMITTED', { transcript: text, messageId: message.id });
    if (this.committedMessages.has(message.id)) throw new voice.StopResponse();
    this.committedMessages.add(message.id);
    // Exact equality deliberately prefers silence over accepting ambiguous/late commits.
    if (
      !text ||
      this.session?.userState === 'speaking' ||
      (this.latestTranscript !== null && text !== this.latestTranscript)
    ) {
      this.invalidate();
      throw new voice.StopResponse();
    }
    if (!this.candidate || this.candidate.transcript !== text || this.candidate.messageId) {
      this.invalidate();
      this.startPreparation(text);
    }
    const candidate = this.candidate!;
    candidate.messageId = message.id;
    this.coordinator.onCommitted(candidate.generation);
    await candidate.task;
    if (this.candidate !== candidate || candidate.released === null) throw new voice.StopResponse();
  }

  hooks(): Pick<
    voice.AgentCreateOptions,
    'sttNode' | 'onUserTurnCompleted' | 'llmNode' | 'onEnter' | 'onExit'
  > {
    // SDK generator hooks have their own `this`; retain the adapter explicitly.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const spike = this;
    let detach: (() => void) | undefined;
    return {
      onEnter(ctx) {
        const session = ctx.session;
        spike.session = session;
        const speechCreated = (event: voice.SpeechCreatedEvent) => {
          spike.speeches.add(event.speechHandle);
        };
        const userStateChanged = (event: voice.UserStateChangedEvent) => {
          if (event.newState === 'speaking') {
            // Session state can lag raw STT; do not erase a newer observed transcript.
            spike.invalidate();
          }
        };
        detach = () => {
          spike.latestTranscript = '';
          spike.invalidate();
          session.off(voice.AgentSessionEventTypes.SpeechCreated, speechCreated);
          session.off(voice.AgentSessionEventTypes.UserStateChanged, userStateChanged);
          session.off(voice.AgentSessionEventTypes.Close, detach!);
        };
        session.on(voice.AgentSessionEventTypes.SpeechCreated, speechCreated);
        session.on(voice.AgentSessionEventTypes.UserStateChanged, userStateChanged);
        session.on(voice.AgentSessionEventTypes.Close, detach);
      },
      onExit() {
        detach?.();
      },
      async *sttNode(ctx, audio, modelSettings) {
        try {
          const events = await voice.Agent.default.sttNode(ctx.agent, audio, modelSettings);
          if (!events) return;
          for await (const event of events) {
            if (typeof event !== 'string') spike.speechEvent(event);
            yield event;
          }
        } finally {
          spike.latestTranscript = '';
          spike.invalidate();
        }
      },
      onUserTurnCompleted(_ctx, _chatCtx, newMessage) {
        return spike.committed(newMessage);
      },
      async *llmNode(_ctx, chatCtx) {
        const user = [...chatCtx.items]
          .reverse()
          .find((item) => item.type === 'message' && item.role === 'user');
        const candidate = spike.candidate;
        if (
          !candidate ||
          candidate.released === null ||
          candidate.claimed ||
          candidate.messageId !== user?.id
        )
          return;
        candidate.claimed = true;
        yield candidate.released;
      },
    };
  }
}
