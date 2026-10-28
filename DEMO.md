# FastFloor: 60–90-second technical demo checklist

This is a checklist, not a narration. Use fictional requests and headphones.

## Before recording

- Run `pnpm test`, `pnpm typecheck`, and `pnpm lint`.
- Open `src/fastfloor/turn-coordinator.ts`, the README diagram/results, and Agent
  Console. Keep credentials and full request-context logs off screen.
- Prepare two separate sessions: `FASTFLOOR_EVAL_ARM=fastfloor pnpm dev` and,
  after stopping that process, `FASTFLOOR_BOARDY=1 pnpm dev`. Connect to agent
  `fastfloor`. Neither mode gives an unsolicited greeting; speak first.
- Rehearse a correction that actually produces preflight then invalidation. If
  the recognizer does not produce that ordering, do not claim that trial proved
  speculative cancellation. Keep a deterministic cancellation test ready instead.
- Have the benchmark table open; do not spend the demo waiting for a fresh A/B run.

## Demo checkpoints (target: 80 seconds)

- [ ] 0–15 s — Show the custom coordinator and architecture diagram. Identify the
      generation ID, existing AbortController, private prepared response, and
      `COMMITTED && prepared && !hasPublished` release gate. LiveKit, not our
      coordinator, owns endpointing, TTS, playback, and normal history.
- [ ] 15–35 s — In FastFloor mode, ask a short question with a before-commit
      correction, such as a Monday → Tuesday change. Show preparation followed
      by invalidation/new generation, then commitment and one corrected response.
      Point out that stale completion cannot authorize output. If event ordering
      differs, use the tested example rather than manufacture a success.
- [ ] 35–45 s — Ask one follow-up to demonstrate multi-turn context. Optionally
      interrupt audible speech and check it yields without restarting the old
      reply. This is a qualitative check, not a measured acoustic guarantee.
- [ ] 45–60 s — Show the saved matched A/B table: SDK commitment → SDK playback
      p50 1,016 ms baseline versus 474 ms FastFloor, ten samples per arm. Identify
      the matched full-buffer control and say that caller-audible onset and
      production speedup were not measured.
- [ ] 60–80 s — Switch to the prepared Boardy-mode segment/session. Ask for a
      robotics founder in Boston. Show `find_people` returning fictional Maya
      Chen and the agent explaining the match/offering help drafting an intro.
      No contact or introduction is sent. State that this tool-enabled mode
      disables speculation; it is a separate committed-only workload.

For a 60-second cut, omit the optional interruption/follow-up, not the benchmark
qualification or tool-policy boundary. Switching sessions may be an explicit cut
in the recording; never present two modes as one simultaneous capability.

## Close / pass criteria

- [ ] No stale or duplicate response in the shown trial; the next turn still works.
- [ ] Maya is identified as fictional; draft assistance is not a sent introduction.
- [ ] Mention the isolated missed-speech observation as unconfirmed if discussing
      reliability. It has no established cause or measured recurrence rate.
- [ ] Stop local agents. Review the recording for secrets, project settings, private
      conversations, and trace paths before sharing it.

## Share with Dev at Boardy

1. Publish the reviewed feature branch; do not merge or force-push for the demo.
2. Share the feature-branch README, not the default-branch starter README.
3. Include this checklist/a short recording, the real-audio methodology, and the
   per-turn evidence linked from the README.
4. Suggested handoff context: a custom speculative turn coordinator integrated
   with real Flux/Gemma/Fish audio; a small matched SDK-timing experiment; and a
   separate fictional networking tool interaction. Explicitly retain the acoustic
   measurement and production-readiness limitations.
5. If GitHub access is private in a future fork, grant Dev access before sending
   links. Verify the shared branch and commit SHA in GitHub after pushing.
