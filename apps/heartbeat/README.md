# Heartbeat

Heartbeat runs a command on a schedule and records its latest result so another agent can inspect
or resume the work.

For a task at a particular time, put a `## Due` section outside the machine block of a Markdown
record directly inside `${SNO_PROFILE_DIR:-$HOME/.sno}/station/handoff/`. The machine block names
`checkout:`, `runtime: claude-code` or `runtime: codex`, and `session-id:` (empty for a fresh run).
Entries are separated by blank lines; the section ends at the next `## ` heading or end of file:

```markdown
<!-- machine-record:start -->
checkout: /path/to/project
runtime: claude-code
session-id:
<!-- machine-record:end -->

## Due
at: 2026-11-16 07:00 America/Los_Angeles
repeat: daily
do: write the daily report

at: 2026-11-17 09:00 America/Los_Angeles
do: check the build result
```

`at` requires `YYYY-MM-DD HH:MM` and an IANA time zone. `repeat` is optional (`daily` or `weekly`),
and preserves the local clock time across daylight saving changes. `do` is a required single-line
action independent of the record's current next step. Heartbeat owns `last`; leave it alone.

```sh
sno heartbeat --due-set /path/to/record.md "2026-11-16 07:00 America/Los_Angeles" "write the report" daily
sno heartbeat --due-cancel /path/to/record.md "write the report"
sno heartbeat --due-cancel /path/to/record.md
sno heartbeat --due
sno heartbeat --due --problems
sno heartbeat --due-tick
```

Setting an action again updates its time; cancelling without an action removes the section.
`--due-tick` starts detached agents for due entries and returns promptly. A per-entry lock prevents
a second run while an agent is working. Open conversations are forked; closed conversations are
resumed; absent context starts a fresh conversation of the same runtime (Claude first if the
record has no runtime). Agents run in `checkout`, with stdin closed, under your own settings,
without added permission flags or a run time limit. Agent JSON streams require `jq`.

An occurrence is consumed at the first real reply. One-time entries retain their action and
result but lose `at`; repeating entries advance to the first future occurrence, even after
several missed days. A failure before any reply keeps the task due and records the reason.
Login and quota failures never start a fresh agent. Agents are asked to end with
`DUE_RESULT done`, `DUE_RESULT unfinished <why>`, or `DUE_RESULT waiting-for-you <need>`.
`--due` shows next times in your local zone, repeat, last result, and running time;
`--due --problems` shows failed starts, errors, unfinished work, requests for your help, and runs
that ended without a result. Output is kept in the heartbeat state directory under `log/`.

The source is included here as part of Sno Station. Release archives and the supported install
path will be documented when they are published.

Licensed under Apache-2.0. See [NOTICE](NOTICE).
