import { asLanguageCode, initializeLogger, llm, stt, tts, voice } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import dotenv from 'dotenv';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgent } from '../agent.ts';
import { EvaluationTrace, summarize } from './evaluation.ts';
import { FluxIntegrationSpike } from './livekit-flux-spike.ts';
import { boardyInstructions, createFindPeopleTool } from './people.ts';

initializeLogger({ pretty: false, level: 'silent' });
afterEach(() => vi.restoreAllMocks());

// Public provider interfaces only: no deep imports or private session access.
class UnusedLLM extends llm.LLM {
  override label() {
    return 'must-not-call-llm';
  }
  override chat(): llm.LLMStream {
    throw new Error('Production LLM must not run');
  }
}

class ControlledSTT extends stt.STT {
  override label = 'scripted-flux-events';
  current: ControlledStream | undefined;
  constructor() {
    super({ streaming: true, interimResults: true });
  }
  override async _recognize(): Promise<stt.SpeechEvent> {
    throw new Error('stream only');
  }
  override stream(): ControlledStream {
    this.current = new ControlledStream(this);
    return this.current;
  }
}

class ControlledStream extends stt.SpeechStream {
  override label = 'scripted-flux-stream';
  send(type: stt.SpeechEventType, text?: string) {
    this.queue.put({
      type,
      ...(text === undefined
        ? {}
        : {
            alternatives: [
              { text, language: asLanguageCode('en'), startTime: 0, endTime: 0, confidence: 1 },
            ],
          }),
    });
  }
  protected override async run(): Promise<void> {
    // Keep the real SDK STT stream open; tests replace only the provider transport.
    for await (const frame of this.input) {
      void frame; /* no network */
    }
  }
}

class UnusedTTS extends tts.TTS {
  override label = 'custom-tts-node-only';
  constructor() {
    super(24000, 1, { streaming: true });
  }
  override synthesize(): tts.ChunkedStream {
    throw new Error('custom node only');
  }
  override stream(): tts.SynthesizeStream {
    throw new Error('custom node only');
  }
}

// An in-memory sink, NOT a speaker or a WebRTC publication.
class CaptureOutput extends voice.AudioOutput {
  frames: AudioFrame[] = [];
  override async captureFrame(frame: AudioFrame) {
    await super.captureFrame(frame);
    this.frames.push(frame);
    this.onPlaybackStarted(Date.now());
  }
  override flush() {
    super.flush();
    if (this.pendingPlayoutSegments)
      this.onPlaybackFinished({ playbackPosition: 0.01, interrupted: false });
  }
  override clearBuffer() {
    while (this.pendingPlayoutSegments)
      this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
  }
}

async function setup(
  holdOutput?: Promise<void>,
  holdTts?: Promise<void>,
  model?: llm.LLM,
  evaluation?: { speculate: boolean; trace: EvaluationTrace; boardy?: boolean; prompt?: string },
) {
  const provider = new ControlledSTT();
  const log = vi.fn((event: string, details: Record<string, unknown>) =>
    evaluation?.trace.log(event, details),
  );
  const spike = new FluxIntegrationSpike({
    log,
    ...(model ? { mode: 'real' as const } : {}),
    ...(evaluation
      ? { speculate: evaluation.speculate, committedTools: evaluation.boardy ?? false }
      : {}),
  });
  const synthesized: string[] = [];
  let outputMessageId: string | undefined;
  const hooks = spike.hooks();
  const agent = voice.Agent.create({
    instructions:
      evaluation?.prompt ?? (evaluation?.boardy ? boardyInstructions : 'integration mechanics'),
    ...(evaluation?.boardy ? { tools: [createFindPeopleTool(log)] } : {}),
    llm: model ?? new UnusedLLM(),
    ...hooks,
    async *llmNode(ctx, chatCtx, toolCtx, settings) {
      outputMessageId = [...chatCtx.items]
        .reverse()
        .find((item) => item.type === 'message' && item.role === 'user')?.id;
      const stream = await hooks.llmNode!(ctx, chatCtx, toolCtx, settings);
      if (stream) for await (const value of stream) yield value;
      if (holdOutput) await holdOutput;
    },
    async *ttsNode(_ctx, text) {
      evaluation?.trace.log('TTS_STARTED', {
        messageId: outputMessageId,
        provider: 'synthetic-silent-PCM',
      });
      let fullText = '';
      for await (const value of text) fullText += value;
      synthesized.push(fullText);
      if (holdTts) await holdTts;
      evaluation?.trace.log('TTS_FIRST_FRAME', {
        messageId: outputMessageId,
        provider: 'synthetic-silent-PCM',
      });
      yield new AudioFrame(new Int16Array(240), 24000, 1, 240);
    },
  });
  const session = new voice.AgentSession({
    stt: provider,
    tts: new UnusedTTS(),
    vad: null,
    turnHandling: {
      turnDetection: 'stt',
      endpointing: { minDelay: 0, maxDelay: 0 },
      preemptiveGeneration: { enabled: false },
      interruption: { enabled: false },
    },
  });
  const sink = new CaptureOutput(24000);
  session.output.audio = sink;
  await session.start({ agent });
  evaluation?.trace.attach(session);
  await vi.waitFor(() => expect(provider.current).toBeDefined());
  return { provider: provider.current!, session, agent, log, sink, synthesized };
}

class ScriptedLLM extends llm.LLM {
  requests: Parameters<llm.LLM['chat']>[0][] = [];
  streams: llm.LLMStream[] = [];
  respond = async (emit: (chunk: llm.ChatChunk) => void) => {
    emit({ id: 'fixture', delta: { role: 'assistant', content: 'Real interface ' } });
    emit({ id: 'fixture', delta: { role: 'assistant', content: 'reply.' } });
  };
  override label() {
    return 'scripted-real-llm-interface';
  }
  override chat(options: Parameters<llm.LLM['chat']>[0]): llm.LLMStream {
    this.requests.push(options);
    const stream = new ScriptedLLMStream(this, options);
    this.streams.push(stream);
    return stream;
  }
}

class ScriptedLLMStream extends llm.LLMStream {
  private readonly respond: ScriptedLLM['respond'];
  constructor(model: ScriptedLLM, options: Parameters<llm.LLM['chat']>[0]) {
    super(model, {
      chatCtx: options.chatCtx,
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1000 },
    });
    this.respond = model.respond;
  }
  protected override async run() {
    await this.respond((chunk) => this.queue.put(chunk));
  }
}

it('buffers real LLM chunks privately and reuses them for exactly one committed SDK reply', async () => {
  const model = new ScriptedLLM();
  const { provider, session, synthesized, sink } = await setup(undefined, undefined, model);
  try {
    provider.send(stt.SpeechEventType.START_OF_SPEECH);
    await vi.waitFor(() => expect(session.userState).toBe('speaking'));
    provider.send(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, 'hello');
    await vi.waitFor(() => expect(model.requests).toHaveLength(1));
    expect(synthesized).toEqual([]);
    expect(sink.frames).toHaveLength(0);
    expect(
      model.requests[0]!.chatCtx.items.filter((item) => item.type === 'message').map((item) => [
        item.role,
        item.textContent,
      ]),
    ).toEqual([
      ['system', 'integration mechanics'],
      ['user', 'hello'],
    ]);
    expect(model.requests[0]!.toolChoice).toBe('none');
    provider.send(stt.SpeechEventType.FINAL_TRANSCRIPT, 'hello');
    provider.send(stt.SpeechEventType.END_OF_SPEECH);
    await vi.waitFor(() => expect(synthesized).toEqual(['Real interface reply.']));
    await session.waitForIdle();
    expect(model.requests).toHaveLength(1);
    expect(sink.frames).toHaveLength(1);
    expect(
      session.history.items
        .filter((item) => item.type === 'message')
        .map((item) => [item.role, item.textContent]),
    ).toEqual([
      ['user', 'hello'],
      ['assistant', 'Real interface reply.'],
    ]);
  } finally {
    await session.close();
  }
});

it('uses the complete multi-segment SDK turn and preserves history for the next real request', async () => {
  const model = new ScriptedLLM();
  const { provider, session, synthesized } = await setup(undefined, undefined, model);
  const first = 'I want to book a flight';
  const second = 'to Boston on Tuesday';
  try {
    provider.send(stt.SpeechEventType.START_OF_SPEECH);
    await vi.waitFor(() => expect(session.userState).toBe('speaking'));
    provider.send(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, first);
    await vi.waitFor(() => expect(model.requests).toHaveLength(1));
    provider.send(stt.SpeechEventType.FINAL_TRANSCRIPT, first);
    provider.send(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, second);
    provider.send(stt.SpeechEventType.FINAL_TRANSCRIPT, second);
    provider.send(stt.SpeechEventType.END_OF_SPEECH);
    await vi.waitFor(() => expect(synthesized).toHaveLength(1));
    await session.waitForIdle();
    // No second-segment-only speculation; fallback uses the SDK message verbatim.
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]!.chatCtx.items.at(-1)).toMatchObject({
      role: 'user',
      content: [`${first} ${second}`],
    });
    provider.send(stt.SpeechEventType.START_OF_SPEECH);
    provider.send(stt.SpeechEventType.FINAL_TRANSCRIPT, 'What destination did I say?');
    provider.send(stt.SpeechEventType.END_OF_SPEECH);
    await vi.waitFor(() => expect(synthesized).toHaveLength(2));
    await session.waitForIdle();
    expect(model.requests).toHaveLength(3);
    expect(
      model.requests[2]!.chatCtx.items.filter((item) => item.type === 'message').map((item) => [
        item.role,
        item.textContent,
      ]),
    ).toEqual([
      ['system', 'integration mechanics'],
      ['user', `${first} ${second}`],
      ['assistant', 'Real interface reply.'],
      ['user', 'What destination did I say?'],
    ]);
  } finally {
    await session.close();
  }
});

it('does not release a partial real-model response after an unrecoverable provider failure', async () => {
  const model = new ScriptedLLM();
  model.respond = async (emit) => {
    emit({ id: 'failed', delta: { role: 'assistant', content: 'unsafe partial' } });
    throw new Error('provider disconnected');
  };
  const spike = new FluxIntegrationSpike({ mode: 'real', log: vi.fn() });
  const agent = voice.Agent.create({ instructions: 'test', llm: model, ...spike.hooks() });
  const message = llm.ChatMessage.create({ role: 'user', content: 'hello' });
  // The installed SDK surfaces stream failures via the model's error event.
  const errors = vi.fn();
  model.on('error', errors);
  await expect(agent.onUserTurnCompleted(llm.ChatContext.empty(), message)).rejects.toBeInstanceOf(
    voice.StopResponse,
  );
  expect(errors).toHaveBeenCalledWith(expect.objectContaining({ recoverable: false }));
  expect(model.listenerCount('error')).toBe(1);
});

it('closes a cancelled real stream and never plays its late chunks after fallback', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = new ScriptedLLM();
  model.respond = async (emit) => {
    emit({ id: 'old', delta: { role: 'assistant', content: 'Monday partial' } });
    await pending;
    emit({ id: 'old', delta: { role: 'assistant', content: ' stale ending' } });
  };
  const { provider, session, synthesized, sink } = await setup(undefined, undefined, model);
  const fresh = async (emit: (chunk: llm.ChatChunk) => void) => {
    emit({ id: 'fresh', delta: { role: 'assistant', content: 'Tuesday reply' } });
  };
  try {
    provider.send(stt.SpeechEventType.START_OF_SPEECH);
    await vi.waitFor(() => expect(session.userState).toBe('speaking'));
    provider.send(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, 'book Monday');
    await vi.waitFor(() => expect(model.requests).toHaveLength(1));
    const close = vi.spyOn(model.streams[0]!, 'close');
    model.respond = fresh;
    provider.send(stt.SpeechEventType.INTERIM_TRANSCRIPT, 'book Tuesday');
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    expect(model.listenerCount('error')).toBe(1); // SDK's own listener only.
    expect(synthesized).toEqual([]);
    provider.send(stt.SpeechEventType.FINAL_TRANSCRIPT, 'book Tuesday');
    provider.send(stt.SpeechEventType.END_OF_SPEECH);
    await vi.waitFor(() => expect(synthesized).toEqual(['Tuesday reply']));
    release();
    await session.waitForIdle();
    expect(model.requests).toHaveLength(2);
    expect(sink.frames).toHaveLength(1);
    expect(
      session.history.items
        .filter((item) => item.type === 'message')
        .map((item) => [item.role, item.textContent]),
    ).toEqual([
      ['user', 'book Tuesday'],
      ['assistant', 'Tuesday reply'],
    ]);
  } finally {
    release();
    await session.close();
  }
});

it('regenerates when history changes between preflight and commitment', async () => {
  const model = new ScriptedLLM();
  const { provider, session, agent, synthesized } = await setup(undefined, undefined, model);
  try {
    provider.send(stt.SpeechEventType.START_OF_SPEECH);
    await vi.waitFor(() => expect(session.userState).toBe('speaking'));
    provider.send(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, 'hello');
    await vi.waitFor(() => expect(model.requests).toHaveLength(1));
    await agent.updateInstructions('Updated instructions');
    provider.send(stt.SpeechEventType.FINAL_TRANSCRIPT, 'hello');
    provider.send(stt.SpeechEventType.END_OF_SPEECH);
    await vi.waitFor(() => expect(synthesized).toHaveLength(1));
    await session.waitForIdle();
    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]!.chatCtx.items[0]).toMatchObject({
      content: ['integration mechanics'],
    });
    expect(model.requests[1]!.chatCtx.items[0]).toMatchObject({
      content: ['Updated instructions'],
    });
  } finally {
    await session.close();
  }
});

it.each(['', 'tools'])('fails closed on empty or tool-bearing real output (%s)', async (kind) => {
  const model = new ScriptedLLM();
  model.respond = async (emit) => {
    if (kind === 'tools')
      emit({
        id: 'unexpected-tool',
        delta: {
          role: 'assistant',
          content: 'Do not play',
          toolCalls: [llm.FunctionCall.create({ name: 'not-allowed', callId: 'x', args: '{}' })],
        },
      });
  };
  const spike = new FluxIntegrationSpike({ mode: 'real', log: vi.fn() });
  const agent = voice.Agent.create({ instructions: 'test', llm: model, ...spike.hooks() });
  await expect(
    agent.onUserTurnCompleted(
      llm.ChatContext.empty(),
      llm.ChatMessage.create({ role: 'user', content: 'hello' }),
    ),
  ).rejects.toBeInstanceOf(voice.StopResponse);
  expect(model.requests).toHaveLength(1);
  expect(model.requests[0]!.toolCtx).toEqual([]);
  expect(model.listenerCount('error')).toBe(0);
});

it('cancels a pending committed real request on new speech without waiting for the provider', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = new ScriptedLLM();
  model.respond = async (emit) => {
    await pending;
    emit({ id: 'late', delta: { role: 'assistant', content: 'stale' } });
  };
  const { provider, session, log, synthesized, sink } = await setup(undefined, undefined, model);
  try {
    provider.send(stt.SpeechEventType.START_OF_SPEECH);
    provider.send(stt.SpeechEventType.FINAL_TRANSCRIPT, 'Monday');
    provider.send(stt.SpeechEventType.END_OF_SPEECH);
    await vi.waitFor(() => expect(model.requests).toHaveLength(1));
    expect(log).toHaveBeenCalledWith('USER_TURN_COMMITTED', expect.anything());
    const close = vi.spyOn(model.streams[0]!, 'close');
    provider.send(stt.SpeechEventType.START_OF_SPEECH);
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    // Collection unblocks even though the scripted remote transport still waits.
    await vi.waitFor(() => expect(model.listenerCount('error')).toBe(1));
    expect(synthesized).toEqual([]);
    expect(sink.frames).toHaveLength(0);
    release();
    provider.send(stt.SpeechEventType.END_OF_SPEECH);
    await session.waitForIdle();
    expect(log).not.toHaveBeenCalledWith('RESPONSE_RELEASED', expect.anything());
  } finally {
    release();
    await session.close();
  }
});

it.each([
  ['New York', 'Boston'],
  ['Lisbon', 'Oslo'],
])(
  'retains a committed %s request when its pending reply is cancelled by %s',
  async (original, correction) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = new ScriptedLLM();
    model.respond = async (emit) => {
      await pending;
      emit({ id: 'cancelled', delta: { role: 'assistant', content: 'stale reply' } });
    };
    const { provider, session, agent, synthesized } = await setup(undefined, undefined, model);
    const first = `Find someone in ${original}.`;
    const second = `Actually, ${correction}.`;
    const question = 'Which location did I ask for originally?';
    try {
      provider.send(stt.SpeechEventType.START_OF_SPEECH);
      provider.send(stt.SpeechEventType.FINAL_TRANSCRIPT, first);
      provider.send(stt.SpeechEventType.END_OF_SPEECH);
      await vi.waitFor(() => expect(model.requests).toHaveLength(1));
      const close = vi.spyOn(model.streams[0]!, 'close');
      provider.send(stt.SpeechEventType.START_OF_SPEECH);
      await vi.waitFor(() => expect(close).toHaveBeenCalled());
      model.respond = async (emit) => {
        emit({ id: 'fresh', delta: { role: 'assistant', content: 'Acknowledged.' } });
      };
      provider.send(stt.SpeechEventType.FINAL_TRANSCRIPT, second);
      provider.send(stt.SpeechEventType.END_OF_SPEECH);
      await vi.waitFor(() => expect(synthesized).toHaveLength(1));
      await session.waitForIdle();
      provider.send(stt.SpeechEventType.START_OF_SPEECH);
      provider.send(stt.SpeechEventType.FINAL_TRANSCRIPT, question);
      provider.send(stt.SpeechEventType.END_OF_SPEECH);
      await vi.waitFor(() => expect(synthesized).toHaveLength(2));
      await session.waitForIdle();
      const users = (ctx: llm.ChatContext | voice.Agent['chatCtx']) =>
        ctx.items
          .filter((item) => item.type === 'message' && item.role === 'user')
          .map((item) => (item.type === 'message' ? item.textContent : null));
      expect(users(model.requests.at(-1)!.chatCtx)).toEqual([first, second, question]);
      expect(users(agent.chatCtx)).toEqual([first, second, question]);
      expect(users(session.history)).toEqual([first, second, question]);
      expect(synthesized).not.toContain('stale reply');
    } finally {
      release();
      await session.close();
    }
  },
);

it('interrupts released real output before delayed TTS reaches the sink', async () => {
  let release!: () => void;
  const holdTts = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = new ScriptedLLM();
  const { provider, session, synthesized, sink } = await setup(undefined, holdTts, model);
  const handles: voice.SpeechHandle[] = [];
  session.on(voice.AgentSessionEventTypes.SpeechCreated, (event) =>
    handles.push(event.speechHandle),
  );
  try {
    provider.send(stt.SpeechEventType.START_OF_SPEECH);
    provider.send(stt.SpeechEventType.FINAL_TRANSCRIPT, 'Monday');
    provider.send(stt.SpeechEventType.END_OF_SPEECH);
    await vi.waitFor(() => expect(synthesized).toEqual(['Real interface reply.']));
    expect(sink.frames).toHaveLength(0);
    provider.send(stt.SpeechEventType.START_OF_SPEECH);
    await vi.waitFor(() => expect(handles[0]!.interrupted).toBe(true));
    release();
    provider.send(stt.SpeechEventType.END_OF_SPEECH);
    await session.waitForIdle();
    expect(sink.frames).toHaveLength(0);
    expect(model.requests).toHaveLength(1);
  } finally {
    release();
    await session.close();
  }
});

it('runs Monday -> Tuesday through real STT, commitment hook and exactly one SDK reply', async () => {
  const { provider, session, log, sink, synthesized } = await setup();
  const speeches = vi.fn();
  session.on(voice.AgentSessionEventTypes.SpeechCreated, speeches);
  const transcripts = vi.fn();
  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, transcripts);
  try {
    provider.send(stt.SpeechEventType.START_OF_SPEECH);
    provider.send(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, 'book Monday');
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith('PREFLIGHT_TRANSCRIPT', expect.anything()),
    );
    expect(speeches).not.toHaveBeenCalled();
    expect(synthesized).toEqual([]);
    expect(sink.frames).toHaveLength(0);
    provider.send(stt.SpeechEventType.INTERIM_TRANSCRIPT, 'book Tuesday');
    provider.send(stt.SpeechEventType.FINAL_TRANSCRIPT, 'book Tuesday');
    provider.send(stt.SpeechEventType.END_OF_SPEECH);
    await vi.waitFor(() =>
      expect(
        session.history.items.some((item) => item.type === 'message' && item.role === 'assistant'),
      ).toBe(true),
    );
    await session.waitForIdle();
    const messages = session.history.items.filter((item) => item.type === 'message');
    expect(messages.map((item) => [item.role, item.textContent])).toEqual([
      ['user', 'book Tuesday'],
      ['assistant', 'Integration spike. I heard: book Tuesday'],
    ]);
    expect(speeches).toHaveBeenCalledTimes(1);
    expect(synthesized).toEqual(['Integration spike. I heard: book Tuesday']);
    expect(sink.frames).toHaveLength(1);
    expect(transcripts).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: 'book Tuesday', isFinal: true }),
    );
    expect(log).toHaveBeenCalledWith(
      'USER_TURN_COMMITTED',
      expect.objectContaining({ transcript: 'book Tuesday' }),
    );
  } finally {
    await session.close();
  }
});

it('interrupts the SDK response handle when a changed transcript invalidates released output', async () => {
  let release!: () => void;
  const { provider, session } = await setup(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const created: voice.SpeechHandle[] = [];
  session.on(voice.AgentSessionEventTypes.SpeechCreated, (event) =>
    created.push(event.speechHandle),
  );
  try {
    provider.send(stt.SpeechEventType.START_OF_SPEECH);
    provider.send(stt.SpeechEventType.FINAL_TRANSCRIPT, 'book Monday');
    provider.send(stt.SpeechEventType.END_OF_SPEECH);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    provider.send(stt.SpeechEventType.INTERIM_TRANSCRIPT, 'book Tuesday');
    await vi.waitFor(() => expect(created[0]!.interrupted).toBe(true));
  } finally {
    release();
    await session.close();
  }
});

it('rejects a delayed commitment hook while the SDK still reports user speech', async () => {
  const { provider, session, agent, sink } = await setup();
  try {
    provider.send(stt.SpeechEventType.START_OF_SPEECH);
    provider.send(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, 'hello');
    await vi.waitFor(() => expect(session.userState).toBe('speaking'));
    const message = llm.ChatMessage.create({ role: 'user', content: 'hello' });
    await expect(
      agent.onUserTurnCompleted(llm.ChatContext.empty(), message),
    ).rejects.toBeInstanceOf(voice.StopResponse);
    expect(sink.frames).toHaveLength(0);
  } finally {
    await session.close();
  }
});

it('keeps consecutive committed user turns and their replies separate', async () => {
  const { provider, session, synthesized } = await setup();
  try {
    for (const text of ['first', 'second']) {
      provider.send(stt.SpeechEventType.START_OF_SPEECH);
      provider.send(stt.SpeechEventType.FINAL_TRANSCRIPT, text);
      provider.send(stt.SpeechEventType.END_OF_SPEECH);
      await vi.waitFor(() => expect(synthesized).toContain(`Integration spike. I heard: ${text}`));
      await session.waitForIdle();
    }
    expect(
      session.history.items
        .filter((item) => item.type === 'message')
        .map((item) => [item.role, item.textContent]),
    ).toEqual([
      ['user', 'first'],
      ['assistant', 'Integration spike. I heard: first'],
      ['user', 'second'],
      ['assistant', 'Integration spike. I heard: second'],
    ]);
  } finally {
    await session.close();
  }
  expect(session.listenerCount(voice.AgentSessionEventTypes.SpeechCreated)).toBe(0);
  expect(session.listenerCount(voice.AgentSessionEventTypes.UserStateChanged)).toBe(0);
});

it('runs the read-only SDK tool loop only after audio commitment and retains corrections and results', async () => {
  const hosted = process.env.FASTFLOOR_EVAL_HOSTED === '1';
  if (hosted) dotenv.config({ path: '.env.local', quiet: true });
  const trace = new EvaluationTrace({ arm: 'fastfloor' });
  const scripted = new ScriptedLLM();
  scripted.respond = async (emit) => {
    const context = scripted.requests.at(-1)!.chatCtx;
    const lastUser = [...context.items]
      .reverse()
      .find((item) => item.type === 'message' && item.role === 'user');
    const lastOutput = [...context.items]
      .reverse()
      .find((item) => item.type === 'function_call_output');
    const afterUser = context.items.slice(context.items.indexOf(lastUser!));
    if (afterUser.some((item) => item.type === 'function_call_output')) {
      emit({
        id: 'tool-answer',
        delta: {
          role: 'assistant',
          content: `Directory result: ${lastOutput?.type === 'function_call_output' ? lastOutput.output : ''}`,
        },
      });
    } else {
      emit({
        id: 'tool-proposal',
        delta: {
          role: 'assistant',
          toolCalls: [
            llm.FunctionCall.create({
              name: 'find_people',
              callId: `lookup-${scripted.requests.length}`,
              args: JSON.stringify({
                city:
                  lastUser?.type === 'message' && lastUser.textContent?.includes('Boston')
                    ? 'Boston'
                    : 'New York',
                role: 'founder',
                topic: 'robotics',
                limit: 3,
              }),
            }),
          ],
        },
      });
    }
  };
  const configured = hosted ? createAgent(undefined, { boardy: true }) : undefined;
  const model = configured?.llm ?? scripted;
  if (!(model instanceof llm.LLM)) throw new Error('Expected pipeline LLM');
  const requests = vi.spyOn(model, 'chat');
  const { provider, session, log } = await setup(undefined, undefined, model, {
    speculate: true,
    trace,
    boardy: true,
    ...(configured ? { prompt: String(configured.instructions) } : {}),
  });
  try {
    for (const text of ['Find a robotics founder in New York.', 'Boston instead.']) {
      const before = requests.mock.calls.length;
      provider.send(stt.SpeechEventType.START_OF_SPEECH);
      await vi.waitFor(() => expect(session.userState).toBe('speaking'));
      provider.send(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, text);
      await delay(30);
      expect(requests).toHaveBeenCalledTimes(before);
      provider.send(stt.SpeechEventType.FINAL_TRANSCRIPT, text);
      provider.send(stt.SpeechEventType.END_OF_SPEECH);
      await vi.waitFor(() => expect(requests).toHaveBeenCalledTimes(before + 2), {
        timeout: hosted ? 20000 : 1000,
      });
      await session.waitForIdle();
    }
    expect(log).toHaveBeenCalledWith(
      'FIND_PEOPLE_COMPLETED',
      expect.objectContaining({
        result: expect.objectContaining({
          people: [expect.objectContaining({ name: 'Maya Chen' })],
        }),
      }),
    );
    const context = requests.mock.calls.at(-1)![0].chatCtx;
    expect(
      context.items
        .filter((item) => item.type === 'message' && item.role === 'user')
        .map((item) => (item.type === 'message' ? item.textContent : null)),
    ).toEqual(['Find a robotics founder in New York.', 'Boston instead.']);
    expect(context.items.filter((item) => item.type === 'function_call_output')).toHaveLength(2);
    expect(
      session.history.items.filter((item) => item.type === 'function_call_output'),
    ).toHaveLength(2);
    const commit = trace.events.findIndex((event) => event.event === 'USER_TURN_COMMITTED');
    expect(
      trace.events.findIndex((event) => event.event === 'FIND_PEOPLE_STARTED'),
    ).toBeGreaterThan(commit);
    if (hosted && process.env.FASTFLOOR_BOARDY_OUTPUT)
      writeFileSync(
        process.env.FASTFLOOR_BOARDY_OUTPUT,
        JSON.stringify(
          {
            evidence:
              'hosted Gemma; scripted audio transcripts; real local read-only tool; synthetic TTS; not acoustic',
            events: trace.events,
            history: session.history.items.map((item) => item.toJSON(true)),
          },
          null,
          2,
        ),
      );
  } finally {
    await session.close();
  }
}, 60000);

it('exports matched SDK A/B measurements with scripted providers, not acoustic latency', async () => {
  const hosted = process.env.FASTFLOOR_EVAL_HOSTED === '1';
  if (hosted) dotenv.config({ path: '.env.local', quiet: true });
  const runs: Array<ReturnType<typeof summarize> & { events: EvaluationTrace['events'] }> = [];
  for (const arms of [
    ['baseline', 'fastfloor'],
    ['fastfloor', 'baseline'],
  ] as const) {
    for (const arm of arms) {
      const trace = new EvaluationTrace({ arm });
      const scripted = new ScriptedLLM();
      scripted.respond = async (emit) => {
        await delay(30); // Identical scripted transport latency, NOT a hosted-model measurement.
        emit({
          id: 'measured-scripted-request',
          delta: { role: 'assistant', content: 'Fixture response.' },
        });
      };
      const configured = hosted ? createAgent() : undefined;
      const model = configured?.llm ?? scripted;
      if (!(model instanceof llm.LLM)) throw new Error('Expected pipeline LLM');
      const requests = vi.spyOn(model, 'chat');
      const prompt = configured ? String(configured.instructions) : 'integration mechanics';
      trace.log('RUN_CONFIG', {
        llm: hosted ? 'google/gemma-4-31b-it' : scripted.label(),
        prompt,
        stt: 'scripted-flux-events',
        tts: 'synthetic-silent-PCM',
        turnDetection: 'stt',
        minDelay: 0,
        maxDelay: 0,
      });
      const { provider, session, sink, synthesized } = await setup(undefined, undefined, model, {
        speculate: arm === 'fastfloor',
        trace,
        prompt,
      });
      try {
        for (const correction of [false, true]) {
          const before = synthesized.length;
          provider.send(stt.SpeechEventType.START_OF_SPEECH);
          await vi.waitFor(() => expect(session.userState).toBe('speaking'));
          provider.send(
            stt.SpeechEventType.PREFLIGHT_TRANSCRIPT,
            'Find a robotics founder in Lisbon.',
          );
          await delay(60); // Same preflight lead in both arms, not an endpointing change.
          expect(sink.frames).toHaveLength(before);
          const text = correction
            ? 'Actually, find a climate founder in Oslo.'
            : 'Find a robotics founder in Lisbon.';
          if (correction) provider.send(stt.SpeechEventType.INTERIM_TRANSCRIPT, text);
          provider.send(stt.SpeechEventType.FINAL_TRANSCRIPT, text);
          provider.send(stt.SpeechEventType.END_OF_SPEECH);
          await vi.waitFor(() => expect(synthesized).toHaveLength(before + 1), {
            timeout: hosted ? 20000 : 1000,
          });
          await session.waitForIdle();
        }
        const report = summarize(trace.events);
        expect(report.committedTurns).toBe(2);
        expect(report.playbackSamples).toBe(2);
        expect(report.unattributedPlaybackEvents).toBe(0);
        expect(report.prematureSdkPlayback).toBe(0);
        expect(report.speculativeReuses).toBe(arm === 'fastfloor' ? 1 : 0);
        expect(report.rollbacks).toBe(arm === 'fastfloor' ? 1 : 0);
        expect(requests).toHaveBeenCalledTimes(arm === 'fastfloor' ? 3 : 2);
        expect(
          requests.mock.calls
            .at(-1)![0]
            .chatCtx.items.filter((item) => item.type === 'message' && item.role === 'user'),
        ).toHaveLength(2);
        runs.push({ ...report, events: trace.events });
      } finally {
        await session.close();
      }
    }
  }
  if (process.env.FASTFLOOR_EVAL_OUTPUT)
    writeFileSync(
      process.env.FASTFLOOR_EVAL_OUTPUT,
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          evidence: `real SDK sessions; ${hosted ? 'hosted Gemma LLM via LiveKit Inference' : 'scripted LLM'}; scripted STT; synthetic silent PCM; in-memory sink; NOT acoustic or end-to-end hosted voice latency`,
          configuration: {
            llm: hosted ? 'google/gemma-4-31b-it' : 'scripted-real-llm-interface',
            tts: 'synthetic-silent-PCM',
            turnDetection: 'stt',
            minDelay: 0,
            maxDelay: 0,
            scriptedLlmDelayMs: hosted ? null : 30,
            preflightLeadMs: 60,
          },
          runs,
        },
        null,
        2,
      ),
    );
}, 120000);

it('drops delayed synthetic TTS audio when the generation is invalidated before output', async () => {
  let release!: () => void;
  const { provider, session, sink, synthesized } = await setup(
    undefined,
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const handles: voice.SpeechHandle[] = [];
  session.on(voice.AgentSessionEventTypes.SpeechCreated, (event) =>
    handles.push(event.speechHandle),
  );
  try {
    provider.send(stt.SpeechEventType.START_OF_SPEECH);
    provider.send(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, 'book Monday');
    provider.send(stt.SpeechEventType.FINAL_TRANSCRIPT, 'book Monday');
    provider.send(stt.SpeechEventType.END_OF_SPEECH);
    await vi.waitFor(() => expect(synthesized).toHaveLength(1));
    expect(sink.frames).toHaveLength(0);
    provider.send(stt.SpeechEventType.INTERIM_TRANSCRIPT, 'book Tuesday');
    await vi.waitFor(() => expect(handles[0]!.interrupted).toBe(true));
    release();
    await session.waitForIdle();
    expect(sink.frames).toHaveLength(0);
  } finally {
    release();
    await session.close();
  }
});
