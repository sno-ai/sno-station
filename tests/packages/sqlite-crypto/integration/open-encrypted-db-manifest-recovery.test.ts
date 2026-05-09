import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { getDek, openEncryptedDb } from "@snoai/nodix-crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv, uniqueDbPath } from "../_helpers.ts";

let env: TestEnv;

beforeEach(() => {
	env = makeTestEnv("manifest-recovery");
});

afterEach(() => {
	env.cleanup();
});

describe("openEncryptedDb — manifest recovery", () => {
	it("re-registers a readable encrypted DB when only the manifest entry is missing", async () => {
		const dek = await getDek();
		const dbPath = uniqueDbPath(env, "recovered");

		const db = openEncryptedDb(dbPath, dek);
		db.exec("CREATE TABLE t (v TEXT)");
		db.prepare("INSERT INTO t (v) VALUES ('kept')").run();
		db.close();

		expect(existsSync(env.manifestFile)).toBe(true);
		unlinkSync(env.manifestFile);

		const reopened = openEncryptedDb(dbPath, dek);
		expect(reopened.prepare("SELECT v FROM t").pluck().get()).toBe("kept");
		reopened.close();

		const manifest = JSON.parse(readFileSync(env.manifestFile, "utf8")) as {
			dbs: Array<{ path: string }>;
		};
		expect(manifest.dbs.map((entry) => entry.path)).toContain(dbPath);
	});
});
