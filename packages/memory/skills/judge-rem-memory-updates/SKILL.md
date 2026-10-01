---
name: judge-rem-memory-updates
description: Judge REM memory relations, rewrites, verification, and clause carry by meaning. Use for REM update model calls that decide which older facts are superseded, which facts remain current, and whether a proposed rewrite preserves all surviving facts.
---

# Judge REM Memory Updates

Judge meaning. Do not decide from shared words, punctuation, or text position.

## Relation Judgment

- Mark `supersedes` true only when the newer record replaces meaning in the older record.
- Mark `retires_anything` true only when at least one meaning in the older record stops being current.
- Mark `supersedes_everything` true only when every current meaning in the older record is replaced.

## Source Rewrite

- Put only the facts that remain current in `proposed_current`.
- Quote each superseded value from the source row in `retired_values`.
- Drop the wording that exists only to describe the change itself — what the value was
  before, when it changed, and who changed it. That wording retires with the value it
  describes. "currently $1,100,000, updated from $900,000 on 2025-06-06" rewrites to
  "currently $1,100,000", and `retired_values` carries "$900,000".
- This holds in every language and for every kind of value, not only amounts. Any phrasing of
  the shape "changed from A to B", "shifted from A to B", "switched from A to B", "moved from A
  to B", "A is now B", "no longer A but B" leaves ONLY B in `proposed_current` and puts A in
  `retired_values`. The old value must not appear anywhere in the rewrite, not even inside the
  phrase that describes the change — copying "shifted from A to B" into `proposed_current`
  keeps the retired value alive and is wrong. Rewrite it as B alone.
  English: "shifted from morning tea to coffee" rewrites to "coffee", retiring "morning tea".
  Spanish: "cambió de té matutino a café" rewrites to "café", retiring "té matutino".
- A line that says an item is no longer needed, no longer tracked, done with, or that asks
  for it to be removed from the list, IS a retirement instruction. Drop that whole line from
  `proposed_current`, and drop the item it names as well. Quote the named item in
  `retired_values`. Leaving either one in place is wrong: the instruction line is wording
  about a change, and the item it names is the value that change retires.
- Return no retired values when nothing was superseded.
- Return an empty proposed value when nothing remains current.

## Rewrite Verification

- Mark `faithful` true only when source evidence supports every claim in the rewrite.
- When a newer record is provided, retire only meanings that the newer record replaces.
- Reject any unsupported fact, entity, quantity, or claim.
- Mark `retired_absent` true only when no retired meaning remains current in the rewrite.
- Mark `all_facts_accounted` true only when every source fact remains current or appears in the retired values.
- Wording that exists only to describe the change — the prior value, the date it changed,
  who changed it — is part of the retirement, not a surviving fact. Its absence from the
  rewrite never makes `all_facts_accounted` false.
- Accept paraphrases that keep the same meaning.

## Clause Carry

- Mark a clause already current only when the survivor asserts the same meaning as current.
- A negation, quotation, or past description is not a current assertion.
- Different words with the same meaning count as current.
