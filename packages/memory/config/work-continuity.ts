import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getSnoProfileDir } from "@snoai/observability";
import { CODING_SKIN_HOOKS } from "./coding-skin";

type ContinuityHarness = "claude" | "codex";
type ContinuityEvent = "SessionStart" | "UserPromptSubmit";

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(operation: string, target: string, error: unknown, impact: string): void {
	console.error(JSON.stringify({ operation, target, error: String(error), impact }));
}

export function continuityBriefPath(sessionId: string): string {
	return join(getSnoProfileDir(), "station", "handoff", `${sessionId}.md`);
}

function context(output: string, target: string): string {
	if (!output.trim()) return "";
	try {
		const envelope: unknown = JSON.parse(output);
		if (object(envelope) && object(envelope["hookSpecificOutput"])) {
			const text = envelope["hookSpecificOutput"]["additionalContext"];
			if (typeof text === "string") return text;
		}
		throw new Error("no hookSpecificOutput.additionalContext");
	} catch (error) {
		failure("read hook context", target, error, "this context was not delivered; other task context remains available");
		return "";
	}
}

async function sno(args: string[], input: Record<string, unknown>, timeoutMs: number,
	env: NodeJS.ProcessEnv = process.env): Promise<string> {
	return new Promise(resolve => {
		const child = execFile(env["SNO_EXECUTABLE"] ?? "sno", args, {
			encoding: "utf8", timeout: timeoutMs, maxBuffer: Number.POSITIVE_INFINITY, env,
		}, (error, stdout, stderr) => {
			if (stderr) process.stderr.write(stderr);
			if (error) failure(args.slice(0, 2).join(" "), String(input["session_id"]), error,
				"this operation failed; the saved brief and other available context remain usable");
			resolve(error ? "" : stdout);
		});
		child.stdin?.on("error", error => failure("write hook input", args.join(" "), error, "this command did not receive its hook input"));
		child.stdin?.end(JSON.stringify(input));
	});
}

/** Reuse the memory hook's own deadline for the parallel lesson lookup. */
async function recallDeadline(event: ContinuityEvent): Promise<number> {
	const hook = event === "UserPromptSubmit" ? CODING_SKIN_HOOKS.UserPromptSubmit : CODING_SKIN_HOOKS.SessionStart;
	try {
		const settings: unknown = JSON.parse(await readFile(join(getSnoProfileDir(), "settings.json"), "utf8"));
		const key = event === "UserPromptSubmit" ? "prompt" : "sessionStart";
		if (object(settings) && object(settings["recall"]) && object(settings["recall"][key])) {
			const timeoutMs = settings["recall"][key]["timeoutMs"];
			if (typeof timeoutMs === "number" && timeoutMs > 0) return timeoutMs;
		}
	} catch (error) {
		failure("read recall deadline", join(getSnoProfileDir(), "settings.json"), error,
			"using the installed hook deadline; local continuity remains enabled");
	}
	return hook.timeout * 1000;
}

/** The same envelope carries durable task state, memory recall and locally approved lessons. */
export async function composeContinuityContext(harness: ContinuityHarness, event: ContinuityEvent,
	input: unknown, memory: () => Promise<string>): Promise<string> {
	if (!object(input) || typeof input["session_id"] !== "string" || typeof input["cwd"] !== "string"
		|| input["agent_id"] !== undefined) return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: "" } });
	const path = continuityBriefPath(input["session_id"]);
	const lessons = recallDeadline(event).then(timeoutMs => sno([
		"rem-reflect", "recall", "--agent", harness === "claude" ? "claude-code" : "codex", "--first-message",
	], { ...input, hook_event_name: event }, timeoutMs));
	const recalled = memory();
	const readBrief = () => readFile(path, "utf8").catch(error => {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
			failure("read handoff brief", path, error, "task restoration from this brief failed; other context remains available");
		}
		return "";
	});
	// At session start the hook writes a missing template itself, so keeping the brief never asks the user to approve
	// a command. It runs beside the memory and lesson reads, within their deadline; a new template holds no task yet.
	const brief = event !== "SessionStart" ? readBrief() : (async () => {
		const sessionId = String(input["session_id"]);
		try {
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			if (await readFile(path, "utf8").then(() => true, () => false)) return readBrief();
			await sno(["handoff-checkpoint", "--repo", String(input["cwd"]), path], input, await recallDeadline(event),
				checkpointEnvironment(harness, sessionId));
		} catch (error) { failure("prepare handoff brief", path, error, "the agent has no brief template; available context is still delivered"); }
		return "";
	})();
	const [saved, memoryRecall, approved] = await Promise.allSettled([brief, recalled, lessons]);
	const parts: string[] = [];
	// Keeping the brief must never delay the user's first task action or run a shell command that can wait on input.
	if (event === "SessionStart") parts.push(`Keep the current task in the readable handoff brief at ${path}; its template already exists. Start the user's task first: do not read or edit the brief before your first action on the task. Update the brief only when there is real progress to record (a finished step, a decision, a failure, or before an orderly interruption), and only with your ${harness === "claude" ? "Edit or Write tool" : "apply_patch tool"}, never through a shell command. Keep its readable sections accurate: Objective and authorization, decisions and exclusions, Done/current files, Next with the exact next action and its expected observable result, Known failure with operation/target/error, Reach card/recipient when present, and Report destination. Do not ask the owner to reconstruct lost work.`);
	if (saved.status === "fulfilled" && saved.value) parts.push(`Current task handoff brief (complete file: ${path}). If the host reports context overflow, read that complete file before task action; do not infer the missing text. Reconcile actual file/tool results before repeating an unfinished action.\n\n${saved.value}`);
	if (memoryRecall.status === "fulfilled") parts.push(context(memoryRecall.value, "memory recall"));
	else failure("memory recall", input["session_id"], memoryRecall.reason, "memory recall failed; the saved brief and approved lessons remain available");
	if (approved.status === "fulfilled") parts.push(context(approved.value, join(process.env["REM_REFLECT_STORE"] ?? join(homedir(), ".sno", "experience"), "wiki", "lessons.jsonl")));
	else failure("read approved lessons", input["session_id"], approved.reason, "lesson delivery failed; task context remains available");
	return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: parts.filter(Boolean).join("\n\n") } });
}

/** Refresh the existing readable brief before compaction; never manufacture task facts. */
export async function refreshContinuityBrief(harness: ContinuityHarness, input: unknown): Promise<void> {
	if (!object(input) || typeof input["session_id"] !== "string" || typeof input["cwd"] !== "string"
		|| input["agent_id"] !== undefined) return;
	const path = continuityBriefPath(input["session_id"]);
	try { await readFile(path, "utf8"); }
	catch (error) {
		failure("save before compaction", path, error, "no readable current brief was saved; recovery can use only previously durable records");
		return;
	}
	await sno(["handoff-checkpoint", "--repo", input["cwd"], path], input,
		CODING_SKIN_HOOKS.Stop.timeout * 1000, checkpointEnvironment(harness, input["session_id"]));
}

function checkpointEnvironment(harness: ContinuityHarness, sessionId: string): NodeJS.ProcessEnv {
	return { ...process.env,
		CLAUDE_SESSION_ID: harness === "claude" ? sessionId : undefined,
		CODEX_THREAD_ID: harness === "codex" ? sessionId : undefined,
	};
}
