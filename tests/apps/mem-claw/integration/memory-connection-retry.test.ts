import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { createMemoryConnection } from "../../../../apps/mem-claw/src/install/memory-connection";
import { startRemSidecar } from "../../../../packages/memory/src/sidecar/server";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture";
import { createTestDb } from "../helpers/test-db";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

it("registers after failed startup without a gateway restart, then follows a new sidecar port", async () => {
	const database = createTestDb();
	const original = process.env.SNO_PROFILE_DIR;
	const root = mkdtempSync(join(tmpdir(), "memory-retry-"));
	process.env.SNO_PROFILE_DIR = root;
	let sidecar: Awaited<ReturnType<typeof startRemSidecar>> | undefined;
	const connection = createMemoryConnection({ config: {}, logger: { error() {} } } as OpenClawPluginApi);
	try {
		writeSettingsFixture(root, { mode: "local-first", store: { path: database.dbPath, encryptionKey: database.encryptionKey }, rerank: { mode: "none" }, embedding: { cacheDir: "" } });
		const listener = createServer();
		await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
		const address = listener.address();
		if (!address || typeof address === "string") throw new Error("missing test port");
		await new Promise<void>(resolve => listener.close(() => resolve()));
		mkdirSync(join(root, "station"), { recursive: true });
		writeFileSync(join(root, "station", "sidecar.json"), JSON.stringify({ pid: process.pid, port: address.port, token: "a".repeat(64) }));
		await expect(connection.ready()).rejects.toThrow();
		sidecar = await startRemSidecar();
		let registered = 0;
		for (let attempt = 0; attempt < 50; attempt++) {
			const response = await fetch(`http://127.0.0.1:${sidecar.port}/healthz`, { headers: { Authorization: `Bearer ${JSON.parse(readFileSync(join(root, "station", "sidecar.json"), "utf8")).token}` } });
			registered = (await response.json()).accessCounters.engineAccesses;
			if (registered === 1) break;
			await delay(100);
		}
		expect(registered).toBe(1);
		await sidecar.stop();
		sidecar = await startRemSidecar();
		const clients = await Promise.all([connection.ready(), connection.ready()]);
		for (const client of clients) {
			const result = await client.inspect({ op: "stats" }, { principal: client.principal, project: "global", session: "retry" });
			expect(result).toEqual({ degraded: false, result: { op: "stats", total: 0, projectBreakdown: {}, categoryBreakdown: {} } });
		}
		const response = await fetch(`http://127.0.0.1:${sidecar.port}/healthz`, { headers: { Authorization: `Bearer ${JSON.parse(readFileSync(join(root, "station", "sidecar.json"), "utf8")).token}` } });
		expect((await response.json()).accessCounters.engineAccesses).toBe(3);
	} finally {
		await connection.close();
		await sidecar?.stop();
		if (original === undefined) delete process.env.SNO_PROFILE_DIR;
		else process.env.SNO_PROFILE_DIR = original;
		database.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});
