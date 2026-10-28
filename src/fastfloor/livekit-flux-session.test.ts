import { asLanguageCode, initializeLogger, llm, stt, tts, voice } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { afterEach, expect, it, vi } from 'vitest';
import { FluxIntegrationSpike } from './livekit-flux-spike.ts';

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

async function setup(holdOutput?: Promise<void>, holdTts?: Promise<void>) {
  const provider = new ControlledSTT();
  const log = vi.fn();
  const spike = new FluxIntegrationSpike({ log });
  const synthesized: string[] = [];
  const hooks = spike.hooks();
  const agent = voice.Agent.create({
    instructions: 'integration mechanics',
    llm: new UnusedLLM(),
    ...hooks,
    async *llmNode(ctx, chatCtx, toolCtx, settings) {
      const stream = await hooks.llmNode!(ctx, chatCtx, toolCtx, settings);
      if (stream) for await (const value of stream) yield value;
      if (holdOutput) await holdOutput;
    },
    async *ttsNode(_ctx, text) {
      let fullText = '';
      for await (const value of text) fullText += value;
      synthesized.push(fullText);
      if (holdTts) await holdTts;
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
  await vi.waitFor(() => expect(provider.current).toBeDefined());
  return { provider: provider.current!, session, agent, log, sink, synthesized };
}

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
