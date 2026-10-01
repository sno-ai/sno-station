/** @file retired-position-judgment-skill.ts
 * @purpose Loads the model-readable retired-position judgment method shipped with the plugin.
 * @boundary Package-relative read of one trusted bundled skill.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_PATH = path.join("skills", "judge-retired-position", "SKILL.md");

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
	throw new Error(`sno-station-mem retired-position judgment skill is missing: ${SKILL_PATH}`);
}

const skillText = readFileSync(resolveSkillPath(), "utf8");

function readSection(heading: string): string {
	const marker = `## ${heading}\n`;
	const start = skillText.indexOf(marker);
	if (start === -1) throw new Error(`retired-position judgment skill is missing section: ${heading}`);
	const bodyStart = start + marker.length;
	const nextSection = skillText.indexOf("\n## ", bodyStart);
	return skillText.slice(bodyStart, nextSection === -1 ? undefined : nextSection).trim();
}

export type RetiredPositionJudgmentSkill = {
	readonly currentPositionMatch: string;
	readonly retirementRecheck: string;
};

export const RETIRED_POSITION_JUDGMENT_SKILL: RetiredPositionJudgmentSkill = {
	currentPositionMatch: readSection("Current Position Match"),
	retirementRecheck: readSection("Retirement Recheck"),
};
