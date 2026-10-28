import { asLanguageCode, initializeLogger, llm, stt, voice } from '@livekit/agents';
import { ReadableStream } from 'node:stream/web';
import { afterEach, expect, it, vi } from 'vitest';
import { FluxIntegrationSpike } from './livekit-flux-spike.ts';
import { TurnCoordinator } from './turn-coordinator.ts';

initializeLogger({ pretty: false, level: 'silent' });
afterEach(() => vi.restoreAllMocks());

function transcript(type: stt.SpeechEventType, text: string): stt.SpeechEvent {
  return {
    type,
    requestId: 'session-not-a-turn-id',
    alternatives: [
      { text, language: asLanguageCode('en'), startTime: 0, endTime: 1, confidence: 1 },
    ],
  };
}

it('releases through the optional output seam only after commitment, once', () => {
  const publish = vi.fn();
  const coordinator = new TurnCoordinator(publish);
  const generation = coordinator.onEager();
  coordinator.onPrepared('prepared fake', generation);
  expect(publish).not.toHaveBeenCalled();
  coordinator.onCommitted(generation);
  coordinator.onCommitted(generation);
  expect(publish).toHaveBeenCalledExactlyOnceWith('prepared fake');
});

it('logs preflight/interim/final and forwards every original STT event unchanged', async () => {
  const log = vi.fn();
  const spike = new FluxIntegrationSpike({ log });
  const events: stt.SpeechEvent[] = [
    { type: stt.SpeechEventType.START_OF_SPEECH },
    transcript(stt.SpeechEventType.INTERIM_TRANSCRIPT, 'book'),
    transcript(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, 'book Monday'),
    transcript(stt.SpeechEventType.FINAL_TRANSCRIPT, 'book Monday'),
    { type: stt.SpeechEventType.END_OF_SPEECH },
    { type: stt.SpeechEventType.RECOGNITION_USAGE, recognitionUsage: { audioDuration: 1 } },
  ];
  vi.spyOn(voice.Agent.default, 'sttNode').mockResolvedValue(
    new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(event);
        controller.close();
      },
    }),
  );
  const agent = voice.Agent.create({ instructions: 'test', ...spike.hooks() });
  const stream = await agent.sttNode(new ReadableStream(), {});
  const received = [];
  for await (const event of stream!) received.push(event);
  expect(received).toHaveLength(events.length);
  received.forEach((event, index) => expect(event).toBe(events[index]));
  for (const name of ['PREFLIGHT_TRANSCRIPT', 'INTERIM_TRANSCRIPT', 'FINAL_TRANSCRIPT']) {
    expect(log).toHaveBeenCalledWith(name, expect.any(Object));
  }
});

async function output(agent: voice.Agent, message: llm.ChatMessage): Promise<string[]> {
  const chat = llm.ChatContext.empty();
  chat.items.push(message);
  const stream = await agent.llmNode(chat, agent.toolCtx, {});
  const values: string[] = [];
  if (stream) for await (const value of stream) values.push(String(value));
  return values;
}

it('invalidates Monday with the existing coordinator and prepares Tuesday at commitment without another preflight', async () => {
  const resumed = vi.spyOn(TurnCoordinator.prototype, 'onResumed');
  const fakePrepare = vi.fn(async (text: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    return `Fake: ${text}`;
  });
  const log = vi.fn();
  const spike = new FluxIntegrationSpike({ log, fakePrepare });
  const agent = voice.Agent.create({ instructions: 'test', ...spike.hooks() });
  const message = llm.ChatMessage.create({ role: 'user', content: 'book Tuesday' });
  spike.speechEvent(transcript(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, 'book Monday'));
  await Promise.resolve();
  expect(await output(agent, message)).toEqual([]);
  spike.speechEvent(transcript(stt.SpeechEventType.INTERIM_TRANSCRIPT, 'book Tuesday'));
  expect(resumed).toHaveBeenCalledOnce();
  expect(fakePrepare.mock.calls[0]![1].aborted).toBe(true);
  await agent.onUserTurnCompleted(llm.ChatContext.empty(), message);
  expect(fakePrepare.mock.calls.map(([text]) => text)).toEqual(['book Monday', 'book Tuesday']);
  expect(await output(agent, message)).toEqual(['Fake: book Tuesday']);
  expect(await output(agent, message)).toEqual([]);
  expect(log).toHaveBeenCalledWith(
    'USER_TURN_COMMITTED',
    expect.objectContaining({ transcript: 'book Tuesday', messageId: message.id }),
  );
});

it('does not treat unchanged interim as raw TurnResumed or final as session commitment', async () => {
  const resumed = vi.spyOn(TurnCoordinator.prototype, 'onResumed');
  const fakePrepare = vi.fn(async () => 'ready');
  const spike = new FluxIntegrationSpike({ log: vi.fn(), fakePrepare });
  const agent = voice.Agent.create({ instructions: 'test', ...spike.hooks() });
  const message = llm.ChatMessage.create({ role: 'user', content: 'same' });
  spike.speechEvent(transcript(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, 'same'));
  spike.speechEvent(transcript(stt.SpeechEventType.INTERIM_TRANSCRIPT, 'same'));
  spike.speechEvent(transcript(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, 'same'));
  spike.speechEvent(transcript(stt.SpeechEventType.FINAL_TRANSCRIPT, 'same'));
  await Promise.resolve();
  expect(resumed).not.toHaveBeenCalled();
  expect(await output(agent, message)).toEqual([]);
  await agent.onUserTurnCompleted(llm.ChatContext.empty(), message);
  expect(await output(agent, message)).toEqual(['ready']);
  expect(fakePrepare).toHaveBeenCalledTimes(1);
  await expect(agent.onUserTurnCompleted(llm.ChatContext.empty(), message)).rejects.toBeInstanceOf(
    voice.StopResponse,
  );
});

it('rejects a late fake result that ignores coordinator cancellation', async () => {
  let finishOld!: (text: string) => void;
  const fakePrepare = vi.fn(async (text: string) =>
    text === 'old'
      ? new Promise<string>((resolve) => {
          finishOld = resolve;
        })
      : 'fresh',
  );
  const spike = new FluxIntegrationSpike({ log: vi.fn(), fakePrepare });
  const agent = voice.Agent.create({ instructions: 'test', ...spike.hooks() });
  spike.speechEvent(transcript(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, 'old'));
  spike.speechEvent(transcript(stt.SpeechEventType.INTERIM_TRANSCRIPT, 'new'));
  const message = llm.ChatMessage.create({ role: 'user', content: 'new' });
  await agent.onUserTurnCompleted(llm.ChatContext.empty(), message);
  finishOld('stale');
  await Promise.resolve();
  await Promise.resolve();
  expect(await output(agent, message)).toEqual(['fresh']);
});

it('rejects a commitment superseded while fake preparation is pending', async () => {
  let finish!: (text: string) => void;
  const spike = new FluxIntegrationSpike({
    log: vi.fn(),
    fakePrepare: async () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  });
  const agent = voice.Agent.create({ instructions: 'test', ...spike.hooks() });
  const message = llm.ChatMessage.create({ role: 'user', content: 'Monday' });
  spike.speechEvent(transcript(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, 'Monday'));
  const commitment = agent.onUserTurnCompleted(llm.ChatContext.empty(), message);
  const rejected = expect(commitment).rejects.toBeInstanceOf(voice.StopResponse);
  spike.speechEvent(transcript(stt.SpeechEventType.INTERIM_TRANSCRIPT, 'Tuesday'));
  finish('stale');
  await rejected;
  expect(await output(agent, message)).toEqual([]);
});

it('fails closed on preparation errors and never falls back to a production model', async () => {
  const log = vi.fn();
  const spike = new FluxIntegrationSpike({
    log,
    fakePrepare: async () => {
      throw new Error('fake failure');
    },
  });
  const agent = voice.Agent.create({ instructions: 'test', ...spike.hooks() });
  const message = llm.ChatMessage.create({ role: 'user', content: 'hello' });
  await expect(agent.onUserTurnCompleted(llm.ChatContext.empty(), message)).rejects.toBeInstanceOf(
    voice.StopResponse,
  );
  expect(log).toHaveBeenCalledWith('PREPARATION_FAILED', expect.anything());
  expect(await output(agent, message)).toEqual([]);
});

it.each(['', 'old transcript'])(
  'rejects empty or contradictory late commitment (%s)',
  async (text) => {
    const spike = new FluxIntegrationSpike({ log: vi.fn() });
    const agent = voice.Agent.create({ instructions: 'test', ...spike.hooks() });
    spike.speechEvent(transcript(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, 'current transcript'));
    const message = llm.ChatMessage.create({ role: 'user', content: text });
    await expect(
      agent.onUserTurnCompleted(llm.ChatContext.empty(), message),
    ).rejects.toBeInstanceOf(voice.StopResponse);
    expect(await output(agent, message)).toEqual([]);
  },
);

it('propagates STT errors while invalidating prepared work', async () => {
  let signal: AbortSignal | undefined;
  const spike = new FluxIntegrationSpike({
    log: vi.fn(),
    fakePrepare: async (text, received) => {
      signal = received;
      return `fake ${text}`;
    },
  });
  const agent = voice.Agent.create({ instructions: 'test', ...spike.hooks() });
  spike.speechEvent(transcript(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, 'hello'));
  const failure = new Error('STT transport failed');
  vi.spyOn(voice.Agent.default, 'sttNode').mockRejectedValue(failure);
  const stream = await agent.sttNode(new ReadableStream(), {});
  await expect(stream!.getReader().read()).rejects.toBe(failure);
  expect(signal?.aborted).toBe(true);
  const message = llm.ChatMessage.create({ role: 'user', content: 'hello' });
  expect(await output(agent, message)).toEqual([]);
});

it('invalidates on speech start even when the next utterance repeats the same words', async () => {
  const fakePrepare = vi.fn(async () => 'fake');
  const spike = new FluxIntegrationSpike({ log: vi.fn(), fakePrepare });
  const agent = voice.Agent.create({ instructions: 'test', ...spike.hooks() });
  spike.speechEvent(transcript(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, 'hello'));
  const old = llm.ChatMessage.create({ role: 'user', content: 'hello' });
  await agent.onUserTurnCompleted(llm.ChatContext.empty(), old);
  spike.speechEvent({ type: stt.SpeechEventType.START_OF_SPEECH });
  expect(await output(agent, old)).toEqual([]);
  spike.speechEvent(transcript(stt.SpeechEventType.FINAL_TRANSCRIPT, 'hello'));
  const next = llm.ChatMessage.create({ role: 'user', content: 'hello' });
  await agent.onUserTurnCompleted(llm.ChatContext.empty(), next);
  expect(await output(agent, old)).toEqual([]);
  expect(await output(agent, next)).toEqual(['fake']);
  expect(fakePrepare).toHaveBeenCalledTimes(2);
});
