# FastFloor checkpoint handoff

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
