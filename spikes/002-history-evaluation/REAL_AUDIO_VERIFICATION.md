# Real-audio verification — October 28, 2026

## Baseline vs. FastFloor benchmark

Metric: SDK user-turn commitment → first associated SDK console-output playback
event. Only the final measurement set is used below. Both arms run the same
implementation: non-speculative Baseline starts preparation at commitment;
speculative FastFloor can start at preflight. This is not a comparison between
codebase versions, and the history repair is not the experimental variable.

| Metric                            |     Baseline |  FastFloor |
| --------------------------------- | -----------: | ---------: |
| Median SDK playback latency (p50) | 1,016.374 ms | 474.035 ms |
| p95 SDK playback latency          | 1,778.332 ms | 997.356 ms |
| Speculative candidates reused     |            0 |          9 |
| Rollbacks                         |            0 |          2 |
| Pre-commit SDK playback events    |            0 |          0 |

FastFloor achieved a **53.4% lower median commitment-to-first-SDK-playback latency**
in this exploratory comparison: `(1 - 474.035 / 1016.374) × 100`, rounded to one
decimal place. This is a descriptive difference between sample medians, not a
verified production latency improvement.

### Methodology and limits

- Real generated caller speech traversed hosted Deepgram Flux → Gemma → Fish Audio
  → LiveKit CLI console output. Four fresh sessions ran in
  Baseline/FastFloor/FastFloor/Baseline order, five matched requested texts each:
  **10 requested utterances, commitments, and playback samples per arm**.
- Identical model, voice, prompt, and endpointing configuration: Gemma
  `google/gemma-4-31b-it`, Flux `deepgram/flux-general-en` with
  `eager_eot_threshold: 0.5`, Fish `fishaudio/s2.1-pro`, voice
  `fa4c9eb3dccc4806b382b40d61c6b10a`, unchanged SDK STT endpointing defaults,
  disabled SDK preemption, and full-response buffering. Only custom preflight
  preparation differed; the trace-report CLI validated configuration parity.
  Baseline is this matched control, not the original streaming AssemblyAI agent.
- CLI 2.19.2 generated caller speech afresh. Requested text was matched, not
  identical prerecorded waveforms; pauses, punctuation and response lengths varied.
  SDK 1.9.4 ran on a constrained one-CPU host. Cold starts, host contention,
  provider/network variation, synchronous trace I/O, and overlapping local
  verification/setup work are confounders.
- Percentiles use nearest rank: **p95 with ten observations is the maximum**, not
  a reliable production-tail estimate. No verified production latency improvement
  or causal acoustic speedup is claimed.
- **SDK playback is not caller-perceived audible onset.** The experiment used
  console output, not measured room/WebRTC playback or a listener's speaker.
  Audible-onset fields remain null; room simulations captured no conversational
  turns and supply no caller-side metrics.

Reuse counts speculative candidates actually claimed by the output node.
Rollbacks count unclaimed candidates invalidated, not wasted tokens or dollars.
FastFloor made eleven speculative preparations; Baseline made none. Both arms had
zero unattributed playback events. Zero pre-commit SDK playback events is a
mechanical observation, not proof of semantic endpointing or acoustic leakage
safety. First model text, first synthesized frame, and SDK playback are distinct.

Final evidence: [raw traces](real-audio/postfix-console/),
[report](real-audio/postfix-console-report.json), and the `results.afterFix` entry
in [per-turn measurements](real-audio/measured-comparison.json). Existing filenames
and JSON keys are preserved; historical entries are excluded from this benchmark.

### What full-response buffering costs

Derived directly from the final benchmark trace timestamps, milliseconds:

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

## History correctness: separate debugging evidence

A historical audio capture reproduced accepted-input loss: Flux finalized the
Lisbon/Tuesday/hotel request, newer speech arrived, and the SDK commitment hook
then suppressed the earlier reply. Agents 1.9.4 returns before persisting input
when that hook raises `StopResponse`; the adapter had coupled reply suppression
to input loss. The next actual model context lacked the accepted details. See the
[raw trace](real-audio/console/3-fastfloor.jsonl) and
[CLI observation](real-audio/console/3-fastfloor-turn4.json).

The repair retains the exact provenance-validated SDK message by ID in both agent
and session history before `StopResponse`, while still suppressing the superseded
reply. It accepts only the observed final aggregate, not hypotheses, truncated or
invented text. It changes neither endpointing nor coordinator cancellation policy.
This is a correctness repair shared by both benchmark arms, not a latency feature.

[Deterministic SDK regressions](../../src/fastfloor/livekit-flux-session.test.ts)
replay the final/new-interim/commit ordering in both arms and verify both histories,
no stale output, duplicate-ID handling, and the next actual model request. Three
negative cases reject unproven input. Exact recurrence of this ordering was not
observed in the final audio capture; the controlled regression validates the repair.
These fixture-backed tests are not performance samples; all tests remain unchanged.

Historical measurements and the incomplete/incorrect trial remain available in
[`console-report.json`](real-audio/console-report.json) and `results.beforeFix` in
[`measured-comparison.json`](real-audio/measured-comparison.json). They are archived
debugging evidence, excluded from all headline metrics and never pooled with the
final experiment. No historical trace, regression test, or benchmark data was changed.

## Manual verification / publication note

The developer reported successful live microphone tests of multi-turn conversation,
corrections and interruptions. Boardy mode called `find_people`, retrieved fictional
Maya Chen in Boston, and offered help drafting an introduction. That opt-in workload
remains committed-only with all speculation disabled; no introduction is sent.
These qualitative observations add no acoustic timing samples. One isolated
missed-speech observation after an agent response remains unconfirmed and undiagnosed.

Caller-side onset/yield measurements remain outstanding. The original default
AssemblyAI/streaming agent passed a separate audio smoke turn, outside this
benchmark. Machine-specific worker logs/test-runner dumps referenced below remain
local-only; published fictional traces, CLI observations and exports are unchanged.

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

- `real-audio/postfix-console/`, `real-audio/postfix-console-report.json`: the final
  benchmark's four sessions/twenty utterances, raw JSONL, CLI turns/history, and
  report exported by `scripts/summarize-traces.ts`.
- `real-audio/console/`, `real-audio/console-report.json`: archived four-session
  debugging capture, including the failing long utterance and incomplete output.
  Excluded from headline results; preserved without overwriting or pooling.
- `real-audio/measured-comparison.json`: per-turn timings, arm-local nearest-rank
  percentiles, buffering intervals, incompleteness, and user-request history checks.
  `results.afterFix` is the final benchmark; `results.beforeFix` is historical only.
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
