import { asLanguageCode, initializeLogger, llm, stt, voice } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import type { ReadableStreamDefaultController } from 'node:stream/web';
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

it('supports a matched baseline that waits for commitment without changing the output gate', async () => {
  const fakePrepare = vi.fn(async () => 'committed response');
  const spike = new FluxIntegrationSpike({ log: vi.fn(), fakePrepare, speculate: false });
  const agent = voice.Agent.create({ instructions: 'test', ...spike.hooks() });
  spike.speechEvent(transcript(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, 'hello'));
  await Promise.resolve();
  expect(fakePrepare).not.toHaveBeenCalled();
  const message = llm.ChatMessage.create({ role: 'user', content: 'hello' });
  await agent.onUserTurnCompleted(llm.ChatContext.empty(), message);
  expect(fakePrepare).toHaveBeenCalledTimes(1);
  expect(await output(agent, message)).toEqual(['committed response']);
  expect(await output(agent, message)).toEqual([]);
});

it('rejects tool delegation in fake mode rather than silently calling a production model', () => {
  expect(() => new FluxIntegrationSpike({ committedTools: true, log: vi.fn() })).toThrow(
    'real mode',
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

it.each([
  ['second', false],
  ['first second', true],
  ['invented first second', false],
])('validates a multi-segment committed message without guessing (%s)', async (text, accepted) => {
  const fakePrepare = vi.fn(async (value: string) => `Fake: ${value}`);
  const spike = new FluxIntegrationSpike({ log: vi.fn(), fakePrepare });
  const agent = voice.Agent.create({ instructions: 'test', ...spike.hooks() });
  spike.speechEvent(transcript(stt.SpeechEventType.FINAL_TRANSCRIPT, 'first'));
  spike.speechEvent({ type: stt.SpeechEventType.START_OF_SPEECH });
  spike.speechEvent(transcript(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, 'second'));
  expect(fakePrepare).not.toHaveBeenCalled();
  spike.speechEvent(transcript(stt.SpeechEventType.FINAL_TRANSCRIPT, 'second'));
  const message = llm.ChatMessage.create({ role: 'user', content: String(text) });
  if (accepted) {
    await agent.onUserTurnCompleted(llm.ChatContext.empty(), message);
    expect(await output(agent, message)).toEqual(['Fake: first second']);
  } else {
    await expect(
      agent.onUserTurnCompleted(llm.ChatContext.empty(), message),
    ).rejects.toBeInstanceOf(voice.StopResponse);
    expect(fakePrepare).not.toHaveBeenCalled();
    expect(await output(agent, message)).toEqual([]);
  }
});

it('does not reuse a committed answer if its user message text changes before the LLM node', async () => {
  const spike = new FluxIntegrationSpike({ log: vi.fn() });
  const agent = voice.Agent.create({ instructions: 'test', ...spike.hooks() });
  const message = llm.ChatMessage.create({ role: 'user', content: 'Monday' });
  await agent.onUserTurnCompleted(llm.ChatContext.empty(), message);
  message.content = ['Tuesday'];
  expect(await output(agent, message)).toEqual([]);
});

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

it.each(['tts', 'llm', 'stt'] as const)(
  'cancels a stalled default %s node immediately through the actual SDK hook adapter',
  async (node) => {
    const cancel = vi.fn();
    let controller!: ReadableStreamDefaultController<never>;
    const upstream = new ReadableStream<never>({
      start(value) {
        controller = value;
      },
      cancel,
    });
    const spike = new FluxIntegrationSpike({
      mode: 'real',
      committedTools: true,
      log: vi.fn(),
    });
    const agent = voice.Agent.create({ instructions: 'test', ...spike.hooks() });
    let stream: ReadableStream<unknown> | null;
    if (node === 'tts') {
      vi.spyOn(voice.Agent.default, 'ttsNode').mockResolvedValue(upstream);
      stream = await agent.ttsNode(new ReadableStream<string>(), {});
    } else if (node === 'stt') {
      vi.spyOn(voice.Agent.default, 'sttNode').mockResolvedValue(upstream);
      stream = await agent.sttNode(new ReadableStream(), {});
    } else {
      vi.spyOn(voice.Agent.default, 'llmNode').mockResolvedValue(upstream);
      const message = llm.ChatMessage.create({ role: 'user', content: 'find a founder' });
      const chat = llm.ChatContext.empty();
      await agent.onUserTurnCompleted(chat, message);
      chat.insert(message);
      stream = await agent.llmNode(chat, agent.toolCtx, {});
    }
    const reader = stream!.getReader();
    const pendingRead = reader.read();
    try {
      await vi.waitFor(() => expect(upstream.locked).toBe(true));
      await reader.cancel('user interrupted before first provider chunk');
      expect(cancel).toHaveBeenCalledExactlyOnceWith(
        'user interrupted before first provider chunk',
      );
      await expect(pendingRead).resolves.toEqual({ done: true, value: undefined });
      await vi.waitFor(() => expect(upstream.locked).toBe(false));
    } finally {
      // Release the deliberately stalled provider even when the regression fails.
      if (!cancel.mock.calls.length) controller.close();
    }
  },
);

it('forwards default TTS frames unchanged, timestamps the first once, and releases the reader', async () => {
  const log = vi.fn();
  const frame = new AudioFrame(new Int16Array(240), 24000, 1, 240);
  const upstream = new ReadableStream({
    start(controller) {
      controller.enqueue(frame);
      controller.enqueue(frame);
      controller.close();
    },
  });
  vi.spyOn(voice.Agent.default, 'ttsNode').mockResolvedValue(upstream);
  const agent = voice.Agent.create({
    instructions: 'test',
    ...new FluxIntegrationSpike({ log }).hooks(),
  });
  const stream = await agent.ttsNode(new ReadableStream<string>(), {});
  const received = [];
  for await (const value of stream!) received.push(value);
  expect(received).toHaveLength(2);
  expect(received[0]).toBe(frame);
  expect(received[1]).toBe(frame);
  expect(log.mock.calls.filter(([event]) => event === 'TTS_FIRST_FRAME')).toHaveLength(1);
  expect(upstream.locked).toBe(false);
});

it('propagates a default TTS stream failure without a first-frame timestamp or leaked reader', async () => {
  const log = vi.fn();
  const failure = new Error('provider TTS stream failed');
  const upstream = new ReadableStream<AudioFrame>({
    start(controller) {
      controller.error(failure);
    },
  });
  vi.spyOn(voice.Agent.default, 'ttsNode').mockResolvedValue(upstream);
  const agent = voice.Agent.create({
    instructions: 'test',
    ...new FluxIntegrationSpike({ log }).hooks(),
  });
  const stream = await agent.ttsNode(new ReadableStream<string>(), {});
  await expect(stream!.getReader().read()).rejects.toBe(failure);
  expect(log.mock.calls.filter(([event]) => event === 'TTS_FIRST_FRAME')).toHaveLength(0);
  expect(upstream.locked).toBe(false);
});
