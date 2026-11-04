import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { observeAgentEvent, readAgentView } from "../../../packages/memory/config/agent-state.ts";

it("preserves Cursor final response through its textless Stop and shows the observed task/project", async () => {
	const home = await mkdtemp(join(tmpdir(), "sno-cursor-observation-"));
	const previous = process.env.SNO_PROFILE_DIR;
	process.env.SNO_PROFILE_DIR = home;
	try {
		await mkdir(join(home, "reach"));
		const input = { conversation_id: "cursor-session", workspace_roots: [home] };
		await observeAgentEvent("cursor", "user-prompt-submit", { ...input, prompt: "Inspect the requested module" });
		await observeAgentEvent("cursor", "after-agent-response", { ...input, text: "Would you like to proceed？" });
		await observeAgentEvent("cursor", "stop", { ...input, status: "completed" });
		const view = await readAgentView({ profileDir: home, reachRoot: join(home, "reach"), reachProgram: resolve("apps/reach/lib/reach-agent-view") });
		expect(view.agents[0]).toMatchObject({ harness: "cursor", sessionId: "cursor-session", cwd: home,
			description: "Inspect the requested module", finalReply: "Would you like to proceed？", group: "Needs you", waitingReason: "asked a question" });
		await observeAgentEvent("cursor", "user-prompt-submit", { ...input, prompt: "Yes" });
		const answered = await readAgentView({ profileDir: home, reachRoot: join(home, "reach"), reachProgram: resolve("apps/reach/lib/reach-agent-view") });
		expect(answered.agents[0]).toMatchObject({ finalReply: "unknown", waitingForHuman: "no", group: "Working" });
	} finally {
		if (previous === undefined) delete process.env.SNO_PROFILE_DIR;
		else process.env.SNO_PROFILE_DIR = previous;
		await rm(home, { recursive: true, force: true });
	}
});

it("stores only bounded observation fields in owner-only files while the state still resolves", async () => {
	const home = await mkdtemp(join(tmpdir(), "sno-observation-fields-"));
	const previous = process.env.SNO_PROFILE_DIR;
	process.env.SNO_PROFILE_DIR = home;
	try {
		await mkdir(join(home, "reach"));
		const secret = "SECRET-FILE-CONTENT ".repeat(500);
		const input = { session_id: "bounded", cwd: home };
		await observeAgentEvent("claude", "user-prompt-submit", { ...input, prompt: `Fix the parser ${"x".repeat(5000)}` });
		await observeAgentEvent("claude", "pre-tool-use", { ...input, tool_name: "AskUserQuestion", tool_use_id: "q", tool_input: { secret } });
		await observeAgentEvent("claude", "post-tool-use", { ...input, tool_name: "AskUserQuestion", tool_use_id: "q", tool_response: { answers: { q: secret } } });
		await observeAgentEvent("claude", "stop", { ...input, last_assistant_message: `${secret}Should I continue?` });
		const file = join(home, "station/agents/claude--bounded.jsonl");
		const stored = await readFile(file, "utf8");
		expect(stored).not.toContain("answers");
		expect(stored).not.toContain("tool_input");
		expect(stored.length).toBeLessThan(3000);
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect((await stat(join(home, "station/agents"))).mode & 0o777).toBe(0o700);
		const view = await readAgentView({ profileDir: home, reachRoot: join(home, "reach"), reachProgram: resolve("apps/reach/lib/reach-agent-view") });
		expect(view.agents[0]).toMatchObject({ description: expect.stringMatching(/^Fix the parser x+$/), group: "Needs you", waitingReason: "asked a question" });
		expect(view.agents[0]?.finalReply).toMatch(/Should I continue\?$/);
	} finally {
		if (previous === undefined) delete process.env.SNO_PROFILE_DIR;
		else process.env.SNO_PROFILE_DIR = previous;
		await rm(home, { recursive: true, force: true });
	}
});

it("keeps a Claude subagent's stop and question out of its working parent's state", async () => {
	const home = await mkdtemp(join(tmpdir(), "sno-subagent-observation-"));
	const previous = process.env.SNO_PROFILE_DIR;
	process.env.SNO_PROFILE_DIR = home;
	try {
		await mkdir(join(home, "reach"));
		const parent = { session_id: "parent-session", cwd: home };
		await observeAgentEvent("claude", "user-prompt-submit", { ...parent, prompt: "Delegate the check" });
		await observeAgentEvent("claude", "pre-tool-use", { ...parent, agent_id: "child-agent", tool_name: "AskUserQuestion" });
		await observeAgentEvent("claude", "stop", { ...parent, agent_id: "child-agent", last_assistant_message: "Child finished?" });
		const view = await readAgentView({ profileDir: home, reachRoot: join(home, "reach"), reachProgram: resolve("apps/reach/lib/reach-agent-view") });
		expect(view.agents.find(row => row.sessionId === "parent-session")).toMatchObject({ doing: "working", group: "Working", waitingForHuman: "no" });
		expect(view.agents.find(row => row.sessionId === "child-agent")?.finalReply).toBe("Child finished?");
	} finally {
		if (previous === undefined) delete process.env.SNO_PROFILE_DIR;
		else process.env.SNO_PROFILE_DIR = previous;
		await rm(home, { recursive: true, force: true });
	}
});
