/** Real ONNX embedder + real encrypted SQLite. No mocks. Missing deps = FAIL. */

import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import {
	buildInsightMetadata,
	parseInsightMetadata,
	stringifyInsightMetadata,
} from "../../../../packages/memory/src/engine/extraction/memory-metadata-codec.ts";
import type { InsightMetadataPatch } from "../../../../packages/memory/src/engine/extraction/memory-metadata-types.ts";
import { StorageError } from "../../../../packages/memory/src/engine/shared/errors.ts";
import {
	MEMORY_CATEGORIES,
	type MemoryCategory,
	type MemoryEntry,
} from "../../../../packages/memory/src/engine/shared/types.ts";
import type { StoreInput } from "../../../../packages/memory/src/store/memory-store-base.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

const SCOPE = "memory-kinds-group-5";
const BASE_TS = Date.UTC(2026, 4, 20, 12, 0, 0);

let testEmbedder: Embedder;

type SqliteForAssert = {
	prepare(sql: string): {
		all(...params: unknown[]): unknown[];
		get(...params: unknown[]): unknown;
	};
};

type MergeIds = {
	rawSourceId: string;
	mergedId: string;
};

type MergeStore = MemoryStore & {
	getByFactKey(scope: string, factKey: string): MemoryEntry | undefined;
	createMergeWithRawLineage(args: {
		rawSource: StoreInput;
		merged: StoreInput | ((ids: MergeIds) => StoreInput);
		closeExisting: Array<{ id: string; buildMetadata: (ids: MergeIds) => string }>;
		buildRawSourceMetadata: (ids: MergeIds) => string;
	}): Promise<{ rawSource: MemoryEntry; merged: MemoryEntry }>;
};

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

function sqliteFromStore(store: MemoryStore): SqliteForAssert {
	return (store as unknown as { sqlite: SqliteForAssert }).sqlite;
}

function metadataFor(
	category: MemoryCategory,
	text: string,
	patch: InsightMetadataPatch = {},
): string {
	const variantPatch =
		category === "profile"
			? { section_name: "identity" }
			: category === "persona"
				? { section_name: "behavior_rules" }
				: category === "lesson"
					? { anti_pattern_signature: "retry-after-path-check" }
					: category === "summary"
						? { children_ids: ["raw-a", "raw-b"], depth: 1 }
						: {};
	return stringifyInsightMetadata(
		buildInsightMetadata(
			{ text, category, timestamp: BASE_TS },
			{
				kind: category,
				memory_category: category,
				asserted_at: BASE_TS,
				source: "manual",
				...variantPatch,
				...patch,
			},
		),
	);
}

function inputFor(category: MemoryCategory, suffix: string): StoreInput {
	const text = `Group 5 ${category} memory ${suffix} ${randomUUID()}`;
	return {
		text,
		category,
		projectId: SCOPE,
		importance: 0.7,
		timestamp: BASE_TS,
		metadata: metadataFor(category, text),
		trusted: category === "profile" || category === "persona",
		system: category === "summary",
	};
}

async function storeFiveKinds(store: MemoryStore): Promise<MemoryEntry[]> {
	const rows: MemoryEntry[] = [];
	for (const category of MEMORY_CATEGORIES) {
		rows.push(await store.store(inputFor(category, "insert")));
	}
	return rows;
}

describe("memory-kinds storage validation and primitives", () => {
	let store: MemoryStore;
	let cleanup: () => void;

	beforeEach(() => {
		const testDb = createTestDb();
		cleanup = testDb.cleanup;
		store = new MemoryStore({ dbPath: testDb.dbPath, embedder: testEmbedder });
	});

	afterEach(async () => {
		await store.close();
		cleanup();
	});

	it("inserts all five foundation kinds and persists only foundation categories", async () => {
		const rows = await storeFiveKinds(store);
		expect(rows.map((row) => row.category).sort()).toEqual([...MEMORY_CATEGORIES].sort());

		for (const row of rows) {
			const metadata = parseInsightMetadata(row.metadata, row);
			expect(metadata.kind).toBe(row.category);
			expect(metadata.memory_category).toBe(row.category);
		}

		const grouped = sqliteFromStore(store)
			.prepare(
				"SELECT category AS memory_category, COUNT(*) AS count FROM nodix_memories WHERE project_id = ? GROUP BY category ORDER BY category",
			)
			.all(SCOPE) as Array<{ memory_category: string; count: number }>;
		expect(grouped.map((row) => row.memory_category).sort()).toEqual(
			[...MEMORY_CATEGORIES].sort(),
		);
		expect(grouped.every((row) => row.count === 1)).toBe(true);
	});

	it("rejects old categories at the direct write chokepoint", async () => {
		for (const oldCategory of ["identity", "preference", "entity", "event"]) {
			await expect(
				store.store({
					text: `old category ${oldCategory}`,
					category: oldCategory as never,
					projectId: SCOPE,
					metadata: JSON.stringify({
						kind: oldCategory,
						memory_category: oldCategory,
					}),
				}),
			).rejects.toThrow(StorageError);
		}

		const count = sqliteFromStore(store)
			.prepare("SELECT COUNT(*) AS count FROM nodix_memories WHERE project_id = ?")
			.get(SCOPE) as { count: number };
		expect(count.count).toBe(0);
	});

	it("rejects metadata category mismatches before persisting rows", async () => {
		const episodicMetadata = metadataFor("episodic", "mismatched profile row");

		await expect(
			store.store({
				text: "mismatched profile row",
				category: "profile",
				projectId: SCOPE,
				metadata: episodicMetadata,
			}),
		).rejects.toThrow(StorageError);

		const count = sqliteFromStore(store)
			.prepare("SELECT COUNT(*) AS count FROM nodix_memories WHERE project_id = ?")
			.get(SCOPE) as { count: number };
		expect(count.count).toBe(0);
	});

	it("looks up active rows by derived fact_key", async () => {
		const profileText = "The user's legal name is L. H.";
		const profile = await store.store({
			text: profileText,
			category: "profile",
			projectId: SCOPE,
			metadata: metadataFor("profile", profileText, { section_name: "identity" }),
			trusted: true,
		});
		const typedStore = store as MergeStore;

		expect(typedStore.getByFactKey(SCOPE, "profile:identity")).toMatchObject({
			id: profile.id,
			category: "profile",
		});
		expect(typedStore.getByFactKey(SCOPE, "profile:preferences.general")).toBeUndefined();
	});

	it("creates raw source, merged row, and closes both source rows atomically", async () => {
		const typedStore = store as MergeStore;
		const originalText = "Lesson: check the working directory before fixing missing files.";
		const original = await store.store({
			text: originalText,
			category: "lesson",
			projectId: SCOPE,
			metadata: metadataFor("lesson", originalText, {
				anti_pattern_signature: "missing-file-check-working-directory",
			}),
		});
		const rawText = "Raw candidate: the script failed because the command ran from the wrong directory.";
		const mergedText =
			"Lesson: when a missing-file script error appears, verify the working directory first.";

		const created = await typedStore.createMergeWithRawLineage({
			rawSource: {
				text: rawText,
				category: "lesson",
				projectId: SCOPE,
				metadata: metadataFor("lesson", rawText, {
					anti_pattern_signature: "missing-file-check-working-directory",
				}),
			},
			merged: ({ rawSourceId }) => ({
				text: mergedText,
				category: "lesson",
				projectId: SCOPE,
				metadata: metadataFor("lesson", mergedText, {
					anti_pattern_signature: "missing-file-check-working-directory",
					supersedes: original.id,
					merge_lineage: [original.id, rawSourceId],
				}),
			}),
			closeExisting: [
				{
					id: original.id,
					buildMetadata: ({ mergedId }) =>
						metadataFor("lesson", originalText, {
							anti_pattern_signature: "missing-file-check-working-directory",
							invalidated_at: BASE_TS + 1,
							superseded_by: mergedId,
						}),
				},
			],
			buildRawSourceMetadata: ({ mergedId }) =>
				metadataFor("lesson", rawText, {
					anti_pattern_signature: "missing-file-check-working-directory",
					invalidated_at: BASE_TS + 1,
					superseded_by: mergedId,
				}),
		});

		const originalMeta = parseInsightMetadata(store.getById(original.id)?.metadata, original);
		const rawMeta = parseInsightMetadata(created.rawSource.metadata, created.rawSource);
		const mergedMeta = parseInsightMetadata(created.merged.metadata, created.merged);

		expect(originalMeta.superseded_by).toBe(created.merged.id);
		expect(rawMeta.superseded_by).toBe(created.merged.id);
		expect(mergedMeta.merge_lineage).toEqual([original.id, created.rawSource.id]);
		expect(store.getById(created.rawSource.id)?.text).toBe(rawText);
		expect(store.getById(created.merged.id)?.text).toBe(mergedText);
	});

	it("rolls back raw-source creation when the merged insert fails", async () => {
		const typedStore = store as MergeStore;
		const originalText = "Lesson: inspect duplicate errors before changing deployment state.";
		const original = await store.store({
			text: originalText,
			category: "lesson",
			projectId: SCOPE,
			metadata: metadataFor("lesson", originalText, {
				anti_pattern_signature: "duplicate-error-before-state-change",
			}),
		});
		const duplicateMergedText = "Lesson: duplicate merged text already exists.";
		await store.store({
			text: duplicateMergedText,
			category: "lesson",
			projectId: SCOPE,
			metadata: metadataFor("lesson", duplicateMergedText, {
				anti_pattern_signature: "duplicate-merged-text",
			}),
		});
		const rawText = "Raw candidate that must not survive a failed merge transaction.";

		await expect(
			typedStore.createMergeWithRawLineage({
				rawSource: {
					text: rawText,
					category: "lesson",
					projectId: SCOPE,
					metadata: metadataFor("lesson", rawText, {
						anti_pattern_signature: "duplicate-error-before-state-change",
					}),
				},
				merged: {
					text: duplicateMergedText,
					category: "lesson",
					projectId: SCOPE,
					metadata: metadataFor("lesson", duplicateMergedText, {
						anti_pattern_signature: "duplicate-merged-text",
					}),
				},
				closeExisting: [
					{
						id: original.id,
						buildMetadata: ({ mergedId }) =>
							metadataFor("lesson", originalText, {
								anti_pattern_signature: "duplicate-error-before-state-change",
								invalidated_at: BASE_TS + 1,
								superseded_by: mergedId,
							}),
					},
				],
				buildRawSourceMetadata: ({ mergedId }) =>
					metadataFor("lesson", rawText, {
						anti_pattern_signature: "duplicate-error-before-state-change",
						invalidated_at: BASE_TS + 1,
						superseded_by: mergedId,
					}),
			}),
		).rejects.toThrow();

		const rows = sqliteFromStore(store)
			.prepare("SELECT id, text FROM nodix_memories WHERE project_id = ? ORDER BY timestamp, id")
			.all(SCOPE) as Array<{ id: string; text: string }>;
		expect(rows.map((row) => row.text)).not.toContain(rawText);
		expect(rows).toHaveLength(2);

		const originalAfter = store.getById(original.id);
		if (!originalAfter) throw new Error("expected original row to remain");
		const originalMeta = parseInsightMetadata(originalAfter.metadata, originalAfter);
		expect(originalMeta.invalidated_at).toBeUndefined();
		expect(originalMeta.superseded_by).toBeUndefined();
	});
});
