/** Integration tests for cjk-other-fix.md §D — FTS5 simple-tokenizer.
 *
 * Verifies that migration 0005 produces an FTS5 table tokenized with
 * `simple 0` and that CJK queries land at word level instead of unigram
 * char level. Real better-sqlite3 + real loadExtension + real migrations.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, initDb } from "../../../../packages/memory/src/store/connection";
import { resolveSimpleTokenizerPath } from "../../../../packages/memory/src/store/simple-tokenizer-path";
import { initSqliteRuntime } from "../../../../packages/memory/src/store/sqlite-runtime";
import { makeTestEnv, type TestEnv } from "../../sqlite-crypto/_helpers";
import type { SqliteDatabaseLike } from "../../../../packages/memory/src/store/sqlite-runtime";

const VECTOR_DIM = 1024;

function insertChunk(
	db: SqliteDatabaseLike,
	memoryId: string,
	chunkId: string,
	text: string,
): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO nodix_memories
		(id, fact_id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash)
		VALUES (?, ?, ?, 'entity', 'global', 0.7, ?, 'UTC', '{}', ?)`,
	).run(memoryId, memoryId, text, now, `hash-${memoryId}`);
	db.prepare(
		`INSERT INTO nodix_memory_chunks
		(chunk_id, memory_id, chunk_index, chunk_text, dense_payload,
		 start_offset, end_offset, token_count, content_type,
		 chunking_version, embedder_provider, embedder_model, embedder_dim,
		 created_at, updated_at)
		VALUES (?, ?, 0, ?, ?, 0, ?, 1, 'prose',
		 'test-1.0', 'local-onnx', 'test-model', ?, ?, ?)`,
	).run(chunkId, memoryId, text, text, text.length, VECTOR_DIM, now, now);
}

function ftsMatch(db: SqliteDatabaseLike, query: string): string[] {
	return (
		db
			.prepare(
				`SELECT c.chunk_id AS chunk_id
				 FROM nodix_memory_chunks_fts f
				 JOIN nodix_memory_chunks c ON c.rowid = f.rowid
				 WHERE nodix_memory_chunks_fts MATCH ?`,
			)
			.all(query) as Array<{ chunk_id: string }>
	).map((r) => r.chunk_id);
}

describe("FTS5 simple-tokenizer (cjk-other-fix.md §D)", () => {
	let tmp: string;
	let dbPath: string;
	let cryptoEnv: TestEnv;

	beforeEach(() => {
		cryptoEnv = makeTestEnv("fts-simple");
		initSqliteRuntime(cryptoEnv.keyHex);
		tmp = mkdtempSync(join(tmpdir(), "claw-fts-simple-"));
		dbPath = join(tmp, "memory.db");
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		cryptoEnv.cleanup();
	});

	it("loader resolves to a real .so/.dylib + dict directory", () => {
		const resolved = resolveSimpleTokenizerPath();
		expect(resolved.platform).toMatch(/^(linux|darwin)-(x64|arm64)$/);
		expect(resolved.extensionPath).toMatch(/libsimple\.(so|dylib)$/);
		expect(resolved.dictPath).toMatch(/dict$/);
	});

	it("migration 0005 lands a `tokenize='simple 0'` FTS5 table", () => {
		const db = initDb(dbPath, VECTOR_DIM);
		try {
			const row = db.$client
				.prepare(
					`SELECT sql FROM sqlite_master
					 WHERE type='table' AND name='nodix_memory_chunks_fts' LIMIT 1`,
				)
				.get() as { sql?: string } | undefined;
			expect(row?.sql ?? "").toMatch(/tokenize\s*=\s*['"]simple\b/i);
		} finally {
			closeDb(db);
		}
	});

	it("Chinese: `天安门` matches the place chunk, not the homograph distractor", () => {
		const db = initDb(dbPath, VECTOR_DIM);
		try {
			insertChunk(
				db.$client,
				"m-cn-1",
				"c-cn-1",
				"天安门事件发生于一九八九年。",
			);
			insertChunk(db.$client, "m-cn-2", "c-cn-2", "天黑后我安心地走进家门。");
			const hits = ftsMatch(db.$client, "天安门");
			expect(hits).toContain("c-cn-1");
			expect(hits).not.toContain("c-cn-2");
		} finally {
			closeDb(db);
		}
	});

	it("Japanese: katakana `東京タワー` matches the relevant chunk", () => {
		const db = initDb(dbPath, VECTOR_DIM);
		try {
			insertChunk(
				db.$client,
				"m-jp-1",
				"c-jp-1",
				"東京タワーは港区にあります。",
			);
			insertChunk(db.$client, "m-jp-2", "c-jp-2", "京都の天気は今日晴れです。");
			const hits = ftsMatch(db.$client, "東京タワー");
			expect(hits).toContain("c-jp-1");
			expect(hits).not.toContain("c-jp-2");
		} finally {
			closeDb(db);
		}
	});

	it("Korean: hangul `안녕` matches the greeting chunk", () => {
		const db = initDb(dbPath, VECTOR_DIM);
		try {
			insertChunk(
				db.$client,
				"m-ko-1",
				"c-ko-1",
				"안녕하세요 친구 반갑습니다.",
			);
			insertChunk(db.$client, "m-ko-2", "c-ko-2", "오늘 날씨가 좋네요.");
			const hits = ftsMatch(db.$client, "안녕");
			expect(hits).toContain("c-ko-1");
			expect(hits).not.toContain("c-ko-2");
		} finally {
			closeDb(db);
		}
	});

	it("English regression: `hello` still finds plain ASCII chunks", () => {
		const db = initDb(dbPath, VECTOR_DIM);
		try {
			insertChunk(db.$client, "m-en-1", "c-en-1", "hello world from claw");
			insertChunk(db.$client, "m-en-2", "c-en-2", "goodbye cruel world");
			const hits = ftsMatch(db.$client, "hello");
			expect(hits).toContain("c-en-1");
			expect(hits).not.toContain("c-en-2");
		} finally {
			closeDb(db);
		}
	});

	it("mixed CJK+English: `Apple Store` and `iPhone` both hit the same chunk", () => {
		const db = initDb(dbPath, VECTOR_DIM);
		try {
			insertChunk(
				db.$client,
				"m-mix-1",
				"c-mix-1",
				"今天我去Apple Store买iPhone，体验非常好。",
			);
			insertChunk(db.$client, "m-mix-2", "c-mix-2", "今天的天气很好。");
			const apple = ftsMatch(db.$client, "Apple");
			expect(apple).toContain("c-mix-1");
			expect(apple).not.toContain("c-mix-2");
			const iphone = ftsMatch(db.$client, "iPhone");
			expect(iphone).toContain("c-mix-1");
			expect(iphone).not.toContain("c-mix-2");
		} finally {
			closeDb(db);
		}
	});
});
