import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { z } from "zod";
import { isAgentText } from "./session-activity";

const execute = promisify(execFile);
const WAITING_SUFFIX = ".waiting";
export type AgentHarness = "claude" | "codex" | "cursor" | "hermes" | "openclaw" | "unknown";
export interface AgentObservation {
	harness: AgentHarness; sessionId: string; at: string; event: string; input: Record<string, unknown>;
	pid?: number; processStart?: string; reachAddress?: string; cwd?: string;
}
const harnessSchema: z.ZodType<AgentHarness> = z.enum(["claude", "codex", "cursor", "hermes", "openclaw", "unknown"]);
const observationSchema: z.ZodType<AgentObservation> = z.object({
	harness: harnessSchema, sessionId: z.string().min(1), at: z.iso.datetime({ offset: true }), event: z.string(),
	input: z.record(z.string(), z.unknown()), pid: z.number().int().positive().optional(),
	processStart: z.string().optional(), reachAddress: z.string().optional(), cwd: z.string().optional(),
});
export interface AgentOperationError { operation: string; target: string; error: string; impact: string }
export interface AgentRow {
	harness: AgentHarness; sessionId: string; reachAddress: string; cwd: string; description: string;
	doing: "working" | "idle at prompt" | "unknown";
	process: "present" | "detached" | "exited" | "absent" | "unknown";
	resumable: "live" | "resumable" | "context full" | "unknown";
	waitingForHuman: "yes" | "no" | "unknown"; waitingReason: string; waitingSince?: string; waitingSubject?: string;
	group: "Needs you" | "Working" | "Finished" | "unknown"; subgroup: string;
	lastEvent: { at: string; event: string; source: string } | "unknown"; ageSeconds: number | "unknown";
	resultId: string; humanSeen: boolean | "unknown"; finalReply: string;
	work: Record<string, unknown>[]; delivery: string; resumeEvidence: string; missingReasons: string[];
}
interface OpenQuestion { agent: string; subject: string; age: number | "unknown"; source: "mail" | "native"; sessionId?: string; harness?: AgentHarness }
interface StuckItem { card: string; holder: string; reason: string; since: string; subject: string; taker?: string }
export interface AgentView {
	observedAt: string; agents: AgentRow[]; work: Record<string, unknown>[];
	quota: Record<string, unknown>[]; errors: AgentOperationError[];
	openQuestions: OpenQuestion[]; stuck: StuckItem[]; reachUnavailable?: string;
}
export interface AgentViewOptions {
	profileDir?: string; reachRoot?: string; now?: number; reachProgram?: string;
	/** Status-line and tmux redraws: skip stale event files without a wait marker, Reach work, and exhausted cards. */
	recent?: boolean;
}
export interface AgentIdentity { harness?: string; sessionId?: string; reachAddress?: string }

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function profileDir(): string { return process.env.SNO_PROFILE_DIR ?? join(homedir(), ".sno"); }
function reachRoot(): string { return process.env.SNO_REACH_ROOT || join(homedir(), ".local/state/sno-reach"); }
function eventFile(profile: string, harness: string, sessionId: string): string {
	return join(profile, "station", "agents", `${encodeURIComponent(harness)}--${encodeURIComponent(sessionId)}.jsonl`);
}
function failure(operation: string, target: string, error: unknown, impact: string): AgentOperationError {
	return { operation, target, error: error instanceof Error ? error.message : String(error), impact };
}
function absent(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }

/** Linux start ticks identify one process lifetime, including across PID reuse. */
export async function agentProcessIdentity(pid: number): Promise<{ pid: number; processStart: string }> {
	const stat = await readFile(`/proc/${pid}/stat`, "utf8");
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	const processStart = fields[19];
	if (!processStart) throw new Error("process start time unavailable");
	return { pid, processStart };
}

async function observedProcess(harness: AgentHarness, input: Record<string, unknown>): Promise<{ pid: number; processStart: string } | undefined> {
	// Match installed executable paths, never a shell parent or a process-name substring.
	const paths = (process.env.PATH ?? "").split(":");
	const command = harness === "cursor" ? "cursor-agent" : harness;
	const binaries: string[] = [];
	for (const path of paths) {
		try { binaries.push(await realpath(join(path, command))); } catch (error) { if (!absent(error)) throw error; }
	}
	const supplied = Number(input.agent_pid ?? process.env.CLAUDE_CODE_PID ?? process.env.CODEX_PID);
	let pid = process.ppid;
	while (pid > 1) {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const exe = await realpath(`/proc/${pid}/exe`);
		const cmdline = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
		if (pid === supplied || binaries.includes(exe) || cmdline.some(argument => binaries.includes(argument))) return agentProcessIdentity(pid);
		pid = Number(fields[1]);
	}
	return undefined;
}

// The fields the reader uses. Prompts, replies and tool output are not memory: only a bounded prompt start,
// a bounded reply end (its final punctuation marks a question) and whether a tool answered are kept.
const OBSERVED_FIELDS = ["tool_name", "tool_use_id", "call_id", "notification_type", "error", "error_type", "approved", "decision",
	"choice", "human_addressee", "review_requested", "decision_required", "context_exhausted", "reference", "transcript_path"];
const OBSERVED_TEXT_CHARS = 200;

function observedInput(input: Record<string, unknown>): Record<string, unknown> {
	const kept: Record<string, unknown> = Object.fromEntries(OBSERVED_FIELDS.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
	if (askTool(input)) {
		const tool = record(input.tool_input);
		const question = text(tool.question) || (Array.isArray(tool.questions) ? text(record(tool.questions[0]).question) : "");
		if (question) kept.question = question.slice(0, OBSERVED_TEXT_CHARS);
	}
	const prompt = text(input.prompt);
	if (prompt) kept.prompt = prompt.slice(0, OBSERVED_TEXT_CHARS);
	const reply = text(input.last_assistant_message ?? input.text ?? input.response ?? input["last-assistant-message"]);
	if (reply) kept.last_assistant_message = reply.trimEnd().slice(-OBSERVED_TEXT_CHARS);
	if (input.tool_response !== undefined) kept.tool_response = { accepted: record(input.tool_response).accepted === true };
	if (input.tool_output !== undefined) kept.tool_output = true;
	return kept;
}

function logHookFailure(operation: string, target: string, error: unknown, impact: string): void {
	process.stderr.write(`${JSON.stringify(failure(operation, target, error, impact))}\n`);
}

async function logReachHookFailure(operation: string, target: string, error: unknown, impact: string): Promise<void> {
	logHookFailure(operation, target, error, impact);
	const path = join(reachRoot(), "reach.log");
	try { await appendFile(path, `reach: ${operation} ${target}: ${error instanceof Error ? error.message : String(error)}\n`); }
	catch (logError) { logHookFailure("append Reach log", path, logError, "failure reported on stderr"); }
}

async function hookHistory(target: string): Promise<AgentObservation[]> {
	try {
		const contents = await readFile(target, "utf8");
		return contents.split("\n").filter(Boolean).flatMap(line => {
			try { return [observationSchema.parse(JSON.parse(line))]; }
			catch (error) { logHookFailure("parse agent observation", target, error, "one hook record ignored"); return []; }
		});
	} catch (error) {
		if (!absent(error)) logHookFailure("read agent observations", target, error, "previous hook records unavailable");
		return [];
	}
}

async function hookSeat(history: AgentObservation[], target: string): Promise<string | undefined> {
	const cached = process.env.SNO_REACH_ADDR || history.findLast(item => item.reachAddress)?.reachAddress;
	if (cached) return cached;
	try { return (await execute("sno", ["reach", "whoami"], { timeout: 1000 })).stdout.trim() || undefined; }
	catch (error) {
		if (record(error).code !== 1 || record(error).stderr) {
			await logReachHookFailure("resolve Reach seat", target, error, "seat unavailable");
		}
		return undefined;
	}
}

async function pickupSeat(seat: string): Promise<void> {
	let reason: string;
	try {
		const { stdout } = await execute("sno", ["reach", "pickup"], {
			timeout: 3000, killSignal: "SIGKILL", env: { ...process.env, SNO_REACH_ADDR: seat },
		});
		reason = stdout.trim();
	} catch (error) {
		reason = text(record(error).stdout).trim();
		await logReachHookFailure("pick up Reach mail", seat, error,
			reason ? "some pickup offers may be missing" : "turn ends without a continuation");
	}
	if (reason) process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
}

function dismissApproval(sessionId: string, root: string): ReturnType<typeof spawn> {
	return spawn("sno", ["reach", "notify", "--dismiss-session", sessionId], {
		detached: true, stdio: "ignore", env: { ...process.env, SNO_REACH_ROOT: root },
	});
}

function approvalNotice(observation: AgentObservation, history: AgentObservation[]): void {
	const { input, event, sessionId, reachAddress, cwd } = observation;
	const dismiss = event === "approval-response" || event === "interrupt" ||
		(event === "post-tool-use" && pendingApproval(history, input));
	const tool = text(input.tool_name);
	if (!dismiss && (event !== "permission-request" || !tool || askTool(input))) return;
	const child = dismiss ? dismissApproval(sessionId, reachRoot()) : spawn("sno", [
		"reach", "notify", ...(reachAddress ? ["--as", reachAddress] : []), "--type", "approval",
		"--session", sessionId, "--subject", `approval needed: ${tool} in ${cwd ?? process.cwd()}`,
	], { detached: true, stdio: "ignore" });
	child.on("error", error => void logReachHookFailure(dismiss ? "dismiss Reach approval" : "send Reach approval", sessionId, error, "approval card unchanged"));
	child.unref();
}

function pendingApproval(history: AgentObservation[], completed: Record<string, unknown>): boolean {
	const index = history.findLastIndex(item =>
		["permission-request", "approval-response", "interrupt"].includes(item.event));
	const request = history[index];
	return request?.event === "permission-request" && !askTool(request.input) && matchingTool(request, completed) &&
		!history.slice(index + 1).some(item => item.event === "post-tool-use" && matchingTool(request, item.input));
}

/** Observational failures are logged; they never prevent an agent's ordinary hook. */
export async function observeAgentEvent(harness: AgentHarness, event: string, raw: unknown): Promise<void> {
	const input = record(raw);
	const thread = text(input.thread_id) || text(input["thread-id"]);
	const sessionId = harness === "cursor" ? text(input.conversation_id) : text(input.session_id) || thread;
	let target = `${harness}/${sessionId || "missing session identity"}`;
	let pickup: Promise<void> | undefined;
	try {
		if (!sessionId) throw new Error("host supplied no session identity");
		// A subagent's hooks carry its own agent_id beside the parent's session id; its events are its own, never the parent's.
		if (typeof input.agent_id === "string" && input.agent_id && input.agent_id !== sessionId) {
			await observeAgentEvent(harness, event, { ...input, session_id: input.agent_id, parent_session_id: undefined });
			return;
		}
		if (event === "notify" && thread && thread !== sessionId) return;
		const agent = (harness === "claude" || harness === "codex") && input.agent_id === undefined;
		target = eventFile(profileDir(), harness, sessionId);
		const identity = observedProcess(harness, input).catch(error => {
			logHookFailure("inspect agent process", target, error, "process observation unknown");
			return undefined;
		});
		const needsSeat = agent && (event === "session-start" || event === "stop" || event === "permission-request");
		const history = agent && (event === "post-tool-use" || (needsSeat && !process.env.SNO_REACH_ADDR)) ? await hookHistory(target) : [];
		const reachAddress = needsSeat ? await hookSeat(history, target) :
			input.agent_id === undefined ? process.env.SNO_REACH_ADDR : undefined;
		if (event === "stop" && agent && reachAddress) pickup = pickupSeat(reachAddress);
		let cwd = text(input.cwd);
		if (!cwd && harness === "cursor" && Array.isArray(input.workspace_roots)) cwd = text(input.workspace_roots[0]);
		const observation: AgentObservation = {
			harness, sessionId, at: new Date().toISOString(),
			event: event === "user-prompt-submit" && isAgentText(text(input.prompt)) ? "agent-prompt-submit" : event,
			input: observedInput(input), ...(reachAddress ? { reachAddress } : {}), ...(cwd ? { cwd } : {}),
		};
		if (agent && process.env.SNO_DUE_RUN !== "1") approvalNotice(observation, history);
		Object.assign(observation, await identity);
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		await appendFile(target, `${JSON.stringify(observation)}\n`, { mode: 0o600 });
		if (canChangeWait(observation)) await updateWaitingMarker(target, endsWaitOnly(observation));
	} catch (error) {
		logHookFailure("append agent observation", target, error, `${event} observation missing`);
	} finally { await pickup; }
}

function emptyAgent(harness: AgentHarness, sessionId: string): AgentRow {
	return {
		harness, sessionId, reachAddress: "unknown", cwd: "unknown", description: "unknown", doing: "unknown", process: "unknown",
		resumable: "unknown", waitingForHuman: "unknown", waitingReason: "unknown", group: "unknown", subgroup: "unknown",
		lastEvent: "unknown", ageSeconds: "unknown", resultId: "unknown", humanSeen: "unknown", finalReply: "unknown",
		work: [], delivery: "unknown", resumeEvidence: "unknown", missingReasons: [],
	};
}

function askTool(input: Record<string, unknown>): boolean {
	return /(?:^|\.)(?:AskUserQuestion|request_user_input_async|request_user_input)$/.test(text(input.tool_name));
}
function wait(row: AgentRow, reason: string): void { row.waitingForHuman = "yes"; row.waitingReason = reason; }
function resolveWait(row: AgentRow): void { row.waitingForHuman = "no"; row.waitingReason = "unknown"; }

function matchingTool(permission: AgentObservation | undefined, input: Record<string, unknown>): boolean {
	if (!permission) return false;
	const requested = text(permission.input.tool_use_id ?? permission.input.call_id);
	const completed = text(input.tool_use_id ?? input.call_id);
	if (requested && completed) return requested === completed;
	const name = text(input.tool_name);
	return Boolean(name && name === permission.input.tool_name);
}

function effectiveEvent({ event, input }: AgentObservation): string {
	// Claude delivers a finished background task's notice as a prompt; it continues the user's task, never starts one.
	return event === "user-prompt-submit" && text(input.prompt).trimStart().startsWith("<task-notification>")
		? "agent-prompt-submit" : event;
}

function quotaFailure(input: Record<string, unknown>): boolean {
	return ["rate_limit", "rate_limit_error", "quota_exhausted"].includes(text(input.error ?? input.error_type));
}

function canChangeWait(observation: AgentObservation): boolean {
	const { input } = observation;
	const event = effectiveEvent(observation);
	if (event === "handoff-released" || event === "human-seen") return false;
	if (input.human_addressee === true && (input.review_requested === true || input.decision_required === true)) return true;
	if (event === "pre-tool-use") return askTool(input);
	if (event === "stop-failure") return quotaFailure(input);
	return ["user-prompt-submit", "permission-request", "post-tool-use", "approval-response",
		"stop", "after-agent-response", "notify", "interrupt"].includes(event);
}

// These events can end a wait but never start one, so with no marker there is nothing to replay.
function endsWaitOnly(observation: AgentObservation): boolean {
	const event = effectiveEvent(observation);
	if (event === "post-tool-use") return !(askTool(observation.input) && observation.harness === "codex");
	return ["user-prompt-submit", "approval-response", "interrupt"].includes(event);
}

async function updateWaitingMarker(path: string, endsOnly: boolean): Promise<void> {
	const marker = path + WAITING_SUFFIX;
	const errors: AgentOperationError[] = [];
	try {
		if (endsOnly && !await stat(marker).then(() => true, (error: unknown) => { if (absent(error)) return false; throw error; })) return;
		const replay = await replayAgentFile(path, errors);
		if (replay?.row.waitingForHuman === "yes") await writeFile(marker, "", { mode: 0o600 });
		else await rm(marker, { force: true });
	} catch (error) { logHookFailure("update agent wait marker", marker, error, "redraw may skip a stale wait or read a stale session"); }
	for (const error of errors) process.stderr.write(`${JSON.stringify(error)}\n`);
}

function applyEvent(row: AgentRow, observation: AgentObservation, index: number, source: string, permission?: AgentObservation): void {
	const { input, at } = observation;
	const event = effectiveEvent(observation);
	if (event === "handoff-released") {
		row.work.push({ ...input, releasedAt: at });
		return;
	}
	if (event === "human-seen") {
		if (input.resultId === row.resultId) row.humanSeen = true;
		return;
	}
	row.lastEvent = { at, event, source };
	row.reachAddress = observation.reachAddress ?? row.reachAddress;
	row.cwd = observation.cwd ?? row.cwd;
	if (["user-prompt-submit", "agent-prompt-submit", "pre-tool-use", "pre-model-call"].includes(event)) row.doing = "working";
	if (event === "user-prompt-submit") {
		resolveWait(row); row.resultId = "unknown"; row.humanSeen = "unknown"; row.subgroup = "unknown";
		row.delivery = "unknown"; row.finalReply = "unknown";
		row.description = text(input.prompt) || "unknown";
	}
	if (event === "permission-request") wait(row, askTool(input) ? "asked a question" : "permission to approve");
	if (event === "notification" && input.notification_type === "permission_prompt" && row.waitingForHuman === "yes") return;
	if (["pre-tool-use", "permission-request"].includes(event) && askTool(input)) wait(row, "asked a question");
	if (event === "post-tool-use") {
		const response = record(input.tool_response);
		if (matchingTool(permission, input) && ((askTool(input) && (input.tool_response !== undefined || input.tool_output !== undefined)) ||
			(!askTool(input) && row.waitingReason === "permission to approve"))) resolveWait(row);
		if (askTool(input) && row.harness === "codex" && response.accepted === true) wait(row, "asked a question");
	}
	if (event === "approval-response") {
		if (input.approved === true || input.decision === "allow" || input.choice === "allow") resolveWait(row);
		else { row.waitingForHuman = "unknown"; row.waitingReason = "unknown"; }
	}
	if (["stop", "after-agent-response", "notify"].includes(event)) {
		const reply = text(input.last_assistant_message ?? input.text ?? input.response ?? input["last-assistant-message"]);
		if (reply) row.finalReply = reply;
		if (event !== "after-agent-response") {
			row.doing = "idle at prompt"; row.resultId = `${row.harness}/${row.sessionId}/${index}`; row.humanSeen = false;
		}
		if (/[?？]$/.test(row.finalReply.trimEnd())) wait(row, "asked a question");
	}
	if (event === "interrupt") {
		row.doing = "idle at prompt";
		if (row.waitingReason === "permission to approve") { row.waitingForHuman = "unknown"; row.waitingReason = "unknown"; }
	}
	if (event === "session-end") row.doing = "idle at prompt";
	if (event === "stop-failure" && quotaFailure(input)) wait(row, "quota exhausted");
	if (input.human_addressee === true && input.review_requested === true) wait(row, "done awaiting review");
	if (input.human_addressee === true && input.decision_required === true) wait(row, "failed awaiting decision");
	if (input.context_exhausted === true) row.resumable = "context full";
	if (event === "delivered" && text(input.reference)) { row.delivery = text(input.reference); row.subgroup = "delivered"; }
	if (event === "ended-no-change") row.subgroup = "ended with no change";
}

async function inspectProcess(row: AgentRow, observations: AgentObservation[], errors: AgentOperationError[]): Promise<void> {
	if (process.platform !== "linux") { row.missingReasons.push("agent process start inspection unsupported on this platform"); return; }
	const observed = observations.findLast(item => item.pid !== undefined && item.processStart !== undefined);
	if (!observed?.pid) { row.missingReasons.push("actual agent PID and start time unavailable"); return; }
	try {
		const identity = await agentProcessIdentity(observed.pid);
		row.process = identity.processStart === observed.processStart ? "present" : "exited";
		if (row.process === "present") {
			if (row.resumable !== "context full") row.resumable = "live";
			const environment = (await readFile(`/proc/${observed.pid}/environ`, "utf8")).split("\0");
			const socket = environment.find(item => item.startsWith("TMUX="))?.slice(5).split(",")[0];
			const pane = environment.find(item => item.startsWith("TMUX_PANE="))?.slice(10);
			if (socket && pane) {
				try {
					const attached = (await execute("tmux", ["-S", socket, "display-message", "-p", "-t", pane, "#{session_attached}"])).stdout.trim();
					row.process = attached === "0" ? "detached" : "present";
				} catch (error) { errors.push(failure("inspect tmux attachment", pane, error, "process attachment unknown")); }
			}
		}
	} catch (error) {
		if (absent(error)) row.process = "exited";
		else { row.process = "unknown"; errors.push(failure("inspect process", String(observed.pid), error, "process unknown")); }
	}
}

async function inspectResume(row: AgentRow, observations: AgentObservation[], errors: AgentOperationError[]): Promise<void> {
	// Only an exited process makes a saved session resumable; an unknown process (unsupported platform) never does.
	if (row.process !== "exited" || row.resumable === "context full") return;
	const transcript = observations.map(item => text(item.input.transcript_path)).findLast(Boolean);
	if (!transcript || !["claude", "codex"].includes(row.harness)) return;
	const stream = createReadStream(transcript, "utf8");
	try {
		// The session's identity is near the start of the transcript; stop reading at the first match.
		for await (const line of createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })) {
			if (!line.trim()) continue;
			const item = record(JSON.parse(line));
			const matches = row.harness === "codex"
				? item.type === "session_meta" && record(item.payload).id === row.sessionId
				: item.sessionId === row.sessionId && ["user", "assistant"].includes(text(item.type));
			if (matches) { row.resumable = "resumable"; row.resumeEvidence = transcript; break; }
		}
	} catch (error) { errors.push(failure("read resume record", transcript, error, "resume availability unknown")); }
	finally { stream.destroy(); }
}

/** Claude fires no hook when a person denies a permission prompt; only its transcript records the rejected call. */
async function permissionDenied(row: AgentRow, observations: AgentObservation[], errors: AgentOperationError[]): Promise<boolean> {
	const at = observations.findLastIndex(item => item.event === "permission-request");
	const request = observations[at];
	if (row.harness !== "claude" || !request) return false;
	const call = text(request.input.tool_use_id) || text(observations.slice(0, at)
		.findLast(item => item.event === "pre-tool-use" && item.input.tool_name === request.input.tool_name)?.input.tool_use_id);
	const transcript = text(request.input.transcript_path);
	if (!call || !transcript) return false;
	const handle = await open(transcript, "r").catch((error: unknown) => {
		errors.push(failure("read permission outcome", transcript, error, "a denied permission still shows as waiting")); return undefined;
	});
	if (!handle) return false;
	try {
		// The rejection is written right after the request; the transcript's last 256 KiB holds it.
		const { size } = await handle.stat();
		const start = Math.max(0, size - 262_144);
		const { buffer, bytesRead } = await handle.read(Buffer.alloc(size - start), 0, size - start, start);
		return buffer.subarray(0, bytesRead).toString("utf8").split("\n")
			.some(line => line.includes(`"tool_use_id":"${call}"`) && line.includes('"toolUseResult":"User rejected tool use"'));
	} catch (error) {
		errors.push(failure("read permission outcome", transcript, error, "a denied permission still shows as waiting")); return false;
	} finally { await handle.close(); }
}

function classify(row: AgentRow): void {
	if (row.waitingForHuman === "yes") { row.group = "Needs you"; row.subgroup = row.waitingReason; }
	else if (row.doing === "working") { row.group = "Working"; row.subgroup = "working"; }
	else if (row.resultId !== "unknown" || row.resumable === "resumable") {
		row.group = "Finished";
		if (row.subgroup === "unknown" && row.resumable === "resumable") row.subgroup = "resumable";
	}
}

async function replayAgentFile(path: string, errors: AgentOperationError[]): Promise<{
	row: AgentRow; observations: AgentObservation[]; unreadable: boolean;
} | undefined> {
	const observations: AgentObservation[] = [];
	let unreadable = false;
	const contents = await readFile(path, "utf8");
	for (const [index, line] of contents.split("\n").entries()) {
		if (!line.trim()) continue;
		try { observations.push(observationSchema.parse(JSON.parse(line))); }
		catch (error) { unreadable = true; errors.push(failure("parse agent observation", `${path}:${index + 1}`, error, "current agent observation unknown")); }
	}
	const first = observations[0];
	if (!first) return undefined;
	const row = emptyAgent(first.harness, first.sessionId);
	let permission: AgentObservation | undefined;
	for (const [index, observation] of observations.entries()) {
		if (observation.sessionId !== row.sessionId || observation.harness !== row.harness) {
			unreadable = true; errors.push(failure("read agent identity", path, "mixed identities in event file", "current agent observation unknown")); continue;
		}
		const previousReason = row.waitingForHuman === "yes" ? row.waitingReason : "";
		if (["permission-request", "pre-tool-use"].includes(observation.event) &&
			(observation.event === "permission-request" || askTool(observation.input))) permission = observation;
		applyEvent(row, observation, index, path, permission);
		if (row.waitingForHuman === "yes" && (previousReason !== row.waitingReason || observation.event === "permission-request")) {
			row.waitingSince = observation.at;
			row.waitingSubject = text(observation.input.question ?? observation.input.last_assistant_message) ||
				(row.waitingReason === "permission to approve" && text(observation.input.tool_name)
					? `approval needed: ${text(observation.input.tool_name)}` : row.waitingReason);
		}
		if (row.waitingForHuman !== "yes") { row.waitingSince = undefined; row.waitingSubject = undefined; }
	}
	if (row.waitingReason === "permission to approve" && await permissionDenied(row, observations, errors)) {
		row.doing = "idle at prompt"; resolveWait(row); row.group = "Finished"; row.subgroup = "permission denied";
	}
	if (unreadable && row.waitingForHuman === "yes") row.waitingForHuman = "unknown";
	return { row, observations, unreadable };
}

async function readAgentFile(path: string, now: number, errors: AgentOperationError[]): Promise<AgentRow | undefined> {
	const replay = await replayAgentFile(path, errors);
	if (!replay) {
		const name = path.slice(path.lastIndexOf("/") + 1, -".jsonl".length);
		const separator = name.indexOf("--");
		const harness = harnessSchema.safeParse(decodeURIComponent(name.slice(0, separator)));
		if (!harness.success || separator < 0) return undefined;
		const row = emptyAgent(harness.data, decodeURIComponent(name.slice(separator + 2)));
		row.missingReasons.push("unreadable observation"); return row;
	}
	const { row, observations, unreadable } = replay;
	await inspectProcess(row, observations, errors);
	await inspectResume(row, observations, errors);
	if (row.lastEvent !== "unknown") row.ageSeconds = Math.max(0, (now - Date.parse(row.lastEvent.at)) / 1000);
	// Existing Reach freshness horizon; this expires observations, never infers failure.
	if (unreadable || (typeof row.ageSeconds === "number" && row.ageSeconds > 900)) {
		if (row.doing === "working") row.doing = "unknown";
		row.missingReasons.push(unreadable ? "unreadable observation" : "current observation older than 900 seconds");
	}
	classify(row);
	return row;
}

async function readSeats(root: string, entries: string[], rows: AgentRow[], errors: AgentOperationError[]): Promise<void> {
	for (const address of entries) {
		if (address.startsWith("developer.human@") || address.startsWith("station.notices@")) continue;
		const path = join(root, address, "seat.json");
		try {
			const seat = record(JSON.parse(await readFile(path, "utf8")));
			if (rows.some(row => row.reachAddress === address)) continue;
			let runtime = text(seat.runtime);
			if (!runtime) {
				try { runtime = text(record(JSON.parse(await readFile(join(root, address, "reachable.json"), "utf8"))).harness); }
				catch (error) { if (!absent(error)) errors.push(failure("read Reach harness", address, error, "harness unknown")); }
			}
			const parsed = harnessSchema.safeParse(runtime === "cursor-agent" ? "cursor" : runtime === "claude-code" ? "claude" : runtime);
			const row = emptyAgent(parsed.success ? parsed.data : "unknown", text(seat.session_id) || "unknown");
			row.reachAddress = address; row.missingReasons.push(row.harness === "openclaw" ? "OpenClaw state capture unsupported" : "Reach seat has no captured events");
			rows.push(row);
		} catch (error) { if (!absent(error)) errors.push(failure("read Reach seat", path, error, "seat observations unknown")); }
	}
}

type MailCard = { path: string; id: string; sender: string; subject: string; type: string; date: string; sessionId: string };

async function readReachFile<T>(operation: string, path: string, view: AgentView, read: () => Promise<T>): Promise<T | undefined> {
	try { return await read(); }
	catch (error) {
		if (!absent(error)) view.errors.push(failure(operation, path, error, "some Reach status unavailable"));
		return undefined;
	}
}

async function* mailboxCards(mailbox: string, view: AgentView): AsyncGenerator<MailCard> {
	for (const folder of ["new", "cur"]) {
		const directory = join(mailbox, folder);
		const files = await readReachFile("list Reach mailbox", directory, view, () => readdir(directory, { withFileTypes: true }));
		for (const file of files ?? []) {
			if (!file.isFile() || /:2,[^,]*T/.test(file.name)) continue;
			const path = join(directory, file.name);
			const contents = await readReachFile("read Reach card", path, view, () => readFile(path, "utf8"));
			if (contents === undefined) continue;
			const header = contents.split(/\r?\n\r?\n/, 1)[0]?.replace(/\r?\n[ \t]+/g, " ") ?? "";
			const fields = new Map(header.split(/\r?\n/).flatMap(line => {
				const delimiter = line.indexOf(":");
				return delimiter < 0 ? [] : [[line.slice(0, delimiter).toLowerCase(), line.slice(delimiter + 1).trim()]];
			}));
			const from = fields.get("from") ?? "";
			yield { path, id: fields.get("message-id") ?? "", sender: /<([^<>]+)>$/.exec(from)?.[1] ?? from,
				subject: fields.get("subject") ?? "unknown", type: fields.get("x-type") ?? "", date: fields.get("date") ?? "",
				sessionId: fields.get("x-session") ?? "" };
		}
	}
}

async function readTaker(root: string, sender: string, id: string, view: AgentView): Promise<string | undefined> {
	if (!sender || !id) return undefined;
	const path = join(root, sender, "takers", createHash("sha256").update(id).digest("hex"));
	return (await readReachFile("read Reach taker", path, view, () => readFile(path, "utf8")))?.trim() || undefined;
}

const trySchema = z.object({ msg_id: z.string(), at: z.iso.datetime() });

async function readExhausted(root: string, holder: string, view: AgentView): Promise<void> {
	const mailbox = join(root, holder);
	const path = join(mailbox, "tries.jsonl");
	const contents = await readReachFile("read Reach tries", path, view, () => readFile(path, "utf8"));
	if (!contents) return;
	const tries = new Map<string, { count: number; since: string }>();
	for (const line of contents.split("\n").filter(Boolean)) {
		try {
			const entry = trySchema.parse(JSON.parse(line));
			const previous = tries.get(entry.msg_id);
			tries.set(entry.msg_id, { count: (previous?.count ?? 0) + 1, since: entry.at });
		} catch (error) { view.errors.push(failure("parse Reach try", path, error, "some Reach tries unknown")); }
	}
	if (![...tries.values()].some(tryRecord => tryRecord.count >= 3)) return;
	for await (const card of mailboxCards(mailbox, view)) {
		const tryRecord = tries.get(card.id);
		if (!tryRecord || tryRecord.count < 3) continue;
		try {
			await execute("sno", ["reach", "__needs-handling", "--as", holder, card.path], {
				env: { ...process.env, SNO_REACH_ROOT: root }, timeout: 3000,
			});
			const taker = await readTaker(root, card.sender, card.id, view);
			view.stuck.push({ card: card.path, holder: taker ?? holder, reason: "3 tries used", since: tryRecord.since, subject: card.subject, ...(taker ? { taker } : {}) });
		} catch (error) {
			if (record(error).code !== 1) view.errors.push(failure("check Reach handling", card.path, error, "card status unknown"));
		}
	}
}

function agoSeconds(now: number, date: string): number | "unknown" {
	const then = Date.parse(date);
	return Number.isFinite(then) ? Math.max(0, (now - then) / 1000) : "unknown";
}

async function readReachStatus(root: string, view: AgentView, now: number, recent = false): Promise<void> {
	const start = view.errors.length;
	try {
		const seats = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
		await readSeats(root, seats, view.agents, view.errors);
		const developer = `developer.human@${hostname()}`;
		for await (const card of mailboxCards(join(root, developer), view)) {
			if (card.type === "approval" && view.agents.some(row => row.harness === "claude" &&
				row.sessionId === card.sessionId && row.subgroup === "permission denied")) {
				try {
					const [code, signal] = await once(dismissApproval(card.sessionId, root), "close");
					if (code !== 0) throw new Error(`Reach notify exited with ${signal ?? code}`);
					continue;
				} catch (error) { view.errors.push(failure("dismiss Reach approval", card.sessionId, error, "approval card unchanged")); }
			}
			if (["question", "decision", "approval"].includes(card.type)) {
				view.openQuestions.push({ agent: card.sender, subject: card.subject, age: agoSeconds(now, card.date), source: "mail" });
			}
		}
		if (!recent) await Promise.all(seats.map(seat => readExhausted(root, seat, view)));
	} catch (error) {
		view.errors.push(failure("read Reach inventory", root, error, "Reach status unavailable"));
	}
	view.reachUnavailable = view.errors[start]?.error;
}

async function readSeatStatus(root: string, view: AgentView, now: number): Promise<void> {
	const seats = new Map<string, AgentRow[]>();
	for (const row of view.agents) {
		if (row.reachAddress === "unknown" || row.reachAddress.startsWith("developer.human@")) continue;
		const rows = seats.get(row.reachAddress) ?? [];
		rows.push(row);
		seats.set(row.reachAddress, rows);
	}
	for (const [holder, rows] of seats) {
		if (rows.some(row => row.process === "present" || row.process === "detached")) continue;
		const latest = rows.map(row => row.lastEvent === "unknown" ? "" : row.lastEvent.at).sort().at(-1) || "unknown";
		const age = agoSeconds(now, latest);
		const registration = join(root, holder, "reachable.json");
		const registered = await readReachFile("inspect Reach registration", registration, view, () => stat(registration));
		const exited = !registered && rows.every(row => row.process === "exited");
		if (!exited && (age === "unknown" || age <= 900)) continue;
		const subject = rows.find(row => row.lastEvent !== "unknown" && row.lastEvent.at === latest)?.description ?? "unknown";
		view.stuck.push({ card: "unknown", holder, reason: exited ? "agent process exited" : "silent", since: latest, subject });
	}
}

async function reachWork(options: AgentViewOptions, errors: AgentOperationError[]): Promise<Record<string, unknown>[]> {
	let program = options.reachProgram;
	try {
		if (!program) {
			const assembled = record(JSON.parse(await readFile(join(homedir(), ".config/sno/assemble.json"), "utf8")));
			const entry = text(record(record(assembled.programs).reach).entry);
			if (!entry) return [];
			program = join(dirname(entry), "../lib/reach-agent-view");
		}
		const result = await execute(program, [], { env: { ...process.env, ...(options.reachRoot ? { SNO_REACH_ROOT: options.reachRoot } : {}) } });
		return result.stdout.trim().split("\n").filter(Boolean).map(line => record(JSON.parse(line)));
	} catch (error) {
		if (!program && absent(error)) return [];
		errors.push(failure("read Reach work", program ?? "Reach installation", error, "failed work observations unknown; other records retained"));
		const output = record(error).stdout;
		if (typeof output !== "string") return [];
		const usable: Record<string, unknown>[] = [];
		for (const line of output.split("\n").filter(Boolean)) {
			try { usable.push(record(JSON.parse(line))); }
			catch (parseError) { errors.push(failure("parse Reach work", program ?? "Reach", parseError, "one work observation unknown")); }
		}
		return usable;
	}
}

export async function readAgentView(options: AgentViewOptions = {}): Promise<AgentView> {
	const now = options.now ?? Date.now();
	const directory = join(options.profileDir ?? profileDir(), "station", "agents");
	const view: AgentView = { observedAt: new Date(now).toISOString(), agents: [], work: [], quota: [], errors: [], openQuestions: [], stuck: [] };
	const files = await readdir(directory).catch((error: unknown) => {
		if (!absent(error)) throw new Error(`read agent inventory ${directory}: ${String(error)}`);
		return [];
	});
	const redrawNames = options.recent ? new Set(files) : undefined;
	for (const name of files.filter(name => name.endsWith(".jsonl")).sort()) {
		try {
			const path = join(directory, name);
			if (redrawNames && !redrawNames.has(name + WAITING_SUFFIX) && now - (await stat(path)).mtimeMs > 900_000) continue;
			const row = await readAgentFile(path, now, view.errors);
			if (row?.waitingForHuman === "yes") {
				view.openQuestions.push({ agent: row.reachAddress === "unknown" ? rowWho(row) : row.reachAddress,
					subject: row.waitingSubject ?? row.waitingReason, age: agoSeconds(now, row.waitingSince ?? ""),
					source: "native", sessionId: row.sessionId, harness: row.harness });
			}
			if (row) view.agents.push(row);
		} catch (error) { view.errors.push(failure("read agent events", join(directory, name), error, "agent observations unknown")); }
	}
	const root = options.reachRoot ?? reachRoot();
	await readReachStatus(root, view, now, options.recent);
	await readSeatStatus(root, view, now);
	// Projecting Reach work rescans every mailbox per work item; a redraw shows only counts and skips it.
	view.work = options.recent ? [] : await reachWork({ ...options, reachRoot: root }, view.errors);
	for (const item of view.work.filter(item => item.handoff_error)) {
		view.errors.push(failure("associate Reach handoff", text(item.message_id), item.handoff_error, "work ownership unknown"));
	}
	const confirmation = new Map<string, string>();
	if (view.work.length) {
		const logPath = join(root, "reach.log");
		const log = await readReachFile("read Reach confirmations", logPath, view, () => readFile(logPath, "utf8"));
		for (const match of (log ?? "").matchAll(/^reach: confirm taker (<[^>]+>): (waiting for confirmation: .+)$/gm)) {
			const [, id, reason] = match;
			if (id && reason) confirmation.set(id, reason);
		}
	}
	for (const item of view.work) {
		const id = text(item.message_id);
		const taker = await readTaker(root, text(item.sender), id, view);
		if (taker) item.taker = taker;
		const reason = confirmation.get(id);
		if (reason && !taker && ["queued", "seen", "unknown"].includes(text(item.state))) {
			view.stuck.push({ card: text(item.path) || id, holder: text(item.owner) || "unknown", reason,
				since: text(item.since) || "unknown", subject: text(item.subject) || "unknown" });
		}
	}
	view.reachUnavailable ??= view.errors.find(error => error.operation.startsWith("read Reach"))?.error;
	const releases = view.agents.flatMap(row => row.work);
	for (const release of releases) {
		const item = view.work.find(item => item.message_id === release.message_id && item.work === release.work &&
			item.recipient === release.source && item.handoff_to === release.target && item.handoff_message_id === release.target_message_id);
		if (item) {
			item.owner = release.target; item.releasedAt = release.releasedAt;
			item.state = item.handoff_state; item.since = item.handoff_since; item.blocked_on = item.handoff_blocked_on;
		}
	}
	for (const row of view.agents) {
		// A released card whose transfer card is itself listed (A to B to C) has been replaced by that card.
		row.work = view.work.filter(item => item.owner === row.reachAddress &&
			!(item.releasedAt && view.work.some(other => other.message_id === item.handoff_message_id)));
		const blocked = row.work.find(item => item.blocked_on && item.blocked_on !== "-");
		if (blocked && row.group === "Working") row.subgroup = "waiting on another agent";
		if (row.waitingForHuman !== "yes" && row.work.some(item => item.handoff_to && !item.releasedAt)) {
			row.group = "Working"; row.subgroup = "handing over";
		}
		const released = view.work.filter(item => item.recipient === row.reachAddress && item.releasedAt).map(item => text(item.releasedAt)).sort().at(-1);
		// Work started after the latest release is current activity, not the finished handover.
		const workingSince = row.doing === "working" && row.lastEvent !== "unknown" && released !== undefined && row.lastEvent.at > released;
		if (row.waitingForHuman !== "yes" && released !== undefined && !workingSince &&
			!row.work.some(item => !["completed", "failed", "cancelled", "refused", "dismissed", "expired", "superseded"].includes(text(item.state)))) {
			row.group = "Finished"; row.subgroup = "handed over";
		}
	}
	view.quota = [...new Set(view.agents.map(row => row.harness))].map(harness => ({ harness, state: "unknown", reason: "no quota observation; use explicit refresh", source: "unknown", observedAt: "unknown" }));
	const groups = ["Needs you", "Working", "Finished", "unknown"];
	const age = (row: AgentRow): number => (row.ageSeconds === "unknown" ? Number.POSITIVE_INFINITY : row.ageSeconds);
	view.agents.sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group) || Number(a.humanSeen === true) - Number(b.humanSeen === true) ||
		age(a) - age(b));
	return view;
}

/** Called only after Reach verifies the receiver's release response. */
export async function recordAgentHandoff(source: string, target: string, releaseText: string, options: AgentViewOptions = {}): Promise<void> {
	const view = await readAgentView(options);
	const candidates = view.work.filter(item => item.handoff_to === target && (!source || item.handoff_sender === source) &&
		typeof item.handoff_message_id === "string" && releaseText.includes(item.handoff_message_id));
	if (candidates.length !== 1) throw new Error("release has no unique linked work card; ownership remains unknown");
	const item = candidates[0];
	// After /clear several sessions share the address; the receiver is the one that acted most recently.
	const at = (row: AgentRow): number => (row.lastEvent === "unknown" ? 0 : Date.parse(row.lastEvent.at));
	const agent = view.agents.filter(row => row.reachAddress === target && row.sessionId !== "unknown").sort((a, b) => at(b) - at(a))[0];
	if (!item || !agent) throw new Error("receiver has no captured session; release observation unavailable");
	const observation: AgentObservation = { harness: agent.harness, sessionId: agent.sessionId, at: new Date().toISOString(),
		event: "handoff-released", reachAddress: target, input: { message_id: item.message_id, target_message_id: item.handoff_message_id,
			work: item.work, source: item.recipient, target } };
	await appendFile(eventFile(options.profileDir ?? profileDir(), agent.harness, agent.sessionId), `${JSON.stringify(observation)}\n`, { mode: 0o600 });
}

// East Asian wide and emoji code points take two terminal columns.
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]|\p{Emoji_Presentation}/u;
const columns = (char: string): number => (WIDE.test(char) ? 2 : 1);

/** One terminal cell of exactly `width` columns: whitespace folded, cut with an ellipsis. */
function cell(value: string, width: number): string {
	const chars = [...value.replace(/\s+/g, " ").trim()];
	const total = chars.reduce((sum, char) => sum + columns(char), 0);
	let out = "";
	let used = 0;
	for (const char of chars) {
		if (total > width && used + columns(char) > width - 1) { out += "…"; used += 1; break; }
		out += char; used += columns(char);
	}
	return out + " ".repeat(Math.max(0, width - used));
}

/** A prepared line cut at `width` columns, its alignment kept. */
function clip(value: string, width: number): string {
	let out = "";
	let used = 0;
	for (const char of value) {
		if (used + columns(char) > width) break;
		out += char; used += columns(char);
	}
	return out;
}

/** Whitespace-folded text broken into lines of at most `width` columns. */
function wrap(value: string, width: number): string[] {
	const lines = [""];
	let used = 0;
	for (const char of value.replace(/\s+/g, " ").trim()) {
		if (used + columns(char) > width) { lines.push(""); used = 0; }
		lines[lines.length - 1] += char; used += columns(char);
	}
	return lines;
}

function ago(seconds: number | "unknown"): string {
	if (seconds === "unknown") return "?";
	const value = Math.round(seconds);
	if (value < 60) return `${value}s`;
	if (value < 3600) return `${Math.floor(value / 60)}m`;
	return value < 86_400 ? `${Math.floor(value / 3600)}h` : `${Math.floor(value / 86_400)}d`;
}

export function questionAndStuckLines(view: AgentView): string[] {
	return [
		`Open questions (${view.openQuestions.length})`,
		...view.openQuestions.map(question => `  ${question.agent} · ${question.subject} · ${ago(question.age)}`),
		`Stuck (${view.stuck.length})`,
		...view.stuck.map(item => `  ${item.holder} · ${item.subject} · ${item.reason} · since ${item.since}${item.taker ? ` · taken by ${item.taker}` : ""}`),
	];
}

function rowWho(row: AgentRow): string {
	const project = row.cwd === "unknown" ? "" : row.cwd.slice(row.cwd.lastIndexOf("/") + 1);
	return `${row.harness} ${project || (row.reachAddress === "unknown" ? row.sessionId.slice(0, 8) : row.reachAddress)}`;
}

function rowWhat(row: AgentRow): string {
	const task = row.description === "unknown" ? "" : row.description;
	const parts = (...items: string[]): string => items.filter(Boolean).join(" · ");
	if (row.group === "Needs you") return parts(row.waitingReason === "permission to approve" ? "approve a permission" : row.waitingReason, task);
	if (row.group === "Working") return parts(row.subgroup === "working" ? "" : row.subgroup, task || "working");
	if (row.group === "Finished") return parts(row.subgroup === "unknown" ? "finished" : row.subgroup, row.humanSeen === false ? "result unseen" : "", task);
	return parts("state unknown", task);
}

/** The screen lists finished and unknown sessions active in the last day; --json and the snapshot list every session. */
export function screenAgents(view: AgentView): { view: AgentView; hidden: number } {
	const agents = view.agents.filter(row => !["Finished", "unknown"].includes(row.group) || typeof row.ageSeconds !== "number" || row.ageSeconds <= 86_400);
	return { view: { ...view, agents }, hidden: view.agents.length - agents.length };
}

/** The interactive squad screen: one line per agent, "Needs you" pinned on top, the selected row's details below. */
export function renderAgentScreen(view: AgentView, selected: number, size: { columns: number; rows: number }, message = "", hidden = 0): string {
	const width = Math.max(40, size.columns);
	const whoWidth = Math.min(22, Math.floor(width / 4));
	const whatWidth = width - whoWidth - 8;
	const count = (group: AgentRow["group"]): number => view.agents.filter(row => row.group === group).length;
	const header = [`Sno Station · squad · ${new Date(view.observedAt).toTimeString().slice(0, 5)}`, `${count("Needs you")} need you`,
		`${count("Working")} working`, `${count("Finished")} finished`, ...(view.errors.length ? [`${view.errors.length} errors (sno --json squad)`] : [])];
	const pinned = [
		...(view.reachUnavailable ? [`Reach unavailable: ${view.reachUnavailable}`] : []),
		...questionAndStuckLines(view),
	].map(text => ({ text, index: -2 }));
	const rest: { text: string; index: number }[] = [];
	for (const [group, label] of [["Needs you", "Needs you"], ["Working", "Working"], ["Finished", "Finished"], ["unknown", "Unknown"]] as const) {
		const members = view.agents.flatMap((row, index) => (row.group === group ? [index] : []));
		if (!members.length) continue;
		const lines = [{ text: `${label} (${members.length})`, index: -1 }, ...members.map(index => {
			const row = view.agents[index] as AgentRow;
			return { index, text: `${index === selected ? ">" : " "} ${cell(rowWho(row), whoWidth)} ${cell(rowWhat(row), whatWidth)} ${ago(row.ageSeconds).padStart(4)}` };
		})];
		(group === "Needs you" ? pinned : rest).push(...lines);
	}
	if (hidden) rest.push({ text: `  ${hidden} older finished or unknown sessions hidden · sno --json squad lists all`, index: -1 });
	const row = view.agents[selected];
	let details: string[];
	// An opened result is shown whole; the list gives up the lines it needs.
	if (message) details = wrap(message, width).slice(0, Math.max(3, size.rows - 5));
	else if (row) {
		const handing = row.work.some(item => item.handoff_to && !item.releasedAt) ? " (handing over)" : "";
		const last = row.lastEvent === "unknown" ? "no event" : `last ${row.lastEvent.event} ${ago(row.ageSeconds)} ago`;
		details = [`Task: ${row.description}`,
			`${row.cwd} · Reach ${row.reachAddress} · process ${row.process} · ${row.resumable} · session ${row.sessionId}`,
			[`Work: ${row.work.length} card(s)${handing}`, last, ...row.missingReasons].join(" · "),
			...row.work.filter(item => item.taker).map(item => `${text(item.subject)} · taken by ${text(item.taker)}`)];
	} else details = ["", "", ""];
	// Title, separator, detail lines and the key line leave the rest of the screen to the list. "Needs you" stays on top
	// while it leaves room; the remaining lines scroll to keep the selected row in view.
	const space = Math.max(1, size.rows - 3 - details.length);
	const visible = (lines: { text: string; index: number }[], room: number): string[] => {
		const at = lines.findIndex(line => line.index === selected);
		const start = lines.length <= room || at < 0 ? 0 : Math.min(Math.max(0, at - Math.floor(room / 2)), lines.length - room);
		return lines.slice(start, start + room).map(line => line.text);
	};
	const list = pinned.length < space ? [...pinned.map(line => line.text), ...visible(rest, space - pinned.length)] : visible([...pinned, ...rest], space);
	if (!view.agents.length) list.push("No observed agents.");
	while (list.length < space) list.push("");
	return [cell(header.join(" · "), width), ...list.map(line => clip(line, width)), "─".repeat(width), ...details.map(line => cell(line, width)),
		cell("↑/↓ select · Enter result · Space refresh · r quota · q exit", width)].map(line => line.trimEnd()).join("\n");
}

export function compactAgentView(view: AgentView, current: AgentIdentity = {}): string {
	const rows = view.agents.filter(row => !((current.harness === row.harness && current.sessionId === row.sessionId) ||
		(current.reachAddress && current.reachAddress === row.reachAddress)));
	const waits = view.openQuestions.filter(question => question.source === "mail" ||
		!(current.harness === question.harness && current.sessionId === question.sessionId) &&
		!(current.reachAddress && current.reachAddress === question.agent));
	const working = rows.filter(row => row.group === "Working").length;
	const unknown = rows.filter(row => row.waitingForHuman === "unknown" || row.group === "unknown").length + view.errors.length;
	const first = waits[0];
	const row = first?.source === "native" ? rows.find(item => item.sessionId === first.sessionId && item.harness === first.harness) : undefined;
	const subject = row?.waitingReason === "permission to approve" ? "approve" : first?.subject;
	const description = first ? `${waits.length} need you · ${first.harness ?? first.agent}: ${subject}` : `${working} working`;
	return `❄ ${description} · ${view.stuck.length} stuck${unknown ? ` · ${unknown} unknown` : ""}${view.reachUnavailable ? ` · Reach unavailable: ${view.reachUnavailable}` : ""}`;
}

export async function markAgentResultSeen(row: AgentRow, profile: string = profileDir()): Promise<void> {
	if (row.resultId === "unknown") return;
	const target = eventFile(profile, row.harness, row.sessionId);
	try {
		await appendFile(target, `${JSON.stringify({ harness: row.harness, sessionId: row.sessionId, at: new Date().toISOString(), event: "human-seen", input: { resultId: row.resultId } })}\n`, { mode: 0o600 });
	} catch (error) { process.stderr.write(`${JSON.stringify(failure("append human result view", target, error, "result remains unseen"))}\n`); }
}
