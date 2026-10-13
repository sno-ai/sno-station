import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { expect, it, vi } from "vitest";
import { createMemoryConnection } from "../../../../apps/mem-claw/src/install/memory-connection";
import { startRemSidecar } from "../../../../packages/memory/src/sidecar/server";
import { writeSettingsFixture } from "../fixtures/settings-file-fixture";

it("backs off repeated registration failures, resets after recovery, and stops retries on close", async () => {
	const saved = { profile: process.env.SNO_PROFILE_DIR, home: process.env.HOME };
	const root = mkdtempSync(join(tmpdir(), "memory-connection-backoff-"));
	process.env.SNO_PROFILE_DIR = root;
	process.env.HOME = join(root, "home");
	writeSettingsFixture(root, { mode: "local-first", rem: { tick: false },
		rerank: { mode: "none" }, embedding: { cacheDir: "" }, telemetry: { observe: { enabled: false } } });
	let sidecar: Awaited<ReturnType<typeof startRemSidecar>> | undefined;
	mkdirSync(join(root, "station"));
	writeFileSync(join(root, "station/sidecar.json"), "{broken");
	let clock = 0;
	const failures: Array<{ at: number; message: string }> = [];
	const connection = createMemoryConnection({ config: {},
		logger: { error(message: string) { failures.push({ at: clock, message }); } },
		runtime: { llm: { async complete() { throw new Error("registration must not call a model"); } } },
	} as unknown as OpenClawPluginApi);
	const flush = async (count: number) => {
		const deadline = performance.now() + 3_000;
		while (failures.length < count && performance.now() < deadline) await new Promise(setImmediate);
	};
	try {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await expect(connection.ready()).rejects.toThrow("sidecar-unreachable");
		expect(failures.map(line => line.at)).toEqual([0]);
		const offsets = [0];
		for (const interval of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
			clock += interval - 1;
			await vi.advanceTimersByTimeAsync(interval - 1);
			await delay(20);
			expect(failures.map(line => line.at)).toEqual(offsets);
			clock++;
			await vi.advanceTimersByTimeAsync(1);
			offsets.push(clock);
			await flush(offsets.length);
			expect(failures.map(line => line.at)).toEqual(offsets);
		}
		expect(failures.every(line => line.message.startsWith("Memory service registration failed:"))).toBe(true);
		rmSync(join(root, "station/sidecar.json"));
		sidecar = await startRemSidecar();
		expect((await connection.ready()).degraded).toBe(false);
		writeFileSync(join(root, "station/sidecar.json"), "{broken");
		await expect(connection.ready()).rejects.toThrow("sidecar-unreachable");
		clock += 999;
		await vi.advanceTimersByTimeAsync(999);
		expect(failures.map(line => line.at)).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000, 63_000, 123_000, 183_000, 183_000]);
		clock++;
		await vi.advanceTimersByTimeAsync(1);
		await flush(11);
		expect(failures.map(line => line.at)).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000, 63_000, 123_000, 183_000, 183_000, 184_000]);
		await connection.close();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(failures.map(line => line.at)).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000, 63_000, 123_000, 183_000, 183_000, 184_000]);
	} finally {
		vi.useRealTimers();
		await connection.close();
		await sidecar?.stop();
		rmSync(root, { recursive: true, force: true });
		if (saved.profile === undefined) delete process.env.SNO_PROFILE_DIR;
		else process.env.SNO_PROFILE_DIR = saved.profile;
		if (saved.home === undefined) delete process.env.HOME;
		else process.env.HOME = saved.home;
	}
}, 30_000);
