# History correctness, matched A/B evaluation, and fictional networking workload

## Real-audio verification follow-up — October 28, 2026

Read [`REAL_AUDIO_VERIFICATION.md`](REAL_AUDIO_VERIFICATION.md) for this phase's
results, raw evidence, repaired finalized-input history loss, buffer measurements,
and exact manual tests. The older scripted-STT tables below remain historical.
Actual Flux/Gemma/Fish audio now ran over the CLI console transport in both arms,
with ten post-fix samples each. Room simulations failed before conversation;
client audible onset and real interruption/leakage are still unverified. No
synthetic-STT latency is promoted to real-audio performance.

## History finding

A deterministic real-SDK reproduction exposed an integration bug, not an STT
loss: a final transcript reached the SDK commitment hook and the first model
request, but disappeared from subsequent model context when new speech cancelled
the pending committed response. Agents 1.9.4 returns before persisting the user
message when the hook raises `StopResponse` (`agent_activity.ts`, around 3430–3450).
The adapter awaited generation in that hook, so reply cancellation also erased
accepted input. The regression failed for both New York → Boston and Lisbon → Oslo.

The adapter now retains the exact validated SDK message, using public
`agent.updateChatCtx()` and `session.history.insert()`, before stopping that reply.
IDs deduplicate the recovery. It copies current history, never a stale preflight
snapshot. It does not retain uncommitted hypotheses, cancelled assistant text, or
contradictory/ambiguous hook input. Ordinary successful persistence stays SDK-owned.
TurnCoordinator, its cancellation/generation semantics, and its seven tests are
unchanged. No destination-specific behavior was added to production code.

The recovery does not emit the SDK's `conversation_item_added` event: there is no
public persist-without-reply API emitting that event in the installed SDK.
`COMMITTED_INPUT_RETAINED` records this path; both public histories and the next
actual `LLM.chat()` context are checked by the regression.

A separate hosted-model text-debugger conversation correctly recalled New York
before a Boston correction with full context. This is one semantic sample, not a
proof that the model cannot make recall errors. The original microphone trace was
not available, so the reproduced cancellation bug cannot be definitively assigned
to that particular live call.

### Distinguishing the remaining causes

1. Check `FINAL_TRANSCRIPT` and `USER_TURN_COMMITTED`: if the original words never
   reach commitment, investigate provider transcription/turn boundaries. A preflight
   alone is not committed conversation history.
2. Check `COORDINATOR_COMMITTED`: this logs the exact accepted input/generation.
3. Check `LLM_STARTED.context`: this is the context actually handed to public
   `LLM.chat()`, not merely the agent's presumed history. Provider-specific wire
   serialization is not captured.
4. Check `COMMITTED_INPUT_RETAINED` and `SDK_HISTORY_ITEM_ADDED` against the next
   request. If full original/corrected input reaches the model but recall is wrong,
   that is a model/prompt-quality issue, not missing history in this adapter.

## Matched A/B arms

`FASTFLOOR_EVAL_ARM=baseline` means this adapter's non-speculative control: start
preparation only at commitment. `FASTFLOOR_EVAL_ARM=fastfloor` starts at preflight
when eligible. Both use Gemma `google/gemma-4-31b-it`, Flux with
`eager_eot_threshold: 0.5`, the identical prompt, Fish `fishaudio/s2.1-pro` and voice,
STT turn detection, unchanged SDK endpointing defaults, disabled SDK preemption,
and the same full-response buffer, release gate, and output path.

This isolates the value of preflight preparation. It is NOT a comparison against
the original default AssemblyAI/turn-detector/streaming agent, which remains
unchanged and selectable with no opt-in flags. It also does not claim full-buffer
FastFloor beats a streaming non-speculative SDK baseline.

For fictional, nonsensitive microphone tests, run each arm in a fresh session:

    FASTFLOOR_EVAL_ARM=baseline FASTFLOOR_TRACE_PATH=/tmp/ff-baseline.jsonl pnpm dev --log-level DEBUG --no-reload
    FASTFLOOR_EVAL_ARM=fastfloor FASTFLOOR_TRACE_PATH=/tmp/ff-fastfloor.jsonl pnpm dev --log-level DEBUG --no-reload

Stop one run before starting the other. Alternate baseline/FastFloor order; repeat
identical utterances (prefer replayed audio), corrections, long turns, and history
questions. Keep models, prompt, workload and endpointing identical. Save all runs,
including failures/silence, not just fast successful ones. The original fake mode
remains `FASTFLOOR_FLUX_SPIKE=1` without real/evaluation/workload flags.

### Traces and metric definitions

`FASTFLOOR_TRACE_PATH` enables JSONL with wall-clock ISO timestamps, per-session
UUIDs, and monotonic elapsed milliseconds. It contains transcript text, prompts,
request contexts, and directory results: use synthetic data only; do not commit
sensitive live traces. New files request mode 0600; existing file permissions are
not changed. Parent directories must exist. Synchronous trace I/O adds overhead;
instrument both arms consistently. There is no redaction or production retention
policy. Trace writing errors are not currently isolated from the opt-in experiment.

Events include STT start/end/interim/preflight/final, SDK commitment, coordinator
commitment/generation, LLM start/first nonempty text delta/completion, invalidation,
release/transport claim, TTS start/first frame, SDK playback start/finish, and SDK
history additions. First text delta is not a provider's internal token timestamp.
Negative commit-to-LLM times are legitimate speculative lead.

Response latency here means commitment → first SDK playback event. TTS start is
node invocation, not audio. TTS first frame is synthesis output, not playback.
SDK playback is a server/output-device event, NOT audible onset at the remote
listener's speaker. `audibleOnsetMs` and `prematureAudibleResponses` remain null.
A client-side synchronized recording/loopback measurement is required for those.
Before-commit SDK playback is a mechanical safety metric, not a semantic judgment
that endpointing waited until the person was actually finished.

Reuse counts preflight candidates actually claimed by the output node, not merely
selected in the commitment hook. Rollbacks count preflight candidates invalidated
before transport claim. These are candidate counts, not wasted tokens or dollars.
Silent/failed commitments remain in denominators; missing latency samples stay null.
Percentiles use nearest rank. The small sample sets are descriptive only.

The installed SDK does not attach a public speech ID to its playback event.
Correlation uses the sole scheduled, unfinished public SpeechHandle and its user
message; multiple possible handles leave the event unattributed. There is no
latest-turn guess, and the report exposes unattributed-event counts. Do not use
ambiguous interruption samples to claim acoustic safety.

Export saved traces or the SDK result files:

    pnpm eval:report /tmp/ff-baseline.jsonl /tmp/ff-fastfloor.jsonl > /tmp/ff-report.json
    pnpm eval:report spikes/002-history-evaluation/hosted-llm-results.json

The report validates records, separates session clocks, preserves incomplete turns,
and reports whether captured configurations match (ignoring arm/preflight enablement).
It does not infer an improvement or pool unrelated sessions into a speedup claim.

## Executed evidence and reproduction

`scripted-sdk-results.json`: real SDK STT/session/coordinator/reply/history plumbing;
scripted model transport (30 ms) and transcript events; silent PCM TTS and in-memory
sink. The 60 ms preflight lead is a fixture input schedule, not a runtime endpointing
delay. This proves mechanics, not voice latency.

`hosted-llm-results.json`: the same harness with the actual configured hosted Gemma
LLM and original assistant prompt. STT events and TTS/sink are still scripted.
Order is baseline/FastFloor then FastFloor/baseline, with stable/corrected turns in
each session. Only four output samples per arm; cold start, network/model variation,
and different completion lengths are confounders. No live improvement is claimed.

`boardy-hosted-results.json`: actual hosted model chose the real local read-only
tool for New York then Boston, retaining founder/robotics constraints. Model
requests, tool results, history, and timestamps are exported. STT and TTS are still
fixtures; this is not a microphone test or a simulation-judge result.

`history-debugger-results.json`: hosted text-debugger recall sample; no audio/STT.

Measured commitment → SDK playback event (milliseconds; nearest-rank percentiles):

| Harness      | Arm       | Samples |     p50 |      p95 | Reused | Rolled back | Before-commit playback |
| ------------ | --------- | ------: | ------: | -------: | -----: | ----------: | ---------------------: |
| Scripted LLM | Baseline  |       4 |  36.416 |   76.170 |      0 |           0 |                      0 |
| Scripted LLM | FastFloor |       4 |   4.353 |   36.154 |      2 |           2 |                      0 |
| Hosted Gemma | Baseline  |       4 | 703.736 | 1075.490 |      0 |           0 |                      0 |
| Hosted Gemma | FastFloor |       4 | 301.820 |  611.519 |      2 |           2 |                      0 |

Both harnesses use scripted STT and silent synthetic TTS/in-memory playback.
These are recorded fixture results, not microphone latency or estimated speedups.
The report CLI verified matching captured configurations for the hosted arms.

Run offline mechanics, optionally exporting JSON:

    FASTFLOOR_EVAL_OUTPUT=/tmp/ff-scripted.json pnpm eval:sdk

Run the same harness with the real model (billable, existing agent credentials):

    FASTFLOOR_EVAL_HOSTED=1 FASTFLOOR_EVAL_OUTPUT=/tmp/ff-hosted.json pnpm eval:sdk
    FASTFLOOR_EVAL_HOSTED=1 FASTFLOOR_BOARDY_OUTPUT=/tmp/ff-boardy.json pnpm test src/fastfloor/livekit-flux-session.test.ts -t 'read-only SDK'

The harness reads credentials through the existing dotenv setup without exporting
or printing them. Full hosted audio debugger and cloud simulations were attempted
but stopped before execution because the CLI project reports `api-key is required`.
The hosted model tests above use the agent's existing configuration independently.

## Minimal networking workload and safety boundary

    FASTFLOOR_BOARDY=1 FASTFLOOR_TRACE_PATH=/tmp/ff-boardy.jsonl pnpm dev --log-level DEBUG --no-reload

There are 18 frozen fictional profiles. `find_people` validates structured
city/role/topic/limit filters, intersects them with case-insensitive substring
matching, returns copies and explicit no-match results, and never writes anything.
Semantic interpretation and remembering/revising preferences belong to the model,
which receives ordinary SDK conversation history and prior tool results.

All preparation is disabled for this tool-enabled workload, in BOTH A/B arms.
After a provenance-validated audio commitment, the SDK owns the ordinary tool loop,
including subsequent LLM calls and history. This is a committed-only reference
workload, not speculative retrieval; no workload speedup is asserted. Only the
read-only search is registered. There are no send-introduction, booking, payment,
or mutation tools, and no speculative-tool-policy engine was added.

The scenario file adds original-preference recall, corrected networking search /
no-introduction, and no-match checks. Scenario userdata selects this workload;
text simulations deliberately use the ordinary SDK path to evaluate semantics,
never fabricated audio commitment. Existing CI runs the full scenario file on
merges to main. The audio adapter remains fail-closed for text-debugger input;
text simulations do not verify its cancellation or commit gate.

## Manual checks still required

Automated verification passed: all 60 tests (zero failed/skipped), project typecheck,
lint, scoped formatting, SDK declaration checks with `skipLibCheck: false`, and
explicit strict typechecking of the affected tests/report script (test files are
excluded from the project's ordinary typecheck). The debugger status was read back
as stopped after the text checks. Existing TurnCoordinator source/tests are unchanged.

Independent review identified a stalled-provider cancellation regression in the new
async-generator observers. SDK `toStream()` queues `iterator.return()` behind a pending
generator read; interruption therefore failed to reach the underlying provider until
another chunk arrived. The shared stream observer now implements `return()` directly,
calls the upstream reader's `cancel(reason)` immediately, and releases its lock on
cancellation, completion and errors. The same fix covers the existing STT observer.
Three real `Agent.create()`/hook-adapter regressions were observed red then green with
stalled default TTS, committed LLM and STT nodes. Focused TTS tests cover unchanged
frame forwarding, one first-frame timestamp, and error cleanup. The original STT
error-propagation contract is preserved. Evaluation artifacts above were regenerated
after this repair; the fixture's synthetic TTS still does not exercise hosted TTS or
establish acoustic interruption safety.

Follow-up independent review passed with no remaining established security or logic
defects. It reran 47 focused offline tests, typecheck and scoped diff checks. Direct
provider-close assertions using real default nodes with scripted provider transports
remain an optional coverage improvement; the stalled-node regressions exercise the
actual SDK hook adapter but replace the default nodes with controlled streams.

- Repeat the original-destination microphone test, including a correction after
  commitment but before the first reply, and confirm retained input in the next request.
- Check stable preflight reuse, same-turn corrections, long multi-final utterances,
  interruptions during generation and delayed/playing TTS, and fake-mode regression.
- Run both matched arms over repeated identical audio; capture client acoustic onset
  and premature/interrupted speech separately from SDK events.
- Run cloud scenarios once the CLI project is configured; verify no-match and
  no-introduction language with the hosted model, not only deterministic mechanics.
- Tool-enabled FastFloor intentionally does not speculate in this phase. Design
  any future speculative read-only lookup policy collaboratively before enabling it.
