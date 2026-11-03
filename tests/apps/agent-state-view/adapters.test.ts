import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
