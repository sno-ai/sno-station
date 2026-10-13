import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createRemModelStageResponsePort,
	runRemBatchJob,
} from "../../../../packages/memory/src/sidecar/rem-batch-executor.ts";
import { createRemRepository, parseRemOperationalConfiguration } from "../../../../packages/memory/src/engine/rem/index.ts";
import { createRemOwnerDecidedOperationalConfiguration } from "../../../apps/mem-claw/helpers/rem-entry-config-fixture.ts";
import { seedProductionMemory } from "../../../apps/mem-claw/helpers/rem-production-entry-fixture.ts";
import { createTestDb, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";
import { writeSettingsFixture } from "../fixtures/settings-file-fixture.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(): TestDb {
	const database = createTestDb();
	const root = mkdtempSync(join(tmpdir(), "rem-model-budget-"));
	const prior = {
		SNO_PROFILE_DIR: process.env["SNO_PROFILE_DIR"],
		SNO_STATION_MEM_REM_EXPECTED_DB_PATH: process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"],
	};
	writeSettingsFixture(root, {
		mode: "local-first",
		store: { path: database.dbPath, encryptionKey: database.encryptionKey },
		embedding: { cacheDir: "" },
	});
	process.env["SNO_PROFILE_DIR"] = root;
	process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"] = database.dbPath;
	cleanups.push(() => {
		database.cleanup();
		rmSync(root, { recursive: true, force: true });
		for (const [name, value] of Object.entries(prior)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	return database;
}

function configuration(maxPairs: number) {
	return parseRemOperationalConfiguration({
		...createRemOwnerDecidedOperationalConfiguration(),
		budgets: { maxPairs },
		retrieval: { neighborLimit: 10, similarityThreshold: 1 },
	});
}

function seedPair(database: TestDb, prefix: string, section: string): void {
	for (let index = 0; index < 2; index += 1) {
		seedProductionMemory(database.runtime.raw, {
			id: `${prefix}-${index}`,
			scope: "persona:model-budget",
			text: `The researcher prefers ${prefix} storage option ${index}.`,
			metadata: { section_name: section },
		});
	}
}

async function replace(jobId: string, maxPairs: number,
	respond: Parameters<typeof createRemModelStageResponsePort>[0]["respond"]) {
	try {
		return await runRemBatchJob({
			jobId, jobType: "rem-replace", scope: "persona:model-budget",
			configuration: configuration(maxPairs),
			modelStageResponses: createRemModelStageResponsePort({ respond }),
		});
	} catch (error) {
		// Invalid/empty replies remain visible failures after their durable refusal is written.
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).toContain("REM LLM calls all failed:");
		return undefined;
	}
}

describe("REM model calls per pass", () => {
	it.each(["uncertain", "invalid reply", null])(
		"retains three failed tries across generations and stops retrying %s after an unrelated insert",
		async (reply) => {
			const database = fixture();
			seedPair(database, "old", "a-storage");
			const prompts: string[] = [];
			const respond = async ({ prompt }: { prompt: string }) => {
				prompts.push(prompt);
				return reply;
			};
			for (let pass = 0; pass < 3; pass += 1) {
				// Another scope's generation must not erase this pair's retry history.
				if (pass > 0) {
					database.runtime.raw.prepare(`INSERT INTO nodix_rem_scan_generations
						(generation_id, corpus_snapshot_hash, pairing_config_hash, max_llm_calls, max_tokens)
						VALUES (?, 'other-corpus', 'other-config', 3, 8192)`)
						.run(`other-scope-${pass}`);
				}
				await replace(`failed-${pass}`, 1, respond);
			}
			expect(prompts).toHaveLength(3);
			const attempts = database.runtime.raw.prepare(`SELECT attempt_count, progress_state
				FROM nodix_rem_scan_pairs ORDER BY rowid`).all();
			expect(attempts).toEqual([
				{ attempt_count: 1, progress_state: "refused" },
				{ attempt_count: 2, progress_state: "refused" },
				{ attempt_count: 3, progress_state: "exhausted" },
			]);
			seedProductionMemory(database.runtime.raw, {
				id: "unrelated", scope: "persona:model-budget", text: "The researcher likes hiking.",
				metadata: { section_name: "hobbies" },
			});
			await replace("after-unrelated", 1, respond);
			expect(prompts).toHaveLength(3);
			const text = "The researcher prefers changed storage option zero.";
			database.runtime.raw.prepare("UPDATE nodix_memories SET text = ?, content_hash = ? WHERE id = 'old-0'")
				.run(text, createHash("sha256").update(text).digest("hex"));
			await replace("after-edit", 1, respond);
			expect(prompts).toHaveLength(4);
			expect(prompts[3]).toContain("changed storage option zero");
		},
	);

	it("gives a new pair the one-pair pass budget before an earlier failing pair", async () => {
		const database = fixture();
		seedPair(database, "old", "a-storage");
		await replace("old-refusal", 1, async () => "uncertain");
		seedPair(database, "new", "z-storage");
		const prompts: string[] = [];
		await replace("new-work", 1, async ({ prompt }) => {
			prompts.push(prompt);
			return "keep";
		});
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("new storage option 0");
		expect(prompts[0]).toContain("new storage option 1");
		expect(database.runtime.raw.prepare(`SELECT progress_state FROM nodix_rem_scan_pairs
			WHERE left_row_id = 'new-0' AND right_row_id = 'new-1'`).pluck().get()).toBe("closed");
	});

	it("does not judge a durably exhausted uncertain pair after unrelated memories start a generation", async () => {
		const database = fixture();
		seedPair(database, "old", "a-storage");
		await replace("first-uncertain", 1, async () => "uncertain");
		const generation = database.runtime.raw.prepare(`SELECT corpus_snapshot_hash, pairing_config_hash
			FROM nodix_rem_scan_generations`).get() as { corpus_snapshot_hash: string; pairing_config_hash: string };
		const pair = database.runtime.raw.prepare(`SELECT pair_id, left_row_id, right_row_id, sort_key
			FROM nodix_rem_scan_pairs`).get() as { pair_id: string; left_row_id: string; right_row_id: string; sort_key: string };
		createRemRepository(database.runtime.db).createVerdictGeneration({
			generationId: "last-try", corpusSnapshotHash: generation.corpus_snapshot_hash,
			pairingConfigHash: generation.pairing_config_hash, maxLlmCalls: 3, maxTokens: 8192,
			pairs: [{ pairId: pair.pair_id, leftRowId: pair.left_row_id, rightRowId: pair.right_row_id, sortKey: pair.sort_key }],
		});
		// Resume a persisted last try; producing this history is independently tested above.
		database.runtime.raw.prepare("UPDATE nodix_rem_scan_pairs SET attempt_count = 2 WHERE generation_id = 'last-try'").run();
		await replace("last-uncertain", 1, async () => "uncertain");
		expect(database.runtime.raw.prepare("SELECT progress_state FROM nodix_rem_scan_pairs WHERE generation_id = 'last-try'").pluck().get()).toBe("exhausted");
		seedPair(database, "new", "z-storage");
		const prompts: string[] = [];
		await replace("after-exhausted", 2, async ({ prompt }) => { prompts.push(prompt); return "keep"; });
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("new storage option 0");
		expect(prompts[0]).not.toContain("old storage option");
	});

	it("does not revisit a settled pair after an unrelated insert", async () => {
		const database = fixture();
		seedPair(database, "old", "storage");
		const prompts: string[] = [];
		const respond = async ({ prompt }: { prompt: string }) => { prompts.push(prompt); return "keep"; };
		await replace("settled", 1, respond);
		seedProductionMemory(database.runtime.raw, {
			id: "unrelated", scope: "persona:model-budget", text: "The researcher likes hiking.",
			metadata: { section_name: "hobbies" },
		});
		await replace("settled-unrelated", 1, respond);
		expect(prompts).toHaveLength(1);
	});

	it.each([1, 2])("limits rewrite and verification calls together to maxPairs=%s", async (maxPairs) => {
		const database = fixture();
		for (let index = 0; index < 3; index += 1) {
			seedProductionMemory(database.runtime.raw, {
				id: `transition-${index}`, scope: "persona:model-budget",
				text: `Lives in city ${index}. Moved from San Francisco in 2024.`,
				metadata: { section_name: `residence-${index}` },
			});
			database.runtime.raw.prepare("UPDATE nodix_memories SET subject = ? WHERE id = ?")
				.run(`person-${index}`, `transition-${index}`);
		}
		const stages: string[] = [];
		const result = await runRemBatchJob({
			jobId: `update-cap-${maxPairs}`, jobType: "rem-update", scope: "persona:model-budget",
			configuration: configuration(maxPairs),
			modelStageResponses: createRemModelStageResponsePort({
				respond: async ({ stage }) => {
					stages.push(stage);
					if (stage === "rem-update-judgment") {
						return JSON.stringify({ proposed_current: "Lives in city 0.", retired_values: ["San Francisco"] });
					}
					if (stage === "rem-update-verification") {
						return JSON.stringify({ faithful: true, retired_absent: true, all_facts_accounted: true });
					}
					throw new Error(`unexpected stage: ${stage}`);
				},
			}),
		});
		expect(stages).toEqual(maxPairs === 1 ? ["rem-update-judgment"] : ["rem-update-judgment", "rem-update-verification"]);
		expect(result.measurements.modelCalls).toBe(maxPairs === 1 ? 1 : 2);
		expect(result.measurements.pairCapBinding).toBe(true);
		expect(database.runtime.raw.prepare("SELECT text FROM nodix_memories WHERE id = 'transition-1'").pluck().get())
			.toBe("Lives in city 1. Moved from San Francisco in 2024.");
		expect(database.runtime.raw.prepare("SELECT count(*) FROM nodix_rem_row_claims WHERE state = 'active'").pluck().get()).toBe(0);
	});

	it.each([1, 2, 3, 4])("shares maxPairs=%s across target, relation, rewrite and verification", async (maxPairs) => {
		const database = fixture();
		seedProductionMemory(database.runtime.raw, {
			id: "prior", scope: "persona:model-budget", text: "Lives in San Francisco.",
			metadata: { section_name: "identity.residence" },
		});
		seedProductionMemory(database.runtime.raw, {
			id: "successor", scope: "persona:model-budget",
			text: "Lives in San Diego. Moved from San Francisco in 2024.",
			metadata: { section_name: "identity.residence" },
			timestamp: "2026-08-21T12:00:00.000Z",
		});
		const stages: string[] = [];
		const result = await runRemBatchJob({
			jobId: `relation-cap-${maxPairs}`, jobType: "rem-update", scope: "persona:model-budget",
			configuration: configuration(maxPairs),
			modelStageResponses: createRemModelStageResponsePort({
				respond: async ({ stage }) => {
					stages.push(stage);
					switch (stage) {
						case "rem-update-retirement-target": return '{"target_row_ids":["prior"]}';
						case "rem-update-relation-judgment": return '{"supersedes":true,"retires_anything":true,"supersedes_everything":false}';
						case "rem-update-judgment": return '{"proposed_current":"Lives in San Diego.","retired_values":["San Francisco"]}';
						case "rem-update-verification": return '{"faithful":true,"retired_absent":true,"all_facts_accounted":true}';
						default: throw new Error(`unexpected stage: ${stage}`);
					}
				},
			}),
		});
		expect(stages).toEqual([
			"rem-update-retirement-target", "rem-update-relation-judgment",
			"rem-update-judgment", "rem-update-verification",
		].slice(0, maxPairs));
		expect(result.measurements.modelCalls).toBe(maxPairs);
		expect(database.runtime.raw.prepare("SELECT text FROM nodix_memories WHERE id = 'prior'").pluck().get())
			.toBe(maxPairs === 4 ? "Lives in San Diego." : "Lives in San Francisco.");
		expect(database.runtime.raw.prepare("SELECT count(*) FROM nodix_rem_row_claims WHERE state = 'active'").pluck().get()).toBe(0);
	});
});
