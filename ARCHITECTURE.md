# FastFloor architecture

FastFloor adds speculative response preparation to a LiveKit Agents voice pipeline.
It can prepare text before a caller's turn ends, but it releases that text only
after LiveKit commits the turn. The integration separates response preparation,
permission to speak, and accepted conversation history.

The [README](README.md) covers setup, the architecture diagram, and measured results.
This document describes the current implementation and its tradeoffs. FastFloor is
an engineering prototype, not a production-ready service.

## Component responsibilities

- [`src/main.ts`](src/main.ts) selects the runtime mode and configures the session,
  providers, turn detection, and optional tracing.
- [`src/agent.ts`](src/agent.ts) supplies the agent instructions and configured LLM.
  It installs the adapter's public SDK hooks when a Flux mode is selected.
- [`TurnCoordinator`](src/fastfloor/turn-coordinator.ts) owns the generation ID,
  AbortController, prepared response, commitment state, and at-most-once release.
- [`FluxIntegrationSpike`](src/fastfloor/livekit-flux-spike.ts) observes STT events,
  validates committed input and context, prepares candidates, and passes released
  text to the normal SDK output pipeline. Its name reflects the integration's origin.
- [`EvaluationTrace`](src/fastfloor/evaluation.ts) records opt-in experimental events.
  [`scripts/summarize-traces.ts`](scripts/summarize-traces.ts) exports per-run reports.
- [`src/fastfloor/people.ts`](src/fastfloor/people.ts) contains the fictional directory
  and read-only search tool used by the separate networking workload.

LiveKit owns STT transport, endpointing, reply scheduling, tool execution, TTS,
speech handles, output buffering, and normal conversation history. FastFloor owns
candidate validity and release authorization. It does not replace endpointing or
start a second output pipeline.

## Runtime modes

Set one mode at a time, with other `FASTFLOOR_*` flags unset:

- No mode flag: the original AssemblyAI pipeline, SDK turn detector, preemptive
  generation, streaming model output, and greeting.
- `FASTFLOOR_EVAL_ARM=baseline`: Flux/Gemma/Fish with preparation starting only at
  commitment. This is the matched non-speculative control.
- `FASTFLOOR_EVAL_ARM=fastfloor`: the same pipeline, with eligible preflight
  preparation enabled.
- `FASTFLOOR_REAL_LLM=1`: real speculative preparation without selecting an
  explicit evaluation arm.
- `FASTFLOOR_FLUX_SPIKE=1`: the original fake-response integration experiment.
- `FASTFLOOR_BOARDY=1`: a committed-only fictional networking workload. All
  speculative preparation is disabled, regardless of the evaluation arm.

Flux modes use `deepgram/flux-general-en` with `eager_eot_threshold: 0.5`, STT turn
detection, Gemma `google/gemma-4-31b-it` for real preparation, and Fish
`fishaudio/s2.1-pro` output. They disable SDK preemptive generation, automatic
keyterm detection, and the unsolicited greeting. The matched arms use identical
prompt, voice, endpointing defaults, and full-response buffering.

Real mode takes precedence over the fake-response flag. An invalid evaluation arm
is rejected. Networking text simulations use the ordinary SDK semantic path; they
do not fabricate audio commitment.

## Preparation and release

1. A preflight transcript can start a candidate through `onEager()` and
   `prepare()`. The coordinator returns the generation ID and supplies the
   AbortSignal used by the producer.
2. Real preparation copies the current agent context and appends the candidate
   user text once. It calls the configured LLM with no tools and
   `toolChoice: 'none'`. The complete response stays private.
3. Changed text or resumed speech invalidates the generation. An old producer
   cannot release a late result, even if it ignores abort.
4. LiveKit calls `onUserTurnCompleted` with its prior context and complete
   `newMessage`. The adapter validates that input before authorizing a reply.
5. A candidate is reused only when its transcript and captured history still
   match. Otherwise, valid committed input starts fresh preparation through the
   same coordinator.
6. The coordinator releases text only when the generation is current, the turn is
   committed, preparation has completed, and that generation has not published.
7. The custom `llmNode` checks the user message ID and text, then claims the
   released response once. LiveKit sends it through its normal TTS/output/history
   pipeline.

There is no parallel `say()` or extra `generateReply()` call in the adapter.
Commitment can precede or follow preparation; both orderings use the same gate.
The coordinator's optional publish callback is synchronous and must not throw or
re-enter the coordinator.

Preparation rejects empty text, unexpected tool calls, and model error events,
including errors after partial text. Error events on the shared LLM lack request
IDs, so an overlapping request's error can conservatively reject an active
candidate. Abort closes the public LLM stream. Completion and cancellation remove
listeners rather than leaving them attached to the model.

## Transcript and commitment boundaries

Preflight and final STT events are not permission to speak. The SDK's complete
committed message is the model's current input, not the latest STT fragment.

The adapter records final segments to validate input provenance. For multiple
finals it checks the SDK message against `segments.join(' ').trimStart()` and
requires the latest transcript observation to be final. It does not guess segment
overlap, remove repeated words, or construct replacement user messages.
Multi-final turns discard partial speculation and prepare from the complete
validated commitment.

Transcript/history matching is exact. Punctuation, case, or whitespace changes can
reduce reuse. Contradictory or ambiguous commitments suppress the reply rather than
releasing a candidate with uncertain input. A correction after commitment is a new
user turn; FastFloor does not extend endpointing to merge it into an earlier turn.

The normalized SDK interface does not expose a typed raw Flux `TurnResumed` or
stable provider turn-ID contract. An identical interim transcript therefore does
not establish a resumed turn. A delayed SDK speaking-state notification can also
invalidate useful work without changing the accepted STT observation.

## Cancellation and output ownership

Invalidation increments the coordinator generation, aborts preparation, clears the
candidate, and interrupts tracked SDK speech handles with the public interruption
API. SDK output that has already left the device or network cannot be retracted.

The STT, committed-LLM, and TTS observers use an explicit async iterator whose
`return()` cancels its upstream reader immediately. This avoids waiting for a
stalled `next()` before forwarding cancellation. The observers preserve forwarded
values and errors and release the reader lock when they finish.

These are local cancellation mechanics. They do not establish an acoustic bound on
how much speech a remote caller can still hear after an interruption.

## History survives a cancelled reply

Accepted input and permission to reply are separate. In the integrated Agents
1.9.4 SDK, `StopResponse` from the commitment hook can suppress user-message
persistence as well as the reply.

When a validated committed preparation fails or is superseded, the adapter retains
the exact SDK message by ID in both the current agent context and session history
before stopping the reply. It uses `agent.updateChatCtx()` and
`session.history.insert()`, copies current history, and avoids duplicate IDs.
Normal successful turns keep SDK-managed persistence.

An earlier final's commitment can also arrive after a newer interim. In that case,
the adapter suppresses the superseded reply but retains the earlier input only if
it exactly matches the observed final aggregate. It never retains preflight
hypotheses, incomplete aggregates, invented input, or cancelled assistant text.

This recovery does not emit the normal SDK history-item event. The explicit
`COMMITTED_INPUT_RETAINED` trace records it. SDK-session regressions inspect both
histories and the next actual LLM request, not just the response text.

## Networking workload

The opt-in Boardy-inspired workload uses 18 fictional profiles and a read-only
`find_people` tool. The model interprets preferences and corrections from SDK
history. The tool validates and intersects city, role, and topic filters, returns
at most five copied profiles, and reports no matches explicitly.

After validated audio commitment, the adapter delegates to the ordinary SDK tool
loop. There is no speculative lookup or speculative-tool policy. No tool contacts
people, sends introductions, books meetings, takes payments, or mutates data.
Offering to draft an introduction does not send it.

## Evaluation and evidence

The [benchmark report](spikes/002-history-evaluation/REAL_AUDIO_VERIFICATION.md#baseline-vs-fastfloor-benchmark)
compares the matched Baseline and FastFloor modes. The final experiment recorded
ten SDK playback samples per arm: p50 1,016.374 ms versus 474.035 ms, a 53.4% lower
sample median. SDK commitment-to-playback is not caller-audible latency.

The [evidence guide](spikes/002-history-evaluation/README.md) separates deterministic
SDK tests, hosted-model tests with fixture STT/TTS, hosted console audio, manual
observations, and unsuccessful room simulations. Raw measurements and failed
attempts remain available; historical samples are not pooled into the headline
comparison. The history recovery is shared by both arms, not the experimental
variable.

Tracing is opt-in through `FASTFLOOR_TRACE_PATH`. It records transcripts, full
request context, SDK timing, and session IDs with synchronous I/O. New trace files
request mode 0600; existing file permissions are unchanged. The parent directory
must exist. There is no production redaction or retention policy, and a trace-write
failure can affect the experiment. Use fictional input and keep new captures
outside Git.

## Tradeoffs and limits

- Full-response buffering keeps incomplete/erroring text private but delays
  non-reused replies and can waste model work. The matched control also buffers;
  the results do not compare FastFloor with an optimized streaming baseline.
- Exact input/context matching favors correctness over reuse. Provider event
  ordering and ambiguous transcript provenance remain integration limits.
- A fake producer that ignores abort can still delay a serialized commitment
  hook. The coordinator does not add a timeout policy.
- Message IDs are retained for one session. Create one adapter per session;
  there is no long-lived eviction policy.
- Expressive-markup parity between standalone preparation and the SDK's normal
  per-reply model request has not been verified.
- Manual microphone checks succeeded overall, including corrections,
  interruptions, and fictional search. One isolated missed-speech observation
  remains undiagnosed. These observations do not supply acoustic timing samples.
- Caller-audible onset, residual interrupted audio, rollback-specific tail
  latency, and production reliability remain unmeasured. Room simulation attempts
  captured no conversational turns; their cause remains unresolved.

The [README verification commands](README.md#reproduce-tests-and-evidence) cover the
offline suite, types, lint, formatting, and report reproduction. Text simulations
exercise semantics, not the audio commitment gate or acoustic cancellation.
