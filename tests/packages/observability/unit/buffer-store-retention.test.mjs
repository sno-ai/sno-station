// Retention pruner unit tests per tasks §22.4 / §22.6.
// Real better-sqlite3 against tmpdir; zero mocks.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import DatabaseConstructor from "better-sqlite3";
import {
	BufferStore,
	CHAIN_RETENTION_SCAN_SQL,
} from "../../../../packages/sno-observe/dist/internal/buffer-store.js";
import { SnoObserveRuntime } from "../../../../packages/sno-observe/dist/internal/runtime.js";
import { parseEventInput } from "../../../../packages/sno-observe/dist/internal/schemas.js";
import { scope, validPayloads } from "../fixtures/temp-env.mjs";

function makeStore() {
	const dir = mkdtempSync(join(tmpdir(), "sno-observe-retention-"));
	const store = new BufferStore(join(dir, "buffer.db"));
	return { dir, store };
}

const RETENTION_MAX_BYTES = 100 * 1024 * 1024;
const RETENTION_BATCH_SIZE = 2_000;
const RETENTION_SCAN_LIMIT = RETENTION_BATCH_SIZE * 2;

function runtimeEnv(dir, bufferPath = join(dir, "buffer.db")) {
	return {
		SNO_PROFILE_DIR: dir,
		SNO_IDENTITY_PATH: join(dir, "identity.json"),
		SNO_BUFFER_PATH: bufferPath,
		SNO_CONSENT_PATH: join(dir, "state", "consent.json"),
		SNO_OBSERVE_BASE_URL: "https://sno.test",
		HOME: dir,
	};
}

function closeRuntime(runtime) {
	runtime.flushEngine?.dispose?.();
	runtime.store?.close?.();
}

function logicalBytes(database) {
	const pageCount = database.pragma("page_count", { simple: true });
	const pageSize = database.pragma("page_size", { simple: true });
	const freelistCount = database.pragma("freelist_count", { simple: true });
	return Math.max(0, pageCount - freelistCount) * pageSize;
}

function fileBytes(path) {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

function tableCount(database, table) {
	return database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function seedTails(database, machineId, agentId, firstEpoch, lastEpoch) {
	const insertChunk = database.prepare(`
		WITH RECURSIVE epochs(chain_epoch) AS (
			VALUES (?)
			UNION ALL
			SELECT chain_epoch + 1 FROM epochs WHERE chain_epoch < ?
		)
		INSERT OR IGNORE INTO chain_tail (
			machine_id, agent_id, chain_epoch, last_seq, last_self_hash, updated_at
		)
		SELECT ?, ?, chain_epoch, 0, printf('%064x', chain_epoch), ? FROM epochs
	`);
	const insertAll = database.transaction(() => {
		for (let start = firstEpoch; start <= lastEpoch; start += 500) {
			insertChunk.run(start, Math.min(lastEpoch, start + 499), machineId, agentId, Date.now());
		}
	});
	insertAll();
}

function seedChildren(database, table, machineId, agentId, firstEpoch, lastEpoch) {
	const valueColumns =
		table === "chain_state"
			? "machine_id, agent_id, chain_epoch, state, reason, updated_at"
			: "machine_id, agent_id, chain_epoch, retry_not_before";
	const selectValues =
		table === "chain_state"
			? "?, ?, chain_epoch, 'retired', 'orphaned test state', ?"
			: "?, ?, chain_epoch, ?";
	const insertChunk = database.prepare(`
		WITH RECURSIVE epochs(chain_epoch) AS (
			VALUES (?)
			UNION ALL
			SELECT chain_epoch + 1 FROM epochs WHERE chain_epoch < ?
		)
		INSERT INTO ${table} (${valueColumns})
		SELECT ${selectValues} FROM epochs
	`);
	const insertAll = database.transaction(() => {
		for (let start = firstEpoch; start <= lastEpoch; start += 500) {
			insertChunk.run(start, Math.min(lastEpoch, start + 499), machineId, agentId, Date.now());
		}
	});
	insertAll();
}

function readTableCounts(database) {
	return {
		events: tableCount(database, "events"),
		chainTail: tableCount(database, "chain_tail"),
		chainState: tableCount(database, "chain_state"),
		chainRetry: tableCount(database, "chain_retry"),
		quarantine: tableCount(database, "quarantine"),
	};
}

function doctorMetric(detail, key) {
	const match = detail.match(new RegExp(`${key}=([^;)]+)`));
	assert.ok(match, `missing ${key} in doctor detail: ${detail}`);
	return match[1];
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
			const report = store.pruneRetention(maxBytes, 24 * 60 * 60 * 1000);
			const remainingIds = store.getAllRows().map((row) => row.event_id);
			assert.equal(report.deletedEvents > 0, true);
			assert.equal(remainingIds.length > 0, true);
			assert.deepEqual(remainingIds, originalIds.slice(report.deletedEvents));
			assert.equal(store.getQueueStats().databaseSizeBytes <= maxBytes, true);
			assert.equal(report.lastCompactionAtMs, null);
			assert.equal(report.compactionReason, "not_run");
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
			const report = store.pruneRetention(/* maxBytes */ 1, /* maxAgeMs */ 1);
			assert.equal(report.deletedEvents, 0);
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

	it("includes a retained WAL sidecar when projecting append capacity", () => {
		const dir = mkdtempSync(join(tmpdir(), "sno-observe-wal-capacity-"));
		const bufferPath = join(dir, "buffer.db");
		const store = new BufferStore(bufferPath);
		const reader = new DatabaseConstructor(bufferPath);
		const writer = new DatabaseConstructor(bufferPath);
		try {
			store.append({
				eventId: "wal-identify",
				eventType: "agent.identify",
				lane: "memory",
				tsEdgeMs: 1,
				consentLevel: "metadata-only",
				redacted: false,
				scope,
				payload: validPayloads["agent.identify"],
				terminal: false,
			});
			writer.exec("CREATE TABLE wal_pressure (payload BLOB NOT NULL)");
			reader.exec("BEGIN");
			reader.prepare("SELECT COUNT(*) AS count FROM events").get();
			const insert = writer.prepare("INSERT INTO wal_pressure (payload) VALUES (zeroblob(?))");
			const clear = writer.prepare("DELETE FROM wal_pressure");
			let stats = store.getQueueStats();
			for (let index = 0; stats.databaseSizeBytes < RETENTION_MAX_BYTES - 1024 * 1024; index += 1) {
				assert.equal(index < 1_000, true, "failed to build bounded WAL pressure fixture");
				insert.run(256 * 1024);
				clear.run();
				stats = store.getQueueStats();
			}
			assert.equal(stats.databaseSizeBytes < RETENTION_MAX_BYTES, true);
			assert.equal(stats.logicalBytes < RETENTION_MAX_BYTES / 2, true);

			assert.throws(
				() =>
					store.append({
						eventId: "wal-over-cap",
						eventType: "memory.write",
						lane: "memory",
						tsEdgeMs: 2,
						consentLevel: "metadata-only",
						redacted: false,
						scope,
						payload: {
							...validPayloads["memory.write"],
							padding: "x".repeat(2 * 1024 * 1024),
						},
						terminal: false,
					}),
				(error) => error?.code === "buffer_capacity",
			);
			assert.equal(store.countAll(), 1);
			reader.exec("ROLLBACK");
		} finally {
			writer.close();
			reader.close();
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

			const report = store.pruneRetention(
				/* maxBytes */ 1,
				/* maxAgeMs */ 24 * 60 * 60 * 1000,
			);

			assert.equal(report.deletedEvents > 0, true);
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
			const report = store.pruneRetention(
				Number.MAX_SAFE_INTEGER,
				24 * 60 * 60 * 1000,
				Date.now() + 25 * 60 * 60 * 1000,
			);
			assert.equal(report.deletedEvents >= 1, true);
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

	it("converges scaled history through existing flush maintenance and restores admission", async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "sno-observe-retention-history-"));
		const bufferPath = join(dir, "buffer.db");
		const initialized = new BufferStore(bufferPath);
		initialized.close();
		const database = new DatabaseConstructor(bufferPath);
		let beforeLogicalBytes = 0;
		let beforePhysicalBytes = 0;
		try {
			const emptyLogicalBytes = logicalBytes(database);
			seedTails(database, scope.machine_id, scope.agent_id, 1, 6_017);
			const historyLogicalBytes = logicalBytes(database);
			const reclaimableHistoryBytes = historyLogicalBytes - emptyLogicalBytes;
			assert.equal(reclaimableHistoryBytes > 0, true);
			database.exec("CREATE TABLE retention_pressure (payload BLOB NOT NULL)");
			const pressureBytes =
				RETENTION_MAX_BYTES - historyLogicalBytes + Math.floor(reclaimableHistoryBytes / 2);
			database
				.prepare("INSERT INTO retention_pressure (payload) VALUES (zeroblob(?))")
				.run(pressureBytes);
			beforeLogicalBytes = logicalBytes(database);
			assert.equal(beforeLogicalBytes > RETENTION_MAX_BYTES, true);
		} finally {
			database.close();
		}
		beforePhysicalBytes = fileBytes(bufferPath);

		const runtime = new SnoObserveRuntime({ env: runtimeEnv(dir), cwd: dir });
		try {
			for (const expectedTailCount of [4_017, 2_017, 17]) {
				await runtime.flush();
				const reader = new DatabaseConstructor(bufferPath, { readonly: true, fileMustExist: true });
				try {
					assert.equal(tableCount(reader, "chain_tail"), expectedTailCount);
				} finally {
					reader.close();
				}
			}

			const report = runtime.store.pruneRetention();
			assert.equal(report.deletedChainTail, 0);
			assert.equal(report.remainingEpochs, 17);
			assert.equal(report.databaseSizeBytes < RETENTION_MAX_BYTES, true);
			const remainingEpochs = new DatabaseConstructor(bufferPath, {
				readonly: true,
				fileMustExist: true,
			});
			try {
				assert.deepEqual(
					remainingEpochs
						.prepare(
							"SELECT chain_epoch FROM chain_tail ORDER BY chain_epoch",
						)
						.all()
						.map((row) => row.chain_epoch),
					Array.from({ length: 17 }, (_, index) => 6_001 + index),
				);
			} finally {
				remainingEpochs.close();
			}

			const detail = runtime.doctor().buffer.detail;
			for (const [key, value] of [
				["logical_bytes", report.logicalBytes],
				["physical_bytes", report.physicalBytes],
				["wal_bytes", report.walBytes],
				["freelist_pages", report.freelistPages],
				["freelist_bytes", report.freelistBytes],
				["freelist_ratio", report.freelistRatio],
				["remaining_epochs", report.remainingEpochs],
			]) {
				assert.equal(doctorMetric(detail, key), String(value));
			}

			const emitted = await runtime.emitParsed(
				parseEventInput({
					event_type: "memory.write",
					lane: "memory",
					agent_id: "codex",
					payload: validPayloads["memory.write"],
				}),
			);
			assert.equal(emitted.accepted, true);
			t.diagnostic(
				JSON.stringify({
					fixtureEpochs: 6_017,
					beforeLogicalBytes,
					beforePhysicalBytes,
					afterLogicalBytes: report.logicalBytes,
					afterPhysicalBytes: report.physicalBytes,
					afterWalBytes: report.walBytes,
					afterFreelistRatio: report.freelistRatio,
					maintenanceDurationMs: report.maintenanceDurationMs,
				}),
			);
		} finally {
			closeRuntime(runtime);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves live epochs and evidence while bounding orphan child cleanup", async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "sno-observe-retention-live-"));
		const bufferPath = join(dir, "buffer.db");
		const store = new BufferStore(bufferPath);
		const pending = store.append({
			eventId: "live-pending",
			eventType: "agent.identify",
			lane: "memory",
			tsEdgeMs: 2,
			consentLevel: "metadata-only",
			redacted: false,
			scope,
			payload: validPayloads["agent.identify"],
			terminal: false,
			chainEpoch: 2,
		});
		store.append({
			eventId: "live-terminal",
			eventType: "agent.identify",
			lane: "memory",
			tsEdgeMs: 3,
			consentLevel: "off",
			redacted: true,
			scope,
			payload: validPayloads["agent.identify"],
			terminal: true,
			chainEpoch: 3,
		});
		const accepted = store.append({
			eventId: "accepted-evidence",
			eventType: "agent.identify",
			lane: "memory",
			tsEdgeMs: 6,
			consentLevel: "metadata-only",
			redacted: false,
			scope,
			payload: validPayloads["agent.identify"],
			terminal: false,
			chainEpoch: 6,
		});
		store.markShipped(accepted.rowid);
		const database = new DatabaseConstructor(bufferPath);
		try {
			seedTails(database, scope.machine_id, scope.agent_id, 1, 100);
			database
				.prepare(
					`INSERT INTO chain_state (
						machine_id, agent_id, chain_epoch, state, reason, updated_at
					) VALUES (?, ?, 4, 'retired', 'live recovery evidence', ?)`,
				)
				.run(scope.machine_id, scope.agent_id, Date.now());
			database
				.prepare(
					`INSERT INTO chain_retry (
						machine_id, agent_id, chain_epoch, retry_not_before
					) VALUES (?, ?, 5, ?)`,
				)
				.run(scope.machine_id, scope.agent_id, Date.now() + 60_000);
			database
				.prepare(
					`INSERT INTO quarantine (
						rowid, event_id, status, reason, response_body, quarantined_at
					) VALUES (?, ?, 409, 'accepted_diagnostic', 'retained evidence', ?)`,
				)
				.run(accepted.rowid, accepted.eventId, Date.now());
			seedChildren(database, "chain_state", "orphan-machine", scope.agent_id, 1_000, 3_000);
			seedChildren(database, "chain_retry", "orphan-machine", scope.agent_id, 1_000, 3_000);
		} finally {
			database.close();
		}

		const beforeReader = new DatabaseConstructor(bufferPath, { readonly: true, fileMustExist: true });
		const before = readTableCounts(beforeReader);
		beforeReader.close();
		const report = store.pruneRetention(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
		const afterReader = new DatabaseConstructor(bufferPath, { readonly: true, fileMustExist: true });
		const after = readTableCounts(afterReader);
		afterReader.close();
		try {
			assert.deepEqual(before, {
				events: 3,
				chainTail: 100,
				chainState: 2_002,
				chainRetry: 2_002,
				quarantine: 1,
			});
			assert.deepEqual(after, {
				events: 3,
				chainTail: 21,
				chainState: 2,
				chainRetry: 2,
				quarantine: 1,
			});
			assert.equal(report.deletedChainTail, 79);
			assert.equal(report.deletedChainState, RETENTION_BATCH_SIZE);
			assert.equal(report.deletedChainRetry, RETENTION_BATCH_SIZE);
			assert.equal(report.deletedEvents, 0);
			assert.equal(store.hasTail(scope.machine_id, scope.agent_id, 2), true);
			assert.equal(store.hasTail(scope.machine_id, scope.agent_id, 3), true);
			assert.equal(store.hasTail(scope.machine_id, scope.agent_id, 4), true);
			assert.equal(store.hasTail(scope.machine_id, scope.agent_id, 5), true);
			assert.equal(store.hasTail(scope.machine_id, scope.agent_id, 6), false);
			assert.equal(store.getByEventId("accepted-evidence")?.shipped, 1);
			assert.equal(store.countQuarantined(), 1);
			assert.equal(store.getCurrentEpoch(scope.machine_id, scope.agent_id), 100);
			assert.equal(store.getChainRecoveryState(scope.machine_id, scope.agent_id, 4), "retired");
			assert.equal(store.getQueueStats().pendingCount, 1);
			assert.equal(store.verifyLocalChain(), true);

			const runtime = new SnoObserveRuntime({ env: runtimeEnv(dir), cwd: dir });
			try {
				assert.equal(runtime.export({ format: "jsonl" }).rowCount, 3);
				const converged = store.pruneRetention(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
				assert.equal(converged.deletedChainState, 1);
				assert.equal(converged.deletedChainRetry, 1);
				store.markShipped(pending.rowid);
				assert.deepEqual(await runtime.flush(), {
					shipped: 0,
					terminal: 0,
					retryable: 0,
				});
			} finally {
				closeRuntime(runtime);
			}
			t.diagnostic(JSON.stringify({ before, after, firstPass: report }));
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("bounds scanned and deleted tails while using the target indexes", () => {
		const dir = mkdtempSync(join(tmpdir(), "sno-observe-retention-plan-"));
		const bufferPath = join(dir, "buffer.db");
		const initialized = new BufferStore(bufferPath);
		initialized.close();
		const database = new DatabaseConstructor(bufferPath);
		try {
			seedTails(database, "000-protected", scope.agent_id, 1, 4_500);
			seedChildren(database, "chain_state", "000-protected", scope.agent_id, 1, 4_500);
			seedTails(database, "zzz-eligible", scope.agent_id, 1, 2_517);

			const fromStartRows = database
				.prepare(CHAIN_RETENTION_SCAN_SQL.fromStart)
				.all(RETENTION_SCAN_LIMIT, 16);
			const afterCursorRows = database
				.prepare(CHAIN_RETENTION_SCAN_SQL.afterCursor)
				.all("000-protected", scope.agent_id, 4_000, RETENTION_SCAN_LIMIT, 16);
			assert.equal(fromStartRows.length, RETENTION_SCAN_LIMIT);
			assert.equal(fromStartRows.every((row) => row.eligible === 0), true);
			assert.equal(afterCursorRows.length <= RETENTION_SCAN_LIMIT, true);
			assert.equal(
				afterCursorRows.filter((row) => row.eligible === 1).length,
				2_500,
			);

			const indexes = database.pragma("index_list('chain_tail')");
			const targetIndex = indexes.find((index) => {
				const columns = database.pragma(`index_info(${index.name})`).map((row) => row.name);
				return columns.join(",") === "machine_id,agent_id,chain_epoch";
			});
			assert.ok(targetIndex);
			for (const [sql, params] of [
				[CHAIN_RETENTION_SCAN_SQL.fromStart, [RETENTION_SCAN_LIMIT, 16]],
				[
					CHAIN_RETENTION_SCAN_SQL.afterCursor,
					["000-protected", scope.agent_id, 4_000, RETENTION_SCAN_LIMIT, 16],
				],
			]) {
				const details = database
					.prepare(`EXPLAIN QUERY PLAN ${sql}`)
					.all(...params)
					.map((row) => row.detail);
				assert.equal(
					details.some(
						(detail) =>
							detail.includes("chain_tail") &&
							detail.includes("USING COVERING INDEX") &&
							detail.includes(targetIndex.name),
					),
					true,
				);
				assert.equal(details.some((detail) => detail.includes("USE TEMP B-TREE")), false);
				for (const detail of details.filter((value) => value.startsWith("SCAN chain_tail"))) {
					assert.equal(detail.includes(`USING COVERING INDEX ${targetIndex.name}`), true);
				}
			}
		} finally {
			database.close();
		}

		const store = new BufferStore(bufferPath);
		try {
			const protectedPrefix = store.pruneRetention(
				Number.MAX_SAFE_INTEGER,
				Number.MAX_SAFE_INTEGER,
			);
			assert.equal(protectedPrefix.deletedChainTail, 0);
			const progressed = store.pruneRetention(
				Number.MAX_SAFE_INTEGER,
				Number.MAX_SAFE_INTEGER,
			);
			assert.equal(progressed.deletedChainTail, RETENTION_BATCH_SIZE);
			assert.equal(progressed.remainingEpochs, 5_017);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rolls back interrupted cleanup and repeats idempotently", () => {
		const dir = mkdtempSync(join(tmpdir(), "sno-observe-retention-interrupt-"));
		const bufferPath = join(dir, "buffer.db");
		const store = new BufferStore(bufferPath);
		const event = store.append({
			eventId: "interrupt-event",
			eventType: "agent.identify",
			lane: "memory",
			tsEdgeMs: 1,
			consentLevel: "metadata-only",
			redacted: false,
			scope,
			payload: validPayloads["agent.identify"],
			terminal: false,
			chainEpoch: 1,
		});
		store.markShipped(event.rowid);
		const database = new DatabaseConstructor(bufferPath);
		try {
			seedTails(database, scope.machine_id, scope.agent_id, 1, 20);
			seedChildren(database, "chain_state", "orphan-interrupt", scope.agent_id, 1, 1);
			seedChildren(database, "chain_retry", "orphan-interrupt", scope.agent_id, 1, 1);
			database.prepare("UPDATE events SET created_at = 0 WHERE event_id = ?").run(event.eventId);
			database.exec(`
				CREATE TRIGGER abort_retention_event
				BEFORE DELETE ON events
				WHEN OLD.event_id = 'interrupt-event'
				BEGIN
					SELECT RAISE(ABORT, 'retention-interrupted');
				END
			`);
			const before = readTableCounts(database);
			assert.throws(
				() => store.pruneRetention(Number.MAX_SAFE_INTEGER, 1, Date.now()),
				/retention-interrupted/,
			);
			assert.deepEqual(readTableCounts(database), before);
			database.exec("DROP TRIGGER abort_retention_event");
		} finally {
			database.close();
		}

		try {
			const recovered = store.pruneRetention(Number.MAX_SAFE_INTEGER, 1, Date.now());
			assert.equal(recovered.deletedChainTail, 3);
			assert.equal(recovered.deletedChainState, 1);
			assert.equal(recovered.deletedChainRetry, 1);
			assert.equal(recovered.deletedEvents, 1);
			const idempotent = store.pruneRetention(Number.MAX_SAFE_INTEGER, 1, Date.now());
			assert.equal(idempotent.deletedChainTail, 0);
			assert.equal(idempotent.deletedChainState, 0);
			assert.equal(idempotent.deletedChainRetry, 0);
			assert.equal(idempotent.deletedEvents, 0);
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
