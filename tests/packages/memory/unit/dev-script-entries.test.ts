import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { expect, it } from "vitest";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db";
import { writeSettingsFixture } from "../fixtures/settings-file-fixture";

it("runs the REM utilities against the published module and an encrypted migrated store", () => {
	const repo = resolve(import.meta.dirname, "../../../..");
	const fixture = createTestDb();
	try {
		writeSettingsFixture(dirname(fixture.dbPath), {
			store: { path: fixture.dbPath, encryptionKey: fixture.encryptionKey },
		});
		fixture.sqlite.prepare(`INSERT INTO nodix_memories
			(id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id, lane, raw_candidate_json)
			VALUES ('utility-row', 'I finished the copper folder task.', 'episodic', 'agent:utility', 0.5, 1, 'UTC', '{}', 'utility-hash', 'utility-fact', 'active', '{}')`).run();
		const run = (args: string[]) => execFileSync(resolve(repo, "node_modules/.bin/tsx"), args, {
			cwd: repo, encoding: "utf8", timeout: 30_000, env: process.env,
		});
		expect(run(["dev-scripts/generate-rem-operations.ts"])).toContain("packages/memory/generated/rem-operations.json");
		// The artifact generator's main creates evaluation assets and is expressly excluded.
		expect(run(["-e", "import('./dev-scripts/build-rem-gate-artifacts.ts').then(() => console.log('module-imported'))"])).toContain("module-imported");
		const census = run(["dev-scripts/census-rem-classifier.mts", fixture.dbPath]);
		expect(census).toMatch(/active rows\s+1/);
		expect(census).toMatch(/match bare word\s+1/);
	} finally {
		fixture.cleanup();
	}
});
