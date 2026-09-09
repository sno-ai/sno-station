/** @file extraction-prompts.ts
 * @purpose Builds prompt text for structured memory extraction from conversation context.
 * @boundary Capture policy, JSON contracts, and LLM model behavior.
 * @see memory-extraction-pipeline.ts, llm-client.ts, capture-policy-detector.ts.
 */

/**
 * Prompt templates for the LLM extraction memory pipeline.
 *
 * Exports three builders, each returning a fully-fenced prompt string:
 *   - `buildExtractionPrompt` — two-kind live extraction with verbatim
 *     entity preservation and temporal resolution against a session anchor.
 *   - `buildDedupPrompt` — classifies a candidate against existing memories
 *     as skip or create.
 *     selects `merge`.
 *
 * Untrusted input (conversation text, candidate fields, existing memories) is
 * wrapped in a per-invocation random-UUID fence; the prompt instructs the
 * model to treat fenced bytes as inert data. The fence id is freshly
 * generated per call, so an attacker controlling the input cannot pre-compute
 * a matching close-fence to escape the boundary.
 */

import { randomUUID } from "node:crypto";

/**
 * Assembles data boundary rule from validated inputs for deterministic LLM extraction prompts.
 */
import {
	buildDataBoundaryRule,
	buildSessionMetadataBlock,
	buildTemporalResolutionRule,
	fenceUntrusted,
} from "./extraction-prompt-boundary";
import { FEW_SHOT_EXAMPLES } from "./extraction-prompt-examples";
import { GRANULARITY_RULE, VERBATIM_RULE } from "./extraction-prompt-rules";

export function buildExtractionPrompt(
	conversationText: string,
	user: string,
	sessionDateTime?: string,
	sessionTimezone?: string,
	activeProfileSectionNames: readonly string[] = [],
): string {
	// Compute the normalized session metadata once so later memory extraction checks use one value.
	const sessionMetadata = buildSessionMetadataBlock(sessionDateTime, sessionTimezone);
	// Compute the normalized temporal resolution rule once so later memory extraction checks use one value.
	const temporalResolutionRule = buildTemporalResolutionRule(sessionDateTime, sessionTimezone);
	// Compute the normalized fence id once so later memory extraction checks use one value.
	const fenceId = randomUUID();
	// Compute the normalized data boundary rule once so later memory extraction checks use one value.
	const dataBoundaryRule = buildDataBoundaryRule(fenceId);
	// Compute the normalized fenced conversation once so later memory extraction checks use one value.
	const fencedConversation = fenceUntrusted(fenceId, "CONVERSATION", conversationText);
	const fencedUser = fenceUntrusted(fenceId, "USER", user);
	const fencedProfileSectionNames = fenceUntrusted(
		fenceId,
		"ACTIVE_PROFILE_SECTION_NAMES",
		JSON.stringify(activeProfileSectionNames),
	);

	// Centralize the memory extraction fallback value at the boundary of this helper.
	return `Analyze the following session context and extract memories worth long-term preservation.

User:
${fencedUser}

Target Output Language: auto (detect from recent messages)

${dataBoundaryRule}

## Active Profile Section Names
${fencedProfileSectionNames}
These are addresses only, not memory content. When a profile candidate updates or retracts
the same current-state slot, reuse its exact existing name. Invent a new name only when no
listed address describes that slot.

${sessionMetadata}## Recent Conversation
${fencedConversation}

${VERBATIM_RULE}

${temporalResolutionRule}

${GRANULARITY_RULE}

# Memory Extraction Criteria

## What is worth remembering?
- Personalized information: Information specific to THIS user — their names, relationships, preferences, tools, history.
- Long-term validity: Information that will still be useful in future sessions.
- Specific and clear: Has concrete details (names, dates, numbers) — not vague generalizations.

## What is NOT worth remembering?
- General knowledge that anyone would know.
- System/platform metadata: message IDs, sender IDs, timestamps, channel info, JSON envelopes (e.g. "System: [timestamp] Feishu...", "message_id", "sender_id", "ou_xxx") — infrastructure noise, NEVER extract.
- Temporary information: one-time questions.
- Vague information: "User has questions about a feature" (no specific details).
- Tool output, error logs, or boilerplate.
- Runtime scaffolding: "[Subagent Context]", "[Subagent Task]", bootstrap wrappers, task envelopes — NEVER store.
- Raw conversation carryover: quoted or attributed transcript blocks (especially 3+ lines of "user:"/"assistant:" speaker text), compaction notices, model-switch or session-reset traces, tool-call transcripts, and raw JSON blobs are not memories by themselves — distill one concrete fact/preference/entity/decision or skip.
- Fragment blobs: mixed filename shards, code snippets, stray metadata fields, or partial sentences that look like unprocessed context fragments — skip rather than preserve.
- Recall queries: "Do you remember X?" — retrieval requests, not new info.
- Hollow references: if the user mentions something vaguely ("that thing I said"), do NOT invent details.

# Memory Classification — TWO_RECORD_RULE_V1
Split each worth-remembering sentence into its atomic ideas before classifying each candidate.
Then ask two independent questions per candidate:

1. Is this a durable current-state fact about the user — their preferences, stable identity,
   active tasks, or durable entities they care about?
   - YES → emit \`category: "profile"\` (MUST include \`section_name\`).
2. Did something happen, change, complete, or get decided at a point in time?
   - YES → emit \`category: "episodic"\`.

The questions are independent. If both answers are YES, emit both records. If both answers
are NO, drop the candidate.

A general or habitual assertion with stable or recurring scope remains a durable current-state
fact even when embedded in a sentence describing an occurrence. Emit it as a separate
\`profile\` record rather than leaving it only in the \`episodic\` description.

A command to add, remove, complete, or stop tracking content expresses a requested state
mutation, not a like, dislike, or other preference about that content. Do not infer a
preference unless the user states one independently.

A description of work, a project, an analysis, instructions, metrics, or a message is not a
user preference merely because the user owns or discusses it.

Never output \`identity\`, \`preference\`, \`entity\`, \`event\`, \`fact\`, \`decision\`, \`lesson\`, \`persona\`, \`summary\`, \`other\`, \`others\`, or \`reflection\` as \`category\`. Ambient extraction writes only \`profile\` and \`episodic\`. There is no catch-all category. Drop low-value snippets instead of using a fallback bucket.

## Output Principles
- **Atomicity**: One memory per idea. Split independent facts into separate records.
- **Distillation over transcription**: Each record must read like one durable profile fact or episodic event — not an excerpt, log, or transcript. If a candidate is longer than ~200 characters and reads like raw conversation rather than a distilled insight, rewrite it as one factual statement; if that is not possible, skip it.
- **Specificity**: Include concrete entities and useful context. Include dates and transition context in \`episodic\` records. A \`profile\` record contains only current state. Avoid vague statements like "user likes X" without useful detail.
- **Temporal resolution**: For dynamic memories, resolve relative dates/times against \`session_date_time\` when possible. If unresolved, keep the original phrase in \`temporal_phrase\`.
- **Timeline preservation**: For dated life events (moves, residence changes, job starts, school starts, travel, or family events), preserve the event date and resulting state in the same memory. A dated residence/move fact and a dated job fact are separate topic slots; do not collapse one into the other.
- **Category boundaries**:
  - \`profile\`: current-state facts about the user, their preferences, durable entities, and active tasks. MUST include \`section_name\`.
  - \`episodic\`: append-only timeline items, one-off entity mentions, milestones, plans, incidents, completed work, and explicit decisions.
- **Profile field boundary**: In every \`profile\` record, \`abstract\`, \`overview\`, and \`content\` state only the post-change current state. Never include prior or incorrect values, transition narration, or event dates; those belong in the paired \`episodic\` record.
- **TWO_RECORD_RULE_V1 — occurrences and durable state**: Something that HAPPENED — an action, event, or occurrence at a point in time, a purchase included — is ALWAYS an \`episodic\` event, even when the sentence editorializes about it. A \`profile\` row holds only durable state such as a limit, habit, or identity fact. If one sentence states BOTH durable state AND an occurrence, emit TWO records. Never fold the occurrence or its transaction amount into the profile record.
- **Reporting-verb transparency**: A reporting or realization verb such as "I just remembered", "I've noticed", or "I realized" is transparent. Classify the content behind the verb, not the act of saying it. The act of remembering, noticing, or realizing is not itself an occurrence and must never create an \`episodic\` record. Only the reported content may satisfy the episodic question. Durable reported content yields one \`profile\` record and no dated reporting event. Reported content that is itself an occurrence follows the occurrence rule normally.
- **State mutation in both directions**: When an occurrence changes durable state already stored — a task completed, an item removed from tracked content, or a stated preference retracted — ALWAYS emit the dated \`episodic\` occurrence AND a \`profile\` mutation candidate for the affected section. For a completed, cancelled, removed, or no-longer-tracked task, the profile candidate uses \`section_name: active_tasks\` and states the task transition even when no remaining task is named. Its abstract, overview, and content mention only the POST-change current state; prior, incorrect, completed, removed, and retracted values stay out of all three fields. Never preserve only the pre-change state and never store nothing. Extraction deletes no rows; supersession is the only mutation.
- **Active-task lifecycle**: A to-do is a discrete action the user can finish and tick off; a project description, a deliverable, an ongoing goal, or "the user is working on X" is not a to-do. "I plan to" or "I'm going to" followed by a finishable action opens a to-do; a habit, a routine, or a recurring limit does not. A to-do is done only when the user explicitly says the to-do was done; "I'll do it later today" is not done, and saying the user bought or paid for an item is only a related occurrence and never completes a "buy" to-do.
- **Title guidance**:
  - \`profile\`: \`[section]: [Specific current-state description]\`.
  - \`episodic\`: concrete description with dates/entities when available.
- **Content guidance**: Use the complete message context. Preserve enough evidence for later retrieval.
- **Deduplication**: Do not emit a memory already present in the provided existing memories unless it materially updates, supersedes, or contradicts it.

## Examples
${FEW_SHOT_EXAMPLES}

# Structured fields

The JSON schema requires or allows these fields:
- **section_name** (profile only, REQUIRED): canonical profile section. Use \`identity\`, \`preferences.<topic>\`, \`entities.<id>\`, or \`active_tasks\`. Use lowercase slugs for topic/id segments. Before inventing a section, inspect existing memories. A change or retraction to an existing current-state slot MUST copy that row's exact \`section_name\` so supersession reaches it. Reuse one canonical slug per topic across turns; variant slugs fragment the same fact and prevent supersession. Pick the most specific durable noun for the topic and keep using exactly that slug for every later update to it.
- **event_at** (episodic only): Absolute ISO-8601 date/time when the event happened. Emit only when explicitly stated or resolvable from a relative phrase against \`session_date_time\`.
- **temporal_phrase**: Original relative phrase when it carries useful temporal meaning (for example "next Friday", "last week", "tomorrow morning").
- **valid_from / valid_until**: Interval bounds for dynamic profile facts when supported by the conversation or temporal resolution.
- **entity_kind** (episodic one-off entity mentions only): \`person\`, \`organization\`, \`place\`, \`project\`, \`account\`, \`object\`, or \`other\`. This \`other\` value is only an entity kind, not a memory category.
- **relations** (episodic only): Subject-predicate-object relation objects. Use \`source\` only when the subject differs from this record's event/entity. Prefer 0-3 high-signal relations; hard cap 16; never pad.
- **confidence**: 0.0-1.0 confidence in the extracted memory.
- **source_span**: Short quote or paraphrase that supports the memory.
{
  "memories": [
    {
      "category": "episodic",
      "abstract": "Alice worked at OpenAI when the user met her.",
      "overview": "Alice worked at OpenAI when the user met her.",
      "content": "Alice worked at OpenAI when the user met her.",
      "entity_kind": "person",
      "relations": [{ "type": "works_at", "target": "OpenAI" }]
    },
    {
      "category": "episodic",
      "abstract": "Alice joined DeepMind",
      "overview": "Alice joined DeepMind on September 1, 2022.",
      "content": "Alice joined DeepMind on September 1, 2022.",
      "event_at": "2022-09-01",
      "relations": [{ "type": "joined", "target": "DeepMind" }]
    }
  ]
}

Notes:
- Output language: match the dominant language in the conversation.
- If nothing worth recording, return {"memories": []}.
- Cap 10 memories per extraction.
- For section_name: include it for every profile record.
- For event_at / entity_kind / relations: omit when not applicable, never guess.`;
}

/** Assembles dedup prompt from validated inputs for deterministic LLM extraction prompts. */
// LH: Dedup prompts expose only create/skip because mutation decisions belong to later writer stages.
// LH: The prompt intentionally omits match indexes and context labels; the runtime stores or skips only.
export function buildDedupPrompt(
	candidateAbstract: string,
	candidateOverview: string,
	candidateContent: string,
	existingMemories: string,
): string {
	// Compute the normalized fence id once so later memory extraction checks use one value.
	const fenceId = randomUUID();
	const dataBoundaryRule = buildDataBoundaryRule(fenceId);
	const fencedCandidate = fenceUntrusted(
		fenceId,
		"CANDIDATE_MEMORY",
		`Abstract: ${candidateAbstract}
Overview: ${candidateOverview}
Content: ${candidateContent}`,
	);
	const fencedExisting = fenceUntrusted(fenceId, "EXISTING_MEMORIES", existingMemories);

	// Centralize the memory extraction fallback value at the boundary of this helper.
	return `Determine how to handle this candidate memory.

${dataBoundaryRule}

**Candidate Memory**:
${fencedCandidate}

**Existing Similar Memories**:
${fencedExisting}

Please decide:
- \`skip\`: Candidate duplicates an existing memory with equal or less information. Also \`skip\` if the candidate contains LESS information than an existing memory on the same topic (e.g., candidate "programming language preference" vs existing "programming language preference: Python, TypeScript").
- \`create\`: Candidate contains new durable information, adds DISTINCT proper nouns the existing memories do not cover, changes a current-state value, preserves a separate timeline fact, or should be retained for later conflict handling. When in doubt, \`create\` — a lost entity is harder to fix than a duplicate.

IMPORTANT:
- This gate has exactly two valid decisions: \`skip\` and \`create\`.
- Never output any other decision name.
- Do not mutate, link, or close existing memories in this gate.
- "episodic" and "lesson" are append-only records. Only \`skip\` or \`create\`.
- If the candidate appears to be derived from a recall question and an existing memory already covers that topic with equal or more detail, you MUST choose \`skip\`.
- A candidate with LESS information than an existing memory on the same topic: never \`create\` — always \`skip\`.
- For profile current-state facts, if the same mutable current-state slot has a newer value, choose \`create\` so the new value is preserved.
- If candidate and existing memory mention DIFFERENT proper nouns (different people, different products, different places), prefer \`create\` — they are different entities.
- TEMPORAL TIMELINE FACTS: a dated residence, job, school, travel, or life event is not a duplicate of a different dated fact just because both mention the same person. If the facts can both be true at different times, preserve the older fact as historical evidence and \`create\` the new fact unless they are the same slot with no added detail.
- RESIDENCE + JOB ORDER: a move/residence fact with a date (e.g. "moved to San Francisco on March 15, 2026") and a job-start fact with a later date (e.g. "started at Anthropic on April 1, 2026") are different topic slots. Keep both so before/after questions can be answered.
- MIGRATION CHANGES: if the candidate preference explicitly says "replaced X" / "migrated from X" / "switched from X" and an existing memory holds the same topic slot with value X, choose \`create\` — the new value is the active truth.
- DURATION + DATE DETAIL: if the candidate says the same role's start date (e.g. "DeepMind start date September 2022") and an existing memory is the same role with stated duration (e.g. "Prior job: DeepMind — 3 years"), choose \`create\` — the date adds detail.

Return JSON format:
{
  "decision": "create",
  "reason": "Decision reason"
}`;
}
