import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installCodex, uninstallCodex } from "../../../apps/mem-codex/src/install.ts";
import { readAgentView } from "../../../packages/memory/config/agent-state.ts";

const homes: string[] = [];
afterEach(async () => {
	await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

describe("agent state view Codex installation", () => {
	it("installs supported observations once, loads them in the actual Codex, and preserves foreign hooks on removal", async () => {
		const home = await mkdtemp(join(tmpdir(), "sno-state-codex-"));
		homes.push(home);
		const foreign = { type: "command", command: "printf foreign", timeout: 2 };
		await writeFile(join(home, "hooks.json"), JSON.stringify({ hooks: {
			PermissionRequest: [{ hooks: [foreign] }],
		} }));
		const options = { codexHome: home, programPath: "/opt/sno/bin/sno", writeOutput: () => undefined };
		const previousProfile = process.env.SNO_PROFILE_DIR;
		process.env.SNO_PROFILE_DIR = join(home, "profile");
		await installCodex(options);
		const first = await readFile(join(home, "hooks.json"), "utf8");
		const config = await readFile(join(home, "config.toml"), "utf8");
		await installCodex(options);
		expect(await readFile(join(home, "hooks.json"), "utf8")).toBe(first);
		expect(await readFile(join(home, "config.toml"), "utf8")).toBe(config);
		const hooks = JSON.parse(first).hooks;
		expect(hooks.PermissionRequest).toHaveLength(2);
		expect(hooks.Interrupt).toHaveLength(1);
		expect(hooks.PermissionRequest[1].hooks[0].command).toBe("'/opt/sno/bin/sno' memory hook permission-request --harness codex");
		expect(hooks.Interrupt[0].hooks[0].command).toBe("'/opt/sno/bin/sno' memory hook interrupt --harness codex");
		expect(hooks.Notification).toBeUndefined();
		expect(hooks.StopFailure).toBeUndefined();
		const loaded = spawnSync("codex", ["app-server", "--print-startup-config", "--strict-config"], {
			env: { ...process.env, CODEX_HOME: home }, encoding: "utf8", timeout: 20_000,
		});
		expect(loaded.error, loaded.stderr).toBeUndefined();
		expect(loaded.status, loaded.stderr).toBe(0);
		expect(JSON.parse(loaded.stdout)).toBeTypeOf("object");
		await uninstallCodex({ codexHome: home, writeOutput: () => undefined });
		expect(JSON.parse(await readFile(join(home, "hooks.json"), "utf8"))).toEqual({ hooks: {
			PermissionRequest: [{ hooks: [foreign] }],
		} });
		expect(await readFile(join(home, "config.toml"), "utf8")).not.toContain("hooks.state");
		if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR; else process.env.SNO_PROFILE_DIR = previousProfile;
	});

	it("runs installed observational commands and captures scripted hooks before memory filters", async () => {
		const home = await mkdtemp(join(tmpdir(), "sno-state-codex-entry-"));
		homes.push(home);
		const compiled = await import("../../../apps/mem-codex/dist/install.js");
		const previousProfile = process.env.SNO_PROFILE_DIR;
		process.env.SNO_PROFILE_DIR = home;
		await compiled.installCodex({ codexHome: home, programPath: "/opt/sno/bin/sno", writeOutput: () => undefined });
		if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR; else process.env.SNO_PROFILE_DIR = previousProfile;
		const hooks = JSON.parse(await readFile(join(home, "hooks.json"), "utf8")).hooks;
		const env = { ...process.env, CODEX_HOME: home, SNO_PROFILE_DIR: home };
		delete env.SNO_CAPTURE_SCRIPTED;
		const payload = { session_id: "codex-primary", cwd: home, transcript_path: null,
			tool_name: "exec_command", tool_use_id: "approval-one" };
		const start = spawnSync(process.execPath, [join(process.cwd(), "apps/mem-codex/dist/cli.js"), "session-start"], {
			input: JSON.stringify(payload), env, encoding: "utf8", timeout: 10_000,
		});
		expect(start.status, start.stderr).toBe(0);
		// sno passes these Codex events unchanged to the package CLI (`sno memory hook <event> --harness codex`).
		expect(hooks.PermissionRequest[0].hooks[0].command).toMatch(/ memory hook permission-request --harness codex$/);
		const hook = (event: string) => spawnSync(process.execPath, [join(process.cwd(), "apps/mem-codex/dist/cli.js"), event], {
			input: JSON.stringify(payload), env, encoding: "utf8", timeout: 10_000,
		});
		const request = hook("permission-request");
		expect(request.status, request.stderr).toBe(0);
		const reachRoot = join(home, "reach");
		await mkdir(reachRoot);
		const options = { profileDir: home, reachRoot, reachProgram: join(process.cwd(), "apps/reach/lib/reach-agent-view") };
		const waiting = await readAgentView(options);
		expect(waiting.agents[0]).toMatchObject({ sessionId: "codex-primary", waitingForHuman: "yes", group: "Needs you" });
		const interrupt = hook("interrupt");
		expect(interrupt.status, interrupt.stderr).toBe(0);
		const ended = await readAgentView(options);
		expect(ended.agents[0]).toMatchObject({ doing: "idle at prompt", waitingForHuman: "unknown", delivery: "unknown" });
		const recorded = (await readFile(join(home, "station/agents/codex--codex-primary.jsonl"), "utf8"))
			.trim().split("\n").map(line => JSON.parse(line));
		expect(recorded.map(event => event.event)).toEqual(["session-start", "permission-request", "interrupt"]);
		expect(start.stdout).toBe("");
	});
});
