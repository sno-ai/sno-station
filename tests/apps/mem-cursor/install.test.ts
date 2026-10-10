import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctor } from "../../../apps/mem-cursor/src/doctor.ts";
import { installCursor, uninstallCursor } from "../../../apps/mem-cursor/src/install.ts";

const SNO = "/opt/sno/bin/sno";
const EVENTS = [
	["sessionStart", "session-start", 15],
	["beforeSubmitPrompt", "user-prompt-submit", 8],
	["afterAgentResponse", "after-agent-response", 5],
	["afterAgentThought", "after-agent-thought", 5],
	["stop", "stop", 5],
	["preCompact", "pre-compact", 5],
	["sessionEnd", "session-end", 8],
] as const;
const ours = (path: string, subcommand: string) => `'${path}' memory hook ${subcommand} --harness cursor`;
// Entries Orca writes into ~/.cursor/hooks.json today, and a Reach entry Sno's CLI writes.
const ORCA_STOP = { command: "/Applications/Orca.app/Contents/Resources/bin/orca-hook cursor stop", timeout: 10 };
const ORCA_PROMPT = { command: "/Applications/Orca.app/Contents/Resources/bin/orca-hook cursor prompt" };
const REACH_STOP = { command: `'${SNO}' reach cursor-hook stop`, timeout: 3600, loop_limit: null };

let home: string;
const output: string[] = [];
const install = (programPath = SNO) => installCursor({ cursorHome: home, programPath, writeOutput: line => output.push(line) });
const readJson = async (name: string) => JSON.parse(await readFile(join(home, name), "utf8"));

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "mem-cursor-install-"));
	output.length = 0;
});
afterEach(() => rm(home, { recursive: true, force: true }));

describe("Cursor hook and allowlist installation", () => {
	it("writes the seven entries beside foreign ones, keeps their content and order, and a second run changes nothing", async () => {
		await writeFile(join(home, "hooks.json"), JSON.stringify({ version: 1, hooks: { stop: [ORCA_STOP, REACH_STOP], beforeSubmitPrompt: [ORCA_PROMPT], afterFileEdit: [ORCA_PROMPT] } }, null, 2));
		await writeFile(join(home, "cli-config.json"), JSON.stringify({ version: 1, permissions: { allow: ["Shell(ls)"], deny: ["Shell(rm)"] }, model: { default: "auto" } }));
		await install();
		const hooks = await readJson("hooks.json");
		expect(hooks.version).toBe(1);
		expect(hooks.hooks.stop).toEqual([ORCA_STOP, REACH_STOP, { command: ours(SNO, "stop"), timeout: 5 }]);
		expect(hooks.hooks.beforeSubmitPrompt).toEqual([ORCA_PROMPT, { command: ours(SNO, "user-prompt-submit"), timeout: 8 }]);
		expect(hooks.hooks.afterFileEdit).toEqual([ORCA_PROMPT]);
		for (const [event, subcommand, timeout] of EVENTS) {
			expect(hooks.hooks[event].filter((entry: { command: string }) => entry.command.includes("memory hook")), event)
				.toEqual([{ command: ours(SNO, subcommand), timeout }]);
		}
		const config = await readJson("cli-config.json");
		expect(config).toEqual({ version: 1, permissions: { allow: ["Shell(ls)", `Shell(${SNO})`, "Shell(sno)"], deny: ["Shell(rm)"] }, model: { default: "auto" } });
		expect(await readFile(join(home, "skills", "sno-mem-cursor", "SKILL.md"), "utf8")).toContain("--harness cursor");
		const before = [await readFile(join(home, "hooks.json"), "utf8"), await readFile(join(home, "cli-config.json"), "utf8")];
		await install();
		expect([await readFile(join(home, "hooks.json"), "utf8"), await readFile(join(home, "cli-config.json"), "utf8")]).toEqual(before);
		expect(output.at(-1)).toBe("Sno memory for Cursor installed");
	});

	it("installs IDE command prefixes, preserves other settings, and removes only Sno prefixes", async () => {
		const foreign = { terminalAllowlist: ["git status", "/opt/bin/snow", "snooze"], terminalDenylist: ["rm"], browser: { enabled: false } };
		await writeFile(join(home, "permissions.json"), JSON.stringify({ ...foreign, terminalAllowlist: [...foreign.terminalAllowlist, "/old/place/sno", "sno", "sno"] }));
		await install();
		expect(await readJson("permissions.json")).toEqual({ ...foreign, terminalAllowlist: [...foreign.terminalAllowlist, SNO, "sno"] });
		const before = await readFile(join(home, "permissions.json"), "utf8");
		await install();
		expect(await readFile(join(home, "permissions.json"), "utf8")).toBe(before);
		await uninstallCursor({ cursorHome: home, writeOutput: line => output.push(line) });
		expect(await readJson("permissions.json")).toEqual(foreign);
		expect((await doctor(home))[3]).toBe("IDE permission rule: absent");
	});

	it("preserves an unparsable IDE permissions file and reports installation and removal failures", async () => {
		const invalid = '{ "terminalAllowlist": [';
		await writeFile(join(home, "permissions.json"), invalid);
		await expect(install()).rejects.toThrow("could not be parsed");
		expect(await readFile(join(home, "permissions.json"), "utf8")).toBe(invalid);
		expect((await doctor(home))[3]).toBe("IDE permission rule: unparsable");
		expect(output).toContain(`permissions.json parse error; left unchanged: ${join(home, "permissions.json")}`);
		expect(output).not.toContain("Sno memory for Cursor installed");
		await expect(uninstallCursor({ cursorHome: home, writeOutput: line => output.push(line) })).rejects.toThrow("could not be parsed");
		expect(await readFile(join(home, "permissions.json"), "utf8")).toBe(invalid);
		expect(output).not.toContain("Sno memory for Cursor removed");
	});

	it("replaces our entry in place when sno moves, and drops a duplicate", async () => {
		const old = "/old/place/sno";
		await writeFile(join(home, "hooks.json"), JSON.stringify({ version: 1, hooks: {
			stop: [{ command: ours(old, "stop"), timeout: 5 }, ORCA_STOP, { command: ours(old, "stop"), timeout: 5 }],
		} }));
		await writeFile(join(home, "cli-config.json"), JSON.stringify({ permissions: { allow: [`Shell(${old})`, "Shell(git)", "Shell(sno)"] } }));
		await install();
		expect((await readJson("hooks.json")).hooks.stop).toEqual([{ command: ours(SNO, "stop"), timeout: 5 }, ORCA_STOP]);
		expect((await readJson("cli-config.json")).permissions.allow).toEqual(["Shell(git)", `Shell(${SNO})`, "Shell(sno)"]);
	});

	it("creates configuration files on a fresh home and the doctor sees every entry", async () => {
		await install();
		expect(Object.keys((await readJson("hooks.json")).hooks).sort()).toEqual(EVENTS.map(([event]) => event).sort());
		expect(await readJson("permissions.json")).toEqual({ terminalAllowlist: [SNO, "sno"] });
		const lines = await doctor(home);
		expect(lines[1]).toBe(`hooks: ${EVENTS.map(([event]) => `${event}=present`).join(" ")}`);
		expect(lines[2]).toBe("permission rule: present");
		expect(lines[3]).toBe("IDE permission rule: present");
	});

	it("leaves an unparsable hooks.json byte-for-byte and says so", async () => {
		await writeFile(join(home, "hooks.json"), "{ \"version\": 1, \"hooks\": ");
		await expect(install()).rejects.toThrow("could not be parsed");
		expect(await readFile(join(home, "hooks.json"), "utf8")).toBe("{ \"version\": 1, \"hooks\": ");
		expect(output).toContain(`hooks.json parse error; left unchanged: ${join(home, "hooks.json")}`);
		expect(output).not.toContain("Sno memory for Cursor installed");
		expect((await doctor(home))[1]).toContain("sessionStart=unparsable");
		await expect(uninstallCursor({ cursorHome: home, writeOutput: line => output.push(line) })).rejects.toThrow("could not be parsed");
		expect(output).not.toContain("Sno memory for Cursor removed");
	});

	it("uninstall removes only our entries, rule and skill, and creates nothing on a home without the files", async () => {
		await writeFile(join(home, "hooks.json"), JSON.stringify({ version: 1, hooks: { stop: [ORCA_STOP] } }));
		await writeFile(join(home, "cli-config.json"), JSON.stringify({ permissions: { allow: ["Shell(ls)"] } }));
		await install();
		await uninstallCursor({ cursorHome: home, writeOutput: line => output.push(line) });
		expect(await readJson("hooks.json")).toEqual({ version: 1, hooks: { stop: [ORCA_STOP] } });
		expect((await readJson("cli-config.json")).permissions.allow).toEqual(["Shell(ls)"]);
		await expect(stat(join(home, "skills", "sno-mem-cursor"))).rejects.toThrow();
		const empty = await mkdtemp(join(tmpdir(), "mem-cursor-uninstall-"));
		await uninstallCursor({ cursorHome: empty, writeOutput: () => {} });
		await expect(stat(join(empty, "hooks.json"))).rejects.toThrow();
		await expect(stat(join(empty, "cli-config.json"))).rejects.toThrow();
		await expect(stat(join(empty, "permissions.json"))).rejects.toThrow();
		await rm(empty, { recursive: true, force: true });
	});
});
