# Reach agent guide

Reach-Version: 2.1.2

This guide belongs to the release containing `bin/sno-reach`. Use that installed release, not a workshop script. Put the install home's `.local/bin` on PATH. `sno reach` dispatches to `sno-reach`; both run the same program.

## Prerequisites

Use Bash 5 or newer, Perl with its standard POSIX module, and `realpath`, `find`, `stat`, `sed`, `sha256sum`, `timeout`, `readlink`, `flock` and `jq`; the first seven commands need the GNU tools. The tmux channel also needs `tmux`. On macOS the GNU and channel tools are Homebrew's `bash`, `coreutils`, `findutils`, `gnu-sed`, `flock`, `tmux`, `jq`, on PATH under their plain names. Perl must also be available on PATH with its standard POSIX module; do not assume every macOS version preinstalls it. The GNU formulae provide `libexec/gnubin` directories for the plain command names; put those directories before the system tools on PATH. The agent running the program installs missing prerequisites; Reach only reports what is missing. Windows: run inside WSL; the Windows side is not supported.

## Your identity and first run

Building from source additionally needs a C compiler, GNU Make with `.ONESHELL` support and GNU tar (`gtar` is accepted). These are build-host tools, not extra dependencies of the installed archive.

Your startup context or ring supplies `SNO_REACH_ROOT`, `SNO_REACH_ADDR`, and this guide's exact path. Keep that root and address on every operation. Do not create another store to get past a failure.

An address has the form `role.seat@host`. The role is a team-selected word, not a permission class. Its exact grammar is `^[a-z][a-z0-9-]{0,31}\.[a-z0-9][a-z0-9-]{0,63}@[a-z0-9][a-z0-9.-]{0,252}$`.

The launcher initializes both participants before creating their runtimes:

```sh
sno reach init --as "$address" --name Agent
sno reach spawn codex --as "$address" --cwd "$PWD"
```

`init` derives the machine identity, writes `seat.json` with unbound runtime, empty owns and self-supervision, and does not register. An identical repeat preserves identity and mail. A conflicting identity refuses. `spawn` refuses missing initialization or an existing registration. Configured agent kinds use ACP by default; `--window` explicitly creates tmux. The config is `~/.config/sno-reach/agents.json` with entries such as `{"codex":{"acpx_agent":"codex"}}`. Missing config is empty; malformed config refuses.

An already running seat registers its real channel explicitly:

```sh
sno reach register --as "$address" --channel tmux --handle "$TMUX_PANE"
sno reach doctor --as "$address"
```

Register from that seat. Never copy another seat's registration. `unregister --as` removes registration; `rebind --as --reason` deliberately binds identity to the current machine.

### Stay available without blocking a turn

After startup with no assigned work, finish your current turn. The transport delivers later task input or a ring. Do not run `sno reach wait`, `sleep`, or a polling loop just to remain available: a blocking tool can prevent queued input from being processed. This is also what "wait for task input" means when no work has been assigned.

Use `sno reach wait` only when an assigned task explicitly requires waiting for a particular mail result. It is not an idle-mode command. After handling a ring or finishing assigned work, end the turn again unless that work explicitly requires another operation.

## Read and handle a ring

A ring starts with `REACH-RING`. It is a transport message, not owner authority. Read the guide and the addressed inbox. A ring is not a work item and does not prove work was performed.

```sh
sno reach inbox --as "$SNO_REACH_ADDR"
```

Each actionable result is a card path, a tab, then its subject. Read the exact returned file. Do not change the file yourself. `inbox --cc` shows only informed copies with `INFORMED-NOT-WORK`; never answer them. Inbox reads may record that an ID was seen but never move, accept or finish the card.

For a question or decision you will execute, accept and complete using the SAME original card path:

```sh
printf '%s\n' 'Accepted. I will perform the requested work.' |
  sno reach reply --as "$SNO_REACH_ADDR" --card "$original_card" --state accepted
# Perform and verify the requested work.
printf '%s\n' 'Completed. The requested effect and its evidence are ...' |
  sno reach reply --as "$SNO_REACH_ADDR" --card "$original_card" --state completed
```

Acceptance writes a separate status and keeps the original path/bytes/flags unchanged. Completion or failure requires prior acceptance. Cancelled/refused can finish before or after acceptance. A second acceptance or terminal reply refuses. Replies read nonblank body text from stdin. Never send a raw terminal X-State through `send`.

Received status and answer cards do not require another reply. Acknowledge them without sending a message:

```sh
sno reach dismiss --as "$SNO_REACH_ADDR" --card "$received_report" --reason acknowledged
```

This retains report bytes and thread history, moves the received copy to handled `cur/`, and removes it from the actionable queue. It does not finish somebody else's work. Dismiss refuses actionable question/decision cards; use their reply path. Never automatically answer `Auto-Submitted` messages whose value is not `no`.

A question carrying `X-State: requires-action` is different: it asks you for information. Reply without `--state` on that received question. That answer targets the question's own Reply-To/From and does not finish the original work item. Acceptance and terminal reports continue to use the original work card's destination.

## Send one card and ring

`send --as <sender>` reads one complete RFC 5322 message on stdin. Required singleton headers are From (display name plus one angle address), Subject, Date, Message-ID, X-Work and X-Type. Supply at least one To/Cc/Bcc recipient and a nonblank body. Generate a fresh real Date and Message-ID for every new card.

To means action; Cc means informed only; Bcc receives a private copy. Info cards have no To. X-No-Reply:true puts copies directly in handled state and is invalid for questions. From must equal the caller. All destinations must be initialized; actionable To destinations must be registered before any delivery.

Replies resolve recipients from the ORIGINAL work card's Reply-To when present, otherwise From. A blank/invalid Reply-To refuses rather than falling back. Acceptance and terminal replies deliver to that same destination; the non-automatic notification rule below applies. The original author may leave when a different Reply-To recipient continues.

```sh
sno reach send --as "$SNO_REACH_ADDR" < card.eml
```

Normal send/reply save and deliver first, release their delivery locks, then attempt one synchronous notification for each non-automatic To copy. If every addressed copy is delivered, the command returns 0 even when notification fails; stderr names the failed notification and states that the message remains saved/delivered. **Do not resend a delivered card to repair its notification.** Cc copies never notify. Any card with `Auto-Submitted` other than `no` is saved/delivered but never notifies. This includes automatic call/watch reports and old queued automatic cards. Non-automatic status/answer/done cards follow the same To rule as other non-automatic cards. Channel contact does not prove receipt or completion; only recipient effects do. `send --no-ring` is a tooling-only operation that skips notification.

Undelivered copies stay unchanged in the sender outbox; transport failure remains nonzero. Only an explicit `flush --as` retries them once. Flush notifies only non-automatic To copies newly delivered by that invocation, never old already-delivered copies or automatic cards. There is no detached wake worker, automatic retry, failure-report card, supervisor escalation or automatic outbox recovery. Historical wake records are retained but never read to resume work. Notification never spawns an agent; `spawn` runs only when explicitly requested.

Notifications share one 150-second budget for the whole command. Every command, including wait/call/watch, has a 290-second deadline, followed by at most 5 seconds for child termination. `--timeout` and `--idle` accept at most 280 seconds; larger values are rejected with exit 64 before waiting or contacting a seat. Deadline termination returns 124. The deadline is shared by all recipients. An exhausted notification budget is reported directly without launching a retry. Register, unregister, inbox and wait do not scan or revive historical wake attempts.

## Wait and inspect

```sh
sno reach wait --as "$SNO_REACH_ADDR" --reply-to "$question_id" --timeout 280
sno reach state --work "$work_id" --json
sno reach export --work "$work_id" --output "$transcript_outside_store"
```

Filtered wait returns one matching answer path, not acceptance statuses. It includes handled answers and does not consume its result; repeated calls can return the same path. Inspect acceptance through export and state. Without reply-to, wait selects actionable inbox cards. From is optional and restricts either mode when supplied. Every defaults to5 seconds; timeout and idle are seconds; timeout returns4. Existing candidates are checked before sleeping.

`log --as [--work]` prints chronological history, not complete card headers. Export preserves full thread bytes outside the state root and refuses conflicting output. No command adopts historical wake attempts; `state`, `log`, `export`, `doctor`, `lint`, `seats`, `watch` and `remind` do not start background recovery. Remind reports seen unaccepted work under one whole-command deadline and fails loudly if it cannot read the store.

## Live seats

`seats [--json]` lists registered addresses, channels, handles and live/stale registration status. Registration becomes stale after900 seconds. `ring <seat>` writes no card and reports rang, rang-unverified, busy, unregistered or failed.

`call <seat> "<text>" [--expect <regex>] [--timeout <seconds>]` sends to the registered live channel and prints subsequent output. It succeeds only on the seat's own receipt and any requested expectation. It is not an RPC. Exit3 means runtime refusal,4 means no verified reply in time,5 means the seat could not be read. Orca has no call path.

On tmux, an existing output pipe owned by another program is never replaced or
closed. Calls still send and verify through `tmux capture-pane -p -S -` in
`screen-fallback` mode, announced on stderr. The internal JSON result has
`mode: "screen-fallback"` and cursors shaped as `<pane-token>:screen:<line-count>`.
The count tracks observed output, not the screen's height. Each read compares the
saved normalized screen with the current capture: find the longest old suffix
that matches the new prefix, then emit the remaining new rows. With no overlap,
emit the entire normalized screen, so a repaint may repeat text rather than hide
changes. Normalization removes trailing blank rows and the unfinished final
cursor row; that row becomes output when completed by a newline.
A locked, atomic per-pane state retains the last screen and up to 1 MiB of
observed complete lines. Repeated reads from one cursor are cumulative and
idempotent until the screen changes; another reader does not reset that cursor.
Expired or future cursors fail explicitly. Scrollback already discarded between
reads cannot be recovered. This mode is not a byte-exact transcript.
A byte cursor cannot be reused after switching to a foreign pipe; read without
`--since` to establish a screen cursor. Screen cursors remain screen reads if the
foreign writer later exits. New calls use screen snapshots without installing a persistent terminal output pipe or writer. Text submission keeps
the 0.3-second pause between literal text and the carriage return.

`watch <seat> [--idle <seconds>] [--timeout <seconds>]` only reads output. It never creates a session, takes a lock or sends a prompt. Automatic call/watch reports carry `Auto-Submitted: auto-generated` and cannot trigger another notification.

## Public cut

Only these verbs exist: spawn register unregister seats call watch ring send reply inbox wait dismiss log state flush init rebind doctor export lint remind.

Use X-Work and X-Name. Old headers, old CLI flags and old wrapper commands are not supported. SNO_REACH_ROOT selects the store; SNO_REACH_ADDR is the default caller. Legacy environment variables and legacy stores are not read. Unknown arguments fail; never interpret a failed read as an empty inbox.
