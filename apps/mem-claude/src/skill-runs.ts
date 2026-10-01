import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	SKILL_CATEGORIES,
	skillVersionFor,
	type appendObserveLedgerRows,
} from "@snoai/memory/coding-skin";
import { detectProjectId } from "@snoai/observability";
import { z } from "zod";
import { workspaceRoot } from "./scope.js";

const transcriptLineSchema = z.object({
	type: z.string(),
	isMeta: z.boolean().optional(),
	timestamp: z.string().optional(),
	message: z.object({
		content: z.union([z.string(), z.array(z.unknown())]).optional(),
	}).optional(),
});
const skillUseSchema = z.object({
	type: z.literal("tool_use"),
	name: z.literal("Skill"),
	id: z.string(),
	input: z.object({ skill: z.string().min(1) }),
});
const failedResultSchema = z.object({
	type: z.literal("tool_result"),
	tool_use_id: z.string(),
	is_error: z.literal(true),
});

interface SkillUse {
	id?: string;
	name: string;
	ts: number;
}

async function scanTranscript(
	text: string,
	configDir: string,
): Promise<{ skills: SkillUse[]; failed: Set<string>; last: number }> {
	const skills: SkillUse[] = [];
	const failed = new Set<string>();
	let last = 0;
	const slashSkills = new Set<string>();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const entry = transcriptLineSchema.parse(JSON.parse(line));
		const timestamp = entry.timestamp === undefined ? undefined : Date.parse(entry.timestamp);
		if (timestamp !== undefined && !Number.isFinite(timestamp)) {
			throw new Error("invalid-transcript-timestamp");
		}
		if (timestamp !== undefined) last = timestamp;
		const content = entry.message?.content;
		const blocks = Array.isArray(content) ? content : [];
		// Claude Code writes the typed skill's body as a hidden user entry right after the command.
		if (entry.type === "user" && entry.isMeta !== true && !blocks.some(block =>
			z.object({ type: z.literal("tool_result") }).safeParse(block).success)) {
			slashSkills.clear();
			const text = typeof content === "string" ? content : blocks.flatMap(block => {
				const parsed = z.object({ type: z.literal("text"), text: z.string() }).safeParse(block);
				return parsed.success ? [parsed.data.text] : [];
			}).join("\n");
			for (const match of text.matchAll(/<command-name>\/([^/<>\s]+)<\/command-name>/g)) {
				const name = match[1];
				if (!name || slashSkills.has(name)) continue;
				try {
					if (!(await stat(join(configDir, "skills", name))).isDirectory()) continue;
				} catch (error) {
					if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
					throw error;
				}
				if (timestamp === undefined) throw new Error("missing-skill-timestamp");
				slashSkills.add(name);
				skills.push({ name, ts: timestamp });
			}
		}
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			const result = failedResultSchema.safeParse(block);
			if (result.success) failed.add(result.data.tool_use_id);
			if (entry.type !== "assistant") continue;
			const skill = skillUseSchema.safeParse(block);
			if (!skill.success || slashSkills.has(skill.data.input.skill)) continue;
			if (timestamp === undefined) throw new Error("missing-skill-timestamp");
			skills.push({ id: skill.data.id, name: skill.data.input.skill, ts: timestamp });
		}
	}
	return { skills, failed, last };
}

export async function readSkillRuns(input: {
	session_id: string;
	cwd: string;
	transcript_path?: string | undefined;
}): Promise<Parameters<typeof appendObserveLedgerRows>[1]> {
	const configDir = process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
	const transcriptPath = input.transcript_path ?? join(
		configDir,
		"projects",
		input.cwd.replace(/[^a-zA-Z0-9]/g, "-"),
		`${input.session_id}.jsonl`,
	);
	const { skills, failed, last } = await scanTranscript(await readFile(transcriptPath, "utf8"), configDir);
	const projectId = input.cwd ? detectProjectId(await workspaceRoot(input.cwd)) : undefined;
	return skills.map((skill, index) => ({
		ts_ms: skill.ts,
		...(projectId === undefined ? {} : { project_id: projectId }),
		event_type: "skill.run",
		lane: "skill",
		payload: {
			harness: "claude-code",
			skill_name: skill.name,
			skill_version: skillVersionFor(join(configDir, "skills", skill.name)),
			category: SKILL_CATEGORIES[skill.name] ?? "other",
			duration_ms: Math.max(0, (skills[index + 1]?.ts ?? last) - skill.ts),
			outcome: skill.id !== undefined && failed.has(skill.id) ? "fail" : "ok",
		},
	}));
}
