import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { spawn } from "@lydell/node-pty";
import { agentProcessIdentity, readAgentView } from "../../../packages/memory/config/agent-state.ts";

it("distinguishes actual detached and attached tmux process observations", async () => {
	const home = await mkdtemp(join(tmpdir(), "sno-agent-process-"));
	const socket = join(home, "tmux.sock");
	let client: ReturnType<typeof spawn> | undefined;
	try {
		const created = spawnSync("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-P", "-F", "#{pane_pid}", "-s", "isolated", "sleep", "60"], { encoding: "utf8" });
		expect(created.status, created.stderr).toBe(0);
		const identity = await agentProcessIdentity(Number(created.stdout.trim()));
		await mkdir(join(home, "station/agents"), { recursive: true });
		await mkdir(join(home, "reach"));
		await writeFile(join(home, "station/agents/claude--detached.jsonl"), JSON.stringify({ harness: "claude", sessionId: "detached", at: new Date().toISOString(), event: "user-prompt-submit", input: {}, ...identity }) + "\n");
		const result = await readAgentView({ profileDir: home, reachRoot: join(home, "reach"), reachProgram: resolve("apps/reach/lib/reach-agent-view") });
		expect(result.errors).toEqual([]);
		expect(result.agents[0]).toMatchObject({ process: "detached", resumable: "live", doing: "working" });
		client = spawn("tmux", ["-S", socket, "attach-session", "-t", "isolated"], {
			name: "xterm-256color", cols: 80, rows: 24, env: { ...process.env, TERM: "xterm-256color" },
		});
		await new Promise<void>((resolveAttached, reject) => {
			const timer = setTimeout(() => reject(new Error("private tmux client did not attach")), 3000);
			const listener = client?.onData(() => { clearTimeout(timer); listener?.dispose(); resolveAttached(); });
		});
		const attached = await readAgentView({ profileDir: home, reachRoot: join(home, "reach"), reachProgram: resolve("apps/reach/lib/reach-agent-view") });
		expect(attached.agents[0]).toMatchObject({ process: "present", resumable: "live" });
	} finally {
		client?.kill();
		spawnSync("tmux", ["-S", socket, "kill-server"]);
		await rm(home, { recursive: true, force: true });
	}
});
