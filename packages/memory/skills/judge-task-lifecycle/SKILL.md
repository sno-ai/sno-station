---
name: judge-task-lifecycle
description: Judge how a memory changes active-task state and whether it refers to an existing task. Use for mem-claw task-lifecycle model calls.
---

# Judge Task Lifecycle

Judge task meaning. Do not decide from exact wording alone.

## Active Task State

Apply the `To-do Boundary` section supplied from `extract-atomic-memory` before these state rules.

Decide in this order and stop at the first step that applies.

1. **Does the candidate report OR INSTRUCT that an existing active task is done, finished,
   handled, cancelled, or dropped?** If yes, the answer is `complete` or `remove` on THAT task.
   Never `open_or_refine`, and never `none`.
   A report ("I finished X", "X is done") and an instruction ("mark X complete", "tick X off",
   "close X", "remove X from my list") both land here. An instruction to change a task's state
   IS the state change; do not treat it as a request you decline to act on.
   A candidate that speaks about an active task's ending is never a new task, however it is worded,
   and restating the task's name inside such a sentence is naming the task to close, not opening one.
2. Otherwise, if the candidate describes work still to be done, use `open_or_refine`.
3. Otherwise use `none`.

- Use `open_or_refine` only for a current task that remains active.
- Use `complete` only when the candidate says an active task was achieved.
- Use `remove` only when the candidate says an active task was cancelled or should no longer be tracked.
- An explicit instruction to mark a task complete, done, or finished is `complete`, even when it is
  phrased as an edit to a list — "mark X complete on my todo list" and "tick X off" are `complete`,
  not `remove`. Taking a finished task off a list is what completing it looks like; the words that
  decide are whether the work was done. Reserve `remove` for a task abandoned, cancelled, called off,
  no longer needed, or added by mistake — cases where the work will NOT happen.
- Use `none` when the candidate does not change active-task state.
- A candidate that reports a task as finished, cancelled, or already handled never opens one.
- If that task is active, complete or remove it. If it is not active, make no task change.
- Match tasks by meaning, not exact wording. Refine an existing task instead of opening a duplicate.

## Existing Task Relation

- Use `same_instance` when the assertion refers to one listed active task, including different wording with the same meaning.
- Use `distinct_instance` when the assertion is a different active task.
- Use `none` when the assertion does not describe an active-task relation.
- Use `uncertain` when the evidence does not settle the relation.
