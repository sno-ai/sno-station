/** @file sqlite-vec-symbol-isolation.test.ts
 * @purpose Proves the bundled vec0 extension cannot share sqlite3_api with another loaded copy.
 * @boundary Native extension symbols plus a child process using both SQLite runtimes.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	globSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { getLoadablePath } from "sqlite-vec";
import { resolveSqliteVecPath } from "../../../../packages/sno-station-mem/src/store/sqlite-vec-path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const BUNDLED_VEC = resolve(
	REPO_ROOT,
	"packages/sno-station-mem/sqlite-extensions/linux-x64/vec0.so",
);
const SQLITE_VEC_PACKAGE_IMPORT =
	/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']sqlite-vec(?:["'/-])/u;
const require = createRequire(import.meta.url);
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0).reverse()) rmSync(root, { force: true, recursive: true });
});

describe("sqlite-vec symbol isolation", () => {
	it("detects static, aliased, dynamic, and platform-package imports", () => {
		for (const source of [
			'import * as sqliteVec from "sqlite-vec";',
			'import { load as stockLoad } from "sqlite-vec";',
			'const stock = await import("sqlite-vec");',
			'const binary = require("sqlite-vec-linux-x64/vec0.so");',
		]) {
			expect(SQLITE_VEC_PACKAGE_IMPORT.test(source), source).toBe(true);
		}
	});

	it("resolves the bundled Linux x64 extension by absolute path", () => {
		expect(resolveSqliteVecPath()).toBe(BUNDLED_VEC);
	});

	it("allows the sqlite-vec package import only inside the bundled extension loader", () => {
		const sqliteVecImports = globSync("apps/mem-claw/src/**/*.ts", { cwd: REPO_ROOT }).flatMap(
			(file) => {
				const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
				return SQLITE_VEC_PACKAGE_IMPORT.test(source)
					? [file]
					: [];
			},
		);
		expect(sqliteVecImports).toEqual(["packages/sno-station-mem/src/store/sqlite-vec-path.ts"]);
	});

	it("exports only sqlite3_vec_init", () => {
		expect(existsSync(BUNDLED_VEC), `missing bundled extension: ${BUNDLED_VEC}`).toBe(true);
		const symbols = execFileSync("nm", ["-D", "--defined-only", BUNDLED_VEC], {
			encoding: "utf8",
		})
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => line.trim().split(/\s+/u).at(-1));
		expect(symbols).toEqual(["sqlite3_vec_init"]);
	});

	it("keeps the cipher SQLite query valid after Node SQLite loads another vec0 copy", () => {
		const root = mkdtempSync(join(tmpdir(), "sqlite-vec-symbol-isolation-"));
		temporaryRoots.push(root);
		const stockDirectory = join(root, "stock-copy");
		mkdirSync(stockDirectory);
		const stockCopy = join(stockDirectory, "vec0.so");
		copyFileSync(getLoadablePath(), stockCopy);
		const cipherPackage = require.resolve("better-sqlite3-multiple-ciphers");
		const script = `
			import { createRequire } from "node:module";
			const require = createRequire(import.meta.url);
			const Database = require(process.argv[1]);
			const cipher = new Database(":memory:");
			cipher.loadExtension(process.argv[2]);
			cipher.exec("CREATE VIRTUAL TABLE v USING vec0(embedding float[4])");
			cipher.prepare("INSERT INTO v(rowid, embedding) VALUES (1, ?)").run(
				new Float32Array([1, 0, 0, 0]),
			);
			cipher.prepare(
				"SELECT rowid FROM v WHERE embedding MATCH ? ORDER BY distance LIMIT 1",
			).all(new Float32Array([1, 0, 0, 0]));
			const { DatabaseSync } = await import("node:sqlite");
			const builtin = new DatabaseSync(":memory:", { allowExtension: true });
			builtin.enableLoadExtension(true);
			builtin.loadExtension(process.argv[3]);
			const rows = cipher.prepare(
				"SELECT rowid FROM v WHERE embedding MATCH ? ORDER BY distance LIMIT 1",
			).all(new Float32Array([1, 0, 0, 0]));
			process.stdout.write(JSON.stringify(rows));
		`;
		const result = spawnSync(
			process.execPath,
			["--input-type=module", "--eval", script, cipherPackage, BUNDLED_VEC, stockCopy],
			{ encoding: "utf8", timeout: 30_000 },
		);
		expect(result.signal, result.stderr).toBeNull();
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual([{ rowid: 1 }]);
	});
});
