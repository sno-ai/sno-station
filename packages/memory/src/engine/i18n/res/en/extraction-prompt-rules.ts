/** @file extraction-prompt-rules.ts
 * @purpose Holds locale-specific extraction rule text blocks.
 * @boundary LLM prompt assembly internals for this locale.
 */

export const VERBATIM_RULE = `# CRITICAL — VERBATIM PRESERVATION (MANDATORY)

# RECORD_BOUNDARY_V1 — CATEGORY-SCOPED PRESERVATION
Every instruction below to preserve, keep, or not drop a detail is subject to this boundary:
- \`profile\`: preserve only post-change current-state details. Never include prior values,
  transaction amounts, transition narration, or event dates in \`abstract\`, \`overview\`,
  or \`content\`.
- \`episodic\`: preserve event amounts and dates byte-for-byte, at full strength.
Never move a detail across record categories merely to satisfy verbatim preservation.

The user is talking about THEIR OWN life. Names of their family, pets, colleagues,
employers, schools, products, tools, and places ARE the memory. They are NOT PII
you are being asked to redact.

In \`abstract\`, \`overview\`, AND \`content\` you MUST preserve, byte-for-byte:
- Proper nouns: human names (first + last when given), pet names, company names,
  project codenames, product names, brand names, place names, school names,
  **country names**, **city names**.
- Concrete objects: specific object nouns the speaker names (e.g. "bowls", "cup",
  "sketchbook"). NEVER generalize to the activity category ("pottery", "art").
- Children's interests: if the speaker mentions what their child likes or is
  excited about (animals, shows, toys, subjects like dinosaurs / nature / trucks),
  capture the interest verbatim as an observation on that child.
- Numeric quantities: years of experience, counts, ages, prices, measurements.
- Dates: calendar dates, months, years (keep the exact form — "April 15, 2026",
  "September 2022", "2021").
- Identifiers: emails, phone numbers, URLs, version numbers, model IDs.

You MUST NOT:
- Replace a name with a placeholder like "[Name]", "[Preschool Name]", "[Company]",
  "<redacted>", "home country", or "his son's preschool". The placeholder
  destroys the memory.
- Generalize a list of specific people or things into one collective noun.
  Example: "Jin, Priya, Liam, Sara" must NOT collapse into "the team" or
  "colleagues and their locations". Keep every name.
- Collapse specific concrete objects into the activity category. Example:
  "made bowls and a cup in pottery class" must NOT become "did pottery" —
  keep "bowls" and "cup".
- Paraphrase a specific identity into a category. Example: "oat latte" must NOT
  become "non-dairy milk preference".
- Drop numbers. Example: "7 years of experience at Google" must NOT become
  "several years of experience".

Redaction is a FAILURE MODE for this task. If you are unsure whether to keep a
name or number, KEEP IT.`;

/**
 * Assembles session metadata block from validated inputs for deterministic LLM extraction
 * prompts.
 */
export const GRANULARITY_RULE = `# GRANULARITY — ONE TOPIC SLOT PER MEMORY (MANDATORY)

Each memory covers ONE topic slot. Do NOT combine unrelated topics into a single
memory — retrieval works by topic similarity, and a memory that mixes 10 topics
answers none of them well.

Topic slots are narrow. These are separate topics, each deserving its own memory:
- editor preference (e.g. Zed)
- terminal preference (e.g. Ghostty)
- shell prompt preference (e.g. Starship)
- indentation preference (e.g. tabs vs spaces)
- daily-languages preference (e.g. Rust + TypeScript)
- linter preference (e.g. Biome over ESLint)
- package-manager preference (e.g. npm)
- database preference (e.g. Postgres)
- KV / cache preference (e.g. Redis, Dragonfly)
- messaging preference (e.g. NATS.io)
- container runtime preference (e.g. Podman)
- deploy-target preference (e.g. Fly.io, Google Cloud Run)
- hardware preference (e.g. MacBook Pro M4 Max)

A single user turn listing many preferences should produce MANY memories — one
per topic slot — not a single "Coding Stack" mega-memory. It is better to emit
8 focused memories than 1 bloated one.

Similarly for entity memories: job history is ONE topic per role. "3 years at DeepMind"
and "4 years at Google" are DIFFERENT topics, even though both describe prior
employment. Create them as separate entity memories with stated duration AND
any start dates kept inside the SAME per-role entity (do NOT fork "Employment
dates" into a separate memory — the answering model may then sum dates instead
of using the stated years).

When the user says "migrated from X to Y" / "switched from X to Y" / "sold X,
got Y": emit BOTH a dated \`episodic\` record for the change AND a \`profile\`
record for the updated current state. See the migration few-shot in the examples
section for the required two-memory output shape.`;
