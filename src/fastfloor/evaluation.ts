import { voice } from '@livekit/agents';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

export type TraceEvent = {
  runId: string;
  arm: 'baseline' | 'fastfloor';
  timestamp: string;
  elapsedMs: number;
  event: string;
  details: Record<string, unknown>;
};

/** Opt-in local traces contain conversation content. Use fictional data only. */
export class EvaluationTrace {
  readonly events: TraceEvent[] = [];
  readonly runId = randomUUID();
  private readonly clock: () => number;
  private readonly origin: number;
  private readonly arm: TraceEvent['arm'];
  private readonly path: string | undefined;
  constructor(options: { arm: TraceEvent['arm']; path?: string; clock?: () => number }) {
    this.clock = options.clock ?? (() => performance.now());
    this.origin = this.clock();
    this.arm = options.arm;
    this.path = options.path;
  }
  readonly log = (event: string, details: Record<string, unknown> = {}): void => {
    const record: TraceEvent = {
      runId: this.runId,
      arm: this.arm,
      timestamp: new Date().toISOString(),
      elapsedMs: this.clock() - this.origin,
      event,
      details,
    };
    this.events.push(record);
    if (this.path) appendFileSync(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  };

  /** SDK output is a server-side proxy, never a claim about a physical speaker. */
  attach(session: voice.AgentSession): () => void {
    const output = session.output.audio;
    const speeches = new Set<voice.SpeechHandle>();
    const speechCreated = (event: voice.SpeechCreatedEvent) => {
      speeches.add(event.speechHandle);
      event.speechHandle.addDoneCallback(() => speeches.delete(event.speechHandle));
    };
    const owner = () => {
      const active = [...speeches].filter((handle) => handle.scheduled && !handle.done());
      // No public active-speech ID on this SDK's playback event. Do not guess
      // when multiple handles could own it; keep the sample unattributed.
      if (active.length !== 1) return {};
      const handle = active[0]!;
      const user = [...handle.chatItems]
        .reverse()
        .find((item) => item.type === 'message' && item.role === 'user');
      return { speechId: handle.id, messageId: user?.id, correlation: 'unique-live-speech-handle' };
    };
    const started = (event: { createdAt: number }) =>
      this.log('SDK_PLAYBACK_STARTED', {
        ...owner(),
        sdkCreatedAt: event.createdAt,
      });
    const finished = (event: { interrupted: boolean; playbackPosition: number }) =>
      this.log('SDK_PLAYBACK_FINISHED', { ...owner(), ...event });
    const itemAdded = (event: voice.ConversationItemAddedEvent) =>
      this.log('SDK_HISTORY_ITEM_ADDED', { item: event.item.toJSON(true) });
    output?.on(voice.AudioOutput.EVENT_PLAYBACK_STARTED, started);
    output?.on(voice.AudioOutput.EVENT_PLAYBACK_FINISHED, finished);
    session.on(voice.AgentSessionEventTypes.SpeechCreated, speechCreated);
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, itemAdded);
    const detach = () => {
      output?.off(voice.AudioOutput.EVENT_PLAYBACK_STARTED, started);
      output?.off(voice.AudioOutput.EVENT_PLAYBACK_FINISHED, finished);
      session.off(voice.AgentSessionEventTypes.SpeechCreated, speechCreated);
      session.off(voice.AgentSessionEventTypes.ConversationItemAdded, itemAdded);
      session.off(voice.AgentSessionEventTypes.Close, detach);
    };
    session.on(voice.AgentSessionEventTypes.Close, detach);
    return detach;
  }
}

function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) =>
    sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1]! : null;
  return { p50: at(0.5), p95: at(0.95) };
}

/** Summarize one run. Unmatched events remain explicitly unattributed. */
export function summarize(events: TraceEvent[]) {
  if (new Set(events.map((event) => event.runId)).size > 1)
    throw new Error('Summarize each run separately; do not mix clocks or sessions');
  const speechMessages = new Map<string, string>();
  const generationMessages = new Map<number, string>();
  for (const { event, details } of events) {
    if (
      event === 'SPEECH_CREATED' &&
      typeof details.speechId === 'string' &&
      typeof details.messageId === 'string'
    )
      speechMessages.set(details.speechId, details.messageId);
    if (
      event === 'COORDINATOR_COMMITTED' &&
      typeof details.generation === 'number' &&
      typeof details.messageId === 'string'
    )
      generationMessages.set(details.generation, details.messageId);
  }
  const messageId = (event: TraceEvent): string | undefined => {
    const details = event.details;
    if (typeof details.messageId === 'string') return details.messageId;
    if (typeof details.speechId === 'string') return speechMessages.get(details.speechId);
    if (typeof details.generation === 'number') return generationMessages.get(details.generation);
    return undefined;
  };
  const commits = events.filter((event) => event.event === 'USER_TURN_COMMITTED');
  const uniqueCommits = [
    ...new Map([...commits].reverse().map((event) => [messageId(event), event])).values(),
  ].sort((a, b) => a.elapsedMs - b.elapsedMs);
  const turns = uniqueCommits.map((commit) => {
    const id = messageId(commit);
    const forTurn = events.filter((event) => messageId(event) === id);
    const delta = (name: string) => {
      const event = forTurn.find((event) => event.event === name);
      return event ? event.elapsedMs - commit.elapsedMs : null;
    };
    return {
      messageId: id,
      transcript: commit.details.transcript,
      commitMs: commit.elapsedMs,
      commitToLlmStartMs: delta('LLM_STARTED'),
      commitToFirstTextDeltaMs: delta('LLM_FIRST_TEXT_DELTA'),
      commitToTtsFirstFrameMs: delta('TTS_FIRST_FRAME'),
      commitToSdkPlaybackMs: delta('SDK_PLAYBACK_STARTED'),
      audibleOnsetMs: null,
      reused: forTurn.some(
        (event) => event.event === 'TRANSPORT_CLAIMED' && event.details.reused === true,
      ),
    };
  });
  const playback = events.filter((event) => event.event === 'SDK_PLAYBACK_STARTED');
  const latencies = turns.flatMap((turn) =>
    turn.commitToSdkPlaybackMs === null ? [] : [turn.commitToSdkPlaybackMs],
  );
  return {
    runId: events[0]?.runId,
    arm: events[0]?.arm,
    committedTurns: turns.length,
    playbackSamples: latencies.length,
    commitToSdkPlaybackMs: percentiles(latencies),
    speculativePreparations: events.filter(
      (event) => event.event === 'PREPARATION_STARTED' && event.details.phase === 'preflight',
    ).length,
    speculativeReuses: turns.filter((turn) => turn.reused).length,
    rollbacks: events.filter(
      (event) => event.event === 'PREPARATION_INVALIDATED' && event.details.phase === 'preflight',
    ).length,
    prematureSdkPlayback: playback.filter((event) => {
      const commit = uniqueCommits.find((commit) => messageId(commit) === messageId(event));
      return commit && event.elapsedMs < commit.elapsedMs;
    }).length,
    unattributedPlaybackEvents: playback.filter(
      (event) => !uniqueCommits.some((commit) => messageId(commit) === messageId(event)),
    ).length,
    prematureAudibleResponses: null,
    turns,
  };
}
