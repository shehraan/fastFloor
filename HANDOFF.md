# FastFloor checkpoint handoff

## Latest verification phase — October 28, 2026

Read `spikes/002-history-evaluation/REAL_AUDIO_VERIFICATION.md` first. The older
credential-blocked statements below are historical, not this environment's status.

- CLI 2.19.2 installed in the sandbox; launching CLI subprocesses with the existing
  dotenv-loaded environment enabled real audio debugger turns without printing or
  modifying credentials. Flux/Gemma/Fish console audio ran in both matched modes.
- A long real-audio utterance reproduced accepted-final history loss when its SDK
  commitment arrived after a newer interim. The adapter's early rejection now
  retains only exact observed-final aggregates using the existing history recovery;
  it still suppresses superseded replies. Coordinator/core cancellation untouched.
- Pre-fix and fresh post-fix ABBA sets are separate under `real-audio/`. Post-fix:
  ten playback samples per arm, SDK commit-to-output p50/p95 baseline
  1016.374/1778.332 ms and FastFloor 474.035/997.356 ms. This is real hosted provider
  audio but CLI console transport, not room/WebRTC or actual audible onset. With
  ten samples p95 is the maximum. Raw failed/incomplete pre-fix input is retained.
- Room audio simulations failed before conversational turns in both arms. Exports,
  worker warnings and a timeboxed cancelled attempt are preserved. No caller-side
  metric, acoustic cancellation, generation/playback interruption, or real-room
  speedup was verified. Do not label the unresolved setup as a proven SDK defect.
- Original baseline audio smoke passed separately. All original sixty tests plus
  five regressions pass; typecheck/lint/SDK declarations/supplemental strict types
  pass. Manual microphone/room tests and full-response-buffer measurements are
  documented. No packaging, provider/dependency/endpointing changes, commit or push.

## Current phase update — history / A/B / networking

Read `ARCHITECTURE.md`'s current-phase section and
`spikes/002-history-evaluation/README.md` first; the Prompt 2 and checkpoint sections
below are historical. The user reports a working real speculative microphone test.

- Fixed a reproduced integration bug: `StopResponse` after cancellation of a
  pending committed reply erased accepted user input in Agents 1.9.4. The adapter
  now retains validated stopped input by SDK ID in agent/session history; regressions
  assert that subsequent real request contexts preserve original/corrected turns.
- Added `FASTFLOOR_EVAL_ARM=baseline|fastfloor` and opt-in
  `FASTFLOOR_TRACE_PATH`, preserving the original default baseline and fake mode.
  `pnpm eval:sdk` exercises matched mechanics; `pnpm eval:report` exports JSON.
- Actual hosted-Gemma A/B results and scripted results are saved under
  `spikes/002-history-evaluation/`. They use scripted STT and silent TTS/output,
  not physical audio. No live latency improvement or acoustic safety is claimed.
- `FASTFLOOR_BOARDY=1` adds 18 fictional profiles and read-only `find_people`.
  Tools run only through the SDK's committed path; all speculation is disabled for
  this workload in both arms. Hosted-model correction/search plumbing was exercised.
- New semantic scenarios are included in existing merge-to-main simulation CI.
  Local cloud simulations and full hosted audio debugger were blocked by missing
  CLI project credentials. The agent's existing credentials supported separate
  hosted model and text-debugger checks; the debugger was stopped and read back.
- TurnCoordinator and all original tests remain intact. No new dependency, endpointing
  delay, dashboard, commit or push. Stop after this phase; manual microphone/WebRTC
  A/B and acoustic onset/interruption verification remain for the developer.
- Review caught stalled-provider cancellation delayed by async-generator observers.
  Explicit iterator cancellation now forwards directly upstream for TTS, committed
  LLM and STT. Three red-to-green actual-hook regressions plus frame/error checks
  cover the repair; all 60 tests, typecheck, lint and supplemental strict types pass.
  Scripted A/B, hosted-Gemma A/B and hosted Boardy artifacts were regenerated after
  this repair. They still do not measure physical audio or a production latency win.

## Prompt 2 update

Real speculative LLM preparation is now opt-in with `FASTFLOOR_REAL_LLM=1`.
`FASTFLOOR_FLUX_SPIKE=1` alone retains fake mode. The existing TurnCoordinator is
unchanged. Multi-final turns skip partial speculation and generate freshly from
LiveKit's complete committed message plus its conversation context. See
`ARCHITECTURE.md` for current behavior, safety boundaries, verification and manual
audio commands. Hosted real-model/audio verification remains blocked in this
environment by missing CLI project credentials; text debugger startup/silence and
shutdown were checked. The checkpoint sections below describe the earlier fake-only
phase, not the current implementation. No commit or push was made for Prompt 2.

## State and commits

- Branch: `feat/fastfloor-livekit-integration-spike`. Local commits only; the user will push.
- `a3a834b`: fake-response Flux integration, coordinator output seam, and 23-test suite.
- RTC/audio checkpoint: the commit containing this handoff; identify it with
  `git log -1 --oneline -- HANDOFF.md`.
- Integration spike only. No production LLM speculation or Prompt 2 work.

## Current architecture

- `src/main.ts` keeps the normal agent as default. `FASTFLOOR_FLUX_SPIKE=1` selects
  Deepgram Flux (`eager_eot_threshold: 0.5`) and STT endpointing, disables built-in
  preemptive generation, LLM keyterm detection, and the greeting only in this mode.
- `src/agent.ts` installs optional public SDK hooks.
- `FluxIntegrationSpike` transparently forwards the underlying STT stream.
  Preflight prepares a fake string through the existing `TurnCoordinator`.
  Changed transcript text invalidates through `onResumed()`; identical interim
  text is not assumed to mean raw Flux `TurnResumed`.
- `onUserTurnCompleted` is the commitment gate. The coordinator releases text in
  memory; a one-shot `llmNode` supplies it to LiveKit's normal TTS/output/history
  pipeline. No parallel `say()` or extra `generateReply()` path is introduced.
- The coordinator retains generation IDs, abort handling, and at-most-once
  publication. Invalidations also interrupt tracked SDK speech handles. Already
  transmitted audio cannot be retracted.

See `ARCHITECTURE.md` for the full mapping and safety boundaries.

## Files in this checkpoint

- `package.json`: pin RTC to `1.1.0`; add development typings `@types/ws@8.18.2`.
- `pnpm-lock.yaml`: corresponding resolution and peer-snapshot updates. Agents
  remains `1.9.4`, ai-coustics remains `0.3.5`; both require RTC `^1.1.0`.
  The optional `supports-color` snapshot propagation does not upgrade its version.
- `spikes/001-livekit-flux/audio-smoke-results.json`: sanitized evidence from two
  generated-speech turns, not private microphone recordings or raw provider logs.
- `ARCHITECTURE.md`, spike `README.md`, and this file: current checkpoint evidence.

Agent implementation and all 23 tests are unchanged by this checkpoint. Existing
`AGENTS.md` edits, deleted `src/agent.test.ts`, backups, and untracked experiments
are intentionally excluded and left untouched.

## Verification

Passed in the current working checkout after the dependency fix:

- `pnpm run test`: 23 passed (7 coordinator, 11 adapter, 5 SDK session tests).
- `pnpm run typecheck` and `pnpm run lint`: passed.
- `pnpm exec tsc --noEmit --skipLibCheck false`: passed, including SDK declarations.
- Scoped Prettier check: checkpoint Markdown and JSON files only. The repository
  formatter was not allowed to rewrite the user's unrelated files.

Real audio debugger: two sequential generated utterances traversed hosted Flux
and Fish Audio, each with interim, preflight, final, and committed-turn logs, one
speech handle, and one fake assistant response. Commitment preceded TTS task and
speech-start logs. Debugger was stopped. These observations are not a physical
microphone/WebRTC test or an end-to-end acoustic safety/latency measurement.

## Exact live microphone/WebRTC test

From the project root with the existing local credentials configured:

    FASTFLOOR_FLUX_SPIKE=1 pnpm dev --log-level DEBUG --no-reload

Connect to the local `fastfloor` agent through LiveKit Agent Console using a
microphone and headphones. Watch `[FastFloor]` logs for `PREFLIGHT_TRANSCRIPT`,
`INTERIM_TRANSCRIPT`, `FINAL_TRANSCRIPT`, and `USER_TURN_COMMITTED`. Try normal
endpointing, a pause followed by a correction before commitment, and interruption
while the fake response is speaking. Confirm no early, stale, or duplicate speech.
These opt-in logs include transcript text: use synthetic, non-sensitive phrases.
Without the flag, the normal baseline agent remains selected; that baseline has
not been live-audio retested after this dependency change.

## Unresolved issues and next steps

- Physical microphone, browser WebRTC, same-turn resumption, and audible stale-buffer
  cancellation still require the manual test above.
- No typed raw Flux `TurnResumed` or stable provider turn-ID contract was found.
  Exact matching fails closed on ambiguous multi-segment aggregates.
- A pre-existing OpenTelemetry peer-range warning remains; it was not hidden or
  changed. Text-only debugger turns bypass the audio commitment hook.
- The tracked starter `src/agent.test.ts` is comment-only and is already deleted
  locally. It may cause empty-suite collection in a fresh checkout. No clean-worktree
  failure was actually reproduced; its disposition needs separate user approval.
- First finish the manual smoke and review event ordering. Only then scope Prompt 2
  with the user: one small, tested real-preparation seam that preserves coordinator
  authorization/cancellation. Do not silently redesign its core or speculative tools.

Push when ready:

    git push -u origin feat/fastfloor-livekit-integration-spike
