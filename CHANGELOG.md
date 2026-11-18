# Changelog

All notable changes to this repository are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow semver once the
first product packages are published.

## [Unreleased]

### 2026-09-18 — repository opened in public

- Opened `sno-ai/sno-station` with `packages/chunking` (already on npm) and its real history.
- Public README in nine languages, the security page, and the first evidence image of the
  nightly improvement loop running on our own repository.
- Nothing is released yet: no product package version, no tag, no install path. Those land
  with the following waves and will appear here when they do.

## [2.1.0] - 2026-11-17

Tell one agent once. Every agent works from the newest version.

- Say a rule to Claude Code, then say it again in other words. It is kept once, not twice.
- Change your mind in Codex, and the old version stops reaching every agent, not just that one.
- Each night the shared memory tidies itself. Repeats go, outdated lines go, and a line that drifted
  from what you actually said is put back right.
- Nothing is changed on one model's word. One agent proposes the change, and an agent from the other
  vendor checks it first.
- A new session opens with a short list of the rules that matter almost every time, not everything
  ever said.

## [2.0.2] - 2026-11-16

Tell your squad when. An agent shows up and does the work.

- Say "check the build tomorrow at 9" or "write the report every morning at 7" to Claude Code or
  Codex. At that time an agent starts and does it, with the conversation open or closed.
- `sno heartbeat --due` shows what is scheduled. A task that could not start stays on the list with
  the reason beside it.
- Your agents can now message each other across computers on the same network or over Tailscale.
- An agent that was cut off picks up the messages that were waiting for it.

## [2.0.1] - 2026-11-07

Your squad keeps going when an automatic check times out.

- Codex returns control when an automatic memory request times out.
- Automatic checks have more time to finish when a response is slow.
- Work passed between several agents stays with its current owner.
- Asking for help with agent pairing shows help without starting agents.

## [2.0.0] - 2026-11-04

Sno Station 2.0: Tag Team. Your agents have each other now.

- One command puts two agents on a task. One builds, one challenges, and the work reaches you
  already argued over.
- `2 need you` shows up in your status line, and `sno squad` lays out the whole squad: who needs you,
  who is working, what is finished.
- Work outlives the agent doing it. Quota, crash, closed window: the task comes back, and you get the
  truth about how. Resumed, rebuilt or lost.
- Approve a lesson, and the next reply already knows it.
- Messages wait their turn. They land in an inbox first, so you can be typing and the other agent can
  be compacting, and nothing gets lost.
