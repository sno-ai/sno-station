import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const pluginDir = resolve(import.meta.dirname, "../../../../apps/mem-claw");
const bin = join(pluginDir, "bin", "mem-claw-install.js");

describe("OpenClaw installer", () => {
	let root: string;
	let calls: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "mem-claw-install-"));
		calls = join(root, "calls.txt");
		writeFileSync(join(root, "openclaw"), `#!/bin/sh\necho "$*" >> "${calls}"\nexit "$TEST_INSTALL_EXIT"\n`);
		chmodSync(join(root, "openclaw"), 0o755);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));
	const run = (args: string[], exit = "0") => spawnSync(process.execPath, [bin, ...args], {
		env: { ...process.env, HOME: root, PATH: `${root}:${process.env.PATH ?? ""}`, TEST_INSTALL_EXIT: exit },
		encoding: "utf8",
	});

	it("exposes the installer entry points", () => {
		const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
		expect(pkg.bin["mem-claw"]).toBe("./bin/mem-claw-install.js");
		expect(pkg.bin["mem-claw-install"]).toBe("./bin/mem-claw-install.js");
	});
	it("installs the plugin without writing memory settings to OpenClaw", () => {
		const result = run([]);
		expect(result.status).toBe(0);
		expect(readFileSync(calls, "utf8")).toContain(`plugins install ${pluginDir}`);
		expect(existsSync(join(root, ".openclaw", "openclaw.json"))).toBe(false);
		expect(result.stdout).toContain("Run sno setup");
	});
	it("passes the selected profile to OpenClaw", () => {
		const result = run(["--profile", "sno-e2e"]);
		expect(result.status).toBe(0);
		expect(readFileSync(calls, "utf8")).toContain(`--profile sno-e2e plugins install ${pluginDir}`);
	});
	it("propagates an install failure", () => {
		const result = run([], "7");
		expect(result.status).toBe(7);
		expect(result.stdout).not.toContain("plugin installed");
	});
	it("rejects an unknown option before starting OpenClaw", () => {
		const result = run(["--bogus"]);
		expect(result.status).toBe(2);
		expect(existsSync(calls)).toBe(false);
	});
	it("shows help without starting OpenClaw", () => {
		const result = run(["--help"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Run sno setup");
		expect(existsSync(calls)).toBe(false);
	});
});
