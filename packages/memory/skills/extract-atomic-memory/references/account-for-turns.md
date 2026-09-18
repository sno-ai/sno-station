
## Turns to account for

`turn_indexes_to_account_for` lists the user turns this call owns. Read the whole window so that
"this morning" and "the same proposal" resolve, and take claims only from the listed turns. For
each listed turn return every claim it states — a figure, a taste and the reason for it, an
intention, a task to do, a completed task, a removal, a field of a document — one record per
claim, in that turn's own words. Return a claim even when an earlier turn in the window already
stated it; the engine merges repeats. A turn outside the list is context only.
