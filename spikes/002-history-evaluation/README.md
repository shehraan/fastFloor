# Evaluation and evidence

This directory contains reproducible checks for history correctness, matched
Baseline/FastFloor execution, and a fictional networking workload. Use the root
[README](../../README.md) for setup and runtime commands, and
[ARCHITECTURE.md](../../ARCHITECTURE.md) for the current design.

## Evidence index

- [`REAL_AUDIO_VERIFICATION.md`](REAL_AUDIO_VERIFICATION.md) defines the final
  hosted-audio benchmark, its limits, unsuccessful room attempts, and acoustic
  measurement procedures.
- [`real-audio/postfix-console/`](real-audio/postfix-console/),
  [`postfix-console-report.json`](real-audio/postfix-console-report.json), and
  [`measured-comparison.json`](real-audio/measured-comparison.json) contain the
  final four-session console-audio experiment: ten SDK playback samples per arm.
- [`real-audio/console/`](real-audio/console/) and
  [`console-report.json`](real-audio/console-report.json) preserve historical
  diagnostics, including the accepted-input history-loss failure. They are
  excluded from the headline benchmark.
- [`scripted-sdk-results.json`](scripted-sdk-results.json) exercises actual SDK
  wiring with scripted model/STT transports and silent synthetic audio.
- [`hosted-llm-results.json`](hosted-llm-results.json) uses the real hosted Gemma
  model with fixture STT/TTS. Its four output samples per arm are plumbing evidence,
  not hosted-audio latency measurements.
- [`boardy-hosted-results.json`](boardy-hosted-results.json) records hosted-model
  calls to the local read-only search tool, including a New York-to-Boston
  correction and retained tool history. STT/TTS remain fixtures.
- [`history-debugger-results.json`](history-debugger-results.json) contains one
  hosted text-only recall sample. It does not test audio commitment or cancellation.

Developer-reported microphone checks covered multi-turn context, corrections,
interruptions, and retrieval of fictional Maya Chen in Boston. These are
qualitative observations, not additional benchmark samples. One missed-speech
observation remains unconfirmed. Failed room simulations produced no conversational
turns and supply no caller-latency or acoustic-safety evidence.

## Matched comparison

`FASTFLOOR_EVAL_ARM=baseline` starts preparation at commitment.
`FASTFLOOR_EVAL_ARM=fastfloor` can start at an eligible preflight. Both run the same
implementation, model, voice, prompt, endpointing defaults, full-response buffer,
release gate, and output path. SDK preemptive generation is disabled in both.

This comparison isolates custom preflight preparation. The original default
AssemblyAI/SDK-turn-detector/streaming agent is a separate mode, not this control.
The [final benchmark](REAL_AUDIO_VERIFICATION.md#baseline-vs-fastfloor-benchmark)
uses real Flux/Gemma/Fish console audio. Historical diagnostics and fixture timings
are not pooled into it.

For manual comparison, use fresh sessions and run one arm at a time:

```sh
FASTFLOOR_EVAL_ARM=baseline FASTFLOOR_TRACE_PATH=/tmp/ff-baseline.jsonl pnpm dev --log-level DEBUG --no-reload
FASTFLOOR_EVAL_ARM=fastfloor FASTFLOOR_TRACE_PATH=/tmp/ff-fastfloor.jsonl pnpm dev --log-level DEBUG --no-reload
```

Alternate arm order and prefer replayed audio for waveform control. Keep
configuration and workload fixed. Save incomplete and silent turns as well as
successful responses.

## Metrics and tracing

`FASTFLOOR_TRACE_PATH` enables transcript/request-context capture and wall-clock
and monotonic timestamps. Use fictional input only and keep new captures outside
Git. Parent directories must exist. New files request mode 0600; the tracer does
not change permissions on existing files. Synchronous writes add overhead, and
there is no production redaction, retention, or write-failure isolation policy.

The report distinguishes these stages:

- First nonempty model text delta, not a provider-internal token timestamp.
- TTS node invocation and first synthesized frame, neither of which is playback.
- SDK playback associated with a committed user message.
- Caller-audible onset, which remains unmeasured and is represented as null.

Response latency is SDK commitment to the first associated SDK playback event.
The SDK playback event lacks a public speech ID; the tracer associates it only
when one scheduled, unfinished SpeechHandle can own it. Ambiguous events remain
unattributed.

Reuse counts a speculative candidate claimed by the output node. Rollback counts
invalidation before claim, not wasted tokens or cost. Failed commitments remain in
denominators; missing latency samples remain null. Percentiles use nearest rank.
Before-commit SDK playback is a mechanical observation, not proof of semantic
endpointing or absence of sound at a caller's speaker.

Export captures directly with Node to keep package-manager banners out of JSON:

```sh
node scripts/summarize-traces.ts /tmp/ff-baseline.jsonl /tmp/ff-fastfloor.jsonl > /tmp/ff-report.json
node scripts/summarize-traces.ts spikes/002-history-evaluation/hosted-llm-results.json
```

The report keeps session clocks separate, includes incomplete turns, and checks
captured configuration parity. It does not infer a production speedup.

## History and cancellation checks

The SDK-session regressions reproduce accepted input disappearing when a pending
reply is cancelled. Agents 1.9.4 can return from a `StopResponse` commitment hook
without persisting the user message. The adapter retains exact validated SDK input
by ID in both current agent context and session history before suppressing that
reply. It never persists preflight hypotheses or cancelled assistant output.

A separate regression covers an earlier final's commitment arriving after a newer
interim. History retention requires an exact observed-final aggregate; the
superseded reply remains suppressed. Tests inspect both public histories and the
next actual LLM request.

`COMMITTED_INPUT_RETAINED` identifies the explicit recovery path. To investigate a
missing detail, compare `FINAL_TRANSCRIPT`, `USER_TURN_COMMITTED`,
`COORDINATOR_COMMITTED`, and the actual `LLM_STARTED.context`. If the model receives
the full input but answers incorrectly, that is distinct from adapter history loss.

Additional real-hook regressions check that stalled STT, committed-LLM, and TTS
observers forward cancellation immediately. Controlled streams verify SDK wiring;
they do not establish hosted-provider cancellation timing or acoustic interruption
safety.

## Reproduce the harnesses

Run offline SDK mechanics from the project root:

```sh
FASTFLOOR_EVAL_OUTPUT=/tmp/ff-scripted.json pnpm eval:sdk
node scripts/summarize-traces.ts /tmp/ff-scripted.json > /tmp/ff-scripted-report.json
```

The scripted model delay and preflight lead are fixture inputs, not production
endpointing changes or voice-latency measurements.

Hosted-model checks require existing local credentials and incur inference costs:

```sh
FASTFLOOR_EVAL_HOSTED=1 FASTFLOOR_EVAL_OUTPUT=/tmp/ff-hosted.json pnpm eval:sdk
FASTFLOOR_EVAL_HOSTED=1 FASTFLOOR_BOARDY_OUTPUT=/tmp/ff-boardy.json pnpm test src/fastfloor/livekit-flux-session.test.ts -t 'read-only SDK'
```

These commands use real model requests with fixture STT/TTS. For hosted audio,
use the [audio runner and procedure](REAL_AUDIO_VERIFICATION.md#artifacts-and-reproduction).
The agent's dotenv loading and CLI project configuration are separate; the audio
runner loads `.env.local` into the CLI subprocess without printing credentials.

## Fictional networking workload

```sh
FASTFLOOR_BOARDY=1 FASTFLOOR_TRACE_PATH=/tmp/ff-boardy.jsonl pnpm dev --log-level DEBUG --no-reload
```

The directory contains 18 fictional profiles. `find_people` validates structured
city, role, topic, and limit filters; it intersects filters, returns copied results,
and reports no matches explicitly. The model interprets preferences and corrections
from SDK conversation/tool history.

All preparation is disabled in this workload, in both evaluation arms. After
validated audio commitment, the SDK runs the ordinary tool loop. The workload has
no send-introduction, scheduling, payment, or mutation tool. A draft-introduction
offer is not an introduction sent to a real person.

Text scenarios exercise recall, corrected search, no-match behavior, and the
no-introduction boundary through the ordinary SDK semantic path. The simulation
workflow runs on merges to `main` or manual dispatch with repository secrets.
Text simulations do not validate audio commitment, speculative cancellation, or
caller-audible behavior.

## Remaining measurements

- Caller-side onset and residual audio after interruption, with synchronized
  recordings and a stated detection threshold.
- Rollback-specific latency for corrections and interruptions.
- A matched comparison against an optimized streaming non-speculative pipeline.
- Working room-audio simulation coverage and a diagnosis of the existing
  zero-conversation attempts.

Keep raw failures and historical observations separate from final benchmark
samples. New private transcripts, recordings, credentials, and machine-specific
logs do not belong in the published evidence set.
