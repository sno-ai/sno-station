import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctor } from "../../../apps/mem-claude/src/doctor.ts";
import { installClaude } from "../../../apps/mem-claude/src/install.ts";

const events = [
	["SessionStart", "session-start", 15],
	["UserPromptSubmit", "user-prompt-submit", 8],
	["Stop", "stop", 5],
	["SessionEnd", "session-end", 8],
	["PreToolUse", "pre-tool-use", 5],
	["PostToolUse", "post-tool-use", 8],
] as const;
const programPath = "/opt/sno/bin/sno";
const hookCommand = (path: string, subcommand: string) => `'${path}' memory hook ${subcommand} --harness claude`;
let configDir: string;
let previousProfile: string | undefined;

beforeEach(async () => {
	configDir = await mkdtemp(join(tmpdir(), "sno-mem-claude-install-"));
	previousProfile = process.env.SNO_PROFILE_DIR;
	process.env.SNO_PROFILE_DIR = join(configDir, "isolated-profile");
});

afterEach(async () => {
	if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
	else process.env.SNO_PROFILE_DIR = previousProfile;
	await rm(configDir, { recursive: true, force: true });
});

function install(output: string[] = [], dryRun = false) {
	return installClaude({ configDir, programPath, dryRun, writeOutput: line => output.push(line) });
}

async function settings() {
	return JSON.parse(await readFile(join(configDir, "settings.json"), "utf8"));
}

describe("Claude settings installation and diagnosis", () => {
	it("creates only the six hook groups, absolute permission and skill", async () => {
		await install();
		const installed = await settings();
		expect(Object.keys(installed).sort()).toEqual(["hooks", "permissions"]);
		expect(Object.keys(installed.hooks).sort()).toEqual(events.map(([event]) => event).sort());
		for (const [event, subcommand, timeout] of events) {
			expect(installed.hooks[event]).toHaveLength(1);
			expect(installed.hooks[event][0].hooks).toEqual([
				{ type: "command", command: hookCommand(programPath, subcommand), timeout },
			]);
		}
		expect(installed.permissions.allow).toEqual([`Bash(${programPath} memory *)`]);
		expect(await readFile(join(configDir, "skills/sno-mem-claude/SKILL.md"), "utf8"))
			.toContain("name: sno-mem-claude");
		expect((await readdir(configDir)).sort()).toEqual(["settings.json", "skills"]);
	});

	it("reports every dry-run write without changing existing bytes or adding files", async () => {
		const original = '{\r\n  "permissions": { "allow": ["Bash(git status)"] }\r\n}\r\n';
		await writeFile(join(configDir, "settings.json"), original);
		await writeFile(join(configDir, "sentinel"), "untouched\0bytes");
		const output: string[] = [];
		await install(output, true);
		expect((await readdir(configDir)).sort()).toEqual(["sentinel", "settings.json"]);
		expect(await readFile(join(configDir, "settings.json"), "utf8")).toBe(original);
		expect(await readFile(join(configDir, "sentinel"), "utf8")).toBe("untouched\0bytes");
		expect(output).toEqual(expect.arrayContaining([
			expect.stringContaining(join(configDir, "settings.json")),
			expect.stringContaining(join(configDir, "skills/sno-mem-claude/SKILL.md")),
		]));
	});

	it("updates its stale entries in place while keeping foreign groups and rules at their indices", async () => {
		await install();
		const initial = await settings();
		const foreign = { matcher: "startup", hooks: [{ type: "command", command: "/opt/foreign/hook", timeout: 7 }] };
		const stalePath = "/old/release/sno-mem-claude";
		for (const [event, subcommand] of events) {
			// An earlier release's own entry: another program path and timeout that install must rewrite.
			initial.hooks[event][0].hooks[0] = { type: "command", command: `'${stalePath}' ${subcommand}`, timeout: 1 };
			initial.hooks[event].unshift(foreign);
			initial.hooks[event].push({ ...foreign, matcher: "after" });
		}
		initial.permissions.allow = ["Bash(git status)", `Bash(${stalePath} *)`, "Read(/tmp/*)"];
		initial.env = { KEEP_THIS: "unchanged" };
		await writeFile(join(configDir, "settings.json"), JSON.stringify(initial));
		await install();
		const first = await readFile(join(configDir, "settings.json"));
		await install();
		expect(await readFile(join(configDir, "settings.json"))).toEqual(first);
		const installed = await settings();
		for (const [event, subcommand, timeout] of events) {
			expect(installed.hooks[event]).toHaveLength(3);
			expect(JSON.stringify(installed.hooks[event][0])).toBe(JSON.stringify(initial.hooks[event][0]));
			expect(JSON.stringify(installed.hooks[event][2])).toBe(JSON.stringify(initial.hooks[event][2]));
			expect(installed.hooks[event][1].hooks).toEqual([
				{ type: "command", command: hookCommand(programPath, subcommand), timeout },
			]);
		}
		expect(installed.permissions.allow).toEqual(["Bash(git status)", `Bash(${programPath} memory *)`, "Read(/tmp/*)"]);
		expect(installed.env).toEqual(initial.env);
	});

	it("leaves one hook per event when two of its own entries from earlier installs are already present", async () => {
		await install();
		const initial = await settings();
		const foreign = { matcher: "startup", hooks: [{ type: "command", command: "/opt/foreign/hook", timeout: 7 }] };
		for (const [event, subcommand] of events) {
			initial.hooks[event] = [
				{ hooks: [{ type: "command", command: `'/old/release/sno-mem-claude' ${subcommand}`, timeout: 1 }] },
				foreign,
				{ hooks: [{ type: "command", command: `'/older/release/sno-mem-claude' ${subcommand}`, timeout: 1 }] },
			];
		}
		await writeFile(join(configDir, "settings.json"), JSON.stringify(initial));

		await install();

		const installed = await settings();
		for (const [event, subcommand] of events) {
			const own = JSON.stringify(installed.hooks[event]).split(`memory hook ${subcommand} --harness claude`).length - 1;
			expect(own, `${event} must run its hook once`).toBe(1);
			expect(JSON.stringify(installed.hooks[event])).toContain("/opt/foreign/hook");
		}
	});

	it("cleans up the hooks and rule written with a replaced sno's ' (deleted)' path and never writes that path", async () => {
		// sno replaced while it ran reads its own path back as "<path> (deleted)". Setup wrote every hook and the
		// permission rule twice, once at that path; the copy that cannot run failed in every session.
		const deleted = `${programPath} (deleted)`;
		await install();
		const initial = await settings();
		for (const [event, subcommand, timeout] of events) {
			initial.hooks[event] = [
				{ hooks: [{ type: "command", command: hookCommand(deleted, subcommand), timeout }] },
				{ hooks: [{ type: "command", command: hookCommand(programPath, subcommand), timeout }] },
			];
		}
		initial.permissions.allow = [`Bash(${deleted} memory *)`, `Bash(${programPath} memory *)`];
		await writeFile(join(configDir, "settings.json"), JSON.stringify(initial));

		await installClaude({ configDir, programPath: deleted, writeOutput: () => {} });

		const installed = await settings();
		for (const [event, subcommand, timeout] of events) {
			expect(installed.hooks[event], event).toEqual([{ hooks: [{ type: "command", command: hookCommand(programPath, subcommand), timeout }] }]);
		}
		expect(installed.permissions.allow).toEqual([`Bash(${programPath} memory *)`]);
	});

	it("rewrites its hooks and rule when sno is at another path, never hooking an event twice", async () => {
		await install();
		await installClaude({ configDir, programPath: "/other/place/sno", writeOutput: () => {} });
		const installed = await settings();
		for (const [event, subcommand, timeout] of events) {
			expect(installed.hooks[event]).toHaveLength(1);
			expect(installed.hooks[event][0].hooks).toEqual([
				{ type: "command", command: hookCommand("/other/place/sno", subcommand), timeout },
			]);
		}
		expect(installed.permissions.allow).toEqual(["Bash(/other/place/sno memory *)"]);
	});

	it("runs each installed command through sh even when the absolute program path contains spaces", async () => {
		const spacedProgram = join(configDir, "Application Support", "sno");
		await mkdir(dirname(spacedProgram), { recursive: true });
		await writeFile(spacedProgram, "#!/bin/sh\nprintf '%s' \"$3\"\n");
		await chmod(spacedProgram, 0o700);
		await installClaude({ configDir, programPath: spacedProgram, writeOutput: () => {} });
		const installed = await settings();
		for (const [event, subcommand] of events) {
			const result = spawnSync("sh", ["-c", installed.hooks[event][0].hooks[0].command], { encoding: "utf8" });
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toBe(subcommand);
		}
	});

	it("leaves unparsable settings byte-identical, reports the error once, and still installs the skill", async () => {
		const malformed = '{\r\n  "hooks": {"SessionStart": [';
		await writeFile(join(configDir, "settings.json"), malformed);
		const output: string[] = [];
		await expect(install(output)).resolves.toBeUndefined();
		expect(await readFile(join(configDir, "settings.json"), "utf8")).toBe(malformed);
		expect(output.filter(line => /pars|JSON|syntax/i.test(line))).toHaveLength(1);
		expect(await readFile(join(configDir, "skills/sno-mem-claude/SKILL.md"), "utf8"))
			.toContain("name: sno-mem-claude");
		const lines = await doctor(configDir);
		expect(lines).toHaveLength(4);
		for (const [event] of events) expect(lines[1]).toContain(`${event}=unparsable`);
		const cli = spawnSync(process.execPath, [
			"--import", "tsx", "apps/mem-claude/src/cli.ts", "install", "--config-dir", configDir,
		], { encoding: "utf8", timeout: 10_000, env: { ...process.env, SNO_EXECUTABLE: programPath } });
		expect(cli.status, cli.stderr).toBe(0);
		expect(cli.stdout.split("\n").filter(line => /pars|JSON|syntax/i.test(line))).toHaveLength(1);
		expect(await readFile(join(configDir, "settings.json"), "utf8")).toBe(malformed);
	});

	it("uninstall through the command removes exactly what install wrote and keeps the user's own hooks and rules", async () => {
		// sno uninstall runs `dist/cli.js uninstall --config-dir <dir>`; without that command uninstall failed and left the hooks behind.
		await install();
		const installed = await settings();
		installed.hooks.SessionStart[0].hooks.push({ type: "command", command: "/usr/local/bin/notify start" });
		installed.hooks.Notification = [{ hooks: [{ type: "command", command: "/usr/local/bin/notify" }] }];
		installed.permissions.allow.push("Bash(git status)");
		installed.model = "opus";
		await writeFile(join(configDir, "settings.json"), JSON.stringify(installed));

		const cli = spawnSync(process.execPath, ["--import", "tsx", "apps/mem-claude/src/cli.ts", "uninstall", "--config-dir", configDir],
			{ encoding: "utf8", timeout: 10_000 });

		expect(cli.status, cli.stderr).toBe(0);
		const remaining = await settings();
		expect(remaining.hooks).toEqual({
			SessionStart: [{ hooks: [{ type: "command", command: "/usr/local/bin/notify start" }] }],
			Notification: [{ hooks: [{ type: "command", command: "/usr/local/bin/notify" }] }],
		});
		expect(remaining.permissions.allow).toEqual(["Bash(git status)"]);
		expect(remaining.model).toBe("opus");
		expect(await readdir(join(configDir, "skills"))).toEqual([]);
	});

	it("uninstall with nothing installed exits 0 and creates no file", async () => {
		const cli = spawnSync(process.execPath, ["--import", "tsx", "apps/mem-claude/src/cli.ts", "uninstall", "--config-dir", configDir],
			{ encoding: "utf8", timeout: 10_000 });
		expect(cli.status, cli.stderr).toBe(0);
		expect(await readdir(configDir)).toEqual([]);
	});

	it("reports only the missing event, respects disableAllHooks, and prints exactly four items", async () => {
		await install();
		let lines = await doctor(configDir);
		expect(lines).toHaveLength(4);
		for (const [event] of events) expect(lines[1]).toContain(`${event}=present`);
		const installed = await settings();
		delete installed.hooks.UserPromptSubmit;
		await writeFile(join(configDir, "settings.json"), JSON.stringify(installed));
		lines = await doctor(configDir);
		expect(lines).toHaveLength(4);
		expect(lines[1]).toContain("SessionStart=present");
		expect(lines[1]).toContain("UserPromptSubmit=absent");
		expect(lines[1]).toContain("Stop=present");
		installed.disableAllHooks = true;
		await writeFile(join(configDir, "settings.json"), JSON.stringify(installed));
		lines = await doctor(configDir);
		expect(lines).toHaveLength(4);
		for (const [event] of events) expect(lines[1]).toContain(`${event}=disabled`);
	});
});
