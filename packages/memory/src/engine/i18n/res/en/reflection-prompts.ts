/** @file reflection-prompts.ts
 * @purpose Builds reflection prompt + fallback text for the reflection pipeline (en locale).
 * @see ../../../daily-log-generator/daily-log-generator.ts.
 */

import type { ReflectionErrorSignalLike } from "../_types";

const REFLECTION_FALLBACK_MARKER =
	"(fallback) Reflection generation failed; storing minimal pointer only.";

export function buildReflectionPrompt(
	conversation: string,
	maxInputChars: number,
	toolErrorSignals: ReadonlyArray<ReflectionErrorSignalLike> = [],
): string {
	void maxInputChars;
	const promptInput = conversation;
	const errorHints =
		toolErrorSignals.length > 0
			? toolErrorSignals
					.map(
						(e, i) => `${i + 1}. [${e.toolName}] ${e.summary} (sig:${e.signatureHash.slice(0, 8)})`,
					)
					.join("\n")
			: "- (none)";

	return [
		"You are generating a durable MEMORY REFLECTION entry for an AI assistant system.",
		"Align with a self-improvement workflow: governance -> distill -> promote.",
		"",
		"Goal: extract high-signal knowledge and reflection material. Do NOT paste raw transcript.",
		"Write ONLY Markdown. Be concise but information-dense.",
		"",
		"Hard rules:",
		"- Do NOT copy long quotes from the conversation.",
		"- Extract decisions, preferences, lessons, pitfalls, and next actions.",
		"- If any secret/token/password appears, keep it as [REDACTED_SECRET] (never reconstruct).",
		"- If there were tool failures, turn them into actionable learning/error candidates.",
		"",
		"Output sections (use these exact headings):",
		"## Context",
		"## Decisions (durable)",
		"## User model deltas (about the human)",
		"## Agent model deltas (about the assistant/system)",
		"## Lessons & pitfalls (symptom / cause / fix / prevention)",
		"## Learning governance candidates (.learnings / promotion / skill extraction)",
		"## Open loops / next actions",
		"## Retrieval tags / keywords",
		"## Invariants",
		"## Derived",
		"",
		"Guidance for the final two sections (keep them short):",
		"- Invariants = stable cross-session rules only. Each bullet must read like a rule/policy, not a diary note.",
		"- Write invariants in executable rule form, such as: Always / Never / When X, do Y / Prefer / Avoid / Require.",
		"- Do NOT put one-off observations, temporary follow-ups, or vague reflections in Invariants.",
		"- Derived = latest-run deltas only. Keep only changes exposed by THIS run that should influence the NEXT run.",
		"- Write derived bullets as concrete next-run adjustments, such as: This run showed ... / Next run ... / Re-check ... / Avoid repeating ...",
		"- Do NOT restate long-term rules in Derived.",
		"",
		"For 'Learning governance candidates', prefer this structure:",
		"- LRN candidate(s): correction / best_practice / knowledge_gap",
		"- ERR candidate(s): reproducible failure signature + fix",
		"- FEAT candidate(s): missing capability request",
		"- Promotion candidates: AGENTS.md / SOUL.md / TOOLS.md concise rules",
		"- Skill extraction candidate: name + why reusable + source learning id placeholder",
		"",
		"Recent tool error signals (PostToolUse-style detector):",
		errorHints,
		"",
		"INPUT (cleaned recent conversation; role-prefixed):",
		"```",
		promptInput,
		"```",
	].join("\n");
}

export function buildReflectionFallbackText(): string {
	return [
		"## Context",
		`- ${REFLECTION_FALLBACK_MARKER}`,
		"",
		"## Decisions (durable)",
		"- (none captured)",
		"",
		"## User model deltas (about the human)",
		"- (none captured)",
		"",
		"## Agent model deltas (about the assistant/system)",
		"- (none captured)",
		"",
		"## Lessons & pitfalls (symptom / cause / fix / prevention)",
		"- (none captured)",
		"",
		"## Learning governance candidates (.learnings / promotion / skill extraction)",
		"- ERR candidate: investigate last failed tool execution and log to .learnings/ERRORS.md",
		"",
		"## Open loops / next actions",
		"- Investigate why embedded reflection generation failed.",
		"",
		"## Retrieval tags / keywords",
		"- memory-reflection",
		"",
		"## Invariants",
		"- (none captured)",
		"",
		"## Derived",
		"- Investigate why embedded reflection generation failed before trusting any next-run delta.",
	].join("\n");
}
