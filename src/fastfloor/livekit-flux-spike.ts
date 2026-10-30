import { llm, stt, voice } from '@livekit/agents';
import type { ReadableStream } from 'node:stream/web';
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
  historyKey?: string;
  phase: 'preflight' | 'committed';
};

/** Observe SDK output without putting cancellation behind a pending generator read. */
function observeStream<T>(
  stream: ReadableStream<T>,
  observe: (value: T) => void,
  onClose?: () => void,
): AsyncIterable<T> {
  const reader = stream.getReader();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    reader.releaseLock();
    onClose?.();
  };
  const iterator: AsyncIterator<T> = {
    async next() {
      if (closed) return { done: true, value: undefined };
      try {
        const result = await reader.read();
        if (result.done) {
          close();
          return { done: true, value: undefined };
        }
        observe(result.value);
        return { done: false, value: result.value };
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        close();
        throw error;
      }
    },
    async return(reason?: unknown) {
      try {
        // Unlike async-generator return(), this reaches the provider immediately,
        // including when next() is still blocked waiting for its first chunk.
        if (!closed) await reader.cancel(reason);
      } finally {
        close();
      }
      return { done: true, value: undefined };
    },
  };
  return { [Symbol.asyncIterator]: () => iterator };
}

/** Opt-in adapter. No provider events are rewritten or consumed separately. */
export class FluxIntegrationSpike {
  private readonly log: SpikeLog;
  private readonly fakePrepare: FakePrepare;
  private readonly coordinator: TurnCoordinator;
  private candidate: Candidate | undefined;
  private latestTranscript: string | null = null;
  private finalSegments: string[] = [];
  private latestIsFinal = false;
  private readonly committedMessages = new Set<string>();
  private readonly speeches = new Set<voice.SpeechHandle>();
  private session: voice.AgentSession | undefined;
  private agent: voice.Agent | undefined;
  private readonly mode: 'fake' | 'real';
  private readonly speculate: boolean;
  private readonly committedTools: boolean;
  private toolTurn: { id: string; text: string } | undefined;

  constructor(
    options: {
      log?: SpikeLog;
      fakePrepare?: FakePrepare;
      mode?: 'fake' | 'real';
      speculate?: boolean;
      committedTools?: boolean;
    } = {},
  ) {
    this.mode = options.mode ?? 'fake';
    this.speculate = options.speculate ?? true;
    this.committedTools = options.committedTools ?? false;
    if (this.committedTools && this.mode !== 'real')
      throw new Error('Committed tools require real mode; fake mode never calls an LLM');
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
      event.type === stt.SpeechEventType.START_OF_SPEECH ||
      event.type === stt.SpeechEventType.END_OF_SPEECH
    )
      this.log(stt.SpeechEventType[event.type], {});
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
      this.latestIsFinal = event.type === stt.SpeechEventType.FINAL_TRANSCRIPT;
      // After any final, a new segment's preflight is not a complete user turn.
      const anotherSegment =
        this.finalSegments.length > 0 &&
        (event.type === stt.SpeechEventType.PREFLIGHT_TRANSCRIPT || this.latestIsFinal);
      if (this.candidate && (text !== this.candidate.transcript || anotherSegment))
        this.invalidate();
      if (this.latestIsFinal && text) this.finalSegments.push(text);
      if (
        event.type === stt.SpeechEventType.PREFLIGHT_TRANSCRIPT &&
        this.speculate &&
        !this.committedTools &&
        text &&
        !this.candidate &&
        this.finalSegments.length === 0
      ) {
        this.startPreparation(text);
      }
    }
    if (event.type === stt.SpeechEventType.START_OF_SPEECH) {
      this.latestTranscript = '';
      this.latestIsFinal = false;
      // LiveKit can retain finals across STT speech boundaries until commitment.
      this.invalidate();
    }
  }

  private invalidate(): void {
    this.toolTurn = undefined;
    if (this.candidate && !this.candidate.claimed)
      this.log('PREPARATION_INVALIDATED', {
        generation: this.candidate.generation,
        phase: this.candidate.phase,
      });
    this.coordinator.onResumed();
    this.candidate = undefined;
    // The coordinator cancels preparation; LiveKit owns already-scheduled output.
    for (const speech of this.speeches) speech.interrupt(true);
    this.speeches.clear();
  }

  private startPreparation(
    transcript: string,
    history = this.agent?.chatCtx.copy(),
    phase: Candidate['phase'] = 'preflight',
  ): Candidate {
    const candidate: Candidate = {
      generation: this.coordinator.onEager(),
      transcript,
      task: Promise.resolve(),
      released: null,
      claimed: false,
      phase,
      ...(this.mode === 'real' && history ? { historyKey: this.historyKey(history) } : {}),
    };
    this.candidate = candidate;
    this.log('PREPARATION_STARTED', {
      generation: candidate.generation,
      mode: this.mode,
      transcript,
      phase,
    });
    candidate.task = this.coordinator
      .prepare(candidate.generation, (signal) =>
        this.mode === 'fake'
          ? this.fakePrepare(transcript, signal)
          : this.generate(transcript, history, signal, candidate.generation),
      )
      .catch((error: unknown) => {
        this.log('PREPARATION_FAILED', {
          generation: candidate.generation,
          error:
            error instanceof Error ? { name: error.name, message: error.message } : String(error),
        });
        if (this.candidate === candidate) this.invalidate();
      });
    return candidate;
  }

  private historyKey(history: llm.ChatContext): string {
    return JSON.stringify(history.items.map((item) => item.toJSON(true)));
  }

  private async generate(
    transcript: string,
    history: llm.ChatContext | undefined,
    signal: AbortSignal,
    generation: number,
  ): Promise<string> {
    signal.throwIfAborted();
    const model = this.agent?.llm;
    if (!(model instanceof llm.LLM) || !history) throw new Error('No pipeline LLM/context');
    // Never mutate SDK history or expose speculative chunks to its TTS pipeline.
    const chatCtx = history.copy();
    chatCtx.addMessage({ role: 'user', content: transcript });
    this.log('LLM_STARTED', {
      generation,
      context: chatCtx.items.map((item) => item.toJSON(true)),
      toolChoice: 'none',
    });
    const stream = model.chat({
      chatCtx,
      toolCtx: [],
      toolChoice: 'none',
      ...(this.session ? { connOptions: this.session.connOptions.llmConnOptions } : {}),
    });
    // In this SDK collect() can return partial text after a provider error.
    // Error events lack request IDs: any error on this model while collecting
    // conservatively rejects the candidate rather than releasing partial text.
    let failure: Error | undefined;
    const failed = (event: { error: Error }) => {
      failure = event.error;
      stream.close();
    };
    model.on('error', failed);
    const abort = () => stream.close();
    signal.addEventListener('abort', abort, { once: true });
    try {
      const parts: string[] = [];
      let hasToolCalls = false;
      for await (const chunk of stream) {
        if (chunk.delta?.content) {
          if (!parts.length)
            this.log('LLM_FIRST_TEXT_DELTA', { generation, providerRequestId: chunk.id });
          parts.push(chunk.delta.content);
        }
        if (chunk.delta?.toolCalls?.length) hasToolCalls = true;
      }
      signal.throwIfAborted();
      if (failure) throw failure;
      const text = parts.join('').trim();
      if (!text || hasToolCalls) throw new Error('Expected a text-only LLM reply');
      this.log('LLM_COMPLETED', { generation, characters: text.length });
      return text;
    } finally {
      signal.removeEventListener('abort', abort);
      model.off('error', failed);
      stream.close();
    }
  }

  private async committed(history: llm.ChatContext, message: llm.ChatMessage): Promise<void> {
    const text = message.textContent ?? '';
    this.log('USER_TURN_COMMITTED', {
      transcript: text,
      messageId: message.id,
      finalSegments: [...this.finalSegments],
      history: history.items.map((item) => item.toJSON(true)),
    });
    if (this.committedMessages.has(message.id)) throw new voice.StopResponse();
    this.committedMessages.add(message.id);
    const finals = this.finalSegments;
    this.finalSegments = [];
    // Validate the SDK's aggregate, never invent one to send to the model. This
    // mirrors installed SDK final-segment joining only as a provenance check.
    const matches =
      finals.length > 1
        ? this.latestIsFinal && text === finals.join(' ').trimStart()
        : this.latestTranscript === null || text === this.latestTranscript;
    if (!text || this.session?.userState === 'speaking' || !matches) {
      this.invalidate();
      // Flux may finalize a segment, resume with a newer interim, then deliver
      // the SDK hook for the earlier final. Suppress its reply, not accepted
      // history. Only the exact observed final aggregate proves provenance;
      // an interim/preflight hypothesis or truncated aggregate is never retained.
      if (finals.length && text === finals.join(' ').trimStart())
        await this.retainCommittedInput(message);
      throw new voice.StopResponse();
    }
    if (this.committedTools) {
      // No speculative tools or tool-policy engine: delegate this entire workload
      // to the SDK only after a validated audio commitment. Text-only speculative
      // preparation and the coordinator remain unchanged for the other mode.
      this.invalidate();
      this.toolTurn = { id: message.id, text };
      this.log('COMMITTED_TOOL_TURN', { messageId: message.id, speculation: false });
      return;
    }
    if (
      !this.candidate ||
      this.candidate.transcript !== text ||
      this.candidate.messageId ||
      (this.mode === 'real' && this.candidate.historyKey !== this.historyKey(history))
    ) {
      this.invalidate();
      this.startPreparation(text, history, 'committed');
    }
    const candidate = this.candidate!;
    candidate.messageId = message.id;
    this.log('COORDINATOR_COMMITTED', {
      generation: candidate.generation,
      messageId: message.id,
      transcript: candidate.transcript,
      reused: candidate.phase === 'preflight',
    });
    this.coordinator.onCommitted(candidate.generation);
    await candidate.task;
    if (this.candidate !== candidate || candidate.released === null) {
      // StopResponse in Agents 1.9.4 drops the whole user turn, not just its reply.
      // Preserve only a provenance-validated commitment; never store speculation
      // or a cancelled assistant answer. Use current history, not a stale snapshot.
      await this.retainCommittedInput(message);
      throw new voice.StopResponse();
    }
    this.log('RESPONSE_RELEASED', { generation: candidate.generation, messageId: message.id });
  }

  private async retainCommittedInput(message: llm.ChatMessage): Promise<void> {
    if (this.agent && !this.agent.chatCtx.items.some((item) => item.id === message.id)) {
      const retained = this.agent.chatCtx.copy();
      retained.insert(message);
      await this.agent.updateChatCtx(retained);
    }
    if (this.session && !this.session.history.items.some((item) => item.id === message.id))
      this.session.history.insert(message);
    this.log('COMMITTED_INPUT_RETAINED', {
      messageId: message.id,
      transcript: message.textContent,
    });
  }

  hooks(): Pick<
    voice.AgentCreateOptions,
    'sttNode' | 'onUserTurnCompleted' | 'llmNode' | 'ttsNode' | 'onEnter' | 'onExit'
  > {
    // SDK generator hooks have their own `this`; retain the adapter explicitly.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const spike = this;
    let detach: (() => void) | undefined;
    return {
      onEnter(ctx) {
        const session = ctx.session;
        spike.session = session;
        spike.agent = ctx.agent;
        const speechCreated = (event: voice.SpeechCreatedEvent) => {
          spike.speeches.add(event.speechHandle);
          spike.log('SPEECH_CREATED', {
            speechId: event.speechHandle.id,
            messageId: spike.toolTurn?.id ?? spike.candidate?.messageId,
          });
          event.speechHandle.addDoneCallback(() => spike.speeches.delete(event.speechHandle));
        };
        const userStateChanged = (event: voice.UserStateChangedEvent) => {
          if (event.newState === 'speaking') {
            // Session state can lag raw STT; do not erase a newer observed transcript.
            spike.invalidate();
          }
        };
        detach = () => {
          spike.latestTranscript = '';
          spike.finalSegments = [];
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
      async sttNode(ctx, audio, modelSettings) {
        spike.agent = ctx.agent;
        const close = () => {
          spike.latestTranscript = '';
          spike.finalSegments = [];
          spike.invalidate();
        };
        try {
          const events = await voice.Agent.default.sttNode(ctx.agent, audio, modelSettings);
          if (!events) {
            close();
            return null;
          }
          return observeStream(
            events,
            (event) => {
              if (typeof event !== 'string') spike.speechEvent(event);
            },
            close,
          );
        } catch (error) {
          close();
          // Preserve the existing STT hook contract: expose setup errors when
          // reading the node stream, not as a rejected node-construction promise.
          return {
            [Symbol.asyncIterator]() {
              return {
                async next() {
                  throw error;
                },
              };
            },
          };
        }
      },
      onUserTurnCompleted(ctx, chatCtx, newMessage) {
        spike.agent = ctx.agent;
        return spike.committed(chatCtx, newMessage);
      },
      async llmNode(ctx, chatCtx, toolCtx, settings) {
        const user = [...chatCtx.items]
          .reverse()
          .find((item) => item.type === 'message' && item.role === 'user');
        if (spike.committedTools) {
          if (
            !spike.toolTurn ||
            user?.id !== spike.toolTurn.id ||
            user.type !== 'message' ||
            user.textContent !== spike.toolTurn.text
          )
            return null;
          const messageId = spike.toolTurn.id;
          spike.log('LLM_STARTED', {
            messageId,
            context: chatCtx.items.map((item) => item.toJSON(true)),
            tools: toolCtx.flatten().map((tool) => tool.id),
            phase: 'committed-sdk-tool-loop',
          });
          const stream = await voice.Agent.default.llmNode(ctx.agent, chatCtx, toolCtx, settings);
          let first = true;
          return stream
            ? observeStream(stream, (chunk) => {
                if (typeof chunk === 'string' ? chunk.length : chunk.delta?.content) {
                  if (first) spike.log('LLM_FIRST_TEXT_DELTA', { messageId });
                  first = false;
                }
              })
            : null;
        }
        return {
          async *[Symbol.asyncIterator]() {
            const candidate = spike.candidate;
            if (
              !candidate ||
              candidate.released === null ||
              candidate.claimed ||
              candidate.messageId !== user?.id ||
              user?.type !== 'message' ||
              user.textContent !== candidate.transcript
            )
              return;
            candidate.claimed = true;
            spike.log('TRANSPORT_CLAIMED', {
              messageId: candidate.messageId,
              generation: candidate.generation,
              reused: candidate.phase === 'preflight',
            });
            yield candidate.released;
          },
        };
      },
      async ttsNode(ctx, text, settings) {
        const messageId = spike.toolTurn?.id ?? spike.candidate?.messageId;
        spike.log('TTS_STARTED', { messageId });
        const stream = await voice.Agent.default.ttsNode(ctx.agent, text, settings);
        let first = true;
        return stream
          ? observeStream(stream, () => {
              if (first) spike.log('TTS_FIRST_FRAME', { messageId });
              first = false;
            })
          : null;
      },
    };
  }
}
