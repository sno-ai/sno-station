# Reach agent guide

Reach-Version: 2.5.2

This guide belongs to the Reach release that `sno reach` runs. Use that installed release, not a workshop script.

## Choose the feature

Sno Reach has two feature names: **Instant Messenger** and **Agent Email**.

| Owner's intent | Feature | Agent action |
| --- | --- | --- |
| Talk to another agent now and get its response | Instant Messenger | `sno reach call ADDRESS "TEXT" --timeout SECONDS` with your registered sender identity |
| Leave a message or task and handle the reply later | Agent Email | `send --as ADDRESS` with a complete message on stdin; the recipient uses `inbox` and `reply` |

`join-talk` registers the existing conversation for both features. Cross-machine
communication also needs a receiver on each machine and reciprocal `peer` contacts.
Use the exact returned agent address; do not invent or silently change it.

For mail-reply calls, read the original `[CALL]` file and answer with
`sno reach reply --as YOUR_ADDRESS --card ORIGINAL_FILE`, body on stdin and no
`--state`. For task email (a `decision` card addressed to you in To and not automatic
(`Auto-Submitted` absent or `no`), or such a `question` card without
`X-State: requires-action`; there is no `task` card type), reply `--state accepted`, wait for that command
to succeed,
perform the work, then reply `--state completed` or `failed` on the original task.
A saved message, accepted wake or queued turn is not evidence of a recipient response.

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

### Start a pair

Start two agents with one command from the project directory:

```sh
sno reach pair "Implement the requested change and have the second agent review it."
```

`pair` initializes and starts two new agents in visible tmux windows using the existing spawn path. It gives them the same task, checkout and partner address through Reach task mail, with complementary roles. The implementer writes the change and sends its result to the reviewer. The reviewer reads that result, inspects the change and returns concrete findings or an explicit no-defect result through Reach; it does not independently edit the same production files. The implementer addresses findings. The launching process is not counted as either agent, and no permanent third agent is required.

The command prefers different known vendors among usable signed-in agents. When only one vendor is usable, both agents use it and still implement and review together. Output identifies the actual composition and says when review is not cross-vendor. Unknown login or vendor information stays unknown; missing optional usage data does not mean signed out. The pair uses existing model/provider configuration and keeps the selected project/profile and installed memory integrations. It does not change agent settings or create another experience base. Its reviewer is the second live agent, not the standalone cross-vendor peer-review skill.

Output gives both addresses, roles and where to view their work. After assigning work, the command uses the existing Reach wait path to return the assigned reviewer's answer to the implementer. If no review answer arrives before the existing command deadline, it returns nonzero and reports that both assignments remain stored and the agents can continue. Launch and registration alone do not prove a finished review. If the second agent fails to launch, the command reports failure and preserves the working implementer with its delivered task. Inspect the returned review, reported windows and Reach mail for the actual result.

An already running seat registers its real channel explicitly:

```sh
sno reach register --as "$address" --channel tmux --handle "$TMUX_PANE"
sno reach doctor --as "$address"
```

Register from that seat. Never copy another seat's registration. `unregister --as` removes registration; `rebind --as --reason` deliberately binds identity to the current machine.

Ordinary terminals are also accepted. Run `sno reach terminal-info` inside the agent's shell
to discover its input endpoint, then `sno reach register --as "$address" --channel terminal`
to register it. Codex uses its native session queue when available, independently of the
terminal. On macOS, Ghostty's scripting interface can target the exact terminal surface.
If the operating system refuses input into an already running terminal, start or resume the
agent with `sno reach terminal -- <agent command>` and register from there. This foreground
command carries the agent's input, output, window size and exit status in any terminal on
macOS, Linux or Windows WSL; it does not require tmux. Python 3 is required for this channel.
Accepted input reports `rang-unverified`; use the recipient's reply to establish processing.

Registration has no channel-name allowlist. A separately installed input adapter can use any
channel name: provide `reach-channel-<channel>` on PATH, register its handle, and implement
`reach-channel-<channel> ring <handle> <wake text>`. Exit zero means input was accepted;
nonzero means the wake failed. Missing adapters and actual input failures are reported while
the original card remains in the inbox. `watch` requires a readable receiver output
stream. Cross-machine and supported local `call` paths can return an actual threaded
mail reply without reading the terminal screen.

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

Acceptance writes a separate status and keeps the original path/bytes/flags unchanged. Completion or failure requires prior acceptance. Cancelled/refused can finish before or after acceptance. A second acceptance or terminal reply refuses. Replies read nonblank body text from stdin. Never send a raw terminal X-State through `send`. A non-terminal X-State you `send` on work you hold must set In-Reply-To to that work's latest report and References to the work card followed by every report so far; `send` refuses one whose In-Reply-To is not that latest report and prints both expected values.

Received status and answer cards do not require another reply. A call mail (`X-Type: call`, subject `[CALL]`) transports an Instant Messenger instruction, not a new owned task. Read its full body. When it requests a Reach answer, reply on that local original file without `--state`; returning text only in your terminal does not send that answer. Existing capture-based calls may instead request a visible receipt: follow the original call's instructions. Do not accept or complete call mail as a task. A replied call is already handled; do not dismiss it again. Card-backed work keeps its original task card and Reply-To destination. Acknowledge received reports or other dismissible messages without replying:

```sh
sno reach dismiss --as "$SNO_REACH_ADDR" --card "$received_report" --reason acknowledged
```

This retains message bytes and thread history, moves the received copy to handled `cur/`, and removes it from the actionable queue. It does not finish somebody else's work. Dismiss refuses actionable question/decision cards; use their reply path. Never automatically answer `Auto-Submitted` messages whose value is not `no`.

A question carrying `X-State: requires-action` is different: it asks you for information. Reply without `--state` on that received question. That answer targets the question's own Reply-To/From and does not finish the original work item. Acceptance and terminal reports continue to use the original work card's destination.

## Send one card and ring

`send --as <sender>` reads one complete RFC 5322 message on stdin. Required singleton headers are From (display name plus one angle address), Subject, Date, Message-ID, X-Work and X-Type. Supply at least one To/Cc/Bcc recipient and a nonblank body. Generate a fresh real Date and Message-ID for every new card.

To give another agent work to do, send a decision card: `X-Type: decision` with a Subject that starts with `[DECISION]` followed by a space. `sno reach lint` refuses `X-Type: task` as an unknown type.

To means action; Cc means informed only; Bcc receives a private copy. Info cards have no To. X-No-Reply:true puts copies directly in handled state and is invalid for questions. From must equal the caller. All destinations must be initialized; actionable To destinations must be registered before any delivery.

Replies resolve recipients from the ORIGINAL work card's Reply-To when present, otherwise From. A blank/invalid Reply-To refuses rather than falling back. Acceptance and terminal replies deliver to that same destination; the non-automatic notification rule below applies. The original author may leave when a different Reply-To recipient continues.

```sh
sno reach send --as "$SNO_REACH_ADDR" < card.eml
```

Normal send/reply/flush save and deliver first, print `delivered to <recipient>` or `kept in outbox for <recipient>: <error>` per copy, then return; one notification per non-automatic To copy runs afterwards in a detached process (`wake running in background`) and lands in the ring log. The exit status describes placement only. **Do not resend a delivered card to repair its notification**: a card that still needs handling is re-woken by Reach itself (below). Cc copies never notify. Any card with `Auto-Submitted` other than `no` is saved/delivered but never notifies. This includes automatic call/watch reports and old queued automatic cards. Non-automatic status/answer/done cards follow the same To rule as other non-automatic cards. Channel contact does not prove receipt or completion; only recipient effects do. `send --no-ring` is a tooling-only operation that skips notification.

Undelivered copies stay unchanged in the sender outbox; transport failure remains nonzero. Only an explicit `flush --as` retries them once. Flush notifies only non-automatic To copies newly delivered by that invocation, never old already-delivered copies or automatic cards. Notification never spawns an agent; `spawn` runs only when explicitly requested.

The background notifications share one 150-second budget. Every command, including wait/call/watch, has a 290-second deadline, followed by at most 5 seconds for child termination. `--timeout` and `--idle` accept at most 280 seconds; larger values are rejected with exit 64 before waiting or contacting a seat. Deadline termination returns 124. The deadline is shared by all recipients. An exhausted notification budget is reported directly without launching a retry. Register, unregister, inbox and wait do not scan or revive historical wake attempts.

## Turn end, re-wake and resume

At the end of every completed Claude Code or Codex turn in a registered seat, the agent's own Stop hook runs `sno reach pickup`. If cards wait that need handling, the agent continues with one prompt that lists each card's path, sender, subject and the rule for its kind; handle each on its own thread. Pickup never marks a card seen. Only mail delivered after this machine first ran Reach 2.5 is picked up or re-woken.

A card that still needs handling five minutes after its last attempt is tried again by the minute timekeeper, at most three attempts per card per recipient in total (turn-end offers, rings, resumes and forwards all count). A ring refused as busy (someone is typing in the box, the recipient is mid-turn, or a Claude window no longer holds its conversation) typed nothing: it does not count, and it does not delay the offer at the recipient's next turn end. Such a card is rung again every five minutes until the ring goes through. A To copy needs handling when it is not Cc, not `X-No-Reply`, not automatic, and: a task card nobody has accepted; a question or `[CALL]` this recipient has not answered; any other card not dismissed. When the holder of an accepted, unfinished card has no live process, the timekeeper resumes the holder's own conversation with a prompt that tells it to read the card's progress first, stop if the card is final or held by someone else, check every outside action before repeating it, and ask the developer about anything it cannot confirm. When a holder cannot be checked, the card is shown as stuck in `sno squad`.

## One taker for shared task cards

A task card with two or more To recipients is taken by exactly one. Every acceptance asks the sender's machine; the first one wins. A later `reply --state accepted` exits 75 with `taken by <winner>` and that copy needs no further handling. If the sender's machine cannot be reached, it exits 75 with `waiting for confirmation: <error>`: do not start the work; try the acceptance again later, and the same winner is returned. Senders of a shared card wait for the taker's answer only.

## Telling the developer

Write to the developer with `sno reach notify --as "$SNO_REACH_ADDR" --type question|decision|result|routine --subject "<one line>" --body "<details>"`. The card goes to `developer.human@<this machine>`, which is the record of everything agents told the developer. Questions, decisions and results are shown once as a desktop notice on the machine where the developer last typed to an agent; routine cards are kept but never shown. When that machine cannot be judged, the notice is only listed in `sno squad`. When the developer has answered your question, dismiss your own question card: `sno reach dismiss --as developer.human@<this machine> --card <path> --reason answered`. Approval requests, failed timed runs and finished watched windows are reported to the developer automatically.

## Sent box

`sno reach sent --as "$SNO_REACH_ADDR" [--work <id>] [--json]` lists your newest sent items with, per recipient: placement (delivered, kept in outbox, flushed), wake attempts, taker, acceptance and answer. A column with no record reads `unknown`.

## Wait and inspect

```sh
sno reach wait --as "$SNO_REACH_ADDR" --reply-to "$question_id" --timeout 280
sno reach state --work "$work_id" --json
sno reach export --work "$work_id" --output "$transcript_outside_store"
```

Filtered wait returns one matching answer path, not acceptance statuses. It includes handled answers and does not consume its result; repeated calls can return the same path. Inspect acceptance through export and state. Without reply-to, wait selects actionable inbox cards. From is optional and restricts either mode when supplied. Every defaults to5 seconds; timeout and idle are seconds; timeout returns4. Existing candidates are checked before sleeping.

`log --as [--work]` prints chronological history, not complete card headers. Export preserves full thread bytes outside the state root and refuses conflicting output. No command adopts historical wake attempts; `state`, `log`, `export`, `doctor`, `lint`, `seats`, `watch` and `remind` do not start background recovery. Remind reports seen unaccepted work under one whole-command deadline and fails loudly if it cannot read the store.

## Live seats

`seats [--json]` lists registered addresses, channels, handles and live/stale registration status. Registration becomes stale after900 seconds. `ring <seat>` writes no card and reports rang, rang-unverified, busy, unregistered or failed. Busy includes a person typing in the seat's input box: nothing is submitted, the draft is left as it is, and a card stays in the mailbox.

`call <seat> "<text>" [--expect <regex>] [--timeout <seconds>] [--every <seconds>]` saves the full text, including newlines, in the initialized local receiver's existing mailbox before attempting notification. Each call has its own Message-ID and transport X-Work, `X-Type: call`, subject `[CALL]`, and no X-State; it creates no owned work item. `SNO_REACH_ADDR` supplies the sender. Without it, call automatically initializes a local caller mailbox without starting another agent or assigning work.

The terminal receives one short `REACH-RING` cue with the Message-ID and instructions to read the addressed inbox and exact returned mail file. The cue contains no call-body excerpt or handoff marker. After reading that file, the receiver outputs the mail's delivery receipt and follows the instruction. The caller observes fresh receiver output through its transcript, ACP assistant chunks, or the existing screen fallback. `--expect` matches output after this call's receipt. Terminal echo, an inbox listing and mail storage alone never prove execution or release.

Exit0 means a verified receiver response and any requested match; exit3 means runtime refusal, busy input or an unsupported synchronous channel; exit4 means no verified reply in time; exit5 means unreadable receiver output. Orca and Cursor IDE remain unsupported for synchronous calls, but their saved call mail remains readable. Failed delivery returns nonzero without ringing and reports the original mail retained in the sender's existing Maildir `tmp/`; saved sender bytes do not prove receiver delivery. A failure after storage reports the receiver and Message-ID on stderr as stored with receipt unverified, leaving stdout for receiver output. Busy input leaves the person's draft intact. Do not resend stored mail to repair notification: there is no second Enter nudge or automatic resend; the stored call mail follows the bounded re-wake rule above while it still needs an answer. A later inbox and file read can recover the complete instruction after a timeout or compaction; that does not turn the earlier failed call into synchronous success.

`call <seat> "<literal text>" --raw` keeps literal tmux typing and `typed <seat>` output. It is tmux-only, cannot use `--expect`, and does not store call mail or wait for a receipt. Normal calls never fall back to raw typing.

On tmux, an existing output pipe owned by another program is never replaced or
closed. Seats without a readable agent transcript use `tmux capture-pane -p -S -` in
`screen-fallback` mode, announced on stderr. The internal JSON result has
`mode: "screen-fallback"` and cursors shaped as `<pane-token>:screen:<line-count>`.
The count tracks observed output, not the screen's height. Each read compares
archived history and visible rows in separate line-diff passes and emits only
added lines. A repaint does not re-emit the entire normalized screen; repeated
identical text may produce no new lines. Normalization removes trailing blank
rows and the unfinished final cursor row; that row becomes output when completed
by a newline.
A locked, atomic per-pane state retains the last screen and up to 1 MiB of
observed complete lines. Repeated reads from one cursor are cumulative and
idempotent until the screen changes; another reader does not reset that cursor.
Expired or future cursors fail explicitly. Scrollback already discarded between
reads cannot be recovered. This mode is not a byte-exact transcript.
Use only returned screen cursors with `--since`; read without `--since` to
establish a new screen cursor. Screen cursors remain screen reads if the
foreign writer later exits. New calls use screen snapshots without installing a persistent terminal output pipe or writer. Text submission keeps
the 0.3-second pause between literal text and the carriage return. A person can begin typing during that interval; the existing check does not eliminate that race or add composer recognition for Hermes/OpenClaw.

`watch <seat> [--idle <seconds>] [--timeout <seconds>]` only reads output. It never creates a session, takes a lock or sends a prompt. Automatic call/watch reports carry `Auto-Submitted: auto-generated` and cannot trigger another notification.

## Public cut

Only these verbs exist: pair spawn register unregister seats call watch ring send reply inbox wait dismiss log state flush init rebind doctor export lint remind.

Use X-Work and X-Name. Old headers, old CLI flags and old wrapper commands are not supported. SNO_REACH_ROOT selects the store; SNO_REACH_ADDR is the default caller. Legacy environment variables and legacy stores are not read. Unknown arguments fail; never interpret a failed read as an empty inbox.
# Cross-machine messaging

Start a receiver on each machine with `sno reach network start`. Use
`sno reach network status` to inspect its process, listening address and mailbox root.
The root must be the same one used by the local agents. Stop only this receiver with
`sno reach network stop`; stopping it leaves existing mail intact.

Export a contact with `sno reach network address --ip <LAN-or-Tailscale-IP> > contact.json`.
Copy that contact to the other machine and run
`sno reach peer add <complete-hostname-after-@> --file contact.json`.
Configure the reverse contact too, so replies can return. `sno reach peer list` shows
the exact configured hostnames. Contact files contain public endpoint addresses, not
the private endpoint key. The receiver preserves its identity across restarts.

Contacts authorize machines: both sides must add each other before communicating.
Sending uses the same persistent identity as receiving. The receiver accepts only
configured peer identities and checks that message From and ring sender addresses
belong to a hostname registered for that peer. A network contact grants messaging,
not remote identity creation or rebinding; initialize and manage agents locally.

Use ordinary `send`, `reply`, and `call` commands afterward. Configured peers use iroh
direct connections and need no system SSH server. A configured connection failure
never falls back to SSH. Existing destinations without an iroh contact retain their
SSH behavior. For an immediate call, set `SNO_REACH_ADDR` to the caller's registered
address (or use its existing `SNO_EXECUTOR_ADDR`). The called agent reads the received
message and replies through Reach; the caller returns that answer, not a prompt echo.

Reach bundles its native transport. Users do not need Rust. Developers build with the
checked-in Rust toolchain and Cargo.lock; the iroh requirement is exact, and release
builds use `--locked`. Dependency upgrades are deliberate changes tested on the affected
machine-to-machine paths, never automatic runtime upgrades.
