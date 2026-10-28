# Real-audio verification — October 28, 2026

## Final manual verification / publication note

After the instrumented phase below, the developer reported successful live
microphone testing of multi-turn conversation, corrections and interruptions.
Boardy mode also called `find_people`, retrieved fictional Maya Chen in Boston,
and offered help drafting an introduction. Those observations have no new acoustic
timing capture; they do not turn the SDK metrics into caller-audible measurements.
One isolated missed-speech observation after an agent response remains unconfirmed,
with no established cause or measured recurrence rate.

The following sections preserve the instrumented phase as historical evidence.
References to unperformed manual tests describe that earlier phase. The detailed
caller-side onset/yield measurements below remain outstanding. Final packaging is
documented in the root README and DEMO.md, without changing runtime behavior.
Machine-specific worker logs and generated test-runner dumps referenced below are
kept locally rather than in the publication tree; fictional raw traces, per-turn
CLI observations, simulation exports, and measurement reports remain reviewable.

## Result and boundary

Real generated caller speech traversed hosted Deepgram Flux → configured Gemma →
Fish Audio → LiveKit CLI console audio output in both matched arms. This is no
longer scripted STT or silent synthetic TTS. It is **not** room/WebRTC playback,
physical microphone listening, or client-perceived audible onset. The original
AssemblyAI/default streaming agent also completed a separate audio smoke turn.

The room audio simulations failed to capture conversational turns. Therefore
room playback, acoustic leakage, caller-perceived latency, and actual generation/
playback barge-in remain unverified. Do not treat the console metrics below as
those measurements, or the failed simulations as a successful safety test.

No packaging, commit, push, dependencies, provider changes, endpointing tuning,
coordinator changes, speculative tools, or streaming redesign were performed.

## Reproduced history bug and repair

The pre-fix real-audio evidence is `real-audio/console/3-fastfloor.jsonl`, with
CLI observations in `3-fastfloor-turn4.json` and the subsequent model contexts.
The important normalized event order was:

1. `FINAL_TRANSCRIPT`: the full Lisbon/Tuesday/two-room/hotel details.
2. New `START_OF_SPEECH` and `INTERIM_TRANSCRIPT`: “Please repeat the…”.
3. `USER_TURN_COMMITTED`: the earlier finalized details, exactly as observed.
4. No coordinator commitment, retained-input event, or persisted user message for
   that input. The hook rejected it because the latest transcript was now newer.
5. A second final/commit for “Please repeat…” received a reply denying that the
   caller had supplied rooms/hotel preferences. The next request lacked Lisbon.

This is established adapter history loss, not merely a model recall failure.
The SDK split one requested utterance into two commitments; the integration then
mistakenly coupled rejected reply authorization to rejected finalized history.

`FluxIntegrationSpike.committed()` still suppresses that superseded reply. Before
`StopResponse`, however, it now preserves the exact SDK message if its text equals
all observed final segments joined according to the existing SDK aggregate rule.
The existing public-agent/session history recovery was extracted into one helper
and reused. IDs deduplicate recovery. It does not accept an interim/preflight-only
hypothesis, a truncated aggregate, or invented text. It does not merge two SDK
turns, delay endpointing, permit stale speech, or change cancellation policy.

Two regressions were observed failing on missing retained history, one per arm.
The final regressions replay the event ordering through real SDK STT/session/
commit/reply interfaces, then verify both histories, no stale output, duplicate-ID
handling, and the next actual model request. Three negative cases verify that
unproven input is not retained. Provider transports are fixtures in these focused
regressions; they are not counted as audio-performance samples.

Post-fix fresh audio runs completed twenty requested utterances with correct
New York → Boston → original recall and Lisbon/Tuesday/two-room read-back. Exact
reoccurrence of the failing final/interim/hook ordering was not observed in that
post-fix audio set; the deterministic SDK regression establishes that repair.
The original sixty tests and TurnCoordinator source/tests remain intact.

## Matched experiment and measurements

Each set used four fresh sessions in baseline/FastFloor/FastFloor/baseline order,
five identical requested texts per session, ten requested utterances per arm.
Both used the unchanged assistant prompt, Gemma `google/gemma-4-31b-it`, Flux
`deepgram/flux-general-en` with `eager_eot_threshold: 0.5`, Fish `fishaudio/s2.1-pro`
and voice `fa4c9eb3dccc4806b382b40d61c6b10a`, STT endpointing with unchanged SDK
defaults, disabled SDK preemptive generation, and full-response buffering.
Only the custom preflight preparation setting differed. Configuration parity was
validated by the existing trace-report CLI in both sets.

Caller speech was generated afresh by CLI 2.19.2 for each requested text, so the
waveforms, pauses, recognized punctuation and response lengths were not identical.
This is a matched-text exploratory comparison, not controlled audio replay.
SDK 1.9.4 ran in a constrained one-CPU sandbox; cold starts, host contention,
provider/network variation and synchronous trace I/O are confounders. Some local
verification commands overlapped setup/early parts of capture sessions. These
samples do not establish production distributions or a causal acoustic speedup.

Commitment → first SDK console output playback event, milliseconds:

| Set        | Arm       | Requested | Commitments | Playback samples |      p50 |      p95 |
| ---------- | --------- | --------: | ----------: | ---------------: | -------: | -------: |
| Before fix | Baseline  |        10 |          10 |               10 | 1134.319 | 2082.084 |
| Before fix | FastFloor |        10 |          11 |               10 |  736.193 | 1300.684 |
| After fix  | Baseline  |        10 |          10 |               10 | 1016.374 | 1778.332 |
| After fix  | FastFloor |        10 |          10 |               10 |  474.035 |  997.356 |

Nearest-rank percentiles: with ten samples, p95 is just the maximum, not a reliable
estimate of a production tail. Do not pool pre-fix and post-fix sets. The pre-fix
FastFloor failure remains visible: eleven commitments, one missing output sample,
and a semantically incorrect later reply. It must not be hidden by its lower p50.

After the fix, FastFloor claimed nine speculative candidates and invalidated two
unclaimed candidates across eleven speculative preparations. Baseline had zero.
Both arms had zero SDK playback events before their associated commitment and
zero unattributed playback events. This does not establish no semantically early
endpointing or no audible leaked audio. All audible-onset fields remain null.

### What full-response buffering costs

Derived directly from post-fix trace timestamps, milliseconds:

| Trace interval                                         | Baseline p50 / max | FastFloor p50 / max |
| ------------------------------------------------------ | -----------------: | ------------------: |
| First text delta → complete LLM response               |  127.109 / 318.241 |   139.932 / 411.005 |
| Buffer wait still exposed after commitment/first delta |  127.109 / 318.241 |         0 / 370.828 |
| TTS node invocation → first synthesized frame          |  445.030 / 589.859 |   456.156 / 614.252 |

The second row is `max(0, completed - max(commit, firstDelta))`. It isolates the
observed complete-text wait still on the post-commit path, not a measured saving
from hypothetical streaming. A streaming TTS implementation may need a whole
sentence and has different scheduling; these intervals are not a counterfactual
first-audible response. Do not add marginal p50 values as if from one median turn.

Full buffering hides partial/erroring model output and keeps private speculative
text behind the existing release gate. Preparation often completes before commit,
hiding its wait in FastFloor; baseline cannot hide it this way. Fish synthesis is
still substantial. No clear low-risk streaming change was established, so buffering
was measured and retained rather than changing the architecture in this phase.
SDK `llmNodeTtft` for the released one-string transport is not the underlying
model's TTFT; use `LLM_STARTED` / `LLM_FIRST_TEXT_DELTA` instead.

## Room simulation attempts and unresolved setup

`audio-scenarios.yaml` is a separate opt-in set extending the existing history
scenario style; existing text CI scenarios were not changed. It requests ten-turn
history/correction coverage and a separate destination/stop barge-in conversation.
A simulator instruction to interrupt is not itself proof an interruption happened.

- Baseline run `SR_j5fV2qGsWGpu`: completed, two failed jobs, each reporting
  “agent under test went silent for 30s”; zero audio turns, empty metrics turns.
- FastFloor run `SR_JKzbzVikHxJ5`: both jobs report the same inactivity failure.
  The local command exceeded its four-minute timebox while finishing/summarizing;
  exported run status is cancelled. Zero audio turns and no caller-latency samples.
  This attempt also set `OMP_NUM_THREADS=1` / `OPENBLAS_NUM_THREADS=1`; it is not
  comparable latency evidence and did not solve the issue.

Workers registered, received jobs, connected rooms and subscribed to the caller
track. Logs also show an early `room session transport is closed` warning,
VAD slower-than-realtime warnings, event-loop/host stalls and runner timeouts.
No normalized STT/commitment events were recorded in either arm. The exact cause
of missing conversational audio is unresolved: do not assign it to the history
bug, claim a credential failure, or label it a confirmed SDK defect. Exports and
worker logs are retained. Diagnostic documentation feedback was submitted to
LiveKit. Workers/debuggers were stopped; no simulation work is intentionally left
running. Recheck exports rather than assuming a CLI timeout proves cloud shutdown.

## Artifacts and reproduction

All paths below are relative to `spikes/002-history-evaluation/`:

- `real-audio/console/`: pre-fix four-session raw JSONL, CLI turns/history and
  stopped-status results, including the failing long utterance. Do not overwrite.
- `real-audio/postfix-console/`: post-fix equivalent, twenty requested utterances.
- `real-audio/console-report.json`, `real-audio/postfix-console-report.json`:
  exports from the existing `scripts/summarize-traces.ts`.
- `real-audio/measured-comparison.json`: per-turn timings, arm-local nearest-rank
  percentiles, buffering intervals, incompleteness, and user-request history checks.
- `real-audio/simulation-*-export.json`, `*.stdout`, `*.stderr`, `*-worker.log`:
  failed room attempts, not performance evidence.
- `real-audio/default-*.json`: separate original-baseline real audio smoke; correct
  Lisbon/Tuesday reply and verified shutdown. Not part of the matched A/B sample.
- `real-audio/regression-red.json`, `regression-green.json`, `tests-final.json`:
  regression evidence and canonical test results. Filtered runs include skipped
  unrelated tests; only the full-suite result is a suite-completion claim.

Captures contain fictional prompts/transcripts and contexts. Exact configured
API key/secret values were scanned for without printing them; none were found in
these artifacts. Do not reuse this logging scheme for sensitive callers.
An earlier long capture command was killed with exit 137 and its temporary-directory
artifacts were lost when the sandbox reset. Its console observations are excluded
from every reported total. Captures were rerun in durable repository batches.

From the project root, with existing `.env.local` configured, run each session in
a separate invocation. This loads credentials into the CLI process without copying
or printing them, configuring a new account, or modifying the credential file:

    node --env-file=.env.local spikes/002-history-evaluation/run-audio-debugger.ts /tmp/ff-new-audio 1
    node --env-file=.env.local spikes/002-history-evaluation/run-audio-debugger.ts /tmp/ff-new-audio 2
    node --env-file=.env.local spikes/002-history-evaluation/run-audio-debugger.ts /tmp/ff-new-audio 3
    node --env-file=.env.local spikes/002-history-evaluation/run-audio-debugger.ts /tmp/ff-new-audio 4

Use a durable output path if the runtime may reset. The runner refuses an existing
session trace or occupied debugger port rather than appending measurements or
stopping another session. It uses port 8787 and verifies shutdown after each run.

Export with the existing CLI (direct `node` avoids package-manager banners):

    node scripts/summarize-traces.ts /tmp/ff-new-audio/1-baseline.jsonl /tmp/ff-new-audio/2-fastfloor.jsonl /tmp/ff-new-audio/3-fastfloor.jsonl /tmp/ff-new-audio/4-baseline.jsonl > /tmp/ff-new-audio/report.json

To retry cloud audio without shell-exporting credential values, use a fresh trace
path and one arm at a time (repeat with `FASTFLOOR_EVAL_ARM=fastfloor`):

    FASTFLOOR_EVAL_ARM=baseline FASTFLOOR_TRACE_PATH="$PWD/ff-room-baseline.jsonl" node --env-file=.env.local --input-type=module -e 'import { spawnSync } from "node:child_process"; const r = spawnSync("lk", process.argv.slice(1), { stdio: "inherit" }); process.exit(r.status ?? 1);' -- agent simulate audio src/main.ts --scenarios spikes/002-history-evaluation/audio-scenarios.yaml --concurrency 1 --yes

Do not retry indefinitely on this one-CPU sandbox. This command uploads the explicit
scenario descriptions for simulation, not source for scenario generation.

## Exact manual checks still required

Use Agent Console, a microphone/replayed recording, and headphones. Use synthetic
phrases only. Run one arm at a time in fresh sessions, alternating order:

    FASTFLOOR_EVAL_ARM=baseline FASTFLOOR_TRACE_PATH=/tmp/ff-mic-baseline.jsonl pnpm dev --log-level DEBUG --no-reload
    FASTFLOOR_EVAL_ARM=fastfloor FASTFLOOR_TRACE_PATH=/tmp/ff-mic-fastfloor.jsonl pnpm dev --log-level DEBUG --no-reload

1. Say the five exact utterances in `run-audio-debugger.ts`, twice per arm. Replay
   the same recording for better waveform/pausing control. Check New York as the
   original destination, Boston as current, then Lisbon/Tuesday/two rooms/quiet
   hotel near station. Inspect actual `LLM_STARTED.context`, not just the reply.
2. Deliver the long utterance continuously, then repeat with a natural pause before
   “Please repeat…”. Inspect all finals and SDK commitments. A split commitment
   is allowed. If the earlier final's hook arrives after a newer interim, expect
   `COMMITTED_INPUT_RETAINED`, no old reply, and both inputs in the next request.
3. Say “Monday—actually Tuesday” within one breath, before commitment. Confirm no
   Monday-only response plays. Verify the corrected final and authorized output;
   a correction after commitment is a new turn, not evidence of failed speculation.
4. Ask for a detailed neighborhood explanation. While logs show preparation pending
   but before output, say “Wait, Boston instead.” Confirm the old reply never starts,
   and later original-destination recall still sees New York in actual model context.
   If generation finishes before the interruption, that trial did not test this case.
5. Repeat while response audio is already audible: “Stop. Just tell me the current
   destination and day.” Check that speech yields, no old response restarts, and
   the next turn works once. Record residual audio/yield time at the caller; SDK
   cancellation alone is not an audible-leak test.
6. Send several consecutive short turns immediately after playback ends. Check one
   response per committed user message, no duplicate/restarted/stuck speech, and
   correct ordered history. Keep incomplete/silent turns in the report.
7. Capture caller loopback audio or working audio-simulation metrics. Measure caller
   speech end → first received non-silent agent audio separately from SDK commit →
   playback start. Record clock synchronization, threshold and network/device path.
   Distinguish negative caller gaps (overlap) from SDK before-commit playback.
8. As an original-baseline regression, clear all FastFloor flags and run `pnpm dev`.
   Confirm the normal greeting, reply, and interruption behavior still work.

Until these checks or working room audio simulations complete, do not claim a
real-room latency win, acoustic cancellation safety, or production readiness.
Stop here: final packaging is explicitly outside this phase.
