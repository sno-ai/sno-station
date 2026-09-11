/** @file task-lifecycle-judgment-skill.ts
 * @purpose Loads the model-readable active-task judgment method shipped with the plugin.
 * @boundary Package-relative read of one trusted bundled skill.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TASK_SKILL_PATH = path.join("skills", "judge-task-lifecycle", "SKILL.md");
const ATOMIC_SKILL_PATH = path.join("skills", "extract-atomic-memory", "SKILL.md");

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
	throw new Error(`sno-station-mem judgment skill is missing: ${skillPath}`);
}

const taskSkillText = readFileSync(resolveSkillPath(TASK_SKILL_PATH), "utf8");
const atomicSkillText = readFileSync(resolveSkillPath(ATOMIC_SKILL_PATH), "utf8");

function readSection(skillText: string, heading: string): string {
	const marker = `## ${heading}\n`;
	const start = skillText.indexOf(marker);
	if (start === -1) throw new Error(`task lifecycle judgment skill is missing section: ${heading}`);
	const bodyStart = start + marker.length;
	const nextSection = skillText.indexOf("\n## ", bodyStart);
	return skillText.slice(bodyStart, nextSection === -1 ? undefined : nextSection).trim();
}

export type TaskLifecycleJudgmentSkill = {
	readonly activeTaskState: string;
	readonly existingTaskRelation: string;
};

export const TASK_LIFECYCLE_JUDGMENT_SKILL: TaskLifecycleJudgmentSkill = {
	activeTaskState: [
		readSection(atomicSkillText, "To-do Boundary"),
		readSection(taskSkillText, "Active Task State"),
	].join("\n\n"),
	existingTaskRelation: readSection(taskSkillText, "Existing Task Relation"),
};
