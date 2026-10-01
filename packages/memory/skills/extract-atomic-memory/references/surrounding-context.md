## Surrounding context

`preceding_context` and `following_context` contain earlier and later conversation turns,
for understanding only. Resolve a short answer against its question and resolve references
against what those turns actually say. Do not guess a new activity or object when the
surrounding conversation names it.

Extract and classify only the numbered `transcript`, not the surrounding context. A claim
may use a name or relationship supplied by the context, but its source quote and turn index
must come from the numbered transcript. Do not copy context-only claims into new records.
