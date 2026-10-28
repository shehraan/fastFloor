# 001 — LiveKit Flux integration spike

## Question

Can the installed TypeScript LiveKit SDK expose preflight/transcript signals to the
existing TurnCoordinator and take a fake, coordinator-released string through its
normal output pipeline only after session turn commitment?

## Verdict: PARTIAL

The deterministic integration path works with the real SDK and scripted providers.
The checkpoint also passed two real hosted Flux/Fish Audio debugger turns using
generated speech. Physical microphone, browser WebRTC, same-turn resumption, and
audible interruption remain unverified. No production LLM speculation is implemented,
and no latency improvement is claimed. See [HANDOFF.md](../../HANDOFF.md) for the
current checkpoint and exact manual-testing command.

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for exact API verification, the event
mapping, safety boundaries, and limitations.

## Changed files

- `src/fastfloor/turn-coordinator.ts`: user-approved optional publish callback,
  retaining the console default. Original state/generation/cancellation logic intact.
- `src/fastfloor/livekit-flux-spike.ts`: transparent STT observer, conservative
  invalidation using the coordinator's methods, fake-only preparation, commitment
  mapping, one-shot custom LLM-node output, and SDK speech-handle cleanup.
- `src/main.ts`: explicit `FASTFLOOR_FLUX_SPIKE=1` opt-in. Only this mode switches to
  Flux/STT endpointing and disables default preemptive generation, automatic LLM
  keyterm detection, and the greeting.
- `src/agent.ts`: optional spike hooks; normal factory behavior remains default.
- `src/fastfloor/livekit-flux-spike.test.ts`: output seam and hook/adapter edge cases.
- `src/fastfloor/livekit-flux-session.test.ts`: real SDK STT/session/commit/output
  integration with scripted providers and an in-memory synthetic-audio sink.
- `ARCHITECTURE.md` and this file: responsibilities, evidence, limitations, next step.

The follow-up checkpoint changes `package.json` and `pnpm-lock.yaml` only to pin
RTC 1.1.0 and add `@types/ws` 8.18.2, with pnpm peer-snapshot propagation. It adds
sanitized `audio-smoke-results.json` evidence and `HANDOFF.md`. Starter scenarios,
AGENTS.md, and the pre-existing deleted agent test / backups remain untouched by
the checkpoint. The original seven coordinator tests retain their logic but were
reformatted in the initial spike. Work is on `feat/fastfloor-livekit-integration-spike`;
`a3a834b` contains the integration, followed by this dependency/audio checkpoint.
No push was made; the user will push.

### Approved incidental formatting

The first formatter run used an absolute ignore file in `/tmp`. Slash-containing
ignore patterns resolved relative to that location rather than the project, so
Prettier also reformatted the following existing untracked files. The user explicitly
approved keeping these formatting-only changes rather than guessing at restoration:

- `src/fastfloor/turn-coordinator.ts` (in addition to its approved output seam)
- `src/fastfloor/turn-coordinator.test.ts` (same seven test behaviors)
- `src/fastfloor/abort-experiment.ts`
- `src/fastfloor/combined-experiment.ts`
- `src/fastfloor/coordinator-demo.ts`
- `src/fastfloor/experiment.ts`
- `src/fastfloor/state-experiment.ts`

## Proven

- Preflight can prepare a fake response without scheduling speech or synthesizing
  audio. Final STT text alone is not session commitment.
- Unchanged interim is not automatically treated as raw `TurnResumed`.
- Monday preflight -> Tuesday interim -> Tuesday commitment without another
  preflight cancels/invalidates Monday with the existing coordinator and prepares
  Tuesday using `onEager`/`prepare` at commitment. Exactly one Tuesday reply reaches
  the real SDK reply/TTS path; normal conversation history contains user + assistant.
- Stale/duplicate/failed preparations and contradictory/empty/actively-speaking
  commitment hooks fail closed. A provider result ignoring abort cannot escape the
  coordinator's existing generation-ID check.
- Invalidation while synthetic TTS waits to produce a frame cancels the SDK speech
  handle. Releasing that TTS later produces zero frames in the output sink.
- STT events retain object identity, ordering, and all unrelated usage/boundary
  events; STT errors still propagate. Consecutive turns and listener teardown work.

The TTS fixtures synthesize silent PCM, not human speech. Output-sink assertions
prove local SDK mechanics, not what a listener hears over the network.

## Verification commands and outcomes

Baseline:

- `pnpm run test`: 7/7 passed.
- `pnpm run typecheck`: passed.
- `pnpm run lint`: passed.
- `pnpm run format:check`: failed on eight pre-existing files (AGENTS.md and seven
  existing FastFloor files). They were not reformatted as part of this spike.

Integration:

- `pnpm run test`: 23/23 passed, including all seven original tests.
- `pnpm run typecheck`: passed using the project's actual tsconfig.
- `pnpm run lint`: passed.
- Supplemental test-file typecheck (the project tsconfig excludes test files):
  `pnpm exec tsc --noEmit --target ES2022 --module ES2022 --moduleResolution bundler --allowImportingTsExtensions --erasableSyntaxOnly --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess --noImplicitOverride --skipLibCheck --esModuleInterop src/fastfloor/livekit-flux-spike.test.ts src/fastfloor/livekit-flux-session.test.ts`
- `pnpm run format --ignore-path /tmp/fastfloor-spike-prettierignore`: passed, with
  the incidental formatting described above. The ignore file was then corrected to
  use basename patterns. A scoped formatting check passes; the ordinary repository
  formatting check still flags the pre-existing AGENTS.md changes.
- Extra dependency check `pnpm exec tsc --noEmit --skipLibCheck false`: initially
  failed because Agents 1.9.4 expects RTC `^1.1.0` and WebSocket typings were missing.
  It passes after the checkpoint's RTC 1.1.0 / `@types/ws` 8.18.2 fix. Agents and
  ai-coustics versions are unchanged; the existing OpenTelemetry peer warning remains.

Debugger smoke (text only):

- `FASTFLOOR_FLUX_SPIKE=1 lk agent debugger start src/main.ts --port 8786 --json`:
  booted into listening state, with no greeting.
- `lk agent debugger say 'book Tuesday' --port 8786 --timeout 15s --json`:
  intentionally silent; reported `agent produced no response items`. Text input
  bypasses the audio commitment hook; we do not invent commitment to make it reply.
- `lk agent debugger stop --port 8786 --json`, followed by `status`: stopped;
  status reports `running: false` (nonzero exit because there is no running session).

That text-only debugger run was not an audio test. The subsequent audio-mode debugger
run sent two generated utterances through hosted Flux and Fish Audio, producing one
fake response per turn after commitment. See `audio-smoke-results.json` for sanitized
results. No cloud simulation was run; the existing text scenarios exercise the
baseline, not this deliberately audio-commit-gated path.

## Remaining blockers and next step

1. Establish real Flux event ordering and provenance, especially resumption. There
   is no supported typed raw `TurnResumed` event or stable provider turn-ID mapping
   in the inspected STT interface. Do not infer it from every interim.
2. RTC peer-version skew is fixed and strict declaration checking passes. Browser
   room playback and broader telemetry/RPC behavior still require live verification.
3. Validate microphone/WebRTC playback and stale-buffer interruption. The generated
   debugger audio turns do not prove audible cancellation. Already-delivered audio
   cannot be retracted.
4. Exact-text matching currently rejects ambiguous multi-segment aggregates. That
   is intentional silence, not a supported aggregation policy.

Next recommended experiment: run
`FASTFLOOR_FLUX_SPIKE=1 pnpm dev --log-level DEBUG --no-reload` and connect through
Agent Console in an isolated test room. Capture preflight, changed interim, final,
commitment, and speech timing with non-sensitive phrases and the fake response provider.
Test normal endpointing and real resumption before any LLM speculation.

Stop here: no production speculative LLM, speculative tools, policy redesign,
coordinator rewrite, or additional phases belong to this spike.
