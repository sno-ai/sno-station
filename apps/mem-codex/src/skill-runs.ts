import { glob, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	appendObserveLedgerRows,
	type ObserveLedgerRow,
	SKILL_CATEGORIES,
	skillVersionFor,
} from "@snoai/memory/coding-skin";
import { detectProjectId, getSnoProfileDir } from "@snoai/observability";
import { z } from "zod";
import { workspaceRoot } from "./scope.js";
import type { SessionState } from "./session-state.js";

const responseItemSchema = z.object({
	type: z.literal("response_item"),
	timestamp: z.string().optional(),
	payload: z.object({
		type: z.string(),
		role: z.string().optional(),
		call_id: z.string().optional(),
		input: z.string().optional(),
		arguments: z.string().optional(),
		output: z.unknown().optional(),
	}),
});

async function skillIsInstalled(skillDir: string): Promise<boolean> {
	try {
		return (await stat(skillDir)).isDirectory();
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

async function transcriptSkillRuns(text: string, codexHome: string): Promise<ObserveLedgerRow[]> {
	const entries = text.split("\n").filter(line => line.trim()).flatMap(line => {
		const parsed = responseItemSchema.safeParse(JSON.parse(line));
		return parsed.success ? [parsed.data] : [];
	});
	const outputs = new Map<string, string>();
	for (const { payload } of entries) {
		if (!payload.call_id || (payload.type !== "custom_tool_call_output"
			&& payload.type !== "function_call_output")) continue;
		if (typeof payload.output === "string") {
			outputs.set(payload.call_id, payload.output);
		} else if (Array.isArray(payload.output)) {
			const text = payload.output.flatMap(block => {
				const parsed = z.object({ text: z.string() }).safeParse(block);
				return parsed.success ? [parsed.data.text] : [];
			}).join("\n");
			outputs.set(payload.call_id, text);
		}
	}
	const roots = [join(homedir(), ".agents", "skills"), join(codexHome, "skills")];
	const pathPattern = new RegExp(`(?<![\\w/.-])(${roots.map(root => root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})/([^/\\s"'\\\\]+)/SKILL\\.md\\b`, "g");
	const counted = new Set<string>();
	const rows: ObserveLedgerRow[] = [];
	for (const entry of entries) {
		const call = entry.payload;
		if (call.type === "message" && call.role === "user") counted.clear();
		if (call.type !== "custom_tool_call" && call.type !== "function_call") continue;
		const input = call.type === "custom_tool_call" ? call.input : call.arguments;
		const output = call.call_id ? outputs.get(call.call_id) : undefined;
		if (input === undefined || output === undefined) continue;
		for (const match of input.matchAll(pathPattern)) {
			const [, root, name] = match;
			if (!root || !name || counted.has(name)) continue;
			const skillDir = join(root, name);
			if (!(await skillIsInstalled(skillDir))) continue;
			const failed = output.includes(`${join(skillDir, "SKILL.md")}: No such file or directory`);
			if (!failed && !output.split(/\r?\n|\\n/).some(line => line.trim() === `name: ${name}`)) continue;
			const timestamp = z.string().transform(value => Date.parse(value))
				.pipe(z.number().int().nonnegative()).parse(entry.timestamp);
			counted.add(name);
			rows.push({
				ts_ms: timestamp,
				event_type: "skill.run",
				lane: "skill",
				payload: {
					harness: "codex",
					skill_name: name,
					skill_version: skillVersionFor(skillDir),
					category: SKILL_CATEGORIES[name] ?? "other",
					duration_ms: 0,
					outcome: failed ? "fail" : "ok",
				},
			});
		}
	}
	return rows;
}

export async function scanSkillRuns(
	codexHome: string,
	sessionId: string,
): Promise<ObserveLedgerRow[]> {
	const rows: ObserveLedgerRow[] = [];
	let found = false;
	for await (const file of glob("*/*/*/rollout-*.jsonl", { cwd: join(codexHome, "sessions") })) {
		if (!file.endsWith(`-${sessionId}.jsonl`)) continue;
		found = true;
		const transcript = await readFile(join(codexHome, "sessions", file), "utf8");
		rows.push(...await transcriptSkillRuns(transcript, codexHome));
	}
	if (!found) throw new Error("rollout-missing");
	return rows;
}

export async function reportSkillRuns(state: SessionState, cwd?: string): Promise<void> {
	const codexHome = process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
	const rows = await scanSkillRuns(codexHome, state.sessionId);
	const projectId = cwd ? detectProjectId(await workspaceRoot(cwd)) : undefined;
	appendObserveLedgerRows(getSnoProfileDir(), rows.slice(state.skillRunsReported).map(row => ({
		...row,
		...(projectId === undefined ? {} : { project_id: projectId }),
	})));
	state.skillRunsReported = rows.length;
}
