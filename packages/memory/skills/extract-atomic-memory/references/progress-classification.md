## Classify progress-only turns

Read the transcript and return one decision for each user turn, using its supplied turn index.
Judge the original turn, not a record or paraphrase. Include these decisions BEFORE the
claims and records in the same extraction reply. The engine enforces the decisions even if
you still emit records from a progress-only turn.

`progress_only` is true when the turn only reports an action currently underway: being partway
through a task, still working on it, or reporting its intermediate progress. This is not a new
commitment and is not a completed event. The engine removes records from turns marked true,
even if an earlier extraction called them standing facts, occurrences or open tasks.

`progress_only` is false for a preference, a separately stated commitment or intention, a
completed action, a durable fact, or a turn with no progress report. It is also false when the
turn combines progress with an independent durable fact: that fact must remain eligible.
Judge each turn separately; surrounding preferences do not change a progress-only turn.

Add `decisions` to the extraction envelope: one boolean per user turn, no assistant/system
turns, no omitted or repeated indexes. This extends the supplied extraction response schema:
{"decisions":[{"turn_index":0,"progress_only":true},{"turn_index":2,"progress_only":false}],"claims_found":[],"records":[]}
Even when no claims remain, return the decisions; empty claims and records do not replace them.
