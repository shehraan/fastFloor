# FastFloor architecture

## Final packaging — October 28, 2026

The runtime is feature-complete for this demo and frozen. Start with the root
[README](README.md) for the architecture diagram, mode commands, measurement
boundaries, and evidence index; [DEMO.md](DEMO.md) is the 60–90-second checklist.
The sections below are chronological engineering records, not new shipping tasks.

Final developer-reported microphone testing succeeded overall: multi-turn context,
corrections, interruptions, and Boardy mode's real `find_people` call returning
fictional Maya Chen, followed by an offer to help draft an introduction. These are
manual observations, not additional timestamped benchmark samples. One isolated
missed-speech instance after an agent response remains unconfirmed and undiagnosed.
It is not attributed to the earlier reproduced history-loss defects.

The measured result remains SDK commitment → SDK console playback p50
1016.374 ms baseline / 474.035 ms FastFloor, ten post-fix samples per arm. Caller
acoustic onset/yield metrics, leakage bounds, and production speedup are unverified.
Networking remains opt-in, committed-only, and non-speculative; it performs no
real introductions or writes. No provider, endpointing, coordinator, cancellation
policy, runtime source, dependency, or executable-test changes belong to packaging.

Packaging retains reviewed fictional benchmark inputs/results while excluding
local learning exercises, recordings, credentials, and machine-specific diagnostic
logs/test-runner dumps. Raw measurement artifacts are not reformatted. The existing
comment-only starter test placeholder is omitted; all 65 executable tests remain.
CI runs the actual offline suite with the committed lockfile; the starter-only
workflow rejecting that lockfile is removed. Local tutoring edits stay untouched.

## Real-audio verification phase — October 28, 2026

See `spikes/002-history-evaluation/REAL_AUDIO_VERIFICATION.md` for raw artifact
locations, measurement definitions, failure evidence, and exact manual tests.

- Actual generated caller speech exercised hosted Flux → Gemma → Fish → LiveKit
  CLI console output, not scripted STT/silent TTS. A separate original-default
  AssemblyAI agent audio smoke passed. Room/WebRTC and client audible onset remain
  unverified: both audio-simulation arms captured zero conversational turns.
- A real long utterance exposed a second history-loss path: the SDK committed an
  observed final after a newer interim arrived. The early rejected-hook branch
  raised `StopResponse` without retaining that input. The adapter now reuses the
  existing history recovery only when the SDK message exactly equals the observed
  final aggregate. Reply suppression, coordinator and cancellation policy stay
  unchanged. Unproven hypotheses/truncated/invented aggregates are not retained.
- Fresh post-fix ABBA console audio: ten utterances/commitments/playback samples per
  arm. Commit → SDK output p50/p95: baseline 1016.374/1778.332 ms; FastFloor
  474.035/997.356 ms. Nearest-rank p95 is the maximum of ten samples, not a production
  tail estimate. FastFloor reused nine candidates; two were rolled back. No SDK
  before-commit or unattributed playback events occurred. No acoustic claim follows.
- Full-response first-delta → completion wait: baseline p50/max 127.109/318.241 ms;
  FastFloor 139.932/411.005 ms. Post-commit exposed wait was 127.109/318.241 versus
  0/370.828 ms. These are observed buffer intervals, not a streaming counterfactual.
  Full buffering remains: private/error-rejecting output simplicity was preserved.
- All original sixty tests plus five focused regressions pass (65 total), as do
  typecheck, lint, declaration checks and supplemental strict test/runner types.
  No baseline, provider, endpointing, tool policy, dependency or coordinator changes.
  Physical interruption/leakage and caller-side measurements still need the manual
  checks. Stop after this phase; no final packaging, commit or push.

## Current phase — history correctness, matched evaluation, fictional networking

This section supersedes Prompt 2's history and deferred-evaluation limitations
below; those sections remain the historical integration record. Detailed commands,
metric definitions and evidence are in `spikes/002-history-evaluation/README.md`.

### History boundary: accepted input must outlive a cancelled reply

A real-SDK failing regression reproduced committed input loss. Final STT text and
the first model request contained the original location. When resumed speech
cancelled generation while the commit hook awaited its result, `StopResponse`
prevented the SDK from persisting that user message. The next request contained
only the correction and recall question. A second city pair reproduced the same
failure. This is a confirmed integration bug; the original live call lacks a trace
and cannot be retrospectively attributed with certainty.

After a provenance-validated commitment, if preparation fails or is superseded,
the adapter retains that exact SDK message by ID in current agent context and
session history using public APIs before raising `StopResponse`. It never persists
preflight hypotheses or stale assistant output. Normal successful turns remain
SDK-owned. Recovery does not emit `ConversationItemAdded`; the adapter instead
logs `COMMITTED_INPUT_RETAINED`. Regressions verify both histories and subsequent
actual LLM request context, once and in order. The coordinator and its seven tests
are unchanged. No prompt rule or location-specific fix was added.

A hosted text-debugger sample with full history recalled the original New York
destination correctly after Boston. This distinguishes one model semantic success
from the reproduced integration loss; it does not rule out model errors generally.

### Evaluation components and ownership

- `src/main.ts`: explicit `FASTFLOOR_EVAL_ARM=baseline|fastfloor` selects matched
  Flux/Gemma/Fish pipelines with identical instructions, endpointing defaults,
  disabled SDK preemption and full-response buffering. Only preflight preparation
  differs. Original default baseline, fake mode and real voice mode remain available.
- `FluxIntegrationSpike`: optional preflight enablement; logs STT boundaries,
  accepted commitment/coordinator input, generation, exact public `LLM.chat()`
  context, first text delta, completion, release, transport reuse and rollbacks.
  The public stream iterator replaces `collect()` only to timestamp deltas, retaining
  text trimming, error rejection, zero speculative tools and existing abort binding.
  Its TTS wrapper forwards the default SDK node unchanged while timestamping invocation
  and first synthesized frame.
  SDK stream observers use an explicit iterator `return()` that cancels the upstream
  reader immediately, even while `next()` waits on a stalled provider. Async-generator
  wrappers delayed that cancellation; focused failing-then-passing tests cover TTS,
  committed LLM and the same STT seam. Frame identity, first-frame-once, stream errors
  and reader cleanup are tested. This is adapter plumbing, not a new coordinator or
  cancellation policy.
- `src/fastfloor/evaluation.ts`: opt-in JSONL timestamps (wall and monotonic),
  session IDs, SDK history/playback listeners and per-run summary. SDK output events
  are never labelled physical audible onset. Playback events lacking an unambiguous
  public SpeechHandle association remain unattributed. Retained transcript/request
  data and synchronous disk I/O are local experimental telemetry, not production logging.
- `scripts/summarize-traces.ts`: validates and exports JSONL or SDK result files,
  keeps session clocks separate, reports incomplete turns, reuse, rollbacks,
  premature SDK playback, and configuration parity. Missing audio measurements stay null.
- Existing SDK-session tests double as a reproducible matched harness. Two arm orders
  exercise stable/corrected turns with either scripted transport or actual configured
  hosted Gemma. Input event scheduling and silent-PCM output are explicitly fixtures.

Response latency is commitment to first SDK playback event. First text delta,
TTS first frame and SDK playback are distinct stages. Actual remote audible onset,
semantic premature responses and downstream acoustic cancellation require manual
client measurement. Reuse means a preflight candidate claimed by the output node;
rollback means invalidation before claim, not a measured token/dollar cost.

Executed hosted-LLM harness evidence: four samples per arm, scripted STT and silent
TTS/in-memory output. Nearest-rank commit-to-SDK-playback p50/p95 were 703.736/1075.490 ms
for baseline and 301.820/611.519 ms for FastFloor. FastFloor reused two preflight
candidates and rolled back two; both arms had zero premature SDK playback events.
This tiny, cold-start/model/network-confounded sample is not evidence of a live
voice speedup. Raw per-turn timestamps are exported in `hosted-llm-results.json`.

### Fictional networking reference workload

`FASTFLOOR_BOARDY=1` adds 18 frozen fictional profiles and one read-only
`find_people` tool in `src/fastfloor/people.ts`. Structured city/role/topic filters
intersect; parameters and result bounds are validated, results copied, and no
matches explicit. The model—not phrase-matching application code—retains and
revises semantic preferences from SDK user/assistant/tool history.

For this tool-enabled workload, both arms disable all speculative preparation.
After validated audio commitment the adapter delegates to the ordinary SDK tool
loop; the SDK owns tool execution, subsequent LLM steps, history and output.
Consequential tools are absent. No speculative-tool-policy engine or coordinator
redesign was implemented. Combining committed-tool delegation with fake mode is
rejected rather than calling a real model from fake mode.

Deterministic SDK tests and an actual hosted-Gemma run verified New York robotics
founder search followed by “Boston instead”: the real tool returned Leo Navarro,
then Maya Chen, retaining role/topic constraints and both tool results in history.
These are fictional directory fixtures, not actual people or introductions.
Scenario userdata selects this workload for text simulations; those deliberately
use the normal SDK semantic path, not fabricated audio commitment. Existing merge-to-main
simulation CI includes the new scenarios. Local cloud execution was blocked by
missing CLI project credentials, as was hosted audio-debugger startup. Agent-level
model credentials worked independently; no secrets were printed or reconfigured.

### Current limitations and stopping point

The original microphone case and actual acoustic onset/interruption still require
live retesting. The matched control intentionally buffers full responses like
FastFloor, not like the original streaming SDK baseline. Networking is committed-only
and claims no speculative lookup benefit. Endpointing is not delayed or retuned.
No dashboard, dependencies, coordinator changes, commit or push belong to this phase.

## Scope: Prompt 2 — real speculative LLM integration

The working voice-agent baseline remains the default. `FASTFLOOR_REAL_LLM=1`
selects Flux with real speculative generation using the existing configured
`inference.LLM({ model: 'google/gemma-4-31b-it' })`. The old
`FASTFLOOR_FLUX_SPIKE=1` still selects fake preparation, provided the real flag is
unset or `0`. Real mode takes precedence if both flags are `1`. No dependencies,
tools, UI, endpointing delays, or TurnCoordinator changes were added in Prompt 2.
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
  adapter installs public `Agent.create` hooks. Its `llmNode` only yields already
  prepared, coordinator-released text; it never issues a second model request.
  Real preparation calls the same agent LLM's public `chat()` / `collect()` APIs
  privately, outside the audible pipeline. Fake preparation never calls the model.
- `TurnCoordinator`: the original generation IDs, AbortController, commitment gate,
  and at-most-once publication remain authoritative. The only change is the
  user-approved optional synchronous publish callback, defaulting to the existing
  `console.log('Agent:', text)`. Its callback must not throw or re-enter the core.
  The seven original correctness tests retain the same logic. Prettier also
  reformatted the coordinator, original tests, and five existing experiments;
  retaining those incidental formatting-only changes was explicitly approved.
- `FluxIntegrationSpike`: observes the default STT node without mutating, filtering,
  duplicating, or separately consuming events. Associates a transcript and a preparation
  task with the generation returned by the coordinator. Uses no second generation
  counter, cancellation controller, or turn state machine. Invalidations call
  `coordinator.onResumed()`; preparation calls `onEager()` and `prepare()`.
  Message IDs prevent duplicate commit callbacks; a one-shot transport claim
  prevents a released string from being read twice by `llmNode`.
- LiveKit: owns STT transport, endpointing, reply scheduling, normal TTS generation,
  speech handles, output buffering/interruption, and conversation history.

### Real preparation and complete-turn fallback

Input: preflight text and a copy of `agent.chatCtx`, including system instructions
and prior user/assistant messages. Output: a complete private text string, never
streamed to TTS. The request advertises zero tools and sets `toolChoice: 'none'`;
unexpected tool calls and empty replies fail closed. Session LLM connection options
are retained. The coordinator's existing AbortSignal closes the SDK stream; the
adapter adds no cancellation controller, generation counter, or timeout policy.
Abort listeners and model-error listeners are removed on every completion path.

`collect()` in installed Agents 1.9.4 can return partial text after emitting a model
error. The adapter observes that public event and rejects the entire candidate,
including partial text. Because model error events have no request IDs, an error on
the same LLM during overlapping old/new requests conservatively rejects active
preparation. It can cause silence, never authorization of stale output.

At commitment the SDK supplies prior context separately from `newMessage`. The
adapter uses `newMessage.textContent` verbatim as the current user turn, appending
it once to a private context copy. It never rewrites or manually persists session
history. A serialized history key captured at preflight must still match the hook's
history before speculation can be reused; otherwise it regenerates through the
same coordinator methods with the committed context.

The adapter records ordered, nonempty final segments only to validate a committed
aggregate against installed SDK joining (`segments.join(' ').trimStart()`). It does
not use that aggregate as a replacement message or guess segment overlap. After
any final, later preflights skip speculation; a second final invalidates an earlier
candidate even if its text repeats. Multiple finals must exactly match the SDK
commit and the latest observed transcript event must be final. Truncated,
contradictory, or ambiguous commits fail closed. Observations survive raw
`START_OF_SPEECH` within an uncommitted turn, then reset at the commitment hook;
pending preparations/output are still invalidated immediately on speech start.

Thus “I want to book a flight” + “to Boston on Tuesday” discards partial speculation
and generates freshly from “I want to book a flight to Boston on Tuesday”. The SDK
continues to own the authoritative turn boundary and conversation history.

## Event mapping

| Observed signal                                      | Adapter action                                                                                                                                                                                                                                                                                               | Does it commit?                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `PREFLIGHT_TRANSCRIPT`                               | Log; start private fake/real preparation with `onEager()`/`prepare()` if no prior final segments. Changed text invalidates old work. Identical repeated preflights reuse the candidate.                                                                                                                      | No                                                          |
| `INTERIM_TRANSCRIPT`                                 | Log. A different exact transcript calls `onResumed()`. An identical interim does not imply raw Flux `TurnResumed`.                                                                                                                                                                                           | No                                                          |
| `FINAL_TRANSCRIPT`                                   | Log and record the segment for aggregate validation. Changed text or an additional final invalidates preparation.                                                                                                                                                                                            | No                                                          |
| STT `START_OF_SPEECH`                                | Invalidate existing preparation/output and clear the latest transcript observation.                                                                                                                                                                                                                          | No                                                          |
| Session `UserStateChanged` to `speaking`             | Conservatively invalidate. Do not erase the latest STT observation: session state delivery can lag newer STT events.                                                                                                                                                                                         | No                                                          |
| STT `END_OF_SPEECH`, recognition usage, other events | Forward unchanged; SDK retains ownership.                                                                                                                                                                                                                                                                    | No                                                          |
| `onUserTurnCompleted(ctx, chatCtx, newMessage)`      | Log `USER_TURN_COMMITTED` with SDK message ID. Validate exact text/aggregate and history, reuse matching generation or prepare fresh fake/real output from the complete committed message, then call `onCommitted(generation)`. Await preparation; stop a superseded/failed hook with public `StopResponse`. | Yes, response authorization, not proof of persisted history |
| STT end/error/cancellation, agent exit/session close | Invalidate pending work and interrupt owned SDK speech handles; errors still propagate. Remove session listeners at exit/close.                                                                                                                                                                              | No                                                          |

Logs include transcript text and are intentionally opt-in. They are ordinary local
console logs, not redaction-aware production telemetry. Do not use with sensitive
live conversations without a logging/redaction policy.

## Output path and safety boundary

    default STT -> transparent observer -> LiveKit recognition/endpointing
                       |
                       +-> existing coordinator prepares fake/real string privately

    onUserTurnCompleted -> coordinator.onCommitted(generation)
        -> coordinator publish callback releases text in memory
        -> SDK schedules its one normal reply
        -> custom llmNode checks message ID/text and yields released text once
        -> existing SDK TTS/output/history pipeline

There is no `say()` or extra `generateReply()` inside the adapter. Overriding
`llmNode` avoids a second default model response and retains normal user/assistant
history. Built-in preemptive generation is disabled only in spike mode, since the
custom node must not run before our commit hook authorizes the generation.

A transcript change clears the adapter's released reference through coordinator
invalidation. SDK `SpeechCreated` handles are tracked and interrupted with the
public `handle.interrupt(true)` API, covering text already handed to the SDK and
TTS waiting to emit audio. The callback itself never starts TTS or plays audio.

## Phase 1 checkpoint evidence

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
- `src/llm/llm.ts`: public `chat`, `collect`, `close`, error events, and cancellation
  unblocking the stream iterator. `ChatContext.copy()` isolates the item list;
  item objects are SDK-managed and must not be mutated in place during preparation.
- `src/voice/audio_recognition.ts`: final-segment aggregation and SDK commitment.

Current docs were fetched with LiveKit CLI **2.19.2** after running `lk docs`:

- https://docs.livekit.io/agents/logic/nodes/
- https://docs.livekit.io/agents/logic/chat-context/
- https://docs.livekit.io/agents/models/llm/
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
   work. Ordered multi-final aggregates now use complete committed-message fallback
   as described above. Unexplained aggregates, contradictory late hooks, or hooks
   while the SDK still reports the user as speaking fail closed. Provider cumulative
   finals/duplicates are not heuristically deduplicated or corrected; SDK transcript
   quality and ordering remain authoritative limitations.
3. A delayed session speaking notification can discard useful speculation. This is
   safe but may waste preflight work. Real preparation connects the existing signal
   to SDK stream closure, unblocking collection on cancellation. A custom fake that
   ignores abort can still block the serialized hook. No new timeout/cancellation
   policy was added to the core. Real output waits for the full completion, not just
   the first token, which trades streaming latency for a simple private buffer.
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

8. Corrections after LiveKit commitment are new conversational input. Prompt 2 does
   not extend endpointing or merge across committed turns. A rejected hook raises
   `StopResponse`; in this SDK that user message is not persisted. Successful turns
   retain ordinary SDK-managed user/assistant history, including interruption state.
9. Standalone preparation receives the agent context, not the SDK's later per-reply
   expressive-markup injection. Voice instructions and TTS remain unchanged, but
   expressive style parity has not been verified.

## Prompt 2 verification and manual live-audio test

The pre-change checkout passed all 23 tests, typecheck, and lint. New deterministic
tests exercise real public `LLM`/`LLMStream` interfaces with scripted model output,
real STT/session/commit/reply plumbing, and an in-memory synthetic-audio sink. They
cover precommit silence, one-request speculative reuse, complete multi-segment
fallback, next-turn history, changed-history regeneration, provider partial failure,
empty/tool-bearing output, cancelled streams with late chunks, cancellation during
a pending committed request, delayed TTS interruption, ambiguous aggregate rejection,
and the output node's message ID/text guard. These prove SDK mechanics, not hosted
model quality or acoustic safety. No latency improvement is claimed.

Final local verification (after scoped formatting):

- `pnpm run test --reporter=json --outputFile=/tmp/fastfloor-prompt2-vitest.json`:
  **36 passed, 0 failed, 0 pending** across 3 files (7 coordinator, 15 adapter,
  14 SDK-session tests). All original 23 tests remain included.
- `pnpm run typecheck`: passed.
- `pnpm run lint`: passed.
- `pnpm exec tsc --noEmit --skipLibCheck false`: passed with SDK declarations.
- Supplemental strict typecheck of both adapter/session test files using the
  command recorded in the Phase 1 spike README: passed.
- `pnpm run format --ignore-path .fastfloor-phase2-formatignore`: passed; the
  temporary project-root whitelist limited formatting to this phase's eight changed
  files and was removed afterward. Explicit Prettier check of those files passed.
- Scoped `git diff --check` passed. Repository-wide `pnpm run format:check` and
  `git diff --check` flag the pre-existing edited `AGENTS.md`; it was left untouched.
- `git diff HEAD -- src/fastfloor/turn-coordinator.ts
src/fastfloor/turn-coordinator.test.ts` is empty: coordinator code and its seven
  original tests are unchanged in Prompt 2. No commit or push was made.

The audio debugger attempt with `FASTFLOOR_REAL_LLM=1` was blocked before startup:
`--audio ... needs project credentials: api-key is required`. Text debugger startup
reached listening; sending a turn returned `agent produced no response items`, as
expected because text input bypasses audio commitment. It was stopped and status
read back as `running: false`. No hosted real-model call or live microphone test was
verified in this phase. Starter text scenarios do not cover this audio-hook path
and were not altered or run as purported audio evidence. No evaluation phase ran.

From the project root, with existing credentials configured locally:

    FASTFLOOR_REAL_LLM=1 pnpm dev --log-level DEBUG --no-reload

Connect the `fastfloor` agent through Agent Console with microphone/headphones and
synthetic, nonsensitive phrases (the opt-in logs contain transcript text):

1. Say a short question. `PREPARATION_STARTED` with mode `real` may precede
   `USER_TURN_COMMITTED`, but there must be no early speech. `RESPONSE_RELEASED`
   must follow commitment. Expect exactly one assistant response.
2. Say a continuous long turn containing the flight request and destination/date.
   If Flux emits multiple finals before commitment, confirm the committed log
   contains the entire turn and fresh preparation uses that same complete text.
   Do not force a long pause that commits a separate turn.
3. Ask “What destination and day did I say?” on the next turn to check history.
4. Say “Monday—actually Tuesday” before commitment. Confirm the stale response is
   not spoken. Interrupt while generation is pending and while the reply is playing;
   verify no stale reply restarts and the next turn responds once.
5. Repeat with fake mode for regression:
   `FASTFLOOR_REAL_LLM=0 FASTFLOOR_FLUX_SPIKE=1 pnpm dev --log-level DEBUG --no-reload`.

An optional sequential hosted-audio check (not an interruption/microphone test) is:

    FASTFLOOR_REAL_LLM=1 lk agent debugger start src/main.ts --audio --port 8786 --json
    lk agent debugger say "I want to book a flight to Boston on Tuesday." --port 8786 --logs --json
    lk agent debugger say "What destination and day did I say?" --port 8786 --logs --json
    lk agent debugger stop --port 8786 --json

The CLI itself needs a configured LiveKit project for `--audio`, independently of
the agent's local environment loading. Do not paste credentials into chat.
Stop after this integration phase: Boardy tools and evaluation remain deferred.
