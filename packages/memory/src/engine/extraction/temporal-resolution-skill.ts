/** @file temporal-resolution-skill.ts
 * @purpose Loads the model-readable relative-time method shipped with the plugin.
 * @boundary Package-relative read and deterministic section selection only.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_PATH = path.join("skills", "resolve-relative-time", "SKILL.md");

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
	throw new Error(`sno-station-mem relative-time skill is missing: ${SKILL_PATH}`);
}

const skillText = readFileSync(resolveSkillPath(), "utf8");

function readSection(heading: string): string {
	const marker = `## ${heading}\n`;
	const start = skillText.indexOf(marker);
	if (start === -1) throw new Error(`relative-time skill is missing section: ${heading}`);
	const bodyStart = start + marker.length;
	const nextSection = skillText.indexOf("\n## ", bodyStart);
	return skillText.slice(bodyStart, nextSection === -1 ? undefined : nextSection).trim();
}

const WITH_SESSION_ANCHOR = readSection("With Session Anchor");
const WITHOUT_SESSION_ANCHOR = readSection("Without Session Anchor");

export function buildTemporalResolutionRule(
	sessionDateTime?: string,
	_sessionTimezone?: string,
): string {
	return sessionDateTime ? WITH_SESSION_ANCHOR : WITHOUT_SESSION_ANCHOR;
}
