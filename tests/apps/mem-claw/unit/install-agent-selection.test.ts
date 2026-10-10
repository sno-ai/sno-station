import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The installer is run for real. Only `openclaw` is a stand-in: it accepts the install and answers `agents list --json`.
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
		`#!/bin/sh\ncase "$*" in\n  "plugins install "*) exit 0 ;;\n  "agents list --json") cat <<'JSON'\n${JSON.stringify(agents)}\nJSON\n  exit 0 ;;\nesac\nexit 2\n`,
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
