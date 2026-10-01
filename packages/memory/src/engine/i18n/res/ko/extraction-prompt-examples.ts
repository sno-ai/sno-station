/** @file extraction-prompt-examples.ts
 * @purpose Holds locale-specific few-shot examples for memory extraction.
 * @boundary LLM prompt assembly internals for this locale.
 */

const PROFILE_IDENTITY_SECTION = `identity`;

export const FEW_SHOT_EXAMPLES: string = `# Few-shot Examples (foundation kinds)

## profile: identity
\`\`\`json
{
  "category": "profile",
  "section_name": "${PROFILE_IDENTITY_SECTION}",
  "abstract": "User identity: Alex Chen, research engineer in San Francisco",
  "overview": "## Identity\\n- Name: Alex Chen\\n- Role: Research engineer\\n- Location: San Francisco",
  "content": "User is Alex Chen, a research engineer who lives in San Francisco."
}
\`\`\`

## profile: preference
\`\`\`json
{
  "category": "profile",
  "section_name": "preferences.coffee",
  "abstract": "Coffee preference: oat latte",
  "overview": "## Preference\\n- Topic: coffee\\n- Choice: oat latte",
  "content": "User's coffee preference is an oat latte."
}
\`\`\`

## profile: durable entity
\`\`\`json
{
  "category": "profile",
  "section_name": "entities.project-glacier",
  "abstract": "Project Glacier team includes Jin Park, Priya Sharma, Liam O'Connor, and Sara",
  "overview": "## Entity\\n- Project: Project Glacier\\n- Jin Park: backend\\n- Priya Sharma: frontend\\n- Liam O'Connor: infra\\n- Sara: data",
  "content": "Project Glacier is a memory research project. Jin Park handles backend retrieval, Priya Sharma owns the frontend dashboard, Liam O'Connor works on infrastructure, and Sara is on data."
}
\`\`\`

## episodic: event with date
\`\`\`json
{
  "category": "episodic",
  "abstract": "Decided on 2026-04-15 to use Lance instead of pgvector for Glacier vectors",
  "overview": "## Event\\n- Date: 2026-04-15\\n- Decision: Lance\\n- Rejected: pgvector\\n- Reason: better precision-recall performance",
  "content": "On April 15, 2026, the Glacier team decided to use Lance as the vector store instead of pgvector because Lance performed better for precision recall.",
  "event_at": "2026-04-15",
  "relations": [{ "type": "chosen_for", "target": "Project Glacier" }]
}
\`\`\`

## episodic: dated life event preserves timeline
\`\`\`json
{
  "category": "episodic",
  "abstract": "Moved from Seattle to San Francisco on 2026-03-15",
  "overview": "## Event\\n- Date: 2026-03-15\\n- From: Seattle\\n- To: San Francisco\\n- Residence: Mission District, Valencia Street",
  "content": "User moved from Seattle to San Francisco on March 15, 2026 and closed on a two-bedroom apartment on Valencia Street in the Mission District.",
  "event_at": "2026-03-15"
}
\`\`\`

## episodic: one-off entity mention
\`\`\`json
{
  "category": "episodic",
  "abstract": "Alice worked at OpenAI when the user met her",
  "overview": "Alice worked at OpenAI when the user met her.",
  "content": "Alice worked at OpenAI when the user met her.",
  "entity_kind": "person",
  "relations": [{ "type": "works_at", "target": "OpenAI" }]
}
\`\`\`

## migration / replacement: emit event plus current profile state

User said: "We migrated off Redis to Dragonfly on May 3, 2026."

\`\`\`json
{
  "memories": [
    {
      "category": "episodic",
      "abstract": "Migrated KV layer from Redis to Dragonfly on 2026-05-03",
      "overview": "## Event\\n- Date: 2026-05-03\\n- From: Redis\\n- To: Dragonfly",
      "content": "On May 3, 2026, the team migrated the KV layer from Redis to Dragonfly.",
      "event_at": "2026-05-03"
    },
    {
      "category": "profile",
      "section_name": "entities.team-kv-cache",
      "abstract": "Team KV/cache current state: Dragonfly",
      "overview": "## Entity\\n- Entity: team KV/cache layer\\n- Current state: Dragonfly",
      "content": "The team's current KV/cache layer is Dragonfly."
    }
  ]
}
\`\`\`

## TWO_RECORD_RULE_V1: durable habit plus dated occurrence

User said: "My usual coffee is an oat latte, and on May 10, 2026 I paid $7.27 for one."

\`\`\`json
{
  "memories": [
    {
      "category": "episodic",
      "abstract": "Bought an oat latte for $7.27 on 2026-05-10",
      "overview": "## Event\\n- Date: 2026-05-10\\n- Purchase: oat latte\\n- Amount: $7.27",
      "content": "On May 10, 2026, the user bought an oat latte for $7.27.",
      "event_at": "2026-05-10"
    },
    {
      "category": "profile",
      "section_name": "preferences.coffee",
      "abstract": "Usual coffee: oat latte",
      "overview": "## Preference\\n- Topic: usual coffee\\n- Choice: oat latte",
      "content": "The user's usual coffee is an oat latte."
    }
  ]
}
\`\`\`

## task completion: update the current task list AND keep the timeline event

User said: "I've finished preparing the conference abstract — take it off my to-do list."

\`\`\`json
{
  "memories": [
    {
      "category": "episodic",
      "abstract": "Completed the conference abstract on 2026-06-30",
      "overview": "## Event\\n- Date: 2026-06-30\\n- Completed: conference abstract",
      "content": "On June 30, 2026, the user finished preparing the conference abstract.",
      "event_at": "2026-06-30"
    },
    {
      "category": "profile",
      "section_name": "active_tasks",
      "abstract": "Completed task: prepare the conference abstract",
      "overview": "## Active tasks\\n- Done: prepare the conference abstract",
      "content": "The user completed the task 'prepare the conference abstract'; remove it from the active task list."
    }
  ]
}
\`\`\`

## reporting verb: durable content only, no episodic record

User said: "I've noticed I consistently prefer quiet workspaces."

\`\`\`json
{
  "memories": [
    {
      "category": "profile",
      "section_name": "preferences.workspace",
      "abstract": "Workspace preference: quiet",
      "overview": "## Preference\\n- Topic: workspace\\n- Choice: quiet",
      "content": "The user consistently prefers quiet workspaces."
    }
  ]
}
\`\`\`

Do not emit an \`episodic\` record for the act of noticing.

## SPLIT example

User said: "For coding preferences: my daily languages are Rust and TypeScript. I strongly prefer tabs for indentation, never spaces. My editor is Zed."

Correct extraction:
\`\`\`json
{
  "memories": [
    {"category":"profile","section_name":"preferences.programming-languages","abstract":"Daily coding languages: Rust and TypeScript","overview":"## Preference\\n- Topic: daily coding languages\\n- Languages: Rust, TypeScript","content":"User's daily coding languages are Rust and TypeScript."},
    {"category":"profile","section_name":"preferences.indentation","abstract":"Indentation preference: tabs, never spaces","overview":"## Preference\\n- Topic: indentation\\n- Choice: tabs\\n- Avoid: spaces","content":"User strongly prefers tabs over spaces for indentation."},
    {"category":"profile","section_name":"preferences.editor","abstract":"Editor preference: Zed","overview":"## Preference\\n- Topic: editor\\n- Choice: Zed","content":"User's editor is Zed."}
  ]
}
\`\`\`

Wrong extraction:
\`\`\`json
{
  "category": "profile",
  "section_name": "preferences.coding",
  "abstract": "Coding stack: Rust, TypeScript, tabs, Zed, Ghostty, Starship, Postgres, Redis, NATS.io, Tailwind"
}
\`\`\`

Do not create bloated profile rows. Split independent current-state slots.

## BAD examples
\`\`\`
legacy category identity       <- reject
legacy category preference     <- reject
legacy category entity         <- reject
legacy category event          <- reject
"category": "lesson" from ambient extraction               <- reject
"category": "profile" without "section_name"           <- reject
"category": "persona" from ambient extraction           <- reject
"category": "summary" from ambient extraction           <- reject
"abstract": "User's son attends preschool: [Preschool Name]"   <- placeholder, destroys recall
"abstract": "User's team members and their locations"          <- collapsed concrete names
\`\`\``;
