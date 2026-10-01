# Changelog

## Unreleased

`wait --reply-to` records the answer it returns in the caller's seen list, so the same answer no
longer rings the caller again after `wait` already handed it over.

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
