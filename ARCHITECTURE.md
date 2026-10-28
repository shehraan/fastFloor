# FastFloor architecture

## Scope: LiveKit/Flux integration spike

This is an opt-in mechanics experiment, not production LLM speculation. The working
voice-agent baseline remains the default. Set `FASTFLOOR_FLUX_SPIKE=1` to select the
experiment. No tools or production speculative model requests were added.
The checkpoint pins RTC to 1.1.0 and adds development-only WebSocket typings.

## Components and ownership

- `src/main.ts`: selects the baseline or the Flux spike. Baseline remains AssemblyAI,
  the LiveKit audio turn detector, preemptive generation, Fish Audio, expressive
  output, automatic keyterm detection, and the original greeting. Spike selects
  `inference.STT({ model: 'deepgram/flux-general-en', language: 'en', modelOptions:
{ eager_eot_threshold: 0.5 } })`, STT endpointing, and disables built-in
  preemptive generation, LLM-based keyterm detection, and the unsolicited greeting.
  The TTS model and output pipeline remain unchanged.
- `src/agent.ts`: retains the existing agent/instructions/configured LLM. An optional
  spike installs public `Agent.create` hooks. The spike's `llmNode` never delegates
  to the configured model. The SDK still requires an LLM object to schedule its
  normal pipeline; configuring it is not an inference request. SDK prewarming can
  still occur.
- `TurnCoordinator`: the original generation IDs, AbortController, commitment gate,
  and at-most-once publication remain authoritative. The only change is the
  user-approved optional synchronous publish callback, defaulting to the existing
  `console.log('Agent:', text)`. Its callback must not throw or re-enter the core.
  The seven original correctness tests retain the same logic. Prettier also
  reformatted the coordinator, original tests, and five existing experiments;
  retaining those incidental formatting-only changes was explicitly approved.
- `FluxIntegrationSpike`: observes the default STT node without mutating, filtering,
  duplicating, or separately consuming events. Associates a transcript and a fake
  task with the generation returned by the coordinator. Uses no second generation
  counter, cancellation controller, or turn state machine. Invalidations call
  `coordinator.onResumed()`; preparation calls `onEager()` and `prepare()`.
  Message IDs prevent duplicate commit callbacks; a one-shot transport claim
  prevents a released string from being read twice by `llmNode`.
- LiveKit: owns STT transport, endpointing, reply scheduling, normal TTS generation,
  speech handles, output buffering/interruption, and conversation history.

## Event mapping

| Observed signal                                      | Adapter action                                                                                                                                                                                                                                                          | Does it commit?                                             |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `PREFLIGHT_TRANSCRIPT`                               | Log; start fake preparation with `onEager()`/`prepare()` if no matching candidate. A different transcript first invalidates old work. Identical repeated preflights reuse the candidate.                                                                                | No                                                          |
| `INTERIM_TRANSCRIPT`                                 | Log. A different exact transcript calls `onResumed()`. An identical interim does not imply raw Flux `TurnResumed`.                                                                                                                                                      | No                                                          |
| `FINAL_TRANSCRIPT`                                   | Log. Changed text invalidates just like interim.                                                                                                                                                                                                                        | No                                                          |
| STT `START_OF_SPEECH`                                | Invalidate existing preparation/output and clear the latest transcript observation.                                                                                                                                                                                     | No                                                          |
| Session `UserStateChanged` to `speaking`             | Conservatively invalidate. Do not erase the latest STT observation: session state delivery can lag newer STT events.                                                                                                                                                    | No                                                          |
| STT `END_OF_SPEECH`, recognition usage, other events | Forward unchanged; SDK retains ownership.                                                                                                                                                                                                                               | No                                                          |
| `onUserTurnCompleted(ctx, chatCtx, newMessage)`      | Log `USER_TURN_COMMITTED` with SDK message ID. Validate exact text, use matching generation or prepare a fresh fake via existing coordinator methods, then call `onCommitted(generation)`. Await preparation; stop a superseded/failed hook with public `StopResponse`. | Yes, response authorization, not proof of persisted history |
| STT end/error/cancellation, agent exit/session close | Invalidate pending work and interrupt owned SDK speech handles; errors still propagate. Remove session listeners at exit/close.                                                                                                                                         | No                                                          |

Logs include transcript text and are intentionally opt-in. They are ordinary local
console logs, not redaction-aware production telemetry. Do not use with sensitive
live conversations without a logging/redaction policy.

## Output path and safety boundary

    default STT -> transparent observer -> LiveKit recognition/endpointing
                       |
                       +-> existing coordinator prepares fake string privately

    onUserTurnCompleted -> coordinator.onCommitted(generation)
        -> coordinator publish callback releases text in memory
        -> SDK schedules its one normal reply
        -> custom llmNode yields the matching, released string once
        -> existing SDK TTS/output/history pipeline

There is no `say()` or extra `generateReply()` inside the adapter. Overriding
`llmNode` avoids a second default model response and retains normal user/assistant
history. Built-in preemptive generation is disabled only in spike mode, since the
custom node must not run before our commit hook authorizes the generation.

A transcript change clears the adapter's released reference through coordinator
invalidation. SDK `SpeechCreated` handles are tracked and interrupted with the
public `handle.interrupt(true)` API, covering text already handed to the SDK and
TTS waiting to emit audio. The callback itself never starts TTS or plays audio.

## Evidence

- Baseline: `pnpm run test` passed all seven original tests;
  `pnpm run typecheck` and `pnpm run lint` passed before integration edits.
- Integration verification: actual installed `Agent.create`, default STT node,
  `SpeechStream`, `AgentSession`, endpointing, commitment hook, reply pipeline,
  conversation history, and `SpeechHandle` were exercised without private APIs.
  Only provider transport/model output and the output device are scripted.
- Monday preflight -> Tuesday interim -> Tuesday final/commit with no second
  preflight produces exactly one Tuesday reply and no Monday reply. The direct
  hook test additionally verifies `onResumed()` and the aborted coordinator signal.
- There are zero synthetic TTS calls/output frames before commitment. A successful
  committed reply produces one synthetic frame in an in-memory sink. Invalidation
  while synthetic TTS is delayed produces zero sink frames after release.
- Additional tests cover equal interim/preflight deduplication, final not being
  commitment, stale completion ignoring abort, invalidation during a pending
  commitment, preparation failure, empty/contradictory commitment, repeated words,
  STT failure, consecutive turns, and listener cleanup.
- The tests above provide deterministic mechanics evidence, not acoustic safety.
- The subsequent checkpoint exercised two sequential generated-speech turns through
  real hosted Flux and Fish Audio using the audio debugger. Each logged interim,
  preflight, final, and session commitment, then one fake reply and one speech handle.
  Commitment preceded TTS-task and speech-start logs. Sanitized evidence is in
  `spikes/001-livekit-flux/audio-smoke-results.json`. Physical microphone, WebRTC,
  same-turn resumption, audible interruption, and latency improvement remain unverified.

## Installed API verification and references

`package.json` declares agents `^1.9.3`; `pnpm-lock.yaml` and the actual installed
package resolve `@livekit/agents` **1.9.4**. The checkpoint updates RTC from
**0.13.35** to **1.1.0**, satisfying the Agents and ai-coustics peers. Inspected source:

- `node_modules/@livekit/agents/src/inference/stt.ts`: Flux model/options, normalized
  `preflight_transcript`/interim/final conversion, `SpeechData.metadata` passthrough.
- `src/stt/stt.ts` in that package: supported `SpeechEventType` members. No typed
  `TurnResumed` event exists on this interface.
- `src/voice/agent_v2.ts`: `Agent.create` hook signatures and async iterable adapters.
- `src/voice/agent_activity.ts`: commitment hook precedes default reply generation;
  `StopResponse` suppresses a reply; normal reply invokes custom `llmNode`.
- `src/voice/speech_handle.ts`: public forced interruption signature.

Current docs were fetched with LiveKit CLI **2.19.2** after running `lk docs`:

- https://docs.livekit.io/agents/logic/nodes/
- https://docs.livekit.io/agents/models/stt/deepgram/
- https://docs.livekit.io/agents/logic/turns/
- https://docs.livekit.io/testing/unit-tests/
- https://docs.livekit.io/testing/simulations/

## Known limitations / remaining blockers

1. The public normalized STT events do not provide a documented, typed raw Flux
   `TurnResumed`/provider turn-ID contract. `requestId` can be a session ID and is
   not treated as a turn ID. Arbitrarily reordered identical-text provider turns
   cannot be disambiguated from text alone. Do not promote to production until
   live event ordering and provenance have been established.
2. Matching is deliberately exact. Punctuation/case/whitespace changes invalidate
   work. A committed aggregate of multiple STT segments that differs from the last
   observed segment fails closed (silence), rather than guessing concatenation.
   A contradictory late hook, or a hook while the SDK still reports the user as
   speaking, also fails closed. This sacrifices recall for safety.
3. A delayed session speaking notification can discard useful speculation. This is
   safe but may waste preflight work. Default fake preparation is immediate; a
   forever-pending fake/provider that ignores abort could block the serialized SDK
   commitment hook. No new timeout/cancellation policy was added to the core.
4. SDK interruption can clear pending local output, but cannot retract frames that
   have already left the output device/network. Live resumption, downstream buffer
   timing, VAD/adaptive interruption interactions, and actual audible behavior remain
   unverified. The experiment is not an end-to-end acoustic safety guarantee.
5. Text debugger/simulation inputs bypass the audio commitment hook in this SDK.
   The spike intentionally stays silent rather than treating a programmatic
   `generateReply` as user commitment. Existing starter text scenarios were left
   unchanged; they do not validate this audio-path spike. No cloud simulation was run.
6. `committedMessages` retains message IDs for one session. Instantiate one adapter
   per session; no long-lived retention/eviction design is included.
7. RTC compatibility is resolved at checkpoint: RTC 1.1.0 and `@types/ws` 8.18.2
   make `pnpm exec tsc --noEmit --skipLibCheck false` pass without suppressing
   declaration errors. The existing OpenTelemetry peer-range warning is unchanged;
   real room/telemetry compatibility is not comprehensively validated.

Next: follow `HANDOFF.md` for microphone/WebRTC and same-turn resumption testing
with fake responses only. Normal sequential hosted-audio traces are recorded, but
do not establish interruption safety. Do not start production LLM speculation yet.
