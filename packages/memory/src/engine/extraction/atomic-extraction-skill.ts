/** @file atomic-extraction-skill.ts
 * @purpose Loads the model-readable atomic memory extraction method shipped with the plugin.
 * @boundary Package-relative read of one trusted bundled skill.
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_PATH = path.join("skills", "extract-atomic-memory", "SKILL.md");

function resolveSkillPath(): string {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	for (const root of [
		path.resolve(moduleDir, ".."),
		path.resolve(moduleDir, "../.."),
		path.resolve(moduleDir, "../../.."),
	]) {
		const candidate = path.join(root, SKILL_PATH);
		if (existsSync(candidate)) return candidate;
	}
	throw new Error(`sno-station-mem atomic extraction skill is missing: ${SKILL_PATH}`);
}

/** The body only: the frontmatter names the skill for tooling and is not part of the prompt. */
function stripFrontmatter(text: string): string {
	if (!text.startsWith("---\n")) return text;
	const end = text.indexOf("\n---\n", 4);
	return end === -1 ? text : text.slice(end + 5).replace(/^\n+/u, "");
}

const SKILL_FILE = resolveSkillPath();

const loadedSkillFile = readFileSync(SKILL_FILE, "utf8");
const calendarMeaning = readFileSync(path.join(path.dirname(SKILL_FILE), "references", "calendar-meaning.md"), "utf8");
export const ATOMIC_EXTRACTION_SKILL: string = `${stripFrontmatter(loadedSkillFile)}\n\n${calendarMeaning}`;

const REFERENCE_NAMES = [
	"capture",
	"enrichment",
	"calendar-meaning",
	"account-for-turns",
	"resolve-subject",
	"missing-durable-half",
	"user-subject-guard",
	"progress-classification",
	"surrounding-context",
] as const;
export type AtomicExtractionSkillReference = (typeof REFERENCE_NAMES)[number];

const references = new Map<AtomicExtractionSkillReference, string>(
	REFERENCE_NAMES.map((name) => [
		name,
		readFileSync(path.join(path.dirname(SKILL_FILE), "references", `${name}.md`), "utf8").trim(),
	]),
);

export const ATOMIC_EXTRACTION_SKILL_HASH: string = createHash("sha256")
	.update(loadedSkillFile).update(calendarMeaning)
	.update(atomicExtractionSkillReference("capture"))
	.update(atomicExtractionSkillReference("enrichment")).digest("hex");

/**
 * The task-specific text the engine appends for one call. The model reading the skill has no
 * tools and cannot fetch a file, so the engine composes the prompt: the core plus exactly one of
 * these, instead of one long file carrying every task at once.
 */
export function atomicExtractionSkillReference(name: AtomicExtractionSkillReference): string {
	const text = references.get(name);
	if (text === undefined) throw new Error(`sno-station-mem atomic extraction skill reference missing: ${name}`);
	return text;
}
