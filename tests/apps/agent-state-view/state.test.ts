import { spawnSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentProcessIdentity, compactAgentView, markAgentResultSeen, observeAgentEvent, readAgentView,
	type AgentHarness, type AgentObservation } from "../../../packages/memory/config/agent-state.ts";

let home: string;
let previous: string | undefined;
const now = Date.now();
const helper = resolve("apps/reach/lib/reach-agent-view");
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "sno-agent-view-"));
	previous = process.env.SNO_PROFILE_DIR;
	process.env.SNO_PROFILE_DIR = home;
	await mkdir(join(home, "reach"));
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SNO_PROFILE_DIR;
	else process.env.SNO_PROFILE_DIR = previous;
	await rm(home, { recursive: true, force: true });
});
async function events(harness: AgentHarness, sessionId: string, entries: { event: string; input?: Record<string, unknown>; at?: string; identity?: { pid: number; processStart: string } }[]) {
	const directory = join(home, "station/agents");
	await mkdir(directory, { recursive: true });
	const path = join(directory, `${encodeURIComponent(harness)}--${encodeURIComponent(sessionId)}.jsonl`);
	await writeFile(path, entries.map(({ event, input = {}, at = new Date(now).toISOString(), identity }) =>
		JSON.stringify({ harness, sessionId, event, input, at, ...identity } satisfies AgentObservation)).join("\n") + "\n");
	return path;
}
const view = (at = now) => readAgentView({ profileDir: home, reachRoot: join(home, "reach"), reachProgram: helper, now: at });

describe("agent state view read-time semantics", () => {
	it("keeps four axes independent, resolves approval and never turns an ordinary finish into delivery", async () => {
		const identity = await agentProcessIdentity(process.pid);
		await events("claude", "one", [{ event: "user-prompt-submit", identity }, { event: "permission-request", input: { tool_name: "Bash", tool_use_id: "a" } },
			{ event: "notification", input: { notification_type: "permission_prompt" } }]);
		let row = (await view()).agents[0];
		expect(row).toMatchObject({ doing: "working", process: "present", resumable: "live", waitingForHuman: "yes", group: "Needs you", waitingReason: "permission to approve" });
		await appendFile(join(home, "station/agents/claude--one.jsonl"), JSON.stringify({ harness: "claude", sessionId: "one", at: new Date(now).toISOString(), event: "post-tool-use", input: { tool_name: "Bash", tool_use_id: "a" } }) + "\n");
		row = (await view()).agents[0];
		expect(row?.waitingForHuman).toBe("no");
		await events("claude", "ordinary", [{ event: "stop", input: { last_assistant_message: "All done." } }]);
		expect((await view()).agents.find(row => row.sessionId === "ordinary")).toMatchObject({ doing: "idle at prompt", waitingForHuman: "unknown", group: "Finished", subgroup: "unknown", delivery: "unknown", humanSeen: false });
	});
	it.each(["Should we continue?", "继续吗？  "])("recognizes the final punctuation %s", async final => {
		await events("claude", "question", [{ event: "stop", input: { last_assistant_message: final } }]);
		expect((await view()).agents[0]).toMatchObject({ group: "Needs you", waitingReason: "asked a question" });
	});
	it("prefers ask-tool meaning to permission and resolves actual Claude answers", async () => {
		await events("claude", "ask", [{ event: "pre-tool-use", input: { tool_name: "AskUserQuestion" } }, { event: "permission-request", input: { tool_name: "AskUserQuestion" } }]);
		expect((await view()).agents[0]?.waitingReason).toBe("asked a question");
		await events("claude", "answered", [{ event: "permission-request", input: { tool_name: "AskUserQuestion" } }, { event: "post-tool-use", input: { tool_name: "AskUserQuestion", tool_response: { answers: { question: "yes" } } } }]);
		expect((await view()).agents.find(row => row.sessionId === "answered")?.waitingForHuman).toBe("no");
		await events("codex", "codex-answered", [{ event: "pre-tool-use", input: { tool_name: "functions.request_user_input", call_id: "q" } }, { event: "post-tool-use", input: { tool_name: "functions.request_user_input", call_id: "q", tool_response: { answers: { question: "yes" } } } }]);
		expect((await view()).agents.find(row => row.sessionId === "codex-answered")?.waitingForHuman).toBe("no");
	});
	it("keeps accepted async questions unanswered and clears permission on Interrupt without success", async () => {
		await events("codex", "async", [{ event: "pre-tool-use", input: { tool_name: "functions.request_user_input_async" } }, { event: "post-tool-use", input: { tool_name: "functions.request_user_input_async", tool_response: { accepted: true } } }]);
		await events("codex", "denied", [{ event: "permission-request" }, { event: "interrupt" }]);
		const result = await view();
		expect(result.agents.find(row => row.sessionId === "async")).toMatchObject({ group: "Needs you", waitingReason: "asked a question" });
		expect(result.agents.find(row => row.sessionId === "denied")).toMatchObject({ doing: "idle at prompt", waitingForHuman: "unknown", group: "unknown", delivery: "unknown" });
	});
	it("expires current working/wait observations while keeping actual age, reason and completion", async () => {
		await events("claude", "old", [{ event: "user-prompt-submit" }, { event: "permission-request" }]);
		await events("claude", "finished", [{ event: "stop", input: { last_assistant_message: "Done." } }]);
		const result = await view(now + 901_000);
		expect(result.agents.find(row => row.sessionId === "old")).toMatchObject({ doing: "unknown", waitingForHuman: "unknown", waitingReason: "permission to approve", ageSeconds: 901, group: "unknown" });
		expect(result.agents.find(row => row.sessionId === "finished")?.group).toBe("Finished");
	});
	it("does not mistake PID reuse for presence, and reads a real-format saved session", async () => {
		const transcript = join(home, "rollout.jsonl");
		await writeFile(transcript, JSON.stringify({ type: "session_meta", payload: { id: "saved", cwd: home } }) + "\n");
		await events("codex", "saved", [{ event: "stop", input: { transcript_path: transcript }, identity: { pid: process.pid, processStart: "different-start" } }]);
		expect((await view()).agents[0]).toMatchObject({ process: "exited", resumable: "resumable", resumeEvidence: transcript, subgroup: "resumable" });
	});
	it("reads no transcript when the process is unknown", async () => {
		await events("codex", "unknown-process", [{ event: "stop", input: { transcript_path: join(home, "missing-rollout.jsonl") } }]);
		expect((await view()).errors.filter(error => error.operation === "read resume record")).toEqual([]);
	});
	it("reads only fresh observations and no Reach work for a status redraw", async () => {
		const stale = await events("claude", "stale", [{ event: "user-prompt-submit" }]);
		await events("claude", "fresh", [{ event: "user-prompt-submit" }]);
		const past = new Date(now - 901_000);
		await utimes(stale, past, past);
		const recent = await readAgentView({ profileDir: home, reachRoot: join(home, "reach"), now, reachProgram: "/nonexistent/reach-agent-view", recent: true });
		expect(recent.agents.map(row => row.sessionId)).toEqual(["fresh"]);
		expect(recent.errors).toEqual([]);
		const full = await readAgentView({ profileDir: home, reachRoot: join(home, "reach"), now, reachProgram: "/nonexistent/reach-agent-view" });
		expect(full.agents.map(row => row.sessionId).sort()).toEqual(["fresh", "stale"]);
		expect(full.errors.some(error => error.operation === "read Reach work")).toBe(true);
	});
	it("marks only the opened completion seen; passive reads and new completions stay unseen", async () => {
		const path = await events("claude", "result", [{ event: "stop", input: { last_assistant_message: "First." } }]);
		let result = await view();
		await view(); compactAgentView(result);
		expect((await view()).agents[0]?.humanSeen).toBe(false);
		const row = result.agents[0];
		if (!row) throw new Error("expected finished row");
		await markAgentResultSeen(row, home);
		expect((await view()).agents[0]?.humanSeen).toBe(true);
		await appendFile(path, JSON.stringify({ harness: "claude", sessionId: "result", at: new Date(now).toISOString(), event: "stop", input: { last_assistant_message: "Second." } }) + "\n");
		result = await view();
		expect(result.agents[0]?.humanSeen).toBe(false);
		expect(result.agents[0]?.resultId).not.toBe(row.resultId);
	});
	it("includes unsupported Reach seats and excludes current identity, not another same-vendor session", async () => {
		await events("claude", "foreground", [{ event: "user-prompt-submit" }]);
		await events("claude", "other", [{ event: "permission-request" }]);
		await mkdir(join(home, "reach/peer"));
		await writeFile(join(home, "reach/peer/seat.json"), JSON.stringify({ runtime: "openclaw" }));
		const result = await view();
		expect(result.agents).toHaveLength(3);
		expect(result.agents.find(row => row.harness === "openclaw")?.missingReasons).toContain("OpenClaw state capture unsupported");
		expect(compactAgentView(result, { harness: "claude", sessionId: "foreground" })).toMatch(/1 need you.*claude: approve.*unknown/);
	});
	it("keeps corrupt observations explicit instead of a false all-clear", async () => {
		const path = await events("claude", "broken", [{ event: "user-prompt-submit" }]);
		await appendFile(path, "{truncated\n");
		const result = await view();
		expect(result.errors.some(error => error.operation === "parse agent observation")).toBe(true);
		expect(result.agents[0]?.doing).toBe("unknown");
		expect(compactAgentView(result)).toContain("unknown");
	});
	it("appends real per-session observations without a sidecar, ignores foreign notify and keeps same-vendor files separate", async () => {
		await observeAgentEvent("claude", "permission-request", { session_id: "first", tool_name: "Bash" });
		await observeAgentEvent("claude", "stop", { session_id: "second", last_assistant_message: "Done." });
		await observeAgentEvent("codex", "notify", { session_id: "foreground", thread_id: "background", last_assistant_message: "Done." });
		expect(await readdir(join(home, "station/agents"))).toEqual(["claude--first.jsonl", "claude--second.jsonl"]);
		expect((await view()).agents).toHaveLength(2);
		expect(await readdir(join(home, "station"))).toEqual(["agents"]);
	});
	it("supports packaged JSON, compact and snapshot entries against actual hook records", async () => {
		await observeAgentEvent("claude", "permission-request", { session_id: "hook-record", tool_name: "Bash" });
		const run = (...args: string[]) => spawnSync(process.execPath, ["packages/memory/dist/agent-state-view.js", ...args], {
			encoding: "utf8", env: { ...process.env, SNO_PROFILE_DIR: home, SNO_REACH_ROOT: join(home, "reach") }, timeout: 10_000,
		});
		const json = run("--json");
		expect(json.status, json.stderr).toBe(0);
		expect(JSON.parse(json.stdout).agents[0]).toMatchObject({ sessionId: "hook-record", group: "Needs you" });
		expect(run("--compact").stdout).toContain("1 need you");
		expect(run().stdout).toContain("Waiting for a human: yes");
		expect(await readFile(join(home, "station/agents/claude--hook-record.jsonl"), "utf8")).not.toContain("human-seen");
	});
	it("clears a Claude permission wait once its transcript records the person's denial, and only then", async () => {
		const transcript = join(home, "transcript.jsonl");
		const asked = [{ event: "user-prompt-submit", input: { prompt: "Run the command" } },
			{ event: "pre-tool-use", input: { tool_name: "Bash", tool_use_id: "toolu_denied", transcript_path: transcript } },
			{ event: "permission-request", input: { tool_name: "Bash", transcript_path: transcript } }];
		await events("claude", "denied", asked);
		await writeFile(transcript, `${JSON.stringify({ type: "user", message: { content: [{ type: "tool_use", id: "toolu_denied" }] } })}\n`);
		expect((await view()).agents[0]).toMatchObject({ waitingForHuman: "yes", waitingReason: "permission to approve" });
		// The record Claude Code 2.1 writes when "No" or Escape answers the prompt.
		await appendFile(transcript, `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", is_error: true,
			content: "The user doesn't want to proceed with this tool use.", tool_use_id: "toolu_denied" }] }, toolUseResult: "User rejected tool use" })}\n`);
		expect((await view()).agents[0]).toMatchObject({ waitingForHuman: "no", doing: "idle at prompt", group: "Finished", subgroup: "permission denied" });
	});
	it("only resolves the matching permission and preserves its actual age through unrelated activity", async () => {
		await events("claude", "permission", [{ event: "permission-request", input: { tool_name: "Bash", tool_use_id: "waiting" } },
			{ event: "post-tool-use", input: { tool_name: "Read", tool_use_id: "unrelated" }, at: new Date(now + 1000_000).toISOString() }]);
		const result = await view(now + 1000_000);
		expect(result.agents[0]).toMatchObject({ waitingForHuman: "unknown", waitingReason: "permission to approve" });
		expect(result.agents[0]?.missingReasons).toContain("human-wait observation older than 900 seconds");
	});
	it("keeps an entirely corrupt known agent visible with unknown observations", async () => {
		await mkdir(join(home, "station/agents"), { recursive: true });
		await writeFile(join(home, "station/agents/claude--corrupt.jsonl"), "{broken\n");
		const result = await view();
		expect(result.agents[0]).toMatchObject({ harness: "claude", sessionId: "corrupt", doing: "unknown", group: "unknown" });
		expect(result.errors).toHaveLength(1);
	});
	it("shows bare Reach seats with unknown harness and ignores ordinary Reach log files", async () => {
		await mkdir(join(home, "reach/bare"));
		await writeFile(join(home, "reach/bare/seat.json"), JSON.stringify({ address: "bare" }));
		await writeFile(join(home, "reach/reach.log"), "ordinary log\n");
		const result = await view();
		expect(result.agents).toHaveLength(1);
		expect(result.agents[0]).toMatchObject({ reachAddress: "bare", harness: "unknown", sessionId: "unknown", group: "unknown" });
		expect(result.errors).toEqual([]);
	});
});
