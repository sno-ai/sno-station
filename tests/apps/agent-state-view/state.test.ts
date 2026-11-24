import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentProcessIdentity, compactAgentView, markAgentResultSeen, observeAgentEvent, questionAndStuckLines, readAgentView, statusLines,
	type AgentHarness, type AgentObservation } from "../../../packages/memory/config/agent-state.ts";

let home: string;
let previous: string | undefined;
let previousReach: string | undefined;
const now = Date.now();
const helper = resolve("apps/reach/lib/reach-agent-view");
const reach = resolve("apps/reach/bin/sno-reach");
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "sno-agent-view-"));
	previous = process.env.SNO_PROFILE_DIR;
	previousReach = process.env.SNO_REACH_ROOT;
	process.env.SNO_REACH_ROOT = join(home, "reach");
	process.env.SNO_PROFILE_DIR = home;
	await mkdir(join(home, "reach"));
	// Hooks call sno; a test reaches only this repository's Reach, never the developer's installed sno.
	await writeFile(join(home, "sno"), `#!/bin/sh\nif [ "$1" = reach ]; then shift; exec '${reach}' "$@"; fi\nexit 127\n`, { mode: 0o700 });
	vi.stubEnv("PATH", `${home}:${process.env.PATH}`);
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SNO_PROFILE_DIR;
	else process.env.SNO_PROFILE_DIR = previous;
	if (previousReach === undefined) delete process.env.SNO_REACH_ROOT;
	else process.env.SNO_REACH_ROOT = previousReach;
	vi.unstubAllEnvs();
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
	it("expires working observations while keeping old waits and completion", async () => {
		await events("claude", "old", [{ event: "user-prompt-submit" }, { event: "permission-request" }]);
		await events("claude", "finished", [{ event: "stop", input: { last_assistant_message: "Done." } }]);
		const result = await view(now + 901_000);
		expect(result.agents.find(row => row.sessionId === "old")).toMatchObject({ doing: "unknown", waitingForHuman: "yes", waitingReason: "permission to approve", ageSeconds: 901, group: "Needs you" });
		expect(result.agents.find(row => row.sessionId === "finished")?.group).toBe("Finished");
	});
	it("does not mistake PID reuse for presence, and reads a real-format saved session", async () => {
		const transcript = join(home, "rollout.jsonl");
		await writeFile(transcript, JSON.stringify({ type: "session_meta", payload: { id: "saved", cwd: home } }) + "\n");
		await events("codex", "saved", [{ event: "stop", input: { transcript_path: transcript }, identity: { pid: process.pid, processStart: "different-start" } }]);
		expect((await view()).agents[0]).toMatchObject({ process: "exited", resumable: "resumable", resumeEvidence: transcript, subgroup: "resumable" });
	});
	it("keeps a wait in the full view but drops its leftover redraw marker once the agent process has exited", async () => {
		const path = await events("claude", "rebooted", [{ event: "stop", input: { last_assistant_message: "Ship it?" }, identity: { pid: process.pid, processStart: "different-start" } }]);
		const marker = `${path}.waiting`;
		await writeFile(marker, "");
		const past = new Date(now - 901_000);
		await utimes(path, past, past);
		const redraw = await readAgentView({ profileDir: home, reachRoot: join(home, "reach"), now, recent: true });
		expect(redraw.agents).toEqual([]);
		expect(compactAgentView(redraw)).not.toMatch(/\d+ agents? (?:is|are) waiting/);
		await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await view()).agents[0]).toMatchObject({ process: "exited", waitingForHuman: "yes", waitingReason: "asked a question" });
	});
	it("keeps the status redraw to one line: the final question only, and no placeholder rows for idle Reach seats", async () => {
		const reply = "写着这些限制。改成了“限制跟着任务走”。\n- 第三遍通过，存下来的是第三遍的原文。\n\n按一天最多发一帖的规矩，最早能排到周一。就排 23 号早上 8 点吗？";
		await events("claude", "asks", [{ event: "stop", input: { last_assistant_message: reply } }]);
		const root = join(home, "reach");
		await mkdir(join(root, "idle.seat@local"), { recursive: true });
		await writeFile(join(root, "idle.seat@local", "seat.json"), JSON.stringify({ address: "idle.seat@local", runtime: "codex" }));
		const line = compactAgentView(await readAgentView({ profileDir: home, reachRoot: root, now, recent: true }));
		expect(line).not.toContain("\n");
		expect(line).toMatch(/^\[sno\] 1 agent is waiting for you · Claude.* asks: 就排 23 号早上 8 点吗？$/);
		expect(line).not.toContain("unknown");
		expect((await readAgentView({ profileDir: home, reachRoot: root, now })).agents.map(row => row.reachAddress)).toContain("idle.seat@local");
	});
	it("drops an approval wait once its session ended or its agent process exited; nobody is left to approve", async () => {
		await events("claude", "ended", [{ event: "permission-request", input: { tool_name: "Bash" } }, { event: "session-end" }]);
		await events("codex", "gone", [{ event: "permission-request", input: { tool_name: "Bash" }, identity: { pid: process.pid, processStart: "different-start" } }]);
		await events("claude", "asked", [{ event: "stop", input: { last_assistant_message: "Ship it?" } }, { event: "session-end" }]);
		const result = await view();
		expect(result.agents.find(row => row.sessionId === "ended")?.waitingForHuman).toBe("no");
		expect(result.agents.find(row => row.sessionId === "gone")).toMatchObject({ process: "exited", waitingForHuman: "no" });
		expect(result.openQuestions).toMatchObject([{ sessionId: "asked" }]);
		expect(questionAndStuckLines(result)).toContain("  Claude asks: Ship it? · 0s");
	});
	it("says what a non-question wait needs instead of quoting it as a question", async () => {
		await events("claude", "quota", [{ event: "stop-failure", input: { error: "rate_limit" } }]);
		expect(compactAgentView(await view())).toBe("[sno] 1 agent is waiting for you · Claude is out of quota");
	});
	it("gives the status line one row per wait, at most two, so a long question is not cut at the summary", async () => {
		await events("claude", "first", [{ event: "stop", input: { last_assistant_message: "Shall I schedule the Reddit post for Monday 23 November at 8 in the morning?" } }]);
		await events("codex", "second", [{ event: "permission-request", input: { tool_name: "Bash" } }]);
		await events("claude", "third", [{ event: "stop", input: { last_assistant_message: "Ship it?" } }]);
		const rows = statusLines(await view());
		expect(rows).toHaveLength(3);
		expect(rows[0]).toBe("[sno] 3 agents are waiting for you · all: sno squad");
		expect(rows.slice(1).join("\n")).toContain("Claude asks: Shall I schedule the Reddit post for Monday 23 November at 8 in the m…");
		expect(statusLines({ ...(await view()), openQuestions: [] })).toEqual(["[sno] no agent is waiting for you"]);
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
	it("skips stale event files and Reach retry logs before reading them on status redraw", async () => {
		const stale = await events("claude", "stale", [{ event: "user-prompt-submit" }]);
		await appendFile(stale, "{broken\n");
		const past = new Date(now - 901_000);
		await utimes(stale, past, past);
		const root = join(home, "reach");
		await mkdir(join(root, "coder.one@local"));
		await writeFile(join(root, "coder.one@local", "tries.jsonl"), "{broken\n");

		const recent = await readAgentView({ profileDir: home, reachRoot: root, now, recent: true });
		expect(recent.errors).toEqual([]);
		expect((await view()).errors.map(error => error.operation)).toEqual(["parse agent observation", "parse Reach try"]);
	});
	it.each([
		["stop", { last_assistant_message: "Which project?" }, "asked a question"],
		["permission-request", { tool_name: "Bash" }, "permission to approve"],
	] as const)("keeps an old %s wait on status redraw until the user answers", async (event, input, reason) => {
		const identity = { conversation_id: "waiting" };
		await observeAgentEvent("cursor", event, { ...identity, ...input });
		const path = join(home, "station/agents/cursor--waiting.jsonl");
		const marker = `${path}.waiting`;
		const options = { profileDir: home, reachRoot: join(home, "reach"), now: Date.now(), recent: true };
		const past = new Date(options.now - 901_000);
		await utimes(path, past, past);

		const waiting = await readAgentView(options);
		expect(waiting.openQuestions).toMatchObject([{ source: "native", sessionId: "waiting" }]);
		expect(waiting.agents[0]?.waitingReason).toBe(reason);
		expect(compactAgentView(waiting)).toContain("1 agent is waiting for you");
		expect(await readFile(marker, "utf8")).toBe("");

		await observeAgentEvent("cursor", "user-prompt-submit", { ...identity, prompt: "Continue with Sno Station." });
		const answered = await readAgentView(options);
		expect(answered.agents[0]?.waitingForHuman).toBe("no");
		expect(answered.openQuestions).toEqual([]);
		expect(compactAgentView(answered)).not.toMatch(/\d+ agents? (?:is|are) waiting/);
		await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
		await utimes(path, past, past);
		expect((await readAgentView(options)).agents).toEqual([]);
	});
	it("keeps an unanswered wait in the full view but drops its redraw marker when the session ends", async () => {
		const identity = { conversation_id: "abandoned" };
		await observeAgentEvent("cursor", "stop", { ...identity, last_assistant_message: "Which project?" });
		const path = join(home, "station/agents/cursor--abandoned.jsonl");
		const marker = `${path}.waiting`;
		expect(await readFile(marker, "utf8")).toBe("");

		await observeAgentEvent("cursor", "session-end", identity);
		await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
		const options = { profileDir: home, reachRoot: join(home, "reach"), now: Date.now(), recent: true };
		const past = new Date(options.now - 901_000);
		await utimes(path, past, past);
		expect(compactAgentView(await readAgentView(options))).not.toMatch(/\d+ agents? (?:is|are) waiting/);
		// A one-shot run ends its session while its question can still be answered by resuming it.
		expect((await readAgentView({ ...options, recent: false })).agents[0]).toMatchObject({ waitingForHuman: "yes", waitingReason: "asked a question" });
	});
	it("keeps old native questions in the full view and mailed questions on status redraw until dismissed", async () => {
		const old = new Date(now - 1200_000);
		const path = await events("codex", "waiting", [{ event: "stop", at: old.toISOString(), input: { last_assistant_message: "Which project?" } }]);
		await utimes(path, old, old);
		const root = join(home, "reach");
		const mailbox = join(root, `developer.human@${hostname()}`);
		await mkdir(join(mailbox, "new"), { recursive: true });
		await mkdir(join(mailbox, "cur"));
		const mail = "Subject: Choose a destination\nFrom: Agent <agent.one@local>\nX-Type: decision\nDate: " + old.toUTCString() + "\n\nPlease decide.\n";
		await writeFile(join(mailbox, "new/question"), mail);
		const options = { profileDir: home, reachRoot: root, now, recent: true };
		expect((await view()).openQuestions).toMatchObject([
			{ subject: "Which project?", age: 1200, source: "native" },
			{ subject: "Choose a destination", agent: "agent.one@local", source: "mail" },
		]);
		const result = await readAgentView(options);
		expect(result.openQuestions).toMatchObject([{ subject: "Choose a destination", source: "mail" }]);
		expect(compactAgentView(result)).toContain("1 agent is waiting for you");
		await appendFile(path, JSON.stringify({ harness: "codex", sessionId: "waiting", at: new Date(now).toISOString(), event: "user-prompt-submit", input: { prompt: "Use Sno Station" } }) + "\n");
		await rm(join(mailbox, "new/question"));
		await writeFile(join(mailbox, "cur/question:2,ST"), mail);
		expect((await readAgentView(options)).openQuestions).toEqual([]);
	});

	it("lists an exhausted card with its subject and the recorded taker", async () => {
		const root = join(home, "reach");
		const holder = `coder.one@${hostname()}`;
		const sender = `sender.one@${hostname()}`;
		const id = "<shared@local>";
		const mail = join(root, holder, "new/card");
		const time = "2026-11-18T12:00:00Z";
		await mkdir(join(root, holder, "new"), { recursive: true });
		await mkdir(join(root, sender, "takers"), { recursive: true });
		await writeFile(join(root, ".reach-2.5-since"), "2026-11-17T00:00:00Z\n");
		await writeFile(join(root, sender, "takers", createHash("sha256").update(id).digest("hex")), holder + "\n");
		await writeFile(mail, `From: Sender <${sender}>\nTo: <${holder}>, <coder.two@${hostname()}>\nDelivered-To: ${holder}\nSubject: Ship the update\nX-Type: decision\nMessage-ID: ${id}\n\nShip it.\n`);
		await writeFile(join(root, holder, "tries.jsonl"), [
			{ msg_id: id, at: "2026-11-18T11:50:00Z", kind: "ring" },
			{ msg_id: id, at: "2026-11-18T11:55:00Z", kind: "pickup" },
			{ msg_id: id, at: time, kind: "ring" },
		].map(item => JSON.stringify(item)).join("\n") + "\n");
		await writeFile(join(home, "sno"), `#!/bin/sh\nshift\nexec "${resolve("apps/reach/lib/reach-main")}" "$@"\n`, { mode: 0o700 });
		const originalPath = process.env.PATH;
		process.env.PATH = `${home}:${originalPath}`;
		try {
			const result = await view();
			expect(result.stuck).toEqual([{ card: mail, holder, reason: "3 tries used", since: time, subject: "Ship the update", taker: holder }]);
			expect(compactAgentView(result)).toContain("1 stuck: sno squad");
		} finally { process.env.PATH = originalPath; }
	});
	it("does not count wakes Reach refused because the window held no conversation", async () => {
		const root = join(home, "reach");
		const holder = `coder.one@${hostname()}`;
		const sender = `sender.one@${hostname()}`;
		const id = "<refused@local>";
		await mkdir(join(root, holder, "new"), { recursive: true });
		await writeFile(join(root, ".reach-2.5-since"), "2026-11-17T00:00:00Z\n");
		await writeFile(join(root, holder, "new/card"), `From: Sender <${sender}>\nTo: <${holder}>\nDelivered-To: ${holder}\nSubject: Answer the fork\nX-Type: question\nMessage-ID: ${id}\n\nAnswer it.\n`);
		await writeFile(join(root, holder, "tries.jsonl"), [
			{ msg_id: id, at: "2026-11-18T11:50:00Z", kind: "skip" },
			{ msg_id: id, at: "2026-11-18T11:55:00Z", kind: "skip" },
			{ msg_id: id, at: "2026-11-18T12:00:00Z", kind: "skip" },
			{ msg_id: id, at: "2026-11-18T12:05:00Z", kind: "ring" },
		].map(item => JSON.stringify(item)).join("\n") + "\n");
		await writeFile(join(home, "sno"), `#!/bin/sh\nshift\nexec "${resolve("apps/reach/lib/reach-main")}" "$@"\n`, { mode: 0o700 });
		const originalPath = process.env.PATH;
		process.env.PATH = `${home}:${originalPath}`;
		try {
			const result = await view();
			expect(result.stuck).toEqual([]);
			expect(result.errors).toEqual([]);
		} finally { process.env.PATH = originalPath; }
	});

	it("does not list an idle Codex seat as stuck when its hooks run under the shared app-server", async () => {
		// Under the app-server no Codex hook records a process, so silence cannot tell idle from hung.
		const holder = `thread.seat@${hostname()}`;
		await mkdir(join(home, "reach", holder), { recursive: true });
		await writeFile(join(home, "reach", holder, "reachable.json"), JSON.stringify({ address: holder, channel: "terminal", handle: "codex:thread:aG9tZQ" }));
		await mkdir(join(home, "station/agents"), { recursive: true });
		await writeFile(join(home, "station/agents", "codex--thread.jsonl"), JSON.stringify({
			harness: "codex", sessionId: "thread", event: "stop", input: {}, at: new Date(now - 20 * 60_000).toISOString(), reachAddress: holder,
		} satisfies AgentObservation) + "\n");
		const result = await view();
		expect(result.agents.find(row => row.reachAddress === holder)?.process).toBe("unknown");
		expect(result.stuck).toEqual([]);
		expect(compactAgentView(result)).not.toContain("stuck");
	});
	it("lists a quiet Codex seat as stuck once its registration is gone", async () => {
		const holder = `gone.seat@${hostname()}`;
		await mkdir(join(home, "reach", holder), { recursive: true });
		await mkdir(join(home, "station/agents"), { recursive: true });
		await writeFile(join(home, "station/agents", "codex--gone.jsonl"), JSON.stringify({
			harness: "codex", sessionId: "gone", event: "stop", input: {}, at: new Date(now - 20 * 60_000).toISOString(), reachAddress: holder,
		} satisfies AgentObservation) + "\n");
		expect((await view()).stuck).toMatchObject([{ holder, reason: "silent" }]);
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
		await writeFile(join(home, "reach/peer/reachable.json"), JSON.stringify({ channel: "terminal", handle: "tty:/dev/pts/1" }));
		const result = await view();
		expect(result.agents).toHaveLength(3);
		expect(result.agents.find(row => row.harness === "openclaw")?.missingReasons).toContain("OpenClaw state capture unsupported");
		expect(result.stuck).toEqual([]);
		expect(compactAgentView(result, { harness: "claude", sessionId: "foreground" })).toMatch(/^\[sno\] 1 agent is waiting for you · Claude.* needs your approval/);
	});
	it("excludes the Reach notice sender and developer mailbox from the agent inventory", async () => {
		const root = join(home, "reach");
		const notice = spawnSync(reach, ["notify", "--type", "routine", "--subject", "Watch finished"], {
			encoding: "utf8", env: { ...process.env, XDG_STATE_HOME: home },
		});
		expect(notice.status, notice.stderr).toBe(0);
		for (const address of [`developer.human@${hostname()}`, `station.notices@${hostname()}`]) {
			const seat = JSON.parse(await readFile(join(root, address, "seat.json"), "utf8"));
			expect(seat).toMatchObject({ address, runtime: "unbound" });
		}
		expect((await view()).agents).toEqual([]);
		expect(compactAgentView(await readAgentView({ recent: true }))).toBe("[sno] no agent is waiting for you");
	});
	it("keeps corrupt observations explicit instead of a false all-clear", async () => {
		const path = await events("claude", "broken", [{ event: "user-prompt-submit" }]);
		await appendFile(path, "{truncated\n");
		const result = await view();
		expect(result.errors.some(error => error.operation === "parse agent observation")).toBe(true);
		expect(result.agents[0]?.doing).toBe("unknown");
		expect(compactAgentView(result)).toContain("some agents unreadable: sno squad");
	});
	it("appends real per-session observations, marks only the wait, and ignores foreign notify", async () => {
		await observeAgentEvent("claude", "permission-request", { session_id: "first", tool_name: "Bash" });
		await observeAgentEvent("claude", "stop", { session_id: "second", last_assistant_message: "Done." });
		await observeAgentEvent("codex", "notify", { session_id: "foreground", thread_id: "background", last_assistant_message: "Done." });
		expect((await readdir(join(home, "station/agents"))).sort()).toEqual([
			"claude--first.jsonl", "claude--first.jsonl.waiting", "claude--second.jsonl",
		]);
		expect((await view()).agents).toHaveLength(2);
		expect(await readdir(join(home, "station"))).toEqual(["agents"]);
	});
	it.each([
		{ "thread-id": "hyphenated" },
		{ session_id: "", thread_id: "empty-session" },
	])("captures a Codex Stop with payload %j", async fields => {
		await observeAgentEvent("codex", "stop", { ...fields, "last-assistant-message": "The review is ready." });
		expect((await view()).agents).toMatchObject([{
			harness: "codex", sessionId: Object.values(fields).find(Boolean), finalReply: "The review is ready.", group: "Finished",
		}]);
	});
	it("offers a card from pickup output even when the scan timed out", async () => {
		await writeFile(join(home, "sno"), "#!/bin/sh\nprintf 'REACH-RING Guide: g. Read each original card.\\n\\nCard: /reach/worker/new/card\\n'\nexit 124\n", { mode: 0o700 });
		const hook = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
			import { observeAgentEvent } from "./packages/memory/config/agent-state.ts";
			await observeAgentEvent("claude", "stop", { session_id: "pickup" });
		`], {
			encoding: "utf8", timeout: 5000,
			env: { ...process.env, PATH: `${home}:${process.env.PATH}`, SNO_REACH_ADDR: "worker.one@local" },
		});
		expect(hook.status, hook.stderr).toBe(0);
		expect(hook.stdout).toBe('{"decision":"block","reason":"REACH-RING Guide: g. Read each original card.\\n\\nCard: /reach/worker/new/card"}\n');
	});
	it.each([
		["a usage error from an older Reach", "printf 'usage: sno reach <verb> ...\\n'\nexit 64\n", "worker.one@local"],
		["sno help printed for a missing reach command", "printf 'The Sno command line\\nUsage: sno <command>\\n'\nexit 0\n", undefined],
	])("never turns %s into a turn-end continuation", async (_case, script, address) => {
		await writeFile(join(home, "sno"), `#!/bin/sh\n${script}`, { mode: 0o700 });
		const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${home}:${process.env.PATH}` };
		if (address) env.SNO_REACH_ADDR = address; else delete env.SNO_REACH_ADDR;
		const hook = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
			import { observeAgentEvent } from "./packages/memory/config/agent-state.ts";
			await observeAgentEvent("claude", "stop", { session_id: "stray-output" });
		`], { encoding: "utf8", timeout: 5000, env });
		expect(hook.status, hook.stderr).toBe(0);
		expect(hook.stdout).toBe("");
	});
	it("records no process for a Codex hook run by a shared app-server, and the window's process when the window runs the hook", async () => {
		// Codex in daemon mode runs every window's hooks under one app-server; only without it is the hook's ancestor the window.
		await writeFile(join(home, "codex"), `#!/bin/sh
if [ "$1" = app-server ] || [ "$1" = --no-daemon ]; then
	[ "$1" = app-server ] || echo $$ > "$SNO_PROFILE_DIR/window-pid"
	'${process.execPath}' --import tsx --input-type=module -e "$HOOK"
	exit $?
fi
"$0" app-server --listen unix://
exit $?
`, { mode: 0o700 });
		const run = (session: string, ...args: string[]) => spawnSync(join(home, "codex"), args, {
			encoding: "utf8", timeout: 20000,
			env: { ...process.env, PATH: `${home}:${process.env.PATH}`, SNO_REACH_ADDR: "", HOOK: `
				import { observeAgentEvent } from "./packages/memory/config/agent-state.ts";
				await observeAgentEvent("codex", "user-prompt-submit", { session_id: "${session}", prompt: "hello" });
			` },
		});
		const recorded = async (session: string) => JSON.parse((await readFile(join(home, `station/agents/codex--${session}.jsonl`), "utf8")).trim());
		const shared = run("shared");
		expect(shared.status, shared.stderr).toBe(0);
		expect(await recorded("shared")).not.toHaveProperty("pid");
		expect(await recorded("shared")).not.toHaveProperty("processStart");
		const own = run("own", "--no-daemon");
		expect(own.status, own.stderr).toBe(0);
		expect((await recorded("own")).pid).toBe(Number(await readFile(join(home, "window-pid"), "utf8")));
	});
	it("records a pre-tool-use event without looking up the Reach seat", async () => {
		const calls = join(home, "sno-calls");
		await writeFile(calls, "");
		await writeFile(join(home, "sno"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$SNO_PROFILE_DIR/sno-calls"\n`, { mode: 0o700 });
		vi.stubEnv("PATH", `${home}:${process.env.PATH}`);
		vi.stubEnv("SNO_REACH_ADDR", undefined);
		try {
			await observeAgentEvent("claude", "pre-tool-use", { session_id: "tool-start", tool_name: "Bash" });
			expect(await readFile(calls, "utf8")).toBe("");
			const event = await readFile(join(home, "station/agents/claude--tool-start.jsonl"), "utf8");
			expect(JSON.parse(event)).toMatchObject({ event: "pre-tool-use", input: { tool_name: "Bash" } });
		} finally { vi.unstubAllEnvs(); }
	});
	it("supports packaged JSON, compact and snapshot entries against actual hook records", async () => {
		await observeAgentEvent("claude", "permission-request", { session_id: "hook-record", tool_name: "Bash" });
		const run = (...args: string[]) => spawnSync(process.execPath, ["packages/memory/dist/agent-state-view.js", ...args], {
			encoding: "utf8", env: { ...process.env, SNO_PROFILE_DIR: home, SNO_REACH_ROOT: join(home, "reach") }, timeout: 10_000,
		});
		const json = run("--json");
		expect(json.status, json.stderr).toBe(0);
		expect(JSON.parse(json.stdout).agents[0]).toMatchObject({ sessionId: "hook-record", group: "Needs you" });
		expect(run("--compact").stdout).toContain("1 agent is waiting for you");
		expect(run().stdout).toContain("Waiting for a human: yes");
		expect(await readFile(join(home, "station/agents/claude--hook-record.jsonl"), "utf8")).not.toContain("human-seen");
	});
	it("clears a Claude permission wait once its transcript records the person's denial, and only then", async () => {
		const transcript = join(home, "transcript.jsonl");
		const asked = [{ event: "user-prompt-submit", input: { prompt: "Run the command" } },
			{ event: "pre-tool-use", input: { tool_name: "Bash", tool_use_id: "toolu_denied", transcript_path: transcript } }];
		await events("claude", "denied", asked);
		await writeFile(transcript, `${JSON.stringify({ type: "user", message: { content: [{ type: "tool_use", id: "toolu_denied" }] } })}\n`);
		await writeFile(join(home, "sno"), `#!/bin/sh\nshift\nexec "${reach}" "$@"\n`, { mode: 0o700 });
		vi.stubEnv("PATH", `${home}:${process.env.PATH}`);
		vi.stubEnv("XDG_STATE_HOME", home);
		vi.stubEnv("SNO_REACH_ADDR", undefined);
		vi.stubEnv("SNO_DUE_RUN", undefined);
		try {
			await observeAgentEvent("claude", "permission-request", { session_id: "denied", tool_name: "Bash", transcript_path: transcript });
			expect((await view()).agents[0]).toMatchObject({ waitingForHuman: "yes", waitingReason: "permission to approve" });
			const redraw = { profileDir: home, reachRoot: join(home, "reach"), recent: true };
			const mailbox = join(redraw.reachRoot, `developer.human@${hostname()}`);
			await expect.poll(() => readdir(join(mailbox, "new")).catch(() => [])).toHaveLength(1);
			// The approval card and the agent's own wait are one thing waiting for the developer.
			expect((await readAgentView(redraw)).openQuestions.map(question => question.source)).toEqual(["native"]);
			const other = spawnSync(reach, ["notify", "--type", "approval", "--session", "other", "--subject", "Other approval"], { encoding: "utf8" });
			expect(other.status, other.stderr).toBe(0);

			// The record Claude Code 2.1 writes when "No" or Escape answers the prompt.
			await appendFile(transcript, `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", is_error: true,
				content: "The user doesn't want to proceed with this tool use.", tool_use_id: "toolu_denied" }] }, toolUseResult: "User rejected tool use" })}\n`);
			const denied = await readAgentView(redraw);
			expect(denied.agents[0]).toMatchObject({ waitingForHuman: "no", doing: "idle at prompt", group: "Finished", subgroup: "permission denied" });
			expect(denied.openQuestions).toMatchObject([{ source: "mail", subject: "[APPROVAL] Other approval" }]);
			// The redraw starts the dismissal and does not wait for it.
			await expect.poll(() => readdir(join(mailbox, "cur"))).toEqual([expect.stringMatching(/:2,[^,]*T/)]);
		} finally { vi.unstubAllEnvs(); }
	});
	it("keeps the user's task line when a Claude background task notification arrives as a prompt", async () => {
		await events("claude", "notified", [{ event: "user-prompt-submit", input: { prompt: "Fix the login redirect loop" } },
			{ event: "pre-tool-use", input: { tool_name: "Bash" } },
			{ event: "user-prompt-submit", input: { prompt: "<task-notification>\n<task-id>b7bhp5v8t</task-id>\n<tool-use-id>toolu_01</tool-use-id>" } }]);
		expect((await view()).agents[0]).toMatchObject({ description: "Fix the login redirect loop", doing: "working" });
	});
	it("only resolves the matching permission and preserves its actual age through unrelated activity", async () => {
		await events("claude", "permission", [{ event: "permission-request", input: { tool_name: "Bash", tool_use_id: "waiting" } },
			{ event: "post-tool-use", input: { tool_name: "Read", tool_use_id: "unrelated" }, at: new Date(now + 1000_000).toISOString() }]);
		const result = await view(now + 1000_000);
		expect(result.agents[0]).toMatchObject({ waitingForHuman: "yes", waitingReason: "permission to approve" });
		expect(result.openQuestions).toMatchObject([{ age: 1000, source: "native" }]);
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
