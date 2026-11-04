import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { z } from "zod";
import { isAgentText } from "./session-activity";

const execute = promisify(execFile);
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
	waitingForHuman: "yes" | "no" | "unknown"; waitingReason: string;
	group: "Needs you" | "Working" | "Finished" | "unknown"; subgroup: string;
	lastEvent: { at: string; event: string; source: string } | "unknown"; ageSeconds: number | "unknown";
	resultId: string; humanSeen: boolean | "unknown"; finalReply: string;
	work: Record<string, unknown>[]; delivery: string; resumeEvidence: string; missingReasons: string[];
}
export interface AgentView {
	observedAt: string; agents: AgentRow[]; work: Record<string, unknown>[];
	quota: Record<string, unknown>[]; errors: AgentOperationError[];
}
export interface AgentViewOptions {
	profileDir?: string; reachRoot?: string; now?: number; reachProgram?: string;
}
export interface AgentIdentity { harness?: string; sessionId?: string; reachAddress?: string }

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function profileDir(): string { return process.env.SNO_PROFILE_DIR ?? join(homedir(), ".sno"); }
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
	const prompt = text(input.prompt);
	if (prompt) kept.prompt = prompt.slice(0, OBSERVED_TEXT_CHARS);
	const reply = text(input.last_assistant_message ?? input.text ?? input.response ?? input["last-assistant-message"]);
	if (reply) kept.last_assistant_message = reply.trimEnd().slice(-OBSERVED_TEXT_CHARS);
	if (input.tool_response !== undefined) kept.tool_response = { accepted: record(input.tool_response).accepted === true };
	if (input.tool_output !== undefined) kept.tool_output = true;
	return kept;
}

/** Observational failures are logged; they never prevent an agent's ordinary hook. */
export async function observeAgentEvent(harness: AgentHarness, event: string, raw: unknown): Promise<void> {
	const input = record(raw);
	const sessionId = text(harness === "cursor" ? input.conversation_id : input.session_id ?? input.thread_id);
	let target = `${harness}/${sessionId || "missing session identity"}`;
	try {
		if (!sessionId) throw new Error("host supplied no session identity");
		if (input.agent_id && input.agent_id !== sessionId && input.parent_session_id === sessionId) {
			await observeAgentEvent(harness, event, { ...input, session_id: input.agent_id, parent_session_id: undefined });
			return;
		}
		const thread = text(input.thread_id ?? input["thread-id"]);
		if (event === "notify" && thread && thread !== sessionId) return;
		let identity: { pid: number; processStart: string } | undefined;
		try { identity = await observedProcess(harness, input); }
		catch (error) { process.stderr.write(`${JSON.stringify(failure("inspect agent process", target, error, "process observation unknown"))}\n`); }
		let cwd = text(input.cwd);
		if (!cwd && harness === "cursor" && Array.isArray(input.workspace_roots)) cwd = text(input.workspace_roots[0]);
		target = eventFile(profileDir(), harness, sessionId);
		const observation: AgentObservation = {
			harness, sessionId, at: new Date().toISOString(),
			event: event === "user-prompt-submit" && isAgentText(text(input.prompt)) ? "agent-prompt-submit" : event,
			input: observedInput(input), ...identity,
			...(process.env.SNO_REACH_ADDR ? { reachAddress: process.env.SNO_REACH_ADDR } : {}),
			...(cwd ? { cwd } : {}),
		};
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		await appendFile(target, `${JSON.stringify(observation)}\n`, { mode: 0o600 });
	} catch (error) {
		process.stderr.write(`${JSON.stringify(failure("append agent observation", target, error, `${event} observation missing`))}\n`);
	}
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

function applyEvent(row: AgentRow, observation: AgentObservation, index: number, source: string, permission?: AgentObservation): void {
	const { input, event, at } = observation;
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
	if (["user-prompt-submit", "agent-prompt-submit", "pre-tool-use", "pre-model-call", "after-agent-thought"].includes(event)) row.doing = "working";
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
	if (event === "stop-failure" && ["rate_limit", "rate_limit_error", "quota_exhausted"].includes(text(input.error ?? input.error_type))) wait(row, "quota exhausted");
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
				} catch (error) { row.process = "unknown"; errors.push(failure("inspect tmux attachment", pane, error, "process attachment unknown")); }
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

function classify(row: AgentRow): void {
	if (row.waitingForHuman === "yes") { row.group = "Needs you"; row.subgroup = row.waitingReason; }
	else if (row.doing === "working") { row.group = "Working"; row.subgroup = "working"; }
	else if (row.resultId !== "unknown" || row.resumable === "resumable") {
		row.group = "Finished";
		if (row.subgroup === "unknown" && row.resumable === "resumable") row.subgroup = "resumable";
	}
}

async function readAgentFile(path: string, now: number, errors: AgentOperationError[]): Promise<AgentRow | undefined> {
	const observations: AgentObservation[] = [];
	let unreadable = false;
	const contents = await readFile(path, "utf8");
	for (const [index, line] of contents.split("\n").entries()) {
		if (!line.trim()) continue;
		try { observations.push(observationSchema.parse(JSON.parse(line))); }
		catch (error) { unreadable = true; errors.push(failure("parse agent observation", `${path}:${index + 1}`, error, "current agent observation unknown")); }
	}
	const first = observations[0];
	if (!first) {
		const name = path.slice(path.lastIndexOf("/") + 1, -".jsonl".length);
		const separator = name.indexOf("--");
		const harness = harnessSchema.safeParse(decodeURIComponent(name.slice(0, separator)));
		if (!harness.success || separator < 0) return undefined;
		const row = emptyAgent(harness.data, decodeURIComponent(name.slice(separator + 2)));
		row.missingReasons.push("unreadable observation"); return row;
	}
	const row = emptyAgent(first.harness, first.sessionId);
	let permission: AgentObservation | undefined;
	let waitAt: string | undefined;
	for (const [index, observation] of observations.entries()) {
		if (observation.sessionId !== row.sessionId || observation.harness !== row.harness) {
			unreadable = true; errors.push(failure("read agent identity", path, "mixed identities in event file", "current agent observation unknown")); continue;
		}
		const wasWaiting = row.waitingForHuman;
		if (["permission-request", "pre-tool-use"].includes(observation.event) &&
			(observation.event === "permission-request" || askTool(observation.input))) permission = observation;
		applyEvent(row, observation, index, path, permission);
		if (row.waitingForHuman === "yes" && wasWaiting !== "yes") waitAt = observation.at;
		if (row.waitingForHuman !== "yes") waitAt = undefined;
	}
	await inspectProcess(row, observations, errors);
	await inspectResume(row, observations, errors);
	if (row.lastEvent !== "unknown") row.ageSeconds = Math.max(0, (now - Date.parse(row.lastEvent.at)) / 1000);
	// Existing Reach freshness horizon; this expires observations, never infers failure.
	if (unreadable || (typeof row.ageSeconds === "number" && row.ageSeconds > 900)) {
		if (row.doing === "working") row.doing = "unknown";
		if (row.waitingForHuman === "yes") row.waitingForHuman = "unknown";
		row.missingReasons.push(unreadable ? "unreadable observation" : "current observation older than 900 seconds");
	}
	if (row.waitingForHuman === "yes" && waitAt && now - Date.parse(waitAt) > 900_000) {
		row.waitingForHuman = "unknown"; row.missingReasons.push("human-wait observation older than 900 seconds");
	}
	classify(row);
	return row;
}

async function readSeats(root: string, rows: AgentRow[], errors: AgentOperationError[]): Promise<void> {
	let entries: string[];
	try { entries = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); }
	catch (error) { if (!absent(error)) errors.push(failure("read Reach inventory", root, error, "Reach seats unknown")); return; }
	for (const address of entries) {
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
	const view: AgentView = { observedAt: new Date(now).toISOString(), agents: [], work: [], quota: [], errors: [] };
	let files: string[] = [];
	try { files = await readdir(directory); } catch (error) { if (!absent(error)) throw new Error(`read agent inventory ${directory}: ${String(error)}`); }
	for (const name of files.filter(name => name.endsWith(".jsonl")).sort()) {
		try {
			const row = await readAgentFile(join(directory, name), now, view.errors);
			if (row) view.agents.push(row);
		} catch (error) { view.errors.push(failure("read agent events", join(directory, name), error, "agent observations unknown")); }
	}
	const root = options.reachRoot ?? process.env.SNO_REACH_ROOT ?? join(homedir(), ".local/state/sno-reach");
	await readSeats(root, view.agents, view.errors);
	view.work = await reachWork({ ...options, reachRoot: root }, view.errors);
	for (const item of view.work.filter(item => item.handoff_error)) {
		view.errors.push(failure("associate Reach handoff", text(item.message_id), item.handoff_error, "work ownership unknown"));
	}
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
		row.work = view.work.filter(item => item.owner === row.reachAddress);
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
	view.agents.sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group) || Number(a.humanSeen === true) - Number(b.humanSeen === true));
	return view;
}

/** Called only after Reach verifies the receiver's release response. */
export async function recordAgentHandoff(source: string, target: string, releaseText: string, options: AgentViewOptions = {}): Promise<void> {
	const view = await readAgentView(options);
	const candidates = view.work.filter(item => item.handoff_to === target && (!source || item.handoff_sender === source) &&
		typeof item.handoff_message_id === "string" && releaseText.includes(item.handoff_message_id));
	if (candidates.length !== 1) throw new Error("release has no unique linked work card; ownership remains unknown");
	const item = candidates[0];
	const agents = view.agents.filter(row => row.reachAddress === target && row.sessionId !== "unknown");
	if (!item || agents.length !== 1 || !agents[0]) throw new Error("receiver has no unique captured session; release observation unavailable");
	const agent = agents[0];
	const observation: AgentObservation = { harness: agent.harness, sessionId: agent.sessionId, at: new Date().toISOString(),
		event: "handoff-released", reachAddress: target, input: { message_id: item.message_id, target_message_id: item.handoff_message_id,
			work: item.work, source: item.recipient, target } };
	await appendFile(eventFile(options.profileDir ?? profileDir(), agent.harness, agent.sessionId), `${JSON.stringify(observation)}\n`, { mode: 0o600 });
}

export function compactAgentView(view: AgentView, current: AgentIdentity = {}): string {
	const rows = view.agents.filter(row => !((current.harness === row.harness && current.sessionId === row.sessionId) ||
		(current.reachAddress && current.reachAddress === row.reachAddress)));
	const waits = rows.filter(row => row.waitingForHuman === "yes");
	const working = rows.filter(row => row.group === "Working").length;
	const unknown = rows.filter(row => row.waitingForHuman === "unknown" || row.group === "unknown").length + view.errors.length;
	const reason = waits[0];
	const description = reason ? `${waits.length} need you · ${reason.harness}: ${reason.waitingReason === "permission to approve" ? "approve" : reason.waitingReason}` : `${working} working`;
	return `❄ ${description}${unknown ? ` · ${unknown} unknown` : ""}`;
}

export async function markAgentResultSeen(row: AgentRow, profile: string = profileDir()): Promise<void> {
	if (row.resultId === "unknown") return;
	const target = eventFile(profile, row.harness, row.sessionId);
	try {
		await appendFile(target, `${JSON.stringify({ harness: row.harness, sessionId: row.sessionId, at: new Date().toISOString(), event: "human-seen", input: { resultId: row.resultId } })}\n`, { mode: 0o600 });
	} catch (error) { process.stderr.write(`${JSON.stringify(failure("append human result view", target, error, "result remains unseen"))}\n`); }
}
