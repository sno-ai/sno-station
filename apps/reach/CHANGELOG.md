# Changelog

## 2.1.3

`wait --reply-to` records the answer it returns in the caller's seen list, so the same answer no
longer rings the caller again after `wait` already handed it over.

`spawn openclaw` now refuses when OpenClaw has several agents and none is the default. OpenClaw
turns down the first message of a seat in that setup, so a seat that `spawn` reported as created
could never answer. The refusal names the agents and the command that makes one the default.

## 2.1.2

Local candidate; public publication is not asserted.

After a call observes its assistant delivery receipt, keep waiting for the expected
result without issuing the second-Enter fallback. Calls whose receipt is still
missing retain the existing submission fallback.

## 2.1.1

Local candidate; this entry does not assert public publication.

Submit a tmux notification once while retaining the existing confirmation wait.
Terminal repaint observation appends changed lines instead of repeating unchanged
scrollback. Codex calls select the transcript carrying their own delivery receipt
rather than the newest same-directory session. Reminder parsing failures return
nonzero instead of silently succeeding. Rebind reasons retain quotes and literal
backslashes without awk interpreting them twice.

## 2.1.0

Local candidate; publication and installed-host verification are not yet complete.

Delivery attempts each addressed copy once. Successfully delivered sends return 0 even
when notification fails; stderr reports that failure and preserves the delivery result.
Non-automatic To copies receive one synchronous notification attempt. Cc copies and
cards whose Auto-Submitted value is not `no` never notify, including on explicit flush.

Remove detached notification retry, automatic failure-report cards, wake adoption and
background outbox recovery. Register, unregister, inbox and wait do not revive historical
wake records. Failed transport keeps the original outbox bytes for explicit `flush` only.
Notification never spawns an agent; explicitly requested `spawn` remains available.

Notifications share a 150-second budget within a 300-second invocation deadline.
Delivery locks are released before notification. Calls do not leave permanent terminal
capture writers, and automatic call/watch reports cannot trigger another notification.

## 2.0.5

`export` retries its mailbox snapshot once when a selected message moves between Maildir
`new` and `cur` during acknowledgment. A second move or any content change still refuses the
export and asks the caller to retry after mailbox activity stops.

## 2.0.4

A seat spawned by Reach records its agent's own transcript (Claude: a fixed session id; Codex: its rollout file), and `call` verifies a send against new assistant text there instead of the terminal screen; the screen path remains only for raw pane handles. Text already sitting in a composer is cleared before a send instead of refusing it.

## 2.0.3

`call` and `watch` treat a bare carriage return as a line break when reading a terminal, so a TUI that paints with cursor moves no longer glues the delivery receipt to the line after it. A Claude seat starts with prompt suggestions off, because a suggestion in the composer read as unsubmitted text and refused every send.

## 2.0

Move the communication runtime and channel helpers into one core-owned release. Expose only `sno-reach` on PATH. Replace private names and team-registry policy with the public Reach contract. Delivery and replies include ringing; accepted replies preserve the original card; report acknowledgment does not send another reply. Add role-neutral identity, folded inbox/wait, read-only watch/remind and exact archive installation.

This entry describes the candidate under construction. It does not assert publication or completed acceptance.
