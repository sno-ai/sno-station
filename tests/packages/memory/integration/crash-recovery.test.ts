/** Real encrypted SQLite across real processes. No mocking. Missing deps = FAIL. */

/**
 * Application-crash durability under WAL + synchronous=NORMAL (DB-optimization
 * Step 2). SQLite's documented contract: an application crash (SIGKILL, no
 * graceful close) loses NOTHING that was committed — WAL recovery replays it on
 * the next open. This test proves that half of the durability claim on the
 * real encrypted runtime; the power-loss half is an accepted documented risk
 * (see the plan's durability note) and is not tested here.
 *
 * A child process opens the DB with the production pragma recipe, commits
 * numbered transactions, reports each committed id on stdout, and is SIGKILLed
 * mid-stream. The parent reopens the SAME file and asserts every reported
 * commit is present and the DB passes a full integrity sweep.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

const DEK_HEX = "c".repeat(64);

const WRITER_SCRIPT = `
const Database = require(process.env.CRASH_DRIVER_PATH);
const db = new Database(process.env.CRASH_DB_PATH);
db.pragma("cipher = 'sqlcipher'");
db.pragma("cipher_compatibility = 4");
db.pragma('key = "x\\'' + process.env.CRASH_DEK_HEX + '\\'"');
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("synchronous = NORMAL");
db.exec("CREATE TABLE IF NOT EXISTS crash_probe (seq INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
const insert = db.prepare("INSERT INTO crash_probe (seq, payload) VALUES (?, ?)");
let seq = 0;
setInterval(() => {
	seq += 1;
	db.transaction(() => {
		insert.run(seq, "committed-" + seq);
	}).immediate();
	// Reported ONLY after the transaction committed.
	console.log("COMMITTED " + seq);
}, 5);
`;

describe("crash recovery under synchronous=NORMAL", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mem-claw-crash-"));
		dbPath = join(dir, "crash.sqlite");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("loses no committed transaction when the writer process is SIGKILLed", async () => {
		const child = spawn(process.execPath, ["-e", WRITER_SCRIPT], {
			env: {
				...process.env,
				CRASH_DRIVER_PATH: require.resolve("better-sqlite3-multiple-ciphers"),
				CRASH_DB_PATH: dbPath,
				CRASH_DEK_HEX: DEK_HEX,
			},
			stdio: ["ignore", "pipe", "inherit"],
		});

		const committed: number[] = [];
		let buffered = "";
		child.stdout.on("data", (chunk: Buffer) => {
			buffered += chunk.toString();
			let newline = buffered.indexOf("\n");
			while (newline >= 0) {
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				const match = /^COMMITTED (\d+)$/.exec(line.trim());
				if (match) committed.push(Number(match[1]));
				newline = buffered.indexOf("\n");
			}
		});

		// Let it commit a real stream of transactions, then kill WITHOUT close.
		await new Promise<void>((resolve) => {
			const check = setInterval(() => {
				if (committed.length >= 50) {
					clearInterval(check);
					resolve();
				}
			}, 10);
		});
		child.kill("SIGKILL");
		await new Promise<void>((resolve) => child.on("exit", () => resolve()));
		const reportedMax = Math.max(...committed);
		expect(reportedMax).toBeGreaterThanOrEqual(50);

		// Reopen the same file: WAL recovery must replay every reported commit.
		const Database = require("better-sqlite3-multiple-ciphers");
		const db = new Database(dbPath);
		try {
			db.pragma("cipher = 'sqlcipher'");
			db.pragma("cipher_compatibility = 4");
			db.pragma(`key = "x'${DEK_HEX}'"`);
			const integrity = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
			expect(integrity).toEqual([{ integrity_check: "ok" }]);
			for (const seq of committed) {
				const row = db
					.prepare("SELECT payload FROM crash_probe WHERE seq = ?")
					.get(seq) as { payload: string } | undefined;
				expect(row?.payload).toBe(`committed-${seq}`);
			}
		} finally {
			db.close();
		}
	});
});
