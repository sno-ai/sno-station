/**
 * Task 2.7 — manifest atomicity. Spawn a child process that calls `getDek(hex)`
 * + `openEncryptedDb()` enough to trigger a manifest write, then SIGKILL the
 * child via fault-injection at deterministic points. Parent verifies the
 * resulting on-disk manifest is either prior-valid or new-valid, never
 * truncated.
 *
 * Implementation gate: production code MUST honor a SNO_STATION_CORE_CRASH_AFTER env
 * hook only when SNO_STATION_CORE_TESTING=1. Without the gated hook this test cannot
 * deterministically reproduce the crash window.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { openEncryptedDb } from "@snoai/sqlite-crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { childNodeArgs, makeTestEnv, type TestEnv } from "../_helpers.ts";

let env: TestEnv;

beforeEach(() => {
	env = makeTestEnv("manifest");
});

afterEach(() => {
	env.cleanup();
});

const FIXTURE_PATH = new URL(
	"./fixtures/manifest-write-killer.mjs",
	import.meta.url,
).pathname;

function killerDbPath(): string {
	return `${env.snoStationCoreConfigDir}/dbs/killer.db`;
}

function spawnKiller(crashPoint: string): {
	code: number | null;
	signal: NodeJS.Signals | null;
} {
	const result = spawnSync(process.execPath, [...childNodeArgs(FIXTURE_PATH), env.keyHex], {
		env: {
			...process.env,
			SNO_STATION_CORE_CRASH_AFTER: crashPoint,
			SNO_STATION_CORE_DB_PATH: killerDbPath(),
		},
		timeout: 30_000,
		encoding: "utf8",
	});
	return { code: result.status, signal: result.signal };
}

describe("manifest atomicity (task 2.7)", () => {
	it("ignores crash hooks outside explicit test mode", () => {
		const childEnv = {
			...process.env,
			SNO_STATION_CORE_CRASH_AFTER: "before-marker",
			SNO_STATION_CORE_DB_PATH: `${env.snoStationCoreConfigDir}/dbs/no-test-mode.db`,
		};
		delete childEnv.SNO_STATION_CORE_TESTING;

		const ok = spawnSync(process.execPath, [...childNodeArgs(FIXTURE_PATH), env.keyHex], {
			env: childEnv,
			timeout: 30_000,
			encoding: "utf8",
		});
		expect(ok.status, `stderr: ${ok.stderr}`).toBe(0);
		expect(existsSync(env.manifestFile)).toBe(true);
	});

	it("crash before marker fsync → next start treats as fresh-install", () => {
		const r = spawnKiller("before-marker");
		expect(r.code === null || r.code !== 0 || r.signal !== null).toBe(true);
		expect(existsSync(env.markerFile)).toBe(false);
		expect(existsSync(env.manifestFile)).toBe(false);
	});

	it("crash between marker fsync and manifest rename leaves a marker without a manifest", () => {
		const r = spawnKiller("after-marker-before-manifest");
		expect(r.code !== 0 || r.signal !== null).toBe(true);
		expect(existsSync(env.markerFile)).toBe(true);
		expect(existsSync(env.manifestFile)).toBe(false);
	});

	it("crash after DB commit before manifest leaves a rebuildable canary", async () => {
		const r = spawnKiller("after-commit-before-manifest");
		expect(r.code !== 0 || r.signal !== null).toBe(true);
		expect(existsSync(env.markerFile)).toBe(true);
		expect(existsSync(env.manifestFile)).toBe(false);

		// Reopening with the same key adopts the committed canary into the manifest.
		openEncryptedDb(killerDbPath(), env.dek).close();
		const manifest = JSON.parse(readFileSync(env.manifestFile, "utf8")) as {
			dbs: Array<{ path: string }>;
		};
		expect(manifest.dbs.map((db) => db.path)).toContain(killerDbPath());
	});

	it("crash mid-rename → file is either prior-valid or new-valid, never truncated", () => {
		// First create a known-valid manifest by completing one open cycle.
		const ok = spawnSync(process.execPath, [...childNodeArgs(FIXTURE_PATH), env.keyHex], {
			env: {
				...process.env,
				SNO_STATION_CORE_DB_PATH: `${env.snoStationCoreConfigDir}/dbs/clean.db`,
			},
			timeout: 30_000,
			encoding: "utf8",
		});
		expect(ok.status).toBe(0);
		const before = readFileSync(env.manifestFile);

		// Now crash during a second registration's atomic-rename window.
		const r = spawnKiller("during-manifest-rename");
		expect(r.code !== 0 || r.signal !== null).toBe(true);

		expect(existsSync(env.manifestFile)).toBe(true);
		const sz = statSync(env.manifestFile).size;
		expect(sz).toBeGreaterThan(0);
		const after = readFileSync(env.manifestFile);
		// Either the prior file is still on disk (rename rolled back) or a fully
		// new valid file is on disk (rename completed). Never half.
		const parsed = JSON.parse(after.toString("utf8")) as {
			schemaVersion: number;
			dbs: unknown[];
		};
		expect(parsed.schemaVersion).toBe(1);
		expect(Array.isArray(parsed.dbs)).toBe(true);
		// Two acceptable outcomes; we just assert validity.
		void before;
	});
});
