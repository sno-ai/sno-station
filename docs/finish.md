# Finish: the work gets done while you are away

You give your agent a task and leave. Finish is what brings an agent back at the right
time, keeps a long run moving, and tells you plainly when something could not be done.

| You want | What happens | Example |
| --- | --- | --- |
| **Timed tasks** | An agent starts at the time you named and does the work. Once, every day or every week. | “Check the nightly build tomorrow at 9.” |
| **A long run watched** | Your agent checks on a job every so often until it ends, then reports. | “Look at the training run every ten minutes until it finishes.” |
| **Work that outlives a usage limit** | A different agent continues from where the first one stopped. | “This will take all night. Use `rotate-agent`.” |

## Start with one sentence

In a Claude Code or Codex conversation, say the task and the time:

```text
Check the nightly build tomorrow at 9 and tell me what failed.
```

For something that repeats:

```text
Every morning at 7, write the daily report.
```

Your agent writes the time down next to its notes for that task. You can close the
conversation. You can close the terminal. At that time an agent starts and does what
you asked.

`sno setup` installs the small service that checks the clock once a minute. It runs
under your own user account on Linux and macOS. On macOS it needs Homebrew's
`bash`, `coreutils`, `flock` and `jq`.

## See what is scheduled

```sh
sno heartbeat --due
```

It lists each task, its next time in your local time zone, whether it repeats, and how
the last run ended.

To see only what did not go as planned:

```sh
sno heartbeat --due --problems
```

Your agent is shown the same list at the start of your next conversation, so you hear
about a missed task without asking.

To cancel a task, copy the record path from the start of its line in the list:

```sh
sno heartbeat --due-cancel <record path> "write the daily report"
```

Leave the task text out to cancel every timed task in that record.

## What happens at the time

- **The conversation is still open.** A copy of it does the work. The conversation you
  were typing in stays as you left it.
- **The conversation is closed.** It is continued, with everything it knew.
- **The conversation is gone.** A new one starts from the saved notes for that task.

A task that repeats keeps its clock time through daylight saving changes. If several
days were missed, the task runs once when it can, then moves to its next time. It does not run once for every day it missed.

Every run ends with one of three answers: done, unfinished with the reason, or waiting
for you with what it needs.

## When it cannot run

A task that could not start stays due. The reason is written beside it in plain words,
for example an expired login or a usage limit. It is tried again at the next check.
Nothing is marked finished that was not started.

A timed run uses your agent's own settings and adds no permissions. If the work needs a
permission you have not given, allow it before you leave.

## Long runs and usage limits

For a job that takes hours, ask your agent to watch it:

```text
Check the build every ten minutes and tell me when it finishes.
```

For work that may outlast one agent's usage limit, tell the working agent to use
`rotate-agent`. Near the limit it writes a handover and wakes a different agent, which
continues from the same commit. The main [README](../README.md) has a night where this
happened, with the mistakes left in.

## Where it stops

- Timed tasks start Claude Code and Codex. Cursor, Hermes Agent and OpenClaw are not
  started this way yet.
- The computer has to be on and awake. A sleeping laptop starts nothing until it wakes.
- On Linux the service runs while you are logged in. To keep it running after you log
  out, run `sudo loginctl enable-linger $USER` once. `sno setup` tells you when this applies.
- The clock is checked once a minute, so a task starts within about a minute of its time.
- A task survives a closed conversation and a restarted service. A full restart of the
  computer has not been through a real test yet.
- A started task is not a finished task. Read how the run ended.

## For agents

A timed task is a `## Due` entry in the task's progress record. Use
`sno heartbeat --due-set`, `--due-cancel` and `--due`. The record format, the result
line and every rule are in the [Heartbeat guide](../apps/heartbeat/README.md).

[中文说明](finish.zh-CN.md) · [Command reference](sno-commands.md)
