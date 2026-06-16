/**
 * §4 Execution Model Spike — validates the durable mutation queue design
 * (universal-memory-adapter-design.md §4) against real SQLCipher + WAL via
 * @snoai/nodix-crypto.
 *
 * Tests: upsert receipt discrimination, claim/release drain, lost-update
 * guard (payload_version), orphan reclaim, idempotency-on-done, failure
 * retry, and writer+reader connection split under SQLCipher+WAL.
 */

import type { Database as Db } from "better-sqlite3-multiple-ciphers";
import {
	type Dek,
	getDek,
	openEncryptedDb,
	openEncryptedDbReadonly,
} from "@snoai/nodix-crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestEnv, uniqueDbPath, type TestEnv } from "../_helpers.ts";

const DDL = `
CREATE TABLE pending_mutations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_key TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  op_type TEXT NOT NULL,
  payload BLOB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payload_version INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (cast(strftime('%s','now') as integer)),
  processed_at INTEGER,
  UNIQUE(scope_key, turn_id, op_type)
);
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_key TEXT NOT NULL,
  content TEXT NOT NULL,
  source_mutation_id INTEGER,
  created_at INTEGER NOT NULL DEFAULT (cast(strftime('%s','now') as integer))
);
`;

const UPSERT = `
  INSERT INTO pending_mutations (scope_key, turn_id, op_type, payload)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(scope_key, turn_id, op_type)
  DO UPDATE SET
    payload = excluded.payload,
    payload_version = payload_version + 1,
    status = 'pending'
  WHERE status IN ('pending', 'failed', 'processing')
  RETURNING id, status, payload_version
`;

const CLAIM = `
  UPDATE pending_mutations
  SET status = 'processing', claimed_at = cast(strftime('%s','now') as integer)
  WHERE id = ? AND status = 'pending'
`;

const FINAL_WRITE = `
  UPDATE pending_mutations
  SET status = 'done', processed_at = cast(strftime('%s','now') as integer)
  WHERE id = ? AND status = 'processing' AND payload_version = ?
`;

const ORPHAN_RECLAIM = `
  UPDATE pending_mutations
  SET status = 'pending', claimed_at = NULL
  WHERE status = 'processing' AND claimed_at < ?
`;

interface Receipt {
	id: number;
	status: string;
	payload_version: number;
}

interface Row {
	id: number;
	status: string;
	payload_version: number;
	payload: Buffer;
	claimed_at: number | null;
	retry_count: number;
}

let env: TestEnv;

function openWriter(dbPath: string, dek: Dek): Db {
	const db = openEncryptedDb(dbPath, dek);
	db.pragma("journal_mode = WAL");
	db.pragma("busy_timeout = 5000");
	db.exec(DDL);
	return db;
}

beforeEach(() => {
	env = makeTestEnv("s4-spike");
});

afterEach(() => {
	env.cleanup();
});

describe("§4 execution model spike — SQLCipher+WAL", () => {
	it("upsert: fresh insert returns enqueued receipt (version 0)", async () => {
		const dek = await getDek();
		const db = openWriter(uniqueDbPath(env, "t1"), dek);

		const r = db.prepare(UPSERT).get("s:u1", "t:1", "capture", Buffer.from("hello")) as Receipt;
		expect(r.status).toBe("pending");
		expect(r.payload_version).toBe(0);

		db.close();
	});

	it("upsert: re-capture bumps payload_version, updates payload", async () => {
		const dek = await getDek();
		const db = openWriter(uniqueDbPath(env, "t2"), dek);

		const r1 = db.prepare(UPSERT).get("s:u1", "t:1", "capture", Buffer.from("partial")) as Receipt;
		expect(r1.payload_version).toBe(0);

		const r2 = db.prepare(UPSERT).get("s:u1", "t:1", "capture", Buffer.from("complete")) as Receipt;
		expect(r2.payload_version).toBe(1);
		expect(r2.id).toBe(r1.id);

		const row = db.prepare("SELECT payload FROM pending_mutations WHERE id = ?").get(r2.id) as Row;
		expect(Buffer.from(row.payload).toString()).toBe("complete");

		db.close();
	});

	it("claim + final write: version matches → done", async () => {
		const dek = await getDek();
		const db = openWriter(uniqueDbPath(env, "t3"), dek);

		const { id, payload_version } = db.prepare(UPSERT).get(
			"s:u1", "t:1", "capture", Buffer.from("data"),
		) as Receipt;

		db.prepare(CLAIM).run(id);

		db.prepare("INSERT INTO memories (scope_key, content, source_mutation_id) VALUES (?, ?, ?)")
			.run("s:u1", "distilled insight", id);
		const result = db.prepare(FINAL_WRITE).run(id, payload_version);
		expect(result.changes).toBe(1);

		const row = db.prepare("SELECT status FROM pending_mutations WHERE id = ?").get(id) as Row;
		expect(row.status).toBe("done");

		db.close();
	});

	it("lost-update guard: mid-drain re-capture → drain discards stale result", async () => {
		const dek = await getDek();
		const db = openWriter(uniqueDbPath(env, "t4"), dek);

		const { id, payload_version: claimedV } = db.prepare(UPSERT).get(
			"s:u1", "t:1", "capture", Buffer.from("partial"),
		) as Receipt;

		db.prepare(CLAIM).run(id);

		// Host re-captures with corrected payload while drain is off-lock
		const r2 = db.prepare(UPSERT).get("s:u1", "t:1", "capture", Buffer.from("complete-turn")) as Receipt;
		expect(r2.payload_version).toBe(claimedV + 1);
		expect(r2.status).toBe("pending");

		// Stale drain tries version-conditional final write
		const stale = db.prepare(FINAL_WRITE).run(id, claimedV);
		expect(stale.changes).toBe(0);

		const row = db.prepare("SELECT status, payload_version, payload FROM pending_mutations WHERE id = ?")
			.get(id) as Row;
		expect(row.status).toBe("pending");
		expect(row.payload_version).toBe(claimedV + 1);
		expect(Buffer.from(row.payload).toString()).toBe("complete-turn");

		db.close();
	});

	it("orphan reclaim: crashed processing row resets to pending", async () => {
		const dek = await getDek();
		const db = openWriter(uniqueDbPath(env, "t5"), dek);

		const { id } = db.prepare(UPSERT).get("s:u1", "t:1", "capture", Buffer.from("data")) as Receipt;

		// Claim with a past timestamp (simulates crash — lease expired)
		db.prepare("UPDATE pending_mutations SET status = 'processing', claimed_at = 1000 WHERE id = ?")
			.run(id);

		const now = Math.floor(Date.now() / 1000);
		const reclaimed = db.prepare(ORPHAN_RECLAIM).run(now);
		expect(reclaimed.changes).toBe(1);

		const row = db.prepare("SELECT status, claimed_at FROM pending_mutations WHERE id = ?").get(id) as Row;
		expect(row.status).toBe("pending");
		expect(row.claimed_at).toBeNull();

		db.close();
	});

	it("idempotency: re-capture against done row is a no-op", async () => {
		const dek = await getDek();
		const db = openWriter(uniqueDbPath(env, "t6"), dek);

		const { id, payload_version } = db.prepare(UPSERT).get(
			"s:u1", "t:1", "capture", Buffer.from("data"),
		) as Receipt;
		db.prepare(CLAIM).run(id);
		db.prepare(FINAL_WRITE).run(id, payload_version);

		// Re-capture same key — WHERE excludes 'done'
		const receipt = db.prepare(UPSERT).get("s:u1", "t:1", "capture", Buffer.from("retry"));
		expect(receipt).toBeUndefined();

		const row = db.prepare("SELECT payload, status FROM pending_mutations WHERE id = ?").get(id) as Row;
		expect(row.status).toBe("done");
		expect(Buffer.from(row.payload).toString()).toBe("data");

		db.close();
	});

	it("failure path: failed row accepts re-capture (re-enqueue)", async () => {
		const dek = await getDek();
		const db = openWriter(uniqueDbPath(env, "t7"), dek);

		const { id } = db.prepare(UPSERT).get("s:u1", "t:1", "capture", Buffer.from("v1")) as Receipt;

		// Simulate distill failure → mark failed
		db.prepare("UPDATE pending_mutations SET status = 'failed', retry_count = retry_count + 1 WHERE id = ?")
			.run(id);

		// Re-capture updates payload and resets to pending
		const r2 = db.prepare(UPSERT).get("s:u1", "t:1", "capture", Buffer.from("v2")) as Receipt;
		expect(r2.status).toBe("pending");
		expect(r2.payload_version).toBe(1);

		db.close();
	});

	it("writer + reader split: read-only conn reads while writer holds WAL", async () => {
		const dek = await getDek();
		const dbPath = uniqueDbPath(env, "t8");
		const writer = openWriter(dbPath, dek);

		writer.prepare(UPSERT).get("s:u1", "t:1", "capture", Buffer.from("data1"));

		// Open read-only connection to same SQLCipher+WAL DB
		const reader = openEncryptedDbReadonly(dbPath, dek);
		reader.pragma("busy_timeout = 5000");

		const rows = reader.prepare("SELECT * FROM pending_mutations").all();
		expect(rows).toHaveLength(1);

		// Writer starts an IMMEDIATE transaction
		writer.exec("BEGIN IMMEDIATE");
		writer.prepare(
			"INSERT INTO pending_mutations (scope_key, turn_id, op_type, payload) VALUES (?, ?, ?, ?)",
		).run("s:u1", "t:2", "capture", Buffer.from("data2"));

		// Reader sees pre-transaction snapshot (WAL isolation)
		const during = reader.prepare("SELECT count(*) as cnt FROM pending_mutations").get() as { cnt: number };
		expect(during.cnt).toBe(1);

		writer.exec("COMMIT");

		// After commit, reader sees both rows
		const after = reader.prepare("SELECT count(*) as cnt FROM pending_mutations").get() as { cnt: number };
		expect(after.cnt).toBe(2);

		reader.close();
		writer.close();
	});

	it("concurrent independent drains: no cross-row interference", async () => {
		const dek = await getDek();
		const db = openWriter(uniqueDbPath(env, "t9"), dek);

		const claimed: Array<{ id: number; payload_version: number }> = [];
		for (let i = 0; i < 5; i++) {
			const { id, payload_version } = db.prepare(UPSERT).get(
				"s:u1", `t:${i}`, "capture", Buffer.from(`data-${i}`),
			) as Receipt;
			db.prepare(CLAIM).run(id);
			claimed.push({ id, payload_version });
		}

		// Final writes in reverse order (simulating different LLM latencies)
		for (const { id, payload_version } of claimed.reverse()) {
			const r = db.prepare(FINAL_WRITE).run(id, payload_version);
			expect(r.changes).toBe(1);
		}

		const done = db.prepare("SELECT count(*) as cnt FROM pending_mutations WHERE status = 'done'")
			.get() as { cnt: number };
		expect(done.cnt).toBe(5);

		db.close();
	});

	it("retention atomic claim: only one winner when two triggers race", async () => {
		const dek = await getDek();
		const db = openWriter(uniqueDbPath(env, "t10"), dek);

		db.exec(`
			CREATE TABLE retention_state (
				scope_key TEXT PRIMARY KEY,
				last_run INTEGER NOT NULL DEFAULT 0
			);
			INSERT INTO retention_state (scope_key, last_run) VALUES ('s:u1', 0);
		`);

		const now = Math.floor(Date.now() / 1000);
		const due = now - 1;

		const claim = db.prepare("UPDATE retention_state SET last_run = ? WHERE scope_key = ? AND last_run < ?");
		const r1 = claim.run(now, "s:u1", due);
		const r2 = claim.run(now + 1, "s:u1", due);

		expect(r1.changes).toBe(1);
		expect(r2.changes).toBe(0);

		db.close();
	});
});
