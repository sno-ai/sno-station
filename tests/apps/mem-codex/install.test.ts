import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeTrustHash, installCodex } from "../../../apps/mem-codex/src/install.ts";
import { doctor } from "../../../apps/mem-codex/src/doctor.ts";

const temporaryHomes: string[] = [];

async function temporaryHome(): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "sno-mem-codex-install-"));
	temporaryHomes.push(home);
	return home;
}

afterEach(async () => {
	const { rm } = await import("node:fs/promises");
	await Promise.all(temporaryHomes.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("Codex hook trust", () => {
	it("hashes recursively sorted hook JSON in the format Codex trusts", () => {
		expect(computeTrustHash({
			event_name: "session_start",
			hooks: [{
				type: "command",
				command: "/opt/sno/bin/sno-mem-codex session-start",
				timeout: 15,
				async: false,
			}],
		})).toBe("sha256:6644299ac3defec96091dae0856e2bdedcfcb47757ec4f6a4ca51ecfde949866");
	});
});

describe("sno-mem-codex install", () => {
	it("reports one edited hook as stale and prints exactly four items", async () => {
		const codexHome = await temporaryHome();
		await installCodex({ codexHome, programPath: "/opt/sno/bin/sno", writeOutput: () => undefined });
		const hooksPath = join(codexHome, "hooks.json");
		const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
		hooks.hooks.SessionStart[0].hooks[0].command = "/opt/sno/edited/sno-mem-codex session-start";
		await writeFile(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
		const previousProfile = process.env.SNO_PROFILE_DIR;
		process.env.SNO_PROFILE_DIR = codexHome;
		try {
			const lines = await doctor(codexHome);
			expect(lines).toHaveLength(4);
			expect(lines[1]).toBe("hook trust: SessionStart=stale-hash UserPromptSubmit=trusted-current Stop=trusted-current SessionEnd=trusted-current PreToolUse=trusted-current PostToolUse=trusted-current");
		} finally {
			if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
			else process.env.SNO_PROFILE_DIR = previousProfile;
		}
	});

	it("reports every dry-run write without changing the Codex home", async () => {
		const codexHome = await temporaryHome();
		const output: string[] = [];
		const before = await import("node:fs/promises").then(fs => fs.readdir(codexHome));

		await installCodex({
			codexHome,
			programPath: "/opt/sno/bin/sno",
			dryRun: true,
			writeOutput: line => output.push(line),
		});

		expect(await import("node:fs/promises").then(fs => fs.readdir(codexHome))).toEqual(before);
		expect(output).toEqual(expect.arrayContaining([
			expect.stringContaining("hooks.json"),
			expect.stringContaining("config.toml"),
			expect.stringContaining("sno-mem-codex.rules"),
			expect.stringContaining("skills/sno-mem-codex/SKILL.md"),
		]));
	});

	it("rejects malformed hooks configuration without reporting success", async () => {
		const codexHome = await temporaryHome();
		const output: string[] = [];
		await writeFile(join(codexHome, "hooks.json"), "{not-json");

		await expect(installCodex({
			codexHome,
			programPath: "/opt/sno/bin/sno",
			writeOutput: line => output.push(line),
		})).rejects.toThrow();
		expect(await readFile(join(codexHome, "hooks.json"), "utf8")).toBe("{not-json");
		expect(output).toEqual([]);
	});

	it("rejects malformed hook groups without reporting success", async () => {
		const codexHome = await temporaryHome();
		const output: string[] = [];
		await writeFile(join(codexHome, "hooks.json"), JSON.stringify({
			hooks: { SessionStart: [{ hooks: [{ command: 42 }] }] },
		}));

		await expect(installCodex({
			codexHome,
			programPath: "/opt/sno/bin/sno",
			writeOutput: line => output.push(line),
		})).rejects.toThrow();

		expect(await readFile(join(codexHome, "hooks.json"), "utf8"))
			.toBe('{"hooks":{"SessionStart":[{"hooks":[{"command":42}]}]}}');
		expect(output).toEqual([]);
	});

	it("preserves foreign commands and attributes in mixed hook groups", async () => {
		const codexHome = await temporaryHome();
		const hooksPath = join(codexHome, "hooks.json");
		await writeFile(hooksPath, JSON.stringify({
			hooks: { SessionStart: [
				{ matcher: "startup", enabled: true, hooks: [
					{ type: "command", command: "/opt/foreign/before", timeout: 7 },
					{ type: "command", command: "sno-mem-codex session-start", timeout: 9 },
					{ type: "command", command: "/opt/foreign/after", timeout: 8 },
				] },
				{ matcher: "duplicate", hooks: [
					{ type: "command", command: "sno-mem-codex session-start", timeout: 9 },
					{ type: "command", command: "/opt/foreign/duplicate", timeout: 6 },
				] },
			] },
		}));

		await installCodex({ codexHome, programPath: "/opt/sno/bin/sno", writeOutput: () => undefined });

		const installed = JSON.parse(await readFile(hooksPath, "utf8"));
		expect(installed.hooks.SessionStart).toEqual([
			{ matcher: "startup", enabled: true, hooks: [
				{ type: "command", command: "/opt/foreign/before", timeout: 7 },
				{ type: "command", command: "'/opt/sno/bin/sno' memory hook session-start --harness codex", timeout: 15 },
				{ type: "command", command: "/opt/foreign/after", timeout: 8 },
			] },
			{ matcher: "duplicate", hooks: [
				{ type: "command", command: "'/opt/sno/bin/sno' memory hook session-start --harness codex", timeout: 15 },
				{ type: "command", command: "/opt/foreign/duplicate", timeout: 6 },
			] },
		]);
		expect(await readFile(join(codexHome, "config.toml"), "utf8"))
			.toContain('hooks.json:session_start:0:1"]\nenabled = true');
	});

	it("preserves the foreign command index after two owned commands", async () => {
		const codexHome = await temporaryHome();
		const hooksPath = join(codexHome, "hooks.json");
		await writeFile(hooksPath, JSON.stringify({
			hooks: { SessionStart: [{ hooks: [
				{ type: "command", command: "sno-mem-codex session-start", timeout: 9 },
				{ type: "command", command: "sno-mem-codex session-start", timeout: 9 },
				{ type: "command", command: "/opt/foreign/hook", timeout: 7 },
			] }] },
		}));

		await installCodex({ codexHome, programPath: "/opt/sno/bin/sno", writeOutput: () => undefined });

		const installed = JSON.parse(await readFile(hooksPath, "utf8"));
		expect(installed.hooks.SessionStart[0].hooks[2]?.command).toBe("/opt/foreign/hook");
	});

	it("fails installation and preserves the bytes of an unparseable hooks file", async () => {
		const codexHome = await temporaryHome();
		const hooksPath = join(codexHome, "hooks.json");
		await writeFile(hooksPath, '{\r\n  "hooks": {"SessionStart": [');

		await expect.soft(installCodex({
			codexHome,
			programPath: "/opt/sno/bin/sno",
			writeOutput: () => undefined,
		})).rejects.toThrow();
		expect(await readFile(hooksPath)).toEqual(Buffer.from('{\r\n  "hooks": {"SessionStart": ['));
	});

	it("is idempotent and preserves a foreign hook entry byte-for-byte", async () => {
		const codexHome = await temporaryHome();
		const hooksPath = join(codexHome, "hooks.json");
		const foreign = {
			matcher: "foreign",
			hooks: [{ type: "command", command: "/opt/foreign/hook", timeout: 7 }],
		};
		await writeFile(hooksPath, JSON.stringify({
			hooks: { SessionStart: [foreign] },
		}, null, 2) + "\n");
		const foreignTrust = `[hooks.state.${JSON.stringify(`${hooksPath}:session_start:0:0`)}]\nenabled = false\ntrusted_hash = "foreign-hash"`;
		await writeFile(join(codexHome, "config.toml"), `${foreignTrust}\n`);

		const options = {
			codexHome,
			programPath: "/opt/sno/bin/sno",
			writeOutput: () => undefined,
		};
		await installCodex(options);
		const first = await readFile(join(codexHome, "hooks.json"), "utf8");
		const firstConfig = await readFile(join(codexHome, "config.toml"), "utf8");
		await installCodex(options);
		const second = await readFile(join(codexHome, "hooks.json"), "utf8");
		const secondConfig = await readFile(join(codexHome, "config.toml"), "utf8");

		expect(second).toBe(first);
		expect(secondConfig).toBe(firstConfig);
		expect(secondConfig).toContain(foreignTrust);
		const parsed = JSON.parse(second) as {
			hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
		};
		expect(parsed.hooks.SessionStart?.[0]).toEqual(foreign);
		for (const [event, subcommand] of [
			["SessionStart", "session-start"],
			["UserPromptSubmit", "user-prompt-submit"],
			["Stop", "stop"],
			["SessionEnd", "session-end"],
			["PreToolUse", "pre-tool-use"],
			["PostToolUse", "post-tool-use"],
		] as const) {
			const owned = parsed.hooks[event]?.filter(group =>
				group.hooks.some(hook => hook.command === `'/opt/sno/bin/sno' memory hook ${subcommand} --harness codex`));
			expect(owned).toHaveLength(1);
		}
		const rules = await readFile(join(codexHome, "rules/sno-mem-codex.rules"), "utf8");
		expect(rules.trim().split("\n")).toEqual([
			'prefix_rule(pattern=["/opt/sno/bin/sno", "memory", "recall"], decision="allow")',
			'prefix_rule(pattern=["/opt/sno/bin/sno", "memory", "get"], decision="allow")',
			'prefix_rule(pattern=["/opt/sno/bin/sno", "memory", "remember"], decision="allow")',
			'prefix_rule(pattern=["/opt/sno/bin/sno", "memory", "correct"], decision="allow")',
		]);
		expect(rules).not.toMatch(/forget|clear/);
	});

	it("rewrites its hooks when sno is at another path, never hooking an event twice", async () => {
		const codexHome = await temporaryHome();
		await installCodex({ codexHome, programPath: "/opt/sno/bin/sno", writeOutput: () => undefined });
		await installCodex({ codexHome, programPath: "/other/place/sno", writeOutput: () => undefined });
		const installed = JSON.parse(await readFile(join(codexHome, "hooks.json"), "utf8"));
		expect(installed.hooks.SessionStart).toHaveLength(1);
		expect(installed.hooks.SessionStart[0].hooks[0].command).toBe("'/other/place/sno' memory hook session-start --harness codex");
	});

	it("runs each event once at the real path after a setup from a replaced sno wrote ' (deleted)' copies", async () => {
		// sno replaced while it ran reads its own path back as "<path> (deleted)"; setup then wrote a second hook per
		// event at that path, which failed in every session, and the rules allowed only the path that cannot run.
		const codexHome = await temporaryHome();
		const hooksPath = join(codexHome, "hooks.json");
		await installCodex({ codexHome, programPath: "/opt/sno/bin/sno", writeOutput: () => undefined });
		const seeded = JSON.parse(await readFile(hooksPath, "utf8"));
		for (const groups of Object.values(seeded.hooks) as { hooks: { command: string }[] }[][]) {
			groups.push({ hooks: [{ ...groups[0].hooks[0], command: groups[0].hooks[0].command.replace("'/opt/sno/bin/sno'", "'/opt/sno/bin/sno (deleted)'") }] });
		}
		seeded.hooks.Stop.push({ hooks: [{ type: "command", command: "/usr/local/bin/notify", timeout: 2 }] });
		await writeFile(hooksPath, `${JSON.stringify(seeded, null, 2)}\n`);

		await installCodex({ codexHome, programPath: "/opt/sno/bin/sno (deleted)", writeOutput: () => undefined });

		const installed = JSON.parse(await readFile(hooksPath, "utf8"));
		for (const [event, groups] of Object.entries(installed.hooks) as [string, { hooks: { command: string }[] }[]][]) {
			const commands = groups.flatMap(group => group.hooks.map(hook => hook.command)).filter(command => command.includes(" memory hook "));
			expect(commands, event).toHaveLength(1);
			expect(commands[0], event).toMatch(/^'\/opt\/sno\/bin\/sno' memory hook /);
		}
		expect(installed.hooks.Stop[2].hooks[0].command).toBe("/usr/local/bin/notify");
		const rules = await readFile(join(codexHome, "rules", "sno-mem-codex.rules"), "utf8");
		expect(rules).not.toContain("(deleted)");
		expect(rules).toContain('"/opt/sno/bin/sno"');
	});

	it("quotes a program path with spaces before hashing and running each hook", async () => {
		const codexHome = await temporaryHome();
		const programPath = join(codexHome, "Application Support", "sno");
		await mkdir(dirname(programPath), { recursive: true });
		await writeFile(programPath, "#!/bin/sh\nprintf '%s' \"$3\"\n");
		await chmod(programPath, 0o700);

		await installCodex({ codexHome, programPath, writeOutput: () => undefined });
		const installed = JSON.parse(await readFile(join(codexHome, "hooks.json"), "utf8"));
		for (const [event, subcommand] of [
			["SessionStart", "session-start"],
			["UserPromptSubmit", "user-prompt-submit"],
			["Stop", "stop"],
			["SessionEnd", "session-end"],
			["PreToolUse", "pre-tool-use"],
			["PostToolUse", "post-tool-use"],
		] as const) {
			const command = installed.hooks[event][0].hooks[0].command as string;
			expect(command).toBe(`'${programPath}' memory hook ${subcommand} --harness codex`);
			const executed = spawnSync("zsh", ["-c", command], { encoding: "utf8" });
			expect(executed.status, executed.stderr).toBe(0);
			expect(executed.stdout).toBe(subcommand);
		}
		const lines = await doctor(codexHome);
		expect(lines[1]).toBe("hook trust: SessionStart=trusted-current UserPromptSubmit=trusted-current Stop=trusted-current SessionEnd=trusted-current PreToolUse=trusted-current PostToolUse=trusted-current");
	});

	it("replaces an owned group in place without moving a later trusted foreign group", async () => {
		const codexHome = await temporaryHome();
		const hooksPath = join(codexHome, "hooks.json");
		const owned = { hooks: [{ type: "command", command: "'/opt/sno/bin/sno-mem-codex' session-start", timeout: 15 }] };
		const foreign = { matcher: "foreign", hooks: [{ type: "command", command: "/opt/foreign/hook", timeout: 7 }] };
		await writeFile(hooksPath, `${JSON.stringify({ hooks: { SessionStart: [owned, foreign] } }, null, 2)}\n`);
		const ownKey = `${hooksPath}:session_start:0:0`;
		const foreignKey = `${hooksPath}:session_start:1:0`;
		const foreignTrust = `[hooks.state.${JSON.stringify(foreignKey)}]\nenabled = false\ntrusted_hash = "foreign-hash"`;
		await writeFile(join(codexHome, "config.toml"), `[hooks.state.${JSON.stringify(ownKey)}]\nenabled = true\ntrusted_hash = "old"\n\n${foreignTrust}\n`);

		await installCodex({ codexHome, programPath: "/opt/sno/bin/sno", writeOutput: () => undefined });

		const installed = JSON.parse(await readFile(hooksPath, "utf8"));
		expect(installed.hooks.SessionStart[0].hooks[0].command).toBe("'/opt/sno/bin/sno' memory hook session-start --harness codex");
		expect(installed.hooks.SessionStart[1]).toEqual(foreign);
		const config = await readFile(join(codexHome, "config.toml"), "utf8");
		expect(config).toContain(foreignTrust);
		const headers = [...config.matchAll(/^\[hooks\.state\..+\]$/gm)].map(match => match[0]);
		expect(new Set(headers).size).toBe(headers.length);
		const parsed = spawnSync("python3", ["-c", "import sys, tomllib; tomllib.loads(sys.stdin.read())"], {
			encoding: "utf8",
			input: config,
		});
		expect(parsed.status, parsed.stderr).toBe(0);
	});

	it("replaces a stale trust table under the key of a hook it newly appends, leaving one table for that key", async () => {
		const codexHome = await temporaryHome();
		const hooksPath = join(codexHome, "hooks.json");
		const foreign = { matcher: "foreign", hooks: [{ type: "command", command: "/opt/foreign/hook", timeout: 7 }] };
		await writeFile(hooksPath, `${JSON.stringify({ hooks: { PreToolUse: [foreign] } }, null, 2)}\n`);
		const newKey = `${hooksPath}:pre_tool_use:1:0`;
		await writeFile(join(codexHome, "config.toml"), `[hooks.state.${JSON.stringify(newKey)}]\nenabled = true\ntrusted_hash = "stale-hash"\n`);

		await installCodex({ codexHome, programPath: "/opt/sno/bin/sno", writeOutput: () => undefined });

		const installed = JSON.parse(await readFile(hooksPath, "utf8"));
		expect(installed.hooks.PreToolUse[0]).toEqual(foreign);
		expect(installed.hooks.PreToolUse[1].hooks[0].command).toBe("'/opt/sno/bin/sno' memory hook pre-tool-use --harness codex");
		const config = await readFile(join(codexHome, "config.toml"), "utf8");
		const header = `[hooks.state.${JSON.stringify(newKey)}]`;
		expect(config.split(header).length - 1).toBe(1);
		expect(config).not.toContain("stale-hash");
		const parsed = spawnSync("python3", ["-c", "import sys, tomllib; tomllib.loads(sys.stdin.read())"], {
			encoding: "utf8",
			input: config,
		});
		expect(parsed.status, parsed.stderr).toBe(0);
	});

	it("leaves one trust table per key and a parseable file when two of its own entries from earlier installs are already present", async () => {
		const codexHome = await temporaryHome();
		const hooksPath = join(codexHome, "hooks.json");
		const events = [["SessionStart", "session_start", "session-start"], ["Stop", "stop", "stop"]] as const;
		const seeded: Record<string, unknown[]> = {};
		let trust = "";
		for (const [event, eventName, subcommand] of events) {
			seeded[event] = [
				{ hooks: [{ type: "command", command: `'/old/release/sno-mem-codex' ${subcommand}`, timeout: 1 }] },
				{ hooks: [{ type: "command", command: `'/older/release/sno-mem-codex' ${subcommand}`, timeout: 1 }] },
			];
			for (const index of [0, 1]) trust += `[hooks.state.${JSON.stringify(`${hooksPath}:${eventName}:${index}:0`)}]\nenabled = true\ntrusted_hash = "stale-${index}"\n\n`;
		}
		await writeFile(hooksPath, `${JSON.stringify({ hooks: seeded }, null, 2)}\n`);
		await writeFile(join(codexHome, "config.toml"), trust);

		await installCodex({ codexHome, programPath: "/opt/sno/bin/sno", writeOutput: () => undefined });

		const config = await readFile(join(codexHome, "config.toml"), "utf8");
		expect(config).not.toContain("stale-");
		const headers = [...config.matchAll(/^\[hooks\.state\..+\]$/gm)].map(match => match[0]);
		expect(new Set(headers).size).toBe(headers.length);
		const parsed = spawnSync("python3", ["-c", "import sys, tomllib; tomllib.loads(sys.stdin.read())"], { encoding: "utf8", input: config });
		expect(parsed.status, parsed.stderr).toBe(0);
	});
});
