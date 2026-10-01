import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture.ts";
/** @file rem-update-production-repair.test.ts
 * @purpose Proves the PRD30 REM update repair through real SQLite production boundaries.
 * @boundary Production batch executor, REM repository, memory store, and retriever.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { countTokens } from "@snoai/chunking";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
	MAX_AGGREGATION_RESULT_TOKENS,
	MAX_AGGREGATION_ROWS,
} from "../../../../packages/memory/config/index.ts";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { executeMemoryRecallTool } from "../../../../packages/memory/src/engine/bindings/memory-recall-tool";
import { createScopePolicy } from "../../../../packages/memory/src/engine/security/scopes";
import {
	createRemModelStageResponsePort,
	runRemBatchJob,
} from "../../../../packages/memory/src/sidecar/rem-batch-executor.ts";
import {
	createRetriever,
	DEFAULT_RETRIEVAL_CONFIG,
} from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import { retrieveForMemoryRecallOrEval } from "../../../../packages/memory/src/engine/retrieval/rem-consumer-retrieval.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import {
	installRemSchema,
	parseRemOperationalConfiguration,
} from "../../../../packages/memory/src/engine/rem/index.ts";
import { createRemOwnerDecidedOperationalConfiguration } from "../helpers/rem-entry-config-fixture.ts";
import { seedProductionMemory } from "../helpers/rem-production-entry-fixture.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db.ts";
import {
	asClawResult,
	type ClawToolResult,
	getRecallMemories,
} from "../helpers/tool-result.ts";

const priorEnvironment = {
	SNO_STATION_MEM_REM_EXPECTED_DB_PATH: process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"],
	SNO_PROFILE_DIR: process.env["SNO_PROFILE_DIR"],
};

const cleanups: Array<() => void | Promise<void>> = [];
let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	restoreEnvironment(
		"SNO_STATION_MEM_REM_EXPECTED_DB_PATH",
		priorEnvironment.SNO_STATION_MEM_REM_EXPECTED_DB_PATH,
	);
	restoreEnvironment("SNO_PROFILE_DIR", priorEnvironment.SNO_PROFILE_DIR);
});

describe("REM update production repair", () => {
	it("durably refuses unresolved rows before model or mutation work", { timeout: 30_000 }, async () => {
		const fixture = prepareBatchFixture();
		const scope = "persona:rem-update-unresolved";
		const unresolved = [
			{
				id: "update-unresolved-lost-interest",
				text: "It is unclear whether the user lost interest in hiking.",
			},
			{
				id: "update-unresolved-did-not",
				text: "It is unclear whether the user did not enjoy painting.",
			},
		] as const;
		const pureNegation = {
			id: "update-settled-pure-negation",
			text: "The user does not drink coffee.",
		};
		for (const row of [...unresolved, pureNegation]) {
			seedProductionMemory(fixture.runtime.raw, {
				id: row.id,
				scope,
				text: row.text,
			});
		}
		const modelStages: string[] = [];
		const result = await runRemBatchJob({
			jobId: "rem-update-unresolved-production-repair",
			jobType: "rem-update",
			scope,
			configuration: configuration(),
			modelStageResponses: createRemModelStageResponsePort({
				respond: async ({ stage }) => {
					modelStages.push(stage);
					throw new Error(`unresolved or pure-negation row reached model stage ${stage}`);
				},
			}),
		});
		const ledger = fixture.runtime.raw
			.prepare(
				`SELECT row_id, state, owner FROM nodix_rem_relation_ledger
				WHERE row_id IN (?, ?, ?) ORDER BY row_id`,
			)
			.all(unresolved[0].id, unresolved[1].id, pureNegation.id) as Array<{
			row_id: string;
			state: string;
			owner: string;
		}>;
		const refusals = fixture.runtime.raw
			.prepare(
				`SELECT row_id, reason FROM nodix_rem_journal
				WHERE job_id = ? AND outcome = 'refused' ORDER BY row_id`,
			)
			.all("rem-update-unresolved-production-repair") as Array<{
			row_id: string;
			reason: string;
		}>;
		const attempts = fixture.runtime.raw
			.prepare("SELECT row_id, writer FROM nodix_rem_write_attempts WHERE job_id = ?")
			.all("rem-update-unresolved-production-repair");

		expect(ledger).toEqual([
			{ row_id: pureNegation.id, state: "pure-negation", owner: "none" },
			{ row_id: unresolved[1].id, state: "ambiguous", owner: "restate" },
			{ row_id: unresolved[0].id, state: "ambiguous", owner: "restate" },
		]);
		expect(refusals).toEqual(
			unresolved
				.map((row) => ({ row_id: row.id, reason: "ambiguous_unresolved" }))
				.sort((left, right) => left.row_id.localeCompare(right.row_id)),
		);
		expect(modelStages).toEqual([]);
		expect(result.measurements.modelCalls).toBe(0);
		expect(attempts).toEqual([]);
	});

	it("reports update rows and relation pairs as separate durable units", { timeout: 30_000 }, async () => {
		const fixture = prepareBatchFixture();
		const scope = "persona:rem-update-split-statistics";
		seedProductionMemory(fixture.runtime.raw, {
			id: "update-row-standalone",
			scope,
			text: "Lives in San Diego. Moved from San Francisco in 2024.",
			metadata: { section_name: "identity.current-residence" },
		});
		seedProductionMemory(fixture.runtime.raw, {
			id: "update-row-refused",
			scope,
			text: "Works in design. Moved from Austin to Boston in 2023.",
			metadata: { section_name: "work.current-role" },
		});
		seedProductionMemory(fixture.runtime.raw, {
			id: "update-relation-prior",
			scope,
			text: "The user lives in Portland.",
			metadata: { section_name: "identity.relation-residence" },
			timestamp: "2026-08-01T08:00:00.000Z",
		});
		seedProductionMemory(fixture.runtime.raw, {
			id: "update-relation-current",
			scope,
			text: "The user lives in Seattle.",
			metadata: { section_name: "identity.relation-residence" },
			timestamp: "2026-08-02T08:00:00.000Z",
		});

		const result = await runRemBatchJob({
			jobId: "rem-update-split-statistics",
			jobType: "rem-update",
			scope,
			configuration: configuration(),
			modelStageResponses: createRemModelStageResponsePort({ respond: updateModelResponse }),
		});
		const split = result as typeof result & {
			updateRows?: { considered: number; applied: number; appliedFraction: number | null };
			relationPairs?: { considered: number; applied: number; appliedFraction: number | null };
		};
		const summaries = fixture.runtime.raw
			.prepare(
				`SELECT stage, pairs_scanned, actions_applied FROM nodix_rem_journal
				WHERE job_id = ? AND stage IN ('update-rows', 'update-relation-pairs') ORDER BY stage`,
			)
			.all("rem-update-split-statistics") as Array<{
			stage: string;
			pairs_scanned: number;
			actions_applied: number;
		}>;
		const successfulWrites = fixture.runtime.raw
			.prepare(
				`SELECT row_id, writer, outcome FROM nodix_rem_write_attempts
				WHERE job_id = ? AND outcome = 'succeeded' ORDER BY row_id`,
			)
			.all("rem-update-split-statistics") as Array<{
			row_id: string;
			writer: string;
			outcome: string;
		}>;
		const finalRows = fixture.runtime.raw
			.prepare(
				`SELECT id, text, metadata FROM nodix_memories
				WHERE id IN (?, ?, ?) ORDER BY id`,
			)
			.all(
				"update-relation-current",
				"update-relation-prior",
				"update-row-standalone",
			) as Array<{ id: string; text: string; metadata: string }>;

		expect(split.updateRows).toEqual({ considered: 2, applied: 1, appliedFraction: 0.5 });
		expect(split.relationPairs).toEqual({ considered: 1, applied: 1, appliedFraction: 1 });
		expect(result.actionsApplied).toBe(2);
		expect(summaries).toEqual([
			{ stage: "update-relation-pairs", pairs_scanned: 1, actions_applied: 1 },
			{ stage: "update-rows", pairs_scanned: 2, actions_applied: 1 },
		]);
		for (const summary of summaries) {
			const durableFraction =
				summary.pairs_scanned === 0 ? null : summary.actions_applied / summary.pairs_scanned;
			const reported = summary.stage === "update-rows" ? split.updateRows : split.relationPairs;
			expect(reported).toEqual({
				considered: summary.pairs_scanned,
				applied: summary.actions_applied,
				appliedFraction: durableFraction,
			});
		}
		expect(successfulWrites).toEqual([
			{ row_id: "update-relation-prior", writer: "softClose", outcome: "succeeded" },
			{ row_id: "update-row-standalone", writer: "writeTextVersion", outcome: "succeeded" },
		]);
		expect(finalRows.map(({ id, text }) => ({ id, text }))).toEqual([
			{ id: "update-relation-current", text: "The user lives in Seattle." },
			{ id: "update-relation-prior", text: "The user lives in Portland." },
			{ id: "update-row-standalone", text: "Lives in San Diego." },
		]);
		const retiredRelation = finalRows.find((row) => row.id === "update-relation-prior");
		expect(JSON.parse(retiredRelation?.metadata ?? "{}")).toMatchObject({
			superseded_by: "update-relation-current",
		});
	});

	it("drains more than one aggregation page and deduplicates facet copies by event", { timeout: 30_000 }, async () => {
		const fixture = createTestDb();
		installRemSchema(fixture.runtime.db);
		const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		cleanups.push(async () => {
			await store.close();
			fixture.cleanup();
		});
		const scope = "persona:rem-update-aggregation-drain";
		const expectedEventIds = insertAggregationPopulation(
			fixture,
			scope,
			MAX_AGGREGATION_ROWS + 1,
		);
		const retriever = createRetriever(store, embedder, { warn: () => undefined }, {
			...DEFAULT_RETRIEVAL_CONFIG,
			mode: "vector",
			rerank: "none",
			minScore: 0,
		});

		const results = await retrieveForMemoryRecallOrEval(retriever, {
			query: "Show every aggregation proof event.",
			limit: 1,
			scopeFilter: [scope],
			aggregation: { operation: "evidence", terms: ["aggregationproof"] },
			facetPolicy: "include-history",
			nowMs: 0,
		});
		const eventRows = results as Array<(typeof results)[number] & { eventIdentity?: string }>;
		const eventIdentities = eventRows.map((row) => row.eventIdentity);

		expect(results).toHaveLength(expectedEventIds.length);
		expect(eventIdentities.every((identity) => typeof identity === "string")).toBe(true);
		expect(new Set(eventIdentities).size).toBe(eventIdentities.length);
		expect([...eventIdentities].sort()).toEqual([...expectedEventIds].sort());
		expect(results.every((row) => row.scopeRowCount === expectedEventIds.length)).toBe(true);
		expect(results.every((row) => row.aggregationIncomplete !== true)).toBe(true);
	});

	it("marks a token-cut recall prefix as truncated and incomplete", { timeout: 30_000 }, async () => {
		const fixture = createTestDb();
		installRemSchema(fixture.runtime.db);
		const populationSize = 120;
		insertAggregationPopulation(fixture, "global", populationSize, 400);
		const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		const context = { store, embedder, agentId: "rem-update-output-cut", stateDir: dirname(fixture.dbPath),
			scopePolicy: createScopePolicy(), retriever: createRetriever(store, embedder,
				{ warn: () => {} }, { ...DEFAULT_RETRIEVAL_CONFIG, minScore: 0, rerank: "none" }) };
		cleanups.push(async () => { await store.close(); fixture.cleanup(); });

		const result = asClawResult(
			await executeMemoryRecallTool(context, { agentId: context.agentId }, "rem-update-output-cut", {
				query: "Show every aggregation proof event.",
				aggregation: { operation: "evidence", terms: ["aggregationproof"] },
				top_k: 1,
				min_score: 0,
			}, { name: "memory_recall", label: "Memory Recall", description: "" }),
		);
		const memories = getRecallMemories<{ id: string }>(result);
		const rendered = result.content.map((part) => part.text ?? "").join("\n");

		expect(memories.length).toBeGreaterThan(0);
		expect(memories.length).toBeLessThan(populationSize);
		expect(result.details?.["scopeRowCount"]).toBe(populationSize);
		expect(result.details?.["truncated"]).toBe(true);
		expect(result.details?.["populationComplete"]).toBe(false);
		expect(rendered).toContain(`returned-count="${memories.length}"`);
		expect(rendered).toContain('population-complete="false"');
		expect(rendered).toContain('truncated="true"');
		expect(consumerTokens(result)).toBeLessThanOrEqual(MAX_AGGREGATION_RESULT_TOKENS);
	});
});

function prepareBatchFixture(): TestDb {
	const fixture = createTestDb();
	const stateRoot = mkdtempSync(join(tmpdir(), "rem-update-production-repair-"));
	writeSettingsFixture(stateRoot, { mode: "local-first", store: { path: fixture.dbPath, encryptionKey: fixture.encryptionKey }, embedding: { cacheDir: "" } });
	process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"] = fixture.dbPath;
	process.env["SNO_PROFILE_DIR"] = stateRoot;
	cleanups.push(() => {
		fixture.cleanup();
		rmSync(stateRoot, { recursive: true, force: true });
	});
	return fixture;
}

function configuration() {
	return parseRemOperationalConfiguration(createRemOwnerDecidedOperationalConfiguration());
}

async function updateModelResponse(input: { stage: string; prompt: string }): Promise<string> {
	if (input.stage === "rem-update-relation-judgment") {
		return JSON.stringify({
			supersedes: true,
			retires_anything: true,
			supersedes_everything: true,
		});
	}
	if (input.stage === "rem-update-judgment") {
		if (input.prompt.includes("Moved from Austin to Boston")) {
			return JSON.stringify({
				proposed_current: "Works in design.",
				retired_values: [],
			});
		}
		return JSON.stringify({
			proposed_current: "Lives in San Diego.",
			retired_values: ["Moved from San Francisco in 2024"],
		});
	}
	if (input.stage === "rem-update-verification") {
		return JSON.stringify({
			faithful: true,
			retired_absent: true,
			all_facts_accounted: true,
		});
	}
	throw new Error(`unexpected model stage: ${input.stage}`);
}

function insertAggregationPopulation(
	fixture: TestDb,
	scope: string,
	count: number,
	fillerRepeats = 0,
): string[] {
	const insertMemory = fixture.runtime.raw.prepare(
		`INSERT INTO nodix_memories(
			id, text, category, project_id, importance, timestamp, timezone, metadata,
			content_hash, fact_id, lane, raw_candidate_json
		) VALUES (?, ?, 'episodic', ?, 0.8, ?, 'UTC', '{}', ?, ?, 'active', '{}')`,
	);
	const insertHistoryFacet = fixture.runtime.raw.prepare(
		`INSERT INTO nodix_rem_memory_facets(memory_id, facet, text, updated_at_ms)
		VALUES (?, 'history', ?, ?)`,
	);
	const insertChunk = fixture.runtime.raw.prepare(
		`INSERT INTO nodix_memory_chunks(
			chunk_id, memory_id, chunk_index, chunk_text, dense_payload, start_offset,
			end_offset, token_count, content_type, chunking_version, embedder_provider,
			embedder_model, embedder_dim, created_at, updated_at, facet
		) VALUES (?, ?, ?, ?, ?, 0, ?, 3, 'prose', 'test', 'test', 'test', 1024, ?, ?, ?)`,
	);
	const eventIds: string[] = [];
	fixture.runtime.raw.transaction(() => {
		for (let index = 0; index < count; index += 1) {
			const id = `aggregation-event-${index.toString().padStart(4, "0")}`;
			const timestamp = Date.parse("2026-08-01T00:00:00.000Z");
			const filler = " bounded evidence".repeat(fillerRepeats);
			const currentText = `aggregationproof current event ${index}${filler}`;
			const historyText = `aggregationproof history event ${index}${filler}`;
			insertMemory.run(id, currentText, scope, timestamp, id, id);
			insertHistoryFacet.run(id, historyText, timestamp - 1);
			insertChunk.run(
				`${id}:current`,
				id,
				0,
				currentText,
				currentText,
				currentText.length,
				timestamp,
				timestamp,
				"current",
			);
			insertChunk.run(
				`${id}:history`,
				id,
				1,
				historyText,
				historyText,
				historyText.length,
				timestamp - 1,
				timestamp - 1,
				"history",
			);
			eventIds.push(id);
		}
	})();
	return eventIds;
}

function consumerTokens(result: ClawToolResult): number {
	return Math.max(
		countTokens(result.content.map((part) => part.text ?? "").join("\n")),
		countTokens(JSON.stringify(result.details?.["memories"] ?? [])),
	);
}

function restoreEnvironment(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
