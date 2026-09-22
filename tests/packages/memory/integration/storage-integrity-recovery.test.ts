/** Real encrypted SQLite copy, real FTS5 corruption, and real maintenance path. Zero mocks. */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import {

	flushAuditWrites,
	getAuditPath} from "../../../../packages/memory/src/engine/operations/runtime-audit-log.ts";
import { runMaintenancePass } from "../../../../packages/memory/src/store/maintenance.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

let testEmbedder: Embedder;

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

interface Fixture {
	store: MemoryStore;
	dbPath: string;
	stateDir: string;
	cleanup: () => void;
}

let fixture: Fixture | undefined;

afterEach(async () => {
	await flushAuditWrites();
	try {
		fixture?.store.close();
	} catch {
		// A retained integrity latch closes through the wrapper's allowed close path.
	}
	fixture?.cleanup();
	fixture = undefined;
});

function rewriteTestManifestPath(fromPath: string, toPath: string): void {
	const xdgConfigHome = process.env.XDG_CONFIG_HOME;
	if (!xdgConfigHome) throw new Error("createTestDb did not install XDG_CONFIG_HOME");
	const manifestPath = join(xdgConfigHome, "sno-station-core", "dbs.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
		dbs: Array<{ path: string }>;
	};
	const normalizedFrom = resolve(fromPath);
	const normalizedTo = resolve(toPath);
	let replaced = false;
	for (const entry of manifest.dbs) {
		if (entry.path !== normalizedFrom) continue;
		entry.path = normalizedTo;
		replaced = true;
	}
	if (!replaced) throw new Error(`test manifest did not contain ${normalizedFrom}`);
	writeFileSync(manifestPath, JSON.stringify(manifest));
}

function createCopiedFixture(): Fixture {
	const testDb = createTestDb();
	testDb.sqlite.pragma("wal_checkpoint(TRUNCATE)");
	testDb.sqlite.close();
	const copiedPath = join(dirname(testDb.dbPath), "corruption-copy.sqlite");
	copyFileSync(testDb.dbPath, copiedPath);
	rewriteTestManifestPath(testDb.dbPath, copiedPath);
	const stateDir = join(dirname(copiedPath), "runtime-state");
	mkdirSync(stateDir, { recursive: true });
	return {
		store: new MemoryStore({ dbPath: copiedPath, embedder: testEmbedder }),
		dbPath: copiedPath,
		stateDir,
		cleanup: testDb.cleanup,
	};
}

async function seed(store: MemoryStore, suffix: string): Promise<void> {
	await store.store({
		text: `Storage integrity seed ${suffix}: source rows must survive an FTS rebuild unchanged.`,
		category: "episodic",
		projectId: `integrity-${suffix}`,
	});
	await store.store({
		text: `分词索引 seed ${suffix}: derived search data may be rebuilt from source chunks.`,
		category: "episodic",
		projectId: `integrity-${suffix}`,
	});
}

function sourceInventory(store: MemoryStore): string {
	const hash = createHash("sha256");
	const memories = store.sqlite
		.prepare(
			"SELECT id, text, category, project_id, content_hash FROM nodix_memories ORDER BY id",
		)
		.all();
	const chunks = store.sqlite
		.prepare(
			"SELECT chunk_id, memory_id, chunk_index, chunk_text, dense_payload FROM nodix_memory_chunks ORDER BY chunk_id",
		)
		.all();
	hash.update(JSON.stringify({ memories, chunks }));
	return hash.digest("hex");
}

function corruptFtsBlob(store: MemoryStore): void {
	const raw = store.db.$client;
	const unsafeRaw = raw as typeof raw & { unsafeMode(enabled?: boolean): typeof raw };
	const row = raw
		.prepare(
			"SELECT id, block FROM nodix_memory_chunks_fts_data WHERE block IS NOT NULL AND length(block) > 8 ORDER BY id DESC LIMIT 1",
		)
		.get() as { id: number; block: Buffer } | undefined;
	if (!row) throw new Error("seed did not create an FTS data block");
	const corrupted = Buffer.alloc(row.block.length, 0xff);
	unsafeRaw.unsafeMode(true);
	try {
		raw
			.prepare("UPDATE nodix_memory_chunks_fts_data SET block = ? WHERE id = ?")
			.run(corrupted, row.id);
	} finally {
		unsafeRaw.unsafeMode(false);
	}
}

function corruptSourceConstraint(store: MemoryStore): void {
	const raw = store.db.$client;
	raw.pragma("ignore_check_constraints = ON");
	try {
		raw.prepare("UPDATE nodix_memory_chunks SET content_type = 'corrupt-source'").run();
	} finally {
		raw.pragma("ignore_check_constraints = OFF");
	}
}

function readAudit(stateDir: string): Array<Record<string, unknown>> {
	const auditPath = getAuditPath(stateDir);
	if (!existsSync(auditPath)) return [];
	return readFileSync(auditPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("storage integrity recovery", () => {
	it("rebuilds a corrupt derived FTS index, preserves source rows, and resumes writes", async () => {
		fixture = createCopiedFixture();
		await seed(fixture.store, "derived");
		const inventoryBefore = sourceInventory(fixture.store);
		corruptFtsBlob(fixture.store);
		writeFileSync(join(fixture.stateDir, "killswitch"), JSON.stringify({ reason: "db integrity failure retained across gateway restart", activatedBy: "maintenance" }));

		const report = runMaintenancePass({
			store: fixture.store,
			dbPath: fixture.dbPath,
			backupDir: join(fixture.stateDir, "backups"),
			stateDir: fixture.stateDir,
		});

		expect(report).toMatchObject({ aborted: false, integrityRecovery: "recovered" });
		expect(existsSync(join(fixture.stateDir, "killswitch"))).toBe(true);
		expect(sourceInventory(fixture.store)).toBe(inventoryBefore);
		expect(fixture.store.db.$client.pragma("integrity_check")).toEqual([
			{ integrity_check: "ok" },
		]);

		const stored = await fixture.store.store({
			text: "Post-recovery writes persist and keyword search finds this durable marker.",
			category: "episodic",
			projectId: "integrity-derived",
		});
		const matches = await fixture.store.searchKeyword("durable marker", {
			projectIdFilter: ["integrity-derived"],
		});
		expect(matches.map((result) => result.entry.id)).toContain(stored.id);

		await flushAuditWrites();
		const audit = readAudit(fixture.stateDir);
		expect(
			audit.filter((entry) => entry.event === "storage_integrity" && entry.decision === "rebuild_started"),
		).toHaveLength(1);
		expect(
			audit.filter((entry) => entry.event === "storage_integrity" && entry.decision === "recovered"),
		).toHaveLength(1);
	});

	it("keeps source reads and metadata writes available when corrupt FTS cannot be rebuilt", async () => {
		fixture = createCopiedFixture();
		await seed(fixture.store, "source");
		corruptFtsBlob(fixture.store);
		corruptSourceConstraint(fixture.store);
		const report = runMaintenancePass({ store: fixture.store, dbPath: fixture.dbPath,
			backupDir: join(fixture.stateDir, "backups"), stateDir: fixture.stateDir }, new Set(["integrity"]));
		expect(report).toMatchObject({ aborted: false, integrityRecovery: "retained" });
		expect(existsSync(join(fixture.stateDir, "killswitch"))).toBe(false);
		expect(fixture.store.sqlite.prepare("SELECT count(*) AS count FROM nodix_memories").get()).toEqual({ count: 2 });
		fixture.store.sqlite.prepare("UPDATE nodix_memories SET importance = 0.42 WHERE project_id = 'integrity-source'").run();
		expect(fixture.store.sqlite.prepare("SELECT importance FROM nodix_memories ORDER BY id").all()).toEqual([{ importance: 0.42 }, { importance: 0.42 }]);
	});

	it("ignores an obsolete manual-pause file during a clean sweep", async () => {
		fixture = createCopiedFixture();
		writeFileSync(join(fixture.stateDir, "killswitch"), JSON.stringify({ reason: "Manual pause via /memory pause", activatedBy: "slash-command" }));

		const report = runMaintenancePass({
			store: fixture.store,
			dbPath: fixture.dbPath,
			backupDir: join(fixture.stateDir, "backups"),
			stateDir: fixture.stateDir,
		});

		expect(report).toMatchObject({ aborted: false, integrityRecovery: "none" });
		expect(existsSync(join(fixture.stateDir, "killswitch"))).toBe(true);
	});

	it("does not use an obsolete manual-pause file during FTS recovery", async () => {
		fixture = createCopiedFixture();
		await seed(fixture.store, "manual-pause");
		corruptFtsBlob(fixture.store);
		writeFileSync(join(fixture.stateDir, "killswitch"), JSON.stringify({ reason: "Manual pause via /memory pause", activatedBy: "slash-command" }));

		const report = runMaintenancePass({
			store: fixture.store,
			dbPath: fixture.dbPath,
			backupDir: join(fixture.stateDir, "backups"),
			stateDir: fixture.stateDir,
		});

		expect(report).toMatchObject({ aborted: false, integrityRecovery: "recovered" });
		expect(JSON.parse(readFileSync(join(fixture.stateDir, "killswitch"), "utf8"))).toEqual({
			reason: "Manual pause via /memory pause",
			activatedBy: "slash-command",
		});
	});
});
