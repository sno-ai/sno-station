import { dirname, join } from "node:path";
import { runMaintenancePass } from "../../../../packages/sno-station-mem/src/store/maintenance";
import { createLlmClient } from "../../../../packages/sno-station-mem/src/model/llm-client";
import { expect, it } from "vitest";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store";
import { createSnoStationMemRemPorts, createSnoStationMemRemRecovery } from "../../../../packages/sno-station-mem/src/store/rem-sqlite-adapter";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db";

it("keeps FTS consistent through repeated REM facet writes, metadata updates, merges and recovery", async () => {
	const database = createTestDb();
	const embedder = await createTestEmbedder();
	const observer = new MemoryStore({ dbPath: database.dbPath, embedder });
	const store = new MemoryStore({ dbPath: database.dbPath, embedder });
	try {
		const entry = await store.store({ text: "The user keeps a blue notebook.", category: "episodic", projectId: "fts-write-probe" });
		observer.sqlite.prepare("SELECT rowid FROM nodix_memory_chunks_fts WHERE nodix_memory_chunks_fts MATCH 'notebook'").all();
		expect(observer.sqlite.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
		for (let index = 0; index < 16; index++) {
			const before = store.sqlite.prepare("SELECT text, content_hash FROM nodix_memories WHERE id = ?").get(entry.id) as { text: string; content_hash: string };
			const result = await store.applyRemTextVersion({
				jobId: "fts-write-probe", jobType: index % 2 ? "rem-update" : "rem-replace",
				rowId: entry.id, plannedContentHash: before.content_hash,
				replacementText: `The user keeps a blue notebook with ${index + 1} pages.`,
				historyText: before.text, reason: "Exercise REM facet indexing.", timestamp: "2026-09-17T01:00:00.000Z",
			});
			expect(result.applied).toBe(true);
			store.sqlite.exec("INSERT INTO nodix_memory_chunks_fts(nodix_memory_chunks_fts, rank) VALUES('integrity-check', 1)");
			if (!result.applied) throw new Error("REM mutation failed");
			if (index === 7) {
				createSnoStationMemRemRecovery(store.sqlite).restoreTextVersion(result.recoveryHandle);
				store.sqlite.exec("INSERT INTO nodix_memory_chunks_fts(nodix_memory_chunks_fts, rank) VALUES('integrity-check', 1)");
			}
			store.sqlite.prepare("UPDATE nodix_memories SET importance = 0.6 WHERE id = ?").run(entry.id);
			store.sqlite.exec("INSERT INTO nodix_memory_chunks_fts(nodix_memory_chunks_fts, rank) VALUES('merge', 500)");
			expect(store.sqlite.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
			const report = runMaintenancePass({ store: observer, dbPath: database.dbPath,
				stateDir: join(dirname(database.dbPath), "integrity-state"), backupDir: join(dirname(database.dbPath), "backups") }, new Set(["integrity"]));
			expect(report).toMatchObject({ aborted: false, integrityRecovery: "none" });
			expect(observer.sqlite.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
		}
		expect(store.sqlite.prepare("SELECT text FROM nodix_memories WHERE id = ?").get(entry.id)).toEqual({ text: "The user keeps a blue notebook with 16 pages." });
		const matches = await store.searchKeyword("notebook", { projectIdFilter: ["fts-write-probe"] });
		expect(matches.map(match => match.entry.text)).toEqual(["The user keeps a blue notebook with 16 pages."]);
		const successor = await store.store({ text: "The user now keeps a green notebook.", category: "episodic", projectId: "fts-write-probe" });
		const ports = createSnoStationMemRemPorts({ database: store.sqlite, memoryStore: store,
			llmClient: createLlmClient({ preset: "mem_claw/sno_conflict_verdict", baseURL: "http://localhost:8070/codex/v1" }) });
		const prior = store.sqlite.prepare("SELECT content_hash FROM nodix_memories WHERE id = ?").get(entry.id) as { content_hash: string };
		const next = store.sqlite.prepare("SELECT content_hash FROM nodix_memories WHERE id = ?").get(successor.id) as { content_hash: string };
		const closed = await ports.conflict.softClose({ rowId: entry.id, successorId: successor.id,
			plannedContentHash: prior.content_hash, plannedSuccessorContentHash: next.content_hash,
			reason: "Exercise replacement indexing.", timestamp: "2026-09-17T01:01:00.000Z" }).catch(error => {
			const integrity = store.sqlite.prepare("PRAGMA integrity_check").all();
			console.info("fts_after_failed_soft_close", integrity);
			expect(integrity).toEqual([{ integrity_check: "ok" }]);
			store.sqlite.exec("INSERT INTO nodix_memory_chunks_fts(nodix_memory_chunks_fts, rank) VALUES('integrity-check', 1)");
			throw error;
		});
		expect(closed.applied).toBe(true);
		expect(store.sqlite.prepare("SELECT facet, count(*) AS count FROM nodix_memory_chunks WHERE memory_id = ? GROUP BY facet").all(entry.id))
			.toEqual([{ facet: "history", count: 16 }]);
		store.sqlite.exec("INSERT INTO nodix_memory_chunks_fts(nodix_memory_chunks_fts, rank) VALUES('integrity-check', 1)");
		if (!closed.applied) throw new Error("soft close failed");
		createSnoStationMemRemRecovery(store.sqlite).restoreMark(closed.recoveryHandle);
		expect(store.sqlite.prepare("SELECT facet, count(*) AS count FROM nodix_memory_chunks WHERE memory_id = ? GROUP BY facet ORDER BY facet").all(entry.id))
			.toEqual([{ facet: "current", count: 1 }, { facet: "history", count: 15 }]);
		store.sqlite.exec("INSERT INTO nodix_memory_chunks_fts(nodix_memory_chunks_fts, rank) VALUES('integrity-check', 1)");
		expect(store.sqlite.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
	} finally { await store.close(); await observer.close(); database.cleanup(); }
});
