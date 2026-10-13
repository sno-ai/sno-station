import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("exits after three real startup failures rather than leaving a detached retry loop", async () => {
	const root = await mkdtemp(join(tmpdir(), "sidecar-startup-failure-"));
	// A directory where the socket lock file should be makes every actual startup fail with EISDIR.
	await mkdir(join(root, "station", "sidecar.sock.lock"), { recursive: true });
	const repo = resolve(import.meta.dirname, "../../../..");
	const child = spawn(process.execPath, ["--import", "tsx", "packages/memory/src/sidecar/main.ts"], {
		cwd: repo, env: { ...process.env, SNO_PROFILE_DIR: root, TSX_TSCONFIG_PATH: join(repo, "packages/memory/tsconfig.json") },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", part => { output += part; });
	child.stderr.on("data", part => { output += part; });
	const closed = new Promise<number | null>(resolveExit => child.once("close", resolveExit));
	const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
	try {
		expect(await closed, output).toBe(1);
		expect(output).toContain("memory.sidecar.startup.failed");
		expect(output).toContain('"attempt":3');
	} finally {
		clearTimeout(timer);
		child.kill("SIGKILL");
		await closed;
		await rm(root, { recursive: true, force: true });
	}
}, 20_000);
