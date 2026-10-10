// `sno setup --harness openclaw` runs the plugin's own installer with no terminal and nobody to answer a prompt.
// Run the same installer against a real OpenClaw the same way, and check the plugin is installed afterwards.
// Usage: OPENCLAW_BIN=/abs/path/to/openclaw node tests/apps/mem-claw/e2e/install-unattended.e2e.mjs
//   OPENCLAW_BIN may also be a .mjs entry file (it is then run with node).
//   MEM_CLAW_DIR picks the installed @snoai/mem-claw folder, laid out as `npm install -g` leaves it, as sno setup installs it
//   (its dependencies inside the package folder); the default is this source tree.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const openclaw = process.env.OPENCLAW_BIN;
if (!openclaw || !isAbsolute(openclaw)) throw new Error("OPENCLAW_BIN must be the absolute path of the real openclaw");
const packageDir = process.env.MEM_CLAW_DIR ?? new URL("../../../../apps/mem-claw/", import.meta.url).pathname;
const installer = join(packageDir, "bin", "mem-claw-install.js");
if (!existsSync(installer)) throw new Error(`installer not found: ${installer}`);

const root = mkdtempSync(join(tmpdir(), "sno-mem-claw-unattended-"));
try {
	mkdirSync(join(root, "bin"));
	mkdirSync(join(root, "state"));
	const wrapper = join(root, "bin", "openclaw");
	const exec = openclaw.endsWith(".mjs") ? `node ${JSON.stringify(openclaw)}` : JSON.stringify(openclaw);
	writeFileSync(wrapper, `#!/bin/sh\nexec ${exec} "$@"\n`);
	chmodSync(wrapper, 0o755);
	const env = {
		...process.env,
		PATH: `${join(root, "bin")}:${process.env.PATH}`,
		OPENCLAW_STATE_DIR: join(root, "state"),
		OPENCLAW_CONFIG_PATH: join(root, "state", "openclaw.json"),
	};
	// stdin is closed and the child gets its own session, so it has no terminal to ask on: the same as under sno setup.
	const run = spawnSync(process.execPath, [installer], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], detached: true, timeout: 120_000 });
	const output = `${run.stdout}${run.stderr}`.trim();
	if (run.status !== 0) {
		console.error(`unattended OpenClaw install failed (exit ${run.status ?? run.signal}):\n${output.split("\n").slice(-8).join("\n")}`);
		process.exit(1);
	}
	const inspect = spawnSync(wrapper, ["plugins", "inspect", "sno-mem-claw"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
	const status = /^Status:\s*(\S+)/m.exec(inspect.stdout)?.[1];
	if (status !== "enabled" && status !== "loaded") {
		console.error(`the installer exited 0 but the plugin is not installed (status: ${status ?? "none"}):\n${inspect.stdout}${inspect.stderr}`);
		process.exit(1);
	}
	console.log(`unattended OpenClaw install ok: sno-mem-claw ${/^Version:\s*(\S+)/m.exec(inspect.stdout)?.[1]} is ${status}`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
