import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRuntimePool } from "../../../../packages/memory/src/sidecar/memory-runtime";
import { startRemSidecar } from "../../../../packages/memory/src/sidecar/server";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db";
import { writeSettingsFixture } from "../fixtures/settings-file-fixture";

let root: string;
let database: ReturnType<typeof createTestDb>;
let sidecar: Awaited<ReturnType<typeof startRemSidecar>>;
let pool: MemoryRuntimePool;
const entry = fileURLToPath(new URL("./fixtures/recorded-host-worker.mjs", import.meta.url));
const previousProfile = process.env.SNO_PROFILE_DIR;

beforeEach(async () => {
	database = createTestDb();
	root = mkdtempSync(join(tmpdir(), "host-worker-start-"));
	process.env.SNO_PROFILE_DIR = root;
	writeSettingsFixture(root, { mode: "agent-native", rem: { tick: false }, rerank: { mode: "none" },
		store: { path: database.dbPath, encryptionKey: database.encryptionKey },
		telemetry: { observe: { enabled: false }, memoryUsage: { enabled: false } } });
	mkdirSync(join(root, "station"), { recursive: true });
	// Observe the actual pool returned to the HTTP server; no implementation is replaced.
	const opened = vi.spyOn(MemoryRuntimePool, "open");
	try {
		sidecar = await startRemSidecar();
		const discovery = JSON.parse(readFileSync(join(root, "station", "sidecar.json"), "utf8"));
		const inspected = await fetch(`http://127.0.0.1:${sidecar.port}/v1/inspect`, {
			method: "POST", headers: { "x-sidecar-token": discovery.token, "content-type": "application/json" },
			body: JSON.stringify({ scope: { principal: "caller", project: "global", session: "open-runtime" }, op: { op: "stats" } }),
			signal: AbortSignal.timeout(10_000),
		});
		expect(inspected.status).toBe(200);
		pool = await opened.mock.results[0]?.value;
		if (!pool) throw new Error("HTTP server did not open its runtime");
	} finally { opened.mockRestore(); }
});

afterEach(async () => {
	const marker = join(root, "host-worker-started.json");
	if (existsSync(marker)) {
		const { pid } = JSON.parse(readFileSync(marker, "utf8"));
		try { process.kill(pid, "SIGTERM"); }
		catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
	}
	await sidecar?.stop();
	database?.cleanup();
	rmSync(root, { recursive: true, force: true });
	if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
	else process.env.SNO_PROFILE_DIR = previousProfile;
});

it("starts the recorded worker without any registration and answers through the runtime host route", async () => {
	writeFileSync(join(root, "station", "host-worker.json"), JSON.stringify({ node: process.execPath, entry }), { mode: 0o600 });
	const result = await pool.connectedRemPort()?.complete({ prompt: "question", timeoutMs: 10_000 });
	expect(result).toEqual({ kind: "ok", text: "recorded worker answer" });
	expect(existsSync(join(root, "host-worker-started.json"))).toBe(true);
	expect(JSON.parse(readFileSync(join(root, "host-worker-started.json"), "utf8"))).toMatchObject({ argument: "worker" });
}, 20_000);

it("returns no-agent-endpoint within three seconds when the recorded entry is missing", async () => {
	writeFileSync(join(root, "station", "host-worker.json"), JSON.stringify({ node: process.execPath, entry: join(root, "missing-worker.mjs") }), { mode: 0o600 });
	const started = performance.now();
	const result = await pool.connectedRemPort()?.complete({ prompt: "question", timeoutMs: 30_000 });
	expect(performance.now() - started).toBeLessThan(3_000);
	expect(result).toEqual({ kind: "error", category: "transport", message: "no-agent-endpoint" });
}, 40_000);

it("keeps today's absent host route and starts no worker without a record or registration", async () => {
	expect(existsSync(join(root, "station", "host-worker.json"))).toBe(false);
	expect(pool.connectedRemPort()).toBeUndefined();
	expect(existsSync(join(root, "host-worker-started.json"))).toBe(false);
});
