/** Real encrypted SQLite and the production simple-tokenizer extension. Zero mocks. */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveSimpleTokenizerPath } from "../../../../apps/mem-claw/src/storage/simple-tokenizer-path.ts";

const require = createRequire(import.meta.url);
const DRIVER_PATH = require.resolve("better-sqlite3-multiple-ciphers");
const TEST_DEK = "9".repeat(64);
const CASE_TIMEOUT_MS = 30_000;

const CHILD_WRITER = `
const Database = require(process.env.REPRO_DRIVER_PATH);
const db = new Database(process.env.REPRO_DB_PATH);
db.pragma("cipher = 'sqlcipher'");
db.pragma("cipher_compatibility = 4");
db.pragma('key = "x\\'' + process.env.REPRO_DEK + '\\'"');
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.loadExtension(process.env.REPRO_EXTENSION_PATH);
db.prepare("SELECT jieba_dict(?)").get(process.env.REPRO_DICT_PATH);
const writer = process.env.REPRO_WRITER;
const insert = db.prepare("INSERT INTO source_chunks(chunk_id, body) VALUES (?, ?)");
for (let index = 0; index < 100; index += 1) {
  insert.run(writer + "-" + index, "并发写入 memory " + writer + " " + index);
  if ((index + 1) % 25 === 0) console.log("writer " + writer + " " + (index + 1) + "/100");
}
db.close();
`;

type Database = import("better-sqlite3-multiple-ciphers").Database;

interface ReproductionFinding {
	case: string;
	integrity: string[];
	ftsIntegrity: "ok" | string;
	rowCount: number;
}

const findings: ReproductionFinding[] = [];

function openDatabase(dbPath: string): Database {
	const DatabaseConstructor = require("better-sqlite3-multiple-ciphers") as new (
		path: string,
	) => Database;
	const db = new DatabaseConstructor(dbPath);
	db.pragma("cipher = 'sqlcipher'");
	db.pragma("cipher_compatibility = 4");
	db.pragma(`key = "x'${TEST_DEK}'"`);
	db.pragma("journal_mode = WAL");
	db.pragma("busy_timeout = 5000");
	db.pragma("synchronous = NORMAL");
	const tokenizer = resolveSimpleTokenizerPath();
	db.loadExtension(tokenizer.extensionPath);
	db.prepare("SELECT jieba_dict(?)").get(tokenizer.dictPath);
	return db;
}

function initializeSchema(db: Database): void {
	db.exec(`
		CREATE TABLE source_chunks (
			chunk_id TEXT PRIMARY KEY,
			body TEXT NOT NULL
		);
		CREATE VIRTUAL TABLE source_chunks_fts USING fts5(
			body,
			content='source_chunks',
			content_rowid='rowid',
			tokenize='simple 0'
		);
		CREATE TRIGGER source_chunks_ai AFTER INSERT ON source_chunks BEGIN
			INSERT INTO source_chunks_fts(rowid, body) VALUES (new.rowid, new.body);
		END;
		CREATE TRIGGER source_chunks_ad AFTER DELETE ON source_chunks BEGIN
			INSERT INTO source_chunks_fts(source_chunks_fts, rowid, body)
			VALUES ('delete', old.rowid, old.body);
		END;
		CREATE TRIGGER source_chunks_au AFTER UPDATE ON source_chunks BEGIN
			INSERT INTO source_chunks_fts(source_chunks_fts, rowid, body)
			VALUES ('delete', old.rowid, old.body);
			INSERT INTO source_chunks_fts(rowid, body) VALUES (new.rowid, new.body);
		END;
	`);
}

function inspect(db: Database, name: string): ReproductionFinding {
	const integrity = (db.pragma("integrity_check") as Array<{ integrity_check: string }>).map(
		(row) => row.integrity_check,
	);
	let ftsIntegrity: ReproductionFinding["ftsIntegrity"] = "ok";
	try {
		db.prepare("INSERT INTO source_chunks_fts(source_chunks_fts) VALUES('integrity-check')").run();
	} catch (error) {
		ftsIntegrity = error instanceof Error ? error.message : String(error);
	}
	const { rowCount } = db
		.prepare("SELECT COUNT(*) AS rowCount FROM source_chunks")
		.get() as { rowCount: number };
	const finding = { case: name, integrity, ftsIntegrity, rowCount };
	findings.push(finding);
	process.stdout.write(`repro ${findings.length}/5 ${name}: ${JSON.stringify(finding)}\n`);
	return finding;
}

async function runWriter(dbPath: string, writer: string): Promise<void> {
	const tokenizer = resolveSimpleTokenizerPath();
	const child = spawn(process.execPath, ["-e", CHILD_WRITER], {
		detached: true,
		env: {
			...process.env,
			REPRO_DB_PATH: dbPath,
			REPRO_DEK: TEST_DEK,
			REPRO_DICT_PATH: tokenizer.dictPath,
			REPRO_DRIVER_PATH: DRIVER_PATH,
			REPRO_EXTENSION_PATH: tokenizer.extensionPath,
			REPRO_WRITER: writer,
		},
		stdio: ["ignore", "inherit", "inherit"],
	});
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			reject(new Error(`writer ${writer} exceeded ${CASE_TIMEOUT_MS}ms`));
		}, CASE_TIMEOUT_MS);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timeout);
			if (code === 0) resolve();
			else reject(new Error(`writer ${writer} exited ${String(code)}`));
		});
	});
}

async function withFreshDatabase(
	name: string,
	action: (db: Database, dbPath: string) => Promise<Database | void> | Database | void,
): Promise<ReproductionFinding> {
	const dir = mkdtempSync(join(tmpdir(), `mem-claw-repro-${name}-`));
	const dbPath = join(dir, "repro.sqlite");
	let db = openDatabase(dbPath);
	initializeSchema(db);
	try {
		const replacement = await action(db, dbPath);
		if (replacement) db = replacement;
		return inspect(db, name);
	} finally {
		try {
			db.close();
		} catch {
			// The clear-db case closes the original handle before replacing the file.
		}
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("bounded FTS5 corruption reproduction", () => {
	it("keeps integrity under concurrent write load", async () => {
		const result = await withFreshDatabase("concurrent-writes", async (db, dbPath) => {
			db.close();
			await Promise.all([runWriter(dbPath, "alpha"), runWriter(dbPath, "beta")]);
			return openDatabase(dbPath);
		});
		expect(result.integrity).toEqual(["ok"]);
		expect(result.ftsIntegrity).toBe("ok");
		expect(result.rowCount).toBe(200);
	});

	it("keeps integrity while merging FTS segments", async () => {
		const result = await withFreshDatabase("fts-merge", (db) => {
			const insert = db.prepare("INSERT INTO source_chunks(chunk_id, body) VALUES (?, ?)");
			for (let index = 0; index < 250; index += 1) {
				insert.run(`merge-${index}`, `segment merge memory ${index}`);
				if ((index + 1) % 25 === 0) {
					db.prepare("INSERT INTO source_chunks_fts(source_chunks_fts, rank) VALUES('merge', 500)").run();
				}
			}
		});
		expect(result.integrity).toEqual(["ok"]);
		expect(result.ftsIntegrity).toBe("ok");
	});

	it("keeps integrity across WAL checkpoints during writes", async () => {
		const result = await withFreshDatabase("wal-checkpoint", (db, dbPath) => {
			const checkpoint = openDatabase(dbPath);
			try {
				const insert = db.prepare("INSERT INTO source_chunks(chunk_id, body) VALUES (?, ?)");
				for (let index = 0; index < 200; index += 1) {
					insert.run(`checkpoint-${index}`, `checkpoint memory ${index}`);
					if ((index + 1) % 20 === 0) checkpoint.pragma("wal_checkpoint(PASSIVE)");
				}
			} finally {
				checkpoint.close();
			}
		});
		expect(result.integrity).toEqual(["ok"]);
		expect(result.ftsIntegrity).toBe("ok");
	});

	it("keeps integrity when clear-db closes the gateway before deletion", async () => {
		const result = await withFreshDatabase("stopped-clear-db", (db, dbPath) => {
			db.prepare("INSERT INTO source_chunks(chunk_id, body) VALUES (?, ?)").run(
				"before-clear",
				"database generation before a stopped clear",
			);
			db.close();
			rmSync(dbPath, { force: true });
			rmSync(`${dbPath}-wal`, { force: true });
			rmSync(`${dbPath}-shm`, { force: true });
			const replacement = openDatabase(dbPath);
			initializeSchema(replacement);
			replacement
				.prepare("INSERT INTO source_chunks(chunk_id, body) VALUES (?, ?)")
				.run("after-clear", "database generation after a stopped clear");
			return replacement;
		});
		expect(result.integrity).toEqual(["ok"]);
		expect(result.ftsIntegrity).toBe("ok");
		expect(result.rowCount).toBe(1);
	});

	it("keeps integrity while the simple tokenizer is reloaded", async () => {
		const result = await withFreshDatabase("simple-tokenizer-reload", (db, dbPath) => {
			for (let index = 0; index < 20; index += 1) {
				const connection = index === 0 ? db : openDatabase(dbPath);
				connection
					.prepare("INSERT INTO source_chunks(chunk_id, body) VALUES (?, ?)")
					.run(`tokenizer-${index}`, `分词器重载 memory ${index}`);
				if (connection !== db) connection.close();
			}
		});
		expect(result.integrity).toEqual(["ok"]);
		expect(result.ftsIntegrity).toBe("ok");
	});
});

afterAll(() => {
	process.stdout.write(
		`${JSON.stringify({ kind: "storage-integrity-reproduction", cases: findings })}\n`,
	);
});
