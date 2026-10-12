import { spawnSync } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The installer is run for real. Only `openclaw` is a stand-in: it accepts the install, a gateway restart, and answers `agents list --json`.
const installer = new URL("../../../../apps/mem-claw/bin/mem-claw-install.js", import.meta.url).pathname;
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function install(agents: Array<{ id: string; isDefault: boolean }>) {
	const root = mkdtempSync(join(tmpdir(), "sno-mem-claw-agents-"));
	roots.push(root);
	mkdirSync(join(root, "bin"));
	const stub = join(root, "bin", "openclaw");
	writeFileSync(
		stub,
		`#!/bin/sh\ncase "$*" in\n  "plugins install "*) exit 0 ;;\n  "gateway "*) exit 0 ;;\n  "agents list --json") cat <<'JSON'\n${JSON.stringify(agents)}\nJSON\n  exit 0 ;;\nesac\nexit 2\n`,
	);
	chmodSync(stub, 0o755);
	return spawnSync(process.execPath, [installer], {
		env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

describe("mem-claw installer and OpenClaw's agent selection", () => {
	it("tells the user how to pick a default agent when there are several and none is the default, and still succeeds", () => {
		const run = install([{ id: "alpha", isDefault: false }, { id: "beta", isDefault: false }]);
		expect(run.status).toBe(0);
		const output = `${run.stdout}${run.stderr}`;
		expect(output).toContain("alpha, beta");
		expect(output).toContain("openclaw config set agents.defaults.systemAgent.agentId <id>");
	});

	it("says nothing about agents when one is the default or there is only one", () => {
		for (const agents of [[{ id: "alpha", isDefault: true }, { id: "beta", isDefault: false }], [{ id: "only", isDefault: false }]]) {
			const run = install(agents);
			expect(run.status).toBe(0);
			expect(`${run.stdout}${run.stderr}`).not.toContain("agents.defaults.systemAgent.agentId");
		}
	});
});

describe("mem-claw installer and OpenClaw's gateway", () => {
	// `openclaw` is a stand-in that logs every call; `gateway health` fails twice, then answers.
	function installWithGateway(restart: "ok" | "fail", args: string[] = []) {
		const root = mkdtempSync(join(tmpdir(), "sno-mem-claw-gateway-"));
		roots.push(root);
		mkdirSync(join(root, "bin"));
		const calls = join(root, "calls.log");
		const stub = join(root, "bin", "openclaw");
		writeFileSync(
			stub,
			`#!/bin/sh\necho "$*" >> "${calls}"\nargs="${"$"}{*#--profile work }"\ncase "$args" in\n  "plugins install "*) exit 0 ;;\n  "agents list --json") echo "[]"; exit 0 ;;\n  "gateway restart") ${restart === "ok" ? "exit 0" : "echo 'stopping service'; echo 'service stopped'; echo 'Agent database needs a migration: run openclaw doctor --fix' >&2; exit 3"} ;;\n  "gateway health") n=$(grep -c "gateway health" "${calls}"); [ "$n" -ge 3 ] && exit 0; exit 1 ;;\nesac\nexit 2\n`,
		);
		chmodSync(stub, 0o755);
		const run = spawnSync(process.execPath, [installer, ...args], {
			env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { run, calls: readFileSync(calls, "utf8").trim().split("\n") };
	}

	it("restarts the gateway after the install and waits until it answers", () => {
		const { run, calls } = installWithGateway("ok");
		expect(run.status).toBe(0);
		expect(calls.filter(call => call.startsWith("gateway"))).toEqual(["gateway restart", "gateway health", "gateway health", "gateway health"]);
		expect(calls.findIndex(call => call.startsWith("plugins install"))).toBeLessThan(calls.indexOf("gateway restart"));
		expect(`${run.stdout}${run.stderr}`).toContain("gateway restarted and answers");
	});

	it("fails when the restart fails, and the last line carries OpenClaw's own hint (it is the only line `sno update` shows)", () => {
		const { run, calls } = installWithGateway("fail", ["--profile", "work"]);
		expect(run.status).toBe(1);
		expect(calls.filter(call => call.includes("gateway"))).toEqual(["--profile work gateway restart"]);
		const last = run.stderr.trim().split("\n").at(-1) ?? "";
		expect(last).toContain("did not restart");
		expect(last).toContain("run openclaw doctor --fix");
		expect(last).toContain("start it with: openclaw --profile work gateway restart");
	});
});

describe("mem-claw installer over a plugin the running gateway has loaded", () => {
	// A running gateway keeps a second link to each file of the plugin it loaded, and `plugins install` refuses to replace a
	// directory holding such a file. The stand-in refuses the same way, and `plugins inspect` names the installed directory.
	it("upgrades, leaves the gateway's copy as it was, and does not touch the host OpenClaw the plugin links to", () => {
		const root = mkdtempSync(join(tmpdir(), "sno-mem-claw-upgrade-"));
		roots.push(root);
		const installed = join(root, "extensions", "sno-mem-claw");
		mkdirSync(join(installed, "node_modules"), { recursive: true });
		writeFileSync(join(installed, "package.json"), '{"version":"1.2.9"}');
		mkdirSync(join(root, "capture"));
		linkSync(join(installed, "package.json"), join(root, "capture", "package.json"));
		mkdirSync(join(root, "host"));
		writeFileSync(join(root, "host", "index.js"), "host");
		linkSync(join(root, "host", "index.js"), join(root, "host-second-link.js"));
		symlinkSync(join(root, "host"), join(installed, "node_modules", "openclaw"));
		mkdirSync(join(root, "bin"));
		const stub = join(root, "bin", "openclaw");
		writeFileSync(
			stub,
			`#!/bin/sh\ncase "$*" in\n  "plugins inspect sno-mem-claw --json") echo '{"plugin":{"rootDir":"${installed}"}}'; exit 0 ;;\n  "plugins install "*) [ -n "$(find "${installed}" -type f -links +1)" ] && { echo "failed to copy plugin: FsSafeError: Refusing to move hardlinked file" >&2; exit 1; }; exit 0 ;;\n  "gateway "*) exit 0 ;;\n  "agents list --json") echo "[]"; exit 0 ;;\nesac\nexit 2\n`,
		);
		chmodSync(stub, 0o755);
		const run = spawnSync(process.execPath, [installer], {
			env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		expect(run.stderr).not.toContain("Refusing to move hardlinked file");
		expect(run.status).toBe(0);
		expect(readFileSync(join(installed, "package.json"), "utf8")).toBe('{"version":"1.2.9"}');
		expect(readFileSync(join(root, "capture", "package.json"), "utf8")).toBe('{"version":"1.2.9"}');
		expect(statSync(join(root, "host", "index.js")).nlink).toBe(2);
	});
});
