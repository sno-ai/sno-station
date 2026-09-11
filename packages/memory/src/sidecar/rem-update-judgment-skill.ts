/** @file rem-update-judgment-skill.ts
 * @purpose Loads the model-readable REM update judgment method shipped with the plugin.
 * @boundary Package-relative read of one trusted bundled skill.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REM_UPDATE_SKILL_PATH = path.join("skills", "judge-rem-memory-updates", "SKILL.md");
const GROUP_CLOSURE_SKILL_PATH = path.join("skills", "judge-group-closure", "SKILL.md");

function resolveSkillPath(skillPath: string): string {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	for (const root of [
		path.resolve(moduleDir, ".."),
		path.resolve(moduleDir, "../.."),
		path.resolve(moduleDir, "../../.."),
	]) {
		const candidate = path.join(root, skillPath);
		if (existsSync(candidate)) return candidate;
	}
	throw new Error(`sno-station-mem REM update judgment skill is missing: ${skillPath}`);
}

const skillText = readFileSync(resolveSkillPath(REM_UPDATE_SKILL_PATH), "utf8");
const groupClosureSkillText = readFileSync(resolveSkillPath(GROUP_CLOSURE_SKILL_PATH), "utf8");

function readSection(heading: string): string {
	const marker = `## ${heading}\n`;
	const start = skillText.indexOf(marker);
	if (start === -1) throw new Error(`REM update judgment skill is missing section: ${heading}`);
	const bodyStart = start + marker.length;
	const nextSection = skillText.indexOf("\n## ", bodyStart);
	return skillText.slice(bodyStart, nextSection === -1 ? undefined : nextSection).trim();
}

export type RemUpdateJudgmentSkill = {
	readonly relation: string;
	readonly retirementTarget: string;
	readonly rewrite: string;
	readonly verification: string;
	readonly clauseCarry: string;
};

export const REM_UPDATE_JUDGMENT_SKILL: RemUpdateJudgmentSkill = {
	relation: readSection("Relation Judgment"),
	retirementTarget: groupClosureSkillText,
	rewrite: readSection("Source Rewrite"),
	verification: readSection("Rewrite Verification"),
	clauseCarry: readSection("Clause Carry"),
};
