import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { cleanupProfile } from "./profile-cleanup.mjs";

it("stops all harness workers before removing their shared test profile", async () => {
	const profile = mkdtempSync(join(tmpdir(), "memory-precision-cleanup-"));
	const children = [];
	const exited: Promise<unknown>[] = [];
	try {
		for (const harness of ["claude", "cursor"]) {
			const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
			children.push(child);
			exited.push(once(child, "exit"));
			await once(child, "spawn");
			const directory = join(profile, `sno-mem-${harness}`);
			mkdirSync(directory);
			writeFileSync(join(directory, "worker.lock"), `${child.pid} ${Date.now()}\n`);
		}
		await cleanupProfile(profile, "claude");
		await Promise.all(exited);
		expect(children.map(child => child.signalCode)).toEqual(["SIGTERM", "SIGTERM"]);
		for (const child of children) {
			const pid = child.pid;
			if (pid === undefined) throw new Error("Test worker did not start");
			expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
		}
		expect(existsSync(profile)).toBe(false);
	} finally {
		for (const child of children) child.kill("SIGKILL");
		await Promise.all(exited);
		rmSync(profile, { recursive: true, force: true });
	}
});
