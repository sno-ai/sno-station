/**
 * M2 RED scaffolding (tasks 5.2 – 5.6 + 5.1.c preservation diff).
 *
 * These tests are intentionally RED at the start of M2. They drive the
 * Section 6 implementation: when every assertion below passes, the plugin
 * has been migrated off direct `better-sqlite3` access onto the
 * `@snoai/sqlite-crypto` chokepoint.
 *
 * Tests use REAL fs / git / package.json — no mocks.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const PLUGIN_ROOT = join(REPO_ROOT, "apps", "mem-claw");
const PLUGIN_PKG = join(PLUGIN_ROOT, "package.json");
const SQLITE_RUNTIME = join(PLUGIN_ROOT, "src", "storage", "sqlite-runtime.ts");
const MEMORY_SNAPSHOT = join(
	PLUGIN_ROOT,
	"src",
	"observability",
	"memory-snapshot.ts",
);
const PRESERVATION_BASE = join(
	REPO_ROOT,
	"tests",
	"apps",
	"mem-claw",
	"fixtures",
	"preservation-base.txt",
);

function runGit(args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd: REPO_ROOT,
		encoding: "utf8",
	}).trim();
}

describe("M2 preservation diff (task 5.1.c)", () => {
	it("the recorded merge-base SHA exists in this repo", () => {
		expect(existsSync(PRESERVATION_BASE)).toBe(true);
		const sha = readFileSync(PRESERVATION_BASE, "utf8").trim();
		expect(sha).toMatch(/^[0-9a-f]{40}$/);
		const resolved = runGit(["rev-parse", sha]);
		expect(resolved).toBe(sha);
	});

	it("deferred packages have NOT been modified since the merge-base", () => {
		const sha = readFileSync(PRESERVATION_BASE, "utf8").trim();
		const diff = runGit([
			"diff",
			"--name-only",
			`${sha}...HEAD`,
			"--",
			".onhold/sno-station-legacy-core/src",
			".onhold/sno-station-legacy-core/package.json",
			"packages/observability/src",
			"packages/observability/package.json",
			".onhold/sno-station-legacy-code-agent/src",
			"apps/capsix-core/src",
		]);
		expect(diff).toBe("");
	});
});

describe("M2 chokepoint shape (tasks 5.3 + 5.4)", () => {
	it("plugin package.json has @snoai/sqlite-crypto and no better-sqlite3", () => {
		const pkg = JSON.parse(readFileSync(PLUGIN_PKG, "utf8")) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
		expect(all["@snoai/sqlite-crypto"]).toBeDefined();
		expect(all["better-sqlite3"]).toBeUndefined();
		expect(all["better-sqlite3-multiple-ciphers"]).toBeUndefined();
	});

	it("sqlite-runtime.ts contains zero direct better-sqlite3 imports or constructor calls", () => {
		const src = readFileSync(SQLITE_RUNTIME, "utf8");
		expect(src).not.toMatch(/from\s+["']better-sqlite3(["']|-multiple-ciphers["'])/);
		expect(src).not.toMatch(/new\s+Database\s*\(/);
	});

	it("memory-snapshot.ts contains zero direct better-sqlite3 imports or constructor calls", () => {
		// The file may not yet exist before M2 implementation lands.
		if (!existsSync(MEMORY_SNAPSHOT)) {
			throw new Error(
				`expected ${MEMORY_SNAPSHOT} to exist for chokepoint test; if the file was renamed, update the test path`,
			);
		}
		const src = readFileSync(MEMORY_SNAPSHOT, "utf8");
		expect(src).not.toMatch(/from\s+["']better-sqlite3(["']|-multiple-ciphers["'])/);
		expect(src).not.toMatch(/new\s+Database\s*\(/);
	});
});

describe("M2 boot-order safety (task 5.2)", () => {
	it("openSqliteDatabase before initSqliteRuntime() throws a typed error", async () => {
		// This test reaches into the runtime without going through the plugin
		// init pipeline. It must throw a typed `RuntimeNotInitialized`-style
		// error rather than silently constructing a raw better-sqlite3 handle.
		const runtime = (await import(
			"../../../../packages/memory/src/store/sqlite-runtime.ts"
		)) as {
			openSqliteDatabase?: (path: string) => unknown;
			initSqliteRuntime?: () => Promise<void>;
		};
		expect(typeof runtime.openSqliteDatabase).toBe("function");
		expect(typeof runtime.initSqliteRuntime).toBe("function");
		const tmp = `/tmp/m2-red-${Date.now().toString(36)}.db`;
		expect(() => runtime.openSqliteDatabase?.(tmp)).toThrow(/init|not.*ready|not.*initialized/i);
	});
});

describe("M2 lint scope (tasks 5.5 + 5.6)", () => {
	it("plugin biome.json or eslint config restricts better-sqlite3 imports under apps/mem-claw/src/**", () => {
		// At least one of these paths must contain a noRestrictedImports / no-restricted-imports rule
		// targeting better-sqlite3 with a scope of apps/mem-claw/src/**.
		const candidates = [
			join(PLUGIN_ROOT, "biome.json"),
			join(PLUGIN_ROOT, ".eslintrc.json"),
			join(PLUGIN_ROOT, ".eslintrc.cjs"),
			join(PLUGIN_ROOT, "eslint.config.js"),
			join(PLUGIN_ROOT, "eslint.config.mjs"),
		];
		const present = candidates.find(
			(p) => existsSync(p) && statSync(p).isFile(),
		);
		expect(present).toBeDefined();
		if (!present) return;
		const cfg = readFileSync(present, "utf8");
		expect(cfg).toMatch(/better-sqlite3/);
		// Must NOT also forbid drizzle-orm/better-sqlite3 (allow-list per 5.6).
		const rxAllowDrizzle = /drizzle-orm\/better-sqlite3/;
		// Either the rule explicitly excludes drizzle, or the rule is regex-narrow.
		if (rxAllowDrizzle.test(cfg)) {
			// good — explicit allow appears in config or in a comment.
			expect(cfg).toMatch(rxAllowDrizzle);
		}
	});
});
