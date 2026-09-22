/** Real ONNX embedder + real encrypted SQLite. No mocking. Missing deps = FAIL. */

/**
 * Cross-process write-lock contention (DB-optimization Step 3).
 *
 * The gateway and the `sno-mem` CLI open the same encrypted DB from separate
 * PROCESSES. Write transactions run BEGIN IMMEDIATE: the write lock is taken
 * up front and contention waits through busy_timeout (5 s) instead of a
 * DEFERRED read→write upgrade that can return SQLITE_BUSY immediately.
 *
 * The rival writer MUST be a child process: better-sqlite3 busy-waits
 * synchronously, so an in-process rival could never release its lock while the
 * main thread blocks (verified — the single-process variant deadlocks until
 * busy_timeout expires).
 */

import { spawn } from "node:child_process";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDekSync } from "@snoai/sqlite-crypto";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

let testEmbedder: Embedder;

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

const RIVAL_HOLD_MS = 800;

/**
 * Child-process rival: opens the encrypted DB with the raw driver + test DEK,
 * takes the write lock, holds it for RIVAL_HOLD_MS, then commits and exits.
 * Prints LOCKED to stdout once the lock is held.
 */
const RIVAL_SCRIPT = `
const Database = require(process.env.RIVAL_DRIVER_PATH);
const db = new Database(process.env.RIVAL_DB_PATH);
db.pragma("cipher = 'sqlcipher'");
db.pragma("cipher_compatibility = 4");
db.pragma('key = "x\\'' + process.env.RIVAL_DEK_HEX + '\\'"');
db.pragma("busy_timeout = 5000");
db.exec("BEGIN IMMEDIATE");
db.prepare(
	"INSERT INTO nodix_memory_events(event_type, fact_id, timestamp_ms, agent_id) VALUES ('recall', 'rival-fact', ?, 'rival-agent')",
).run(Date.now());
console.log("LOCKED");
const buf = new Int32Array(new SharedArrayBuffer(4));
Atomics.wait(buf, 0, 0, Number(process.env.RIVAL_HOLD_MS));
db.exec("COMMIT");
db.close();
`;

function spawnRival(dbPath: string): { locked: Promise<void>; exited: Promise<number> } {
	const child = spawn(process.execPath, ["-e", RIVAL_SCRIPT], {
		env: {
			...process.env,
			RIVAL_DRIVER_PATH: require.resolve("better-sqlite3-multiple-ciphers"),
			RIVAL_DB_PATH: dbPath,
			RIVAL_DEK_HEX: getDekSync().toString("hex"),
			RIVAL_HOLD_MS: String(RIVAL_HOLD_MS),
		},
		stdio: ["ignore", "pipe", "inherit"],
	});
	const locked = new Promise<void>((resolve, reject) => {
		child.stdout.on("data", (chunk: Buffer) => {
			if (chunk.toString().includes("LOCKED")) resolve();
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code !== 0) reject(new Error(`rival exited early with code ${code}`));
		});
	});
	const exited = new Promise<number>((resolve) => {
		child.on("exit", (code) => resolve(code ?? -1));
	});
	return { locked, exited };
}

describe("write-lock contention across two processes", () => {
	let dbPath: string;
	let cleanup: () => void;
	let store: MemoryStore;

	beforeEach(() => {
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		cleanup = testDb.cleanup;
		store = new MemoryStore({ dbPath, embedder: testEmbedder });
	});

	afterEach(() => {
		store.close();
		cleanup();
	});

	it("store() waits for a rival process's write lock instead of failing busy", async () => {
		const rival = spawnRival(dbPath);
		await rival.locked;

		const startedAt = Date.now();
		const stored = await store.store({
			text: "Write-lock contention memory: the gateway write must wait for the CLI writer and then land intact.",
			category: "episodic",
			projectId: "contention-project",
		});
		const waitedMs = Date.now() - startedAt;

		expect(stored.storeWriteOutcome).toBe("created");
		// Blocking proof: the write cannot complete before the rival releases.
		// (Chunk embedding also contributes time, so assert only the lower bound.)
		expect(waitedMs).toBeGreaterThanOrEqual(RIVAL_HOLD_MS - 300);
		const persisted = store.getById(stored.id);
		expect(persisted?.text).toContain("Write-lock contention memory");

		expect(await rival.exited).toBe(0);
	});
});
