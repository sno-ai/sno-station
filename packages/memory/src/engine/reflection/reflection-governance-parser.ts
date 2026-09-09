/** @file reflection-governance-parser.ts
 * @purpose Parses reflection lessons and learning-governance candidates.
 * @boundary Governance markdown extraction only; storage and promotion are out of scope.
 */

import {
	extractSectionMarkdown,
	parseSectionBullets,
} from "./reflection-markdown-sections";
import {
	PARSER_HEADINGS,
	type ReflectionGovernanceEntry,
} from "./reflection-markdown-types";
import { sanitizeReflectionSliceLines } from "./reflection-slice-sanitizer";

/** Extracts reflection lessons from raw runtime payloads with partial-data tolerance. */
export function extractReflectionLessons(reflectionText: string): string[] {
	return sanitizeReflectionSliceLines(
		parseSectionBullets(reflectionText, PARSER_HEADINGS.lessonsAndPitfalls),
	);
}

/**
 * Extracts reflection learning governance candidates from raw inputs while tolerating partial
 * data.
 */
export function extractReflectionLearningGovernanceCandidates(
	reflectionText: string,
): ReflectionGovernanceEntry[] {
	const section = extractSectionMarkdown(reflectionText, PARSER_HEADINGS.learningGovernance);
	if (!section) return [];

	const entryBlocks = section
		.split(/(?=^###\s+Entry(?![\p{L}\p{N}]))/gimu)
		.map((block) => block.trim())
		.filter(Boolean);

	const parsed = entryBlocks
		.map(parseReflectionGovernanceEntry)
		.filter((entry): entry is ReflectionGovernanceEntry => entry !== null);

	if (parsed.length > 0) return parsed;

	const fallbackBullets = sanitizeReflectionSliceLines(
		parseSectionBullets(reflectionText, PARSER_HEADINGS.learningGovernance),
	);
	if (fallbackBullets.length === 0) return [];

	return [
		{
			priority: "medium",
			status: "pending",
			area: "config",
			summary: "Reflection learning governance candidates",
			details: fallbackBullets.map((line) => `- ${line}`).join("\n"),
			suggestedAction:
				"Review the governance candidates, promote durable rules to AGENTS.md / SOUL.md / TOOLS.md when stable, and extract a skill if the pattern becomes reusable.",
		},
	];
}

/**
 * Parses reflection governance entry into the normalized shape used by reflection text
 * slicing.
 */
function parseReflectionGovernanceEntry(block: string): ReflectionGovernanceEntry | null {
	const body = block.replace(/^###\s+Entry(?![\p{L}\p{N}])[^\n]*\n?/iu, "").trim();
	if (!body) return null;

	/** Reads field and applies reflection text slicing fallback behavior for missing data. */
	const readField = (label: string): string | undefined => {
		const match = body.match(new RegExp(`^\\*\\*${label}\\*\\*:\\s*(.+)$`, "im"));
		const value = match?.[1]?.trim();
		return value ? value : undefined;
	};

	/** Reads section and applies reflection text slicing fallback behavior for missing data. */
	const readSection = (label: string): string | undefined => {
		const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const match = body.match(
			new RegExp(`^###\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=^###\\s+|$)`, "im"),
		);
		const value = match?.[1]?.trim();
		return value ? value : undefined;
	};

	const summary = readSection("Summary");
	if (!summary) return null;

	return {
		priority: readField("Priority"),
		status: readField("Status"),
		area: readField("Area"),
		summary,
		details: readSection("Details"),
		suggestedAction: readSection("Suggested Action"),
	};
}
