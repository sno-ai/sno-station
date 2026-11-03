import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { observeAgentEvent, readAgentView } from "../../../packages/memory/config/agent-state.ts";

it("resolves Claude's native permission without a tool ID using its matching tool continuation", async () => {
	const profile = await mkdtemp(join(tmpdir(), "sno-permission-view-"));
	const previous = process.env.SNO_PROFILE_DIR;
	process.env.SNO_PROFILE_DIR = profile;
	try {
		const root = join(profile, "reach");
		await mkdir(root);
		const options = { profileDir: profile, reachRoot: root, reachProgram: resolve("apps/reach/lib/reach-agent-view") };
		const identity = { session_id: "native-permission" };
		await observeAgentEvent("claude", "pre-tool-use", { ...identity, tool_name: "Bash", tool_use_id: "toolu_native" });
		await observeAgentEvent("claude", "permission-request", { ...identity, tool_name: "Bash" });
		expect((await readAgentView(options)).agents[0]?.waitingForHuman).toBe("yes");
		await observeAgentEvent("claude", "post-tool-use", { ...identity, tool_name: "Read", tool_use_id: "other" });
		expect((await readAgentView(options)).agents[0]?.waitingForHuman).toBe("yes");
		await observeAgentEvent("claude", "post-tool-use", { ...identity, tool_name: "Bash", tool_use_id: "toolu_native" });
		expect((await readAgentView(options)).agents[0]?.waitingForHuman).toBe("no");
		await observeAgentEvent("claude", "stop", { ...identity, last_assistant_message: "Approved operation complete." });
		expect((await readAgentView(options)).agents[0]).toMatchObject({ waitingForHuman: "no", waitingReason: "unknown", group: "Finished" });
	} finally {
		if (previous === undefined) delete process.env.SNO_PROFILE_DIR; else process.env.SNO_PROFILE_DIR = previous;
		await rm(profile, { recursive: true, force: true });
	}
});
