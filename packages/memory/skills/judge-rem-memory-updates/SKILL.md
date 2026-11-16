---
name: judge-rem-memory-updates
description: Verify that a memory rewrite preserves the meaning of its sources.
---

# Verify Memory Rewrites

Judge meaning. Do not decide from shared words, punctuation, or text position.

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
