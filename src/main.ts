import { ServerOptions, cli, defineAgent, inference, voice } from '@livekit/agents';
import { EnhancerModel, audioEnhancement } from '@livekit/plugins-ai-coustics';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createAgent } from './agent.ts';
import { EvaluationTrace } from './fastfloor/evaluation.ts';
import { FluxIntegrationSpike } from './fastfloor/livekit-flux-spike.ts';

// Load environment variables from a local file.
// Make sure to set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET
// when running locally or self-hosting your agent server.
dotenv.config({ path: '.env.local' });

export default defineAgent({
  entry: async (ctx) => {
    // Explicit opt-in: the working baseline stays the default.
    const simulation = ctx.simulationContext();
    const boardy =
      process.env.FASTFLOOR_BOARDY === '1' || simulation?.userdata().workload === 'boardy';
    const arm = process.env.FASTFLOOR_EVAL_ARM;
    if (arm !== undefined && arm !== 'baseline' && arm !== 'fastfloor')
      throw new Error('FASTFLOOR_EVAL_ARM must be baseline or fastfloor');
    const realLlm = boardy || arm !== undefined || process.env.FASTFLOOR_REAL_LLM === '1';
    if (process.env.FASTFLOOR_TRACE_PATH && !realLlm && process.env.FASTFLOOR_FLUX_SPIKE !== '1')
      throw new Error(
        'FASTFLOOR_TRACE_PATH requires an evaluation arm, real mode, fake mode, or Boardy workload',
      );
    const trace = process.env.FASTFLOOR_TRACE_PATH
      ? new EvaluationTrace({ arm: arm ?? 'fastfloor', path: process.env.FASTFLOOR_TRACE_PATH })
      : undefined;
    const fluxSpike =
      realLlm || process.env.FASTFLOOR_FLUX_SPIKE === '1'
        ? new FluxIntegrationSpike({
            mode: realLlm ? 'real' : 'fake',
            speculate: arm !== 'baseline',
            committedTools: boardy,
            ...(trace ? { log: trace.log } : {}),
          })
        : undefined;
    // Set up a voice AI pipeline using AssemblyAI, Fish Audio, and the LiveKit turn detector
    const session = new voice.AgentSession({
      // Speech-to-text (STT) is your agent's ears, turning the user's speech into text that the LLM can understand
      // See all available models at https://docs.livekit.io/agents/models/stt/
      stt: fluxSpike
        ? new inference.STT({
            model: 'deepgram/flux-general-en',
            language: 'en',
            modelOptions: { eager_eot_threshold: 0.5 },
          })
        : new inference.STT({
            model: 'assemblyai/universal-3-6-pro',
            language: 'en',
          }),

      // Keyterms bias the STT toward distinctive words it would otherwise misspell.
      // List your own names, brands, and jargon in `keyterms`. Detection additionally
      // extracts terms from the live conversation, such as a caller's name, and applies
      // them once the transcript corroborates the spelling.
      // See more at https://docs.livekit.io/agents/models/stt/keyterms/
      keytermsOptions: {
        keyterms: ['LiveKit'],
        keytermDetection: { enabled: !fluxSpike },
      },

      // Text-to-speech (TTS) is your agent's voice, turning the LLM's text into speech that the user can hear
      // See all available models as well as voice selections at https://docs.livekit.io/agents/models/tts/
      tts: new inference.TTS({
        model: 'fishaudio/s2.1-pro',
        voice: 'fa4c9eb3dccc4806b382b40d61c6b10a',
      }),

      turnHandling: {
        // Turn detection determines when the user is speaking and when the agent should respond.
        // The LiveKit audio turn detector is a multimodal model that encodes the user's audio
        // directly to predict end of turn. It's built into the SDK (no extra plugin) and
        // AgentSession supplies the required VAD automatically.
        // See more at https://docs.livekit.io/agents/logic/turns/turn-detector/
        turnDetection: fluxSpike ? 'stt' : new inference.TurnDetector(),
        // Adaptive interruptions use the turn detector to tell a real interruption from a
        // backchannel like "mhm" or "right", so the agent keeps talking through the latter.
        // This model is on by default on LiveKit Cloud and in dev mode. To use the model elsewhere,
        // uncomment the `interruption` line. Self-hosted usage past the monthly allowance is billed.
        // See https://docs.livekit.io/deploy/admin/quotas-and-limits/#adaptive-interruption-handling for more information.
        // interruption: { mode: 'adaptive' },
        // Allow the LLM to generate a response while waiting for the end of turn
        preemptiveGeneration: { enabled: !fluxSpike },
      },

      // Expressive mode injects the TTS provider's markup guide into the LLM prompt, so the model
      // emits inline delivery tags (emotion, pacing, non-verbal sounds) that the TTS renders and
      // the transcript never shows. Requires a TTS model that supports markup, such as the Fish
      // Audio model above.
      expressive: true,
    });

    // Start the session, which initializes the voice pipeline and warms up the models
    // Text simulations use the ordinary SDK pipeline, never fabricated audio
    // commitment. They evaluate workload semantics, not speculative/audio safety.
    const agent = createAgent(simulation && boardy ? undefined : fluxSpike, {
      boardy,
      ...(trace ? { log: trace.log } : {}),
    });
    trace?.log('RUN_CONFIG', {
      arm,
      llm: realLlm ? 'google/gemma-4-31b-it' : 'fake-no-llm',
      stt: 'deepgram/flux-general-en',
      eagerEotThreshold: 0.5,
      tts: 'fishaudio/s2.1-pro',
      voice: 'fa4c9eb3dccc4806b382b40d61c6b10a',
      prompt: agent.instructions,
      endpointing: 'unchanged SDK defaults',
      turnDetection: 'stt',
      preemptiveGeneration: false,
      preparation: boardy ? 'committed-sdk-tool-loop' : 'full-response-buffer',
      workload: boardy ? 'fictional-networking' : 'assistant',
      speculationEnabled: !boardy && arm !== 'baseline',
    });
    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        // ai-coustics QUAIL audio enhancement for noise cancellation
        // Works for both WebRTC and telephony (SIP) participants
        noiseCancellation: audioEnhancement({ model: EnhancerModel.QuailVfS }),
      },
    });
    trace?.attach(session);

    // // Add a virtual avatar to the session, if desired
    // // For other providers, see https://docs.livekit.io/agents/models/avatar/
    // const avatar = new anam.AvatarSession({
    //   personaConfig: {
    //     name: '...',
    //     avatarId: '...', // See https://docs.livekit.io/agents/models/avatar/plugins/anam
    //   },
    // });
    // // Start the avatar and wait for it to join
    // await avatar.start(session, ctx.room);

    // Join the room and connect to the user
    await ctx.connect();

    // Greet the user on joining
    if (!fluxSpike) {
      session.generateReply({
        instructions: 'Greet the user in a helpful and friendly manner.',
      });
    }
  },
});

// Run the agent server
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'fastfloor',
  }),
);
