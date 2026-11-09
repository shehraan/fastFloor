# LiveKit Flux integration experiment

This experiment checks whether Flux transcript signals can drive the existing
TurnCoordinator and pass a fake prepared response through LiveKit's normal output
pipeline only after the SDK commits a user turn.

The current runtime also supports real LLM preparation and history recovery. See
[the architecture](../../ARCHITECTURE.md) for its current behavior and
[the evaluation guide](../002-history-evaluation/README.md) for later measurements.
This directory contains evidence for the original fake-response experiment.

## Integration

The adapter observes the SDK STT stream without filtering or replacing events.
A preflight starts private preparation. Changed text invalidates the coordinator
generation. `onUserTurnCompleted` validates and commits the input; the custom
`llmNode` then supplies the released string once to the SDK's existing
TTS/output/history pipeline.

LiveKit owns endpointing and audio output. The coordinator owns generation IDs,
AbortController, commitment state, and at-most-once release. The adapter does not
add a parallel `say()` or `generateReply()` path.

## Evidence

Deterministic tests exercise the real SDK session and public hooks with scripted
provider transports and an in-memory audio sink. They cover:

- No TTS before commitment.
- A Monday preflight followed by a Tuesday correction produces one Tuesday reply.
- Stale results cannot publish, including producers that ignore abort.
- Duplicate, failed, contradictory, and actively-speaking commitments fail closed.
- Invalidating a released response interrupts the SDK speech handle and suppresses
  delayed synthetic audio.
- Consecutive turns retain separate history; STT values, errors, and cleanup are
  forwarded through the adapter.

[`audio-smoke-results.json`](audio-smoke-results.json) records two generated-speech
turns through hosted Flux and Fish Audio. Each turn reached SDK commitment before
TTS and playback of a fake response. This is a console-audio transport check, not
a physical microphone/WebRTC test, an acoustic interruption guarantee, or a
latency benchmark.

## Reproduce

From the project root:

```sh
pnpm test src/fastfloor/turn-coordinator.test.ts src/fastfloor/livekit-flux-spike.test.ts src/fastfloor/livekit-flux-session.test.ts
pnpm typecheck
pnpm lint
pnpm exec tsc --noEmit --skipLibCheck false
```

The current files include later real-preparation and history regressions. The saved
smoke artifact remains evidence for the original fake-response experiment only.

To inspect the fake mode with a configured LiveKit project:

```sh
FASTFLOOR_FLUX_SPIKE=1 pnpm dev --log-level DEBUG --no-reload
```

Clear other FastFloor mode flags first. Connect to agent `fastfloor` through Agent
Console with a microphone and headphones. Try a normal turn, a correction before
commitment, and an interruption during playback. Use fictional phrases because
opt-in logs contain transcript text. A text-debugger request bypasses the audio
commitment hook and cannot validate this experiment.

Normalized STT events do not expose a typed raw Flux resumed-turn/turn-ID contract.
Do not infer that contract from an identical interim transcript. Already delivered
audio cannot be retracted; caller-side interruption behavior needs a separate
acoustic measurement.
