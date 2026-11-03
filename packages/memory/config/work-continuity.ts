import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getSnoProfileDir } from "@snoai/observability";
import { CODING_SKIN_HOOKS, shellQuote } from "./coding-skin";

type ContinuityHarness = "claude" | "codex";
type ContinuityEvent = "SessionStart" | "UserPromptSubmit" | "PostCompact";

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
	if (event === "SessionStart") {
		try { await mkdir(dirname(path), { recursive: true }); }
		catch (error) { failure("prepare handoff brief directory", dirname(path), error, "saving the task brief needs this directory; available context is still delivered"); }
	}
	const brief = readFile(path, "utf8").catch(error => {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
			failure("read handoff brief", path, error, "task restoration from this brief failed; other context remains available");
		}
		return "";
	});
	const lessons = recallDeadline(event).then(timeoutMs => sno([
		"rem-reflect", "recall", "--agent", harness === "claude" ? "claude-code" : "codex", "--first-message",
	], { ...input, hook_event_name: event }, timeoutMs));
	const [saved, recalled, approved] = await Promise.allSettled([brief, memory(), lessons]);
	const parts: string[] = [];
	if (event === "SessionStart") parts.push(`Keep the current task in the readable handoff brief at ${path}. Run env -u ${harness === "claude" ? "CODEX_THREAD_ID" : "CLAUDE_SESSION_ID"} ${harness === "claude" ? "CLAUDE_SESSION_ID" : "CODEX_THREAD_ID"}=${shellQuote(input["session_id"])} sno handoff-checkpoint --repo ${shellQuote(input["cwd"])} ${shellQuote(path)} to create its template first, then fill and maintain the template's existing readable sections. Before each unfinished task action, update Next with the exact action and expected observable result. Keep Objective and authorization, decisions and exclusions, Done/current files, Known failure with operation/target/error, Reach card/recipient when present, and Report destination accurate. Refresh the same record at task boundaries and before an orderly interruption, preserving its readable sections. Do not ask the owner to reconstruct lost work.`);
	if (saved.status === "fulfilled" && saved.value) parts.push(`Current task handoff brief (complete file: ${path}). If the host reports context overflow, read that complete file before task action; do not infer the missing text. Reconcile actual file/tool results before repeating an unfinished action.\n\n${saved.value}`);
	if (recalled.status === "fulfilled") parts.push(context(recalled.value, "memory recall"));
	else failure("memory recall", input["session_id"], recalled.reason, "memory recall failed; the saved brief and approved lessons remain available");
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
		CODING_SKIN_HOOKS.Stop.timeout * 1000, { ...process.env,
			CLAUDE_SESSION_ID: harness === "claude" ? input["session_id"] : undefined,
			CODEX_THREAD_ID: harness === "codex" ? input["session_id"] : undefined,
		});
}
