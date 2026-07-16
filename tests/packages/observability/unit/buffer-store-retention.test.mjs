// Retention pruner unit tests per tasks §22.4 / §22.6.
// Real better-sqlite3 against tmpdir; zero mocks.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import DatabaseConstructor from "better-sqlite3";
import { BufferStore } from "../../../../packages/sno-observe/dist/internal/buffer-store.js";
import { SnoObserveRuntime } from "../../../../packages/sno-observe/dist/internal/runtime.js";
import { parseEventInput } from "../../../../packages/sno-observe/dist/internal/schemas.js";
import { scope, validPayloads } from "../fixtures/temp-env.mjs";

function makeStore() {
	const dir = mkdtempSync(join(tmpdir(), "sno-observe-retention-"));
	const store = new BufferStore(join(dir, "buffer.db"));
	return { dir, store };
}

describe("buffer-store retention pruner", () => {
	it("removes oldest shipped rows when total > maxBytes (22.4)", () => {
		const { dir, store } = makeStore();
		try {
			// Seed identify (seq=0) then enough large rows to cross a real byte ceiling.
			store.append({
				eventId: "id-0",
				eventType: "agent.identify",
				lane: "memory",
				tsEdgeMs: 1,
				consentLevel: "metadata-only",
				redacted: false,
				scope,
				payload: validPayloads["agent.identify"],
				terminal: false,
			});
			const maxBytes = store.getQueueStats().databaseSizeBytes + 2 * 1024 * 1024;
			for (let i = 1; i <= 120; i += 1) {
				store.append({
					eventId: `mw-${i}`,
					eventType: "memory.write",
					lane: "memory",
					tsEdgeMs: 1000 + i,
					consentLevel: "metadata-only",
					redacted: false,
					scope,
					payload: {
						...validPayloads["memory.write"],
						padding: "x".repeat(32 * 1024),
					},
					terminal: false,
				});
			}
			const rows = store.getAllRows();
			// Mark all shipped so the pruner can act on them.
			for (const row of rows) {
				store.markShipped(row.rowid);
			}
			const originalIds = rows.map((row) => row.event_id);
			const pruned = store.pruneRetention(maxBytes, 24 * 60 * 60 * 1000);
			const remainingIds = store.getAllRows().map((row) => row.event_id);
			assert.equal(pruned > 0, true);
			assert.equal(remainingIds.length > 0, true);
			assert.deepEqual(remainingIds, originalIds.slice(pruned));
			assert.equal(store.getQueueStats().databaseSizeBytes <= maxBytes, true);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses to remove unshipped rows even when over cap (22.6)", () => {
		const { dir, store } = makeStore();
		try {
			store.append({
				eventId: "id-0",
				eventType: "agent.identify",
				lane: "memory",
				tsEdgeMs: 1,
				consentLevel: "metadata-only",
				redacted: false,
				scope,
				payload: validPayloads["agent.identify"],
				terminal: false,
			});
			for (let i = 1; i <= 20; i += 1) {
				store.append({
					eventId: `unshipped-${i}`,
					eventType: "memory.write",
					lane: "memory",
					tsEdgeMs: 1000 + i,
					consentLevel: "metadata-only",
					redacted: false,
					scope,
					payload: validPayloads["memory.write"],
					terminal: false,
				});
			}
			const before = store.getAllRows().length;
			// Even with a tiny maxBytes, unshipped rows MUST survive.
			const pruned = store.pruneRetention(/* maxBytes */ 1, /* maxAgeMs */ 1);
			assert.equal(pruned, 0);
			const after = store.getAllRows().length;
			assert.equal(after, before);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects new emissions when pending database storage exceeds the byte safeguard", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sno-observe-disk-safeguard-"));
		const bufferPath = join(dir, "buffer.db");
		const initialized = new BufferStore(bufferPath);
		initialized.close();
		const database = new DatabaseConstructor(bufferPath);
		try {
			database.exec("CREATE TABLE disk_pressure (payload BLOB NOT NULL)");
			database.prepare("INSERT INTO disk_pressure (payload) VALUES (zeroblob(?))").run(
				101 * 1024 * 1024,
			);
		} finally {
			database.close();
		}
		const env = {
			SNO_PROFILE_DIR: dir,
			SNO_IDENTITY_PATH: join(dir, "identity.json"),
			SNO_BUFFER_PATH: bufferPath,
			SNO_CONSENT_PATH: join(dir, "state", "consent.json"),
			SNO_OBSERVE_BASE_URL: "https://sno.test",
			HOME: dir,
		};
		const runtime = new SnoObserveRuntime({ env, cwd: dir });
		try {
			const before = runtime.store?.countAll?.() ?? 0;
			const result = await runtime.emitParsed(
				parseEventInput({
					event_type: "memory.write",
					lane: "memory",
					agent_id: "codex",
					payload: validPayloads["memory.write"],
				}),
			);
			assert.equal(result.accepted, false);
			assert.equal(result.reason, "buffer_safeguard");
			assert.equal(runtime.store.countAll(), before);
			assert.equal(runtime.store.getQueueSafeguard(), "disk_size");
		} finally {
			runtime.flushEngine?.dispose?.();
			runtime.store?.close?.();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a single envelope that would cross capacity inside the append transaction", () => {
		const dir = mkdtempSync(join(tmpdir(), "sno-observe-atomic-capacity-"));
		const bufferPath = join(dir, "buffer.db");
		const initialized = new BufferStore(bufferPath);
		initialized.close();
		const database = new DatabaseConstructor(bufferPath);
		try {
			database.exec("CREATE TABLE disk_pressure (payload BLOB NOT NULL)");
			database.prepare("INSERT INTO disk_pressure (payload) VALUES (zeroblob(?))").run(
				99 * 1024 * 1024,
			);
		} finally {
			database.close();
		}
		const store = new BufferStore(bufferPath);
		try {
			assert.throws(
				() =>
					store.append({
						eventId: "oversized-identify",
						eventType: "agent.identify",
						lane: "memory",
						tsEdgeMs: 1,
						consentLevel: "metadata-only",
						redacted: false,
						scope,
						payload: { ...validPayloads["agent.identify"], padding: "x".repeat(2 * 1024 * 1024) },
						terminal: false,
					}),
				(error) => error?.code === "buffer_capacity",
			);
			assert.equal(store.countAll(), 0);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("separate SQLite connections recheck capacity after the first append commits", () => {
		const dir = mkdtempSync(join(tmpdir(), "sno-observe-capacity-race-"));
		const bufferPath = join(dir, "buffer.db");
		const initialized = new BufferStore(bufferPath);
		initialized.close();
		const database = new DatabaseConstructor(bufferPath);
		try {
			database.exec("CREATE TABLE disk_pressure (payload BLOB NOT NULL)");
			database.prepare("INSERT INTO disk_pressure (payload) VALUES (zeroblob(?))").run(
				98 * 1024 * 1024,
			);
		} finally {
			database.close();
		}
		const first = new BufferStore(bufferPath);
		const second = new BufferStore(bufferPath);
		const padding = "x".repeat(1_100 * 1024);
		try {
			first.append({
				eventId: "codex-identify",
				eventType: "agent.identify",
				lane: "memory",
				tsEdgeMs: 1,
				consentLevel: "metadata-only",
				redacted: false,
				scope,
				payload: { ...validPayloads["agent.identify"], padding },
				terminal: false,
			});
			assert.throws(
				() =>
					second.append({
						eventId: "openclaw-identify",
						eventType: "agent.identify",
						lane: "memory",
						tsEdgeMs: 2,
						consentLevel: "metadata-only",
						redacted: false,
						scope: { ...scope, agent_id: "openclaw" },
						payload: { ...validPayloads["agent.identify"], agent_id: "openclaw", padding },
						terminal: false,
					}),
				(error) => error?.code === "buffer_capacity",
			);
			assert.equal(first.countAll(), 1);
		} finally {
			first.close();
			second.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("removes terminal rows when total > maxBytes", () => {
		const { dir, store } = makeStore();
		try {
			store.append({
				eventId: "id-0",
				eventType: "agent.identify",
				lane: "memory",
				tsEdgeMs: 1,
				consentLevel: "off",
				redacted: true,
				scope,
				payload: validPayloads["agent.identify"],
				terminal: true,
			});
			for (let i = 1; i <= 20; i += 1) {
				store.append({
					eventId: `terminal-${i}`,
					eventType: "memory.write",
					lane: "memory",
					tsEdgeMs: 1000 + i,
					consentLevel: "off",
					redacted: true,
					scope,
					payload: validPayloads["memory.write"],
					terminal: true,
				});
			}

			const pruned = store.pruneRetention(
				/* maxBytes */ 1,
				/* maxAgeMs */ 24 * 60 * 60 * 1000,
			);

			assert.equal(pruned > 0, true);
			assert.equal(
				store.getAllRows().every((row) => row.terminal === 1),
				true,
			);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("removes shipped rows older than maxAgeMs", () => {
		const { dir, store } = makeStore();
		try {
			store.append({
				eventId: "id-0",
				eventType: "agent.identify",
				lane: "memory",
				tsEdgeMs: 1,
				consentLevel: "metadata-only",
				redacted: false,
				scope,
				payload: validPayloads["agent.identify"],
				terminal: false,
			});
			const second = store.append({
				eventId: "mw-1",
				eventType: "memory.write",
				lane: "memory",
				tsEdgeMs: 2,
				consentLevel: "metadata-only",
				redacted: false,
				scope,
				payload: validPayloads["memory.write"],
				terminal: false,
			});
			store.markShipped(second.rowid);
			// Pretend "now" is 25h after creation. Default 24h horizon.
			const pruned = store.pruneRetention(
				Number.MAX_SAFE_INTEGER,
				24 * 60 * 60 * 1000,
				Date.now() + 25 * 60 * 60 * 1000,
			);
			assert.equal(pruned >= 1, true);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("caps quarantine rows independently from shipped-event retention", () => {
		const { dir, store } = makeStore();
		try {
			store.append({
				eventId: "id-0",
				eventType: "agent.identify",
				lane: "memory",
				tsEdgeMs: 1,
				consentLevel: "metadata-only",
				redacted: false,
				scope,
				payload: validPayloads["agent.identify"],
				terminal: false,
			});
			for (let i = 1; i <= 5; i += 1) {
				const appended = store.append({
					eventId: `bad-${i}`,
					eventType: "memory.write",
					lane: "memory",
					tsEdgeMs: 1000 + i,
					consentLevel: "metadata-only",
					redacted: false,
					scope,
					payload: validPayloads["memory.write"],
					terminal: false,
				});
				const row = store
					.getPending()
					.find((pending) => pending.rowid === appended.rowid);
				assert.ok(row);
				store.quarantine(row, 400, "invalid_envelope", "invalid");
			}

			const pruned = store.pruneQuarantine(2, Number.MAX_SAFE_INTEGER);

			assert.equal(pruned, 3);
			assert.equal(store.countQuarantined(), 2);
			assert.equal(store.getQueueStats().latestQuarantineReason, "invalid_envelope");
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("bounds quarantine detail writes for a near-capacity suffix", () => {
		const dir = mkdtempSync(join(tmpdir(), "sno-observe-quarantine-capacity-"));
		const bufferPath = join(dir, "buffer.db");
		let store = new BufferStore(bufferPath);
		try {
			store.append({
				eventId: "id-0",
				eventType: "agent.identify",
				lane: "memory",
				tsEdgeMs: 1,
				consentLevel: "metadata-only",
				redacted: false,
				scope,
				payload: validPayloads["agent.identify"],
				terminal: false,
			});
			for (let index = 1; index <= 1_200; index += 1) {
				store.append({
					eventId: `suffix-${index}`,
					eventType: "memory.write",
					lane: "memory",
					tsEdgeMs: index + 1,
					consentLevel: "metadata-only",
					redacted: false,
					scope,
					payload: validPayloads["memory.write"],
					terminal: false,
				});
			}
			store.close();
			const database = new DatabaseConstructor(bufferPath);
			try {
				database.exec("CREATE TABLE quarantine_pressure (payload BLOB NOT NULL)");
				database.prepare("INSERT INTO quarantine_pressure (payload) VALUES (zeroblob(?))").run(
					98 * 1024 * 1024,
				);
			} finally {
				database.close();
			}
			store = new BufferStore(bufferPath);
			const reader = new DatabaseConstructor(bufferPath);
			reader.exec("BEGIN");
			reader.prepare("SELECT COUNT(*) AS count FROM events").get();
			const walWriter = new DatabaseConstructor(bufferPath);
			try {
				walWriter.exec("CREATE TABLE wal_pressure (payload BLOB NOT NULL)");
				walWriter.prepare("INSERT INTO wal_pressure (payload) VALUES (zeroblob(?))").run(256 * 1024);
			} finally {
				walWriter.close();
			}
			const first = store.getPending(1)[0];
			assert.throws(
				() =>
					store.quarantineEpochSuffix(
						first,
						409,
						"payload_conflict",
						"x".repeat(8_192),
						"retired",
					),
				(error) => error?.code === "buffer_capacity",
			);
			const stats = store.getQueueStats();
			assert.equal(store.countPending(), 1_201);
			assert.equal(stats.quarantinedCount, 0);
			assert.equal(stats.databaseSizeBytes <= 100 * 1024 * 1024, true);
			reader.exec("ROLLBACK");
			reader.close();
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("surfaces queue depth, oldest age, attempts, bytes, and safeguards", () => {
		const { dir, store } = makeStore();
		try {
			const appended = store.append({
				eventId: "id-0",
				eventType: "agent.identify",
				lane: "memory",
				tsEdgeMs: 1,
				consentLevel: "metadata-only",
				redacted: false,
				scope,
				payload: validPayloads["agent.identify"],
				terminal: false,
			});
			const stats = store.getQueueStats();
			assert.equal(stats.pendingCount, 1);
			assert.equal(stats.maxAttempts, 0);
			assert.equal(stats.quarantinedCount, 0);
			assert.equal(stats.databaseSizeBytes > 0, true);
			assert.equal(store.getQueueSafeguard(Date.now() + 25 * 60 * 60 * 1000), "queue_age");
			for (let attempt = 0; attempt < 100; attempt += 1) {
				store.incrementAttempts(appended.rowid);
			}
			assert.equal(store.getQueueSafeguard(), "max_attempts");
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("adds an operator-visible reason column to existing quarantine tables", () => {
		const dir = mkdtempSync(join(tmpdir(), "sno-observe-migrate-"));
		const path = join(dir, "buffer.db");
		const legacy = new DatabaseConstructor(path);
		legacy.exec(`
			CREATE TABLE quarantine (
				rowid INTEGER NOT NULL,
				event_id TEXT NOT NULL,
				status INTEGER NOT NULL,
				response_body TEXT NOT NULL,
				quarantined_at INTEGER NOT NULL
			)
		`);
		legacy.close();
		const store = new BufferStore(path);
		try {
			assert.equal(store.getQueueStats().latestQuarantineReason, null);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
