/** Real encrypted SQLite + real ONNX embedder. No mocks. */

import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client";
import {
	buildInsightMetadata,
	parseInsightMetadata,
	stringifyInsightMetadata,
} from "../../../../packages/sno-station-mem/src/engine/extraction/memory-metadata-codec";
import type { MemoryCategory, MemoryEntry } from "../../../../packages/sno-station-mem/src/engine/shared/types";
import type { StoreInput } from "../../../../packages/sno-station-mem/src/store/memory-store-base";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

const BASE_TS = Date.parse("2026-07-24T12:00:00.000Z");
const PROJECT_ID = "profile-section-write-boundary";

let embedder: Embedder;
let store: MemoryStore;
let cleanup: () => void;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

beforeEach(() => {
	const testDb = createTestDb();
	cleanup = testDb.cleanup;
	store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
});

afterEach(async () => {
	await store.close();
	cleanup();
});

function inputFor(
	category: MemoryCategory,
	sectionName: string,
	label: string,
): StoreInput {
	const text = `${label} ${randomUUID()}`;
	const categoryMetadata =
		category === "lesson"
			? { anti_pattern_signature: `profile-boundary-${randomUUID()}` }
			: category === "summary"
				? { children_ids: ["source-a", "source-b"], depth: 1 }
				: {};
	return {
		text,
		category,
		projectId: PROJECT_ID,
		timestamp: BASE_TS,
		metadata: stringifyInsightMetadata(
			buildInsightMetadata(
				{ text, category, timestamp: BASE_TS },
				{ ...categoryMetadata, section_name: sectionName },
			),
		),
		...(category === "summary"
			? { system: true }
			: category === "profile" || category === "persona"
				? { trusted: true }
				: {}),
	};
}

function sectionName(row: MemoryEntry | null | undefined): string | undefined {
	if (!row) return undefined;
	const value = parseInsightMetadata(row.metadata, row).section_name;
	return typeof value === "string" ? value : undefined;
}

describe("profile section canonicalization at the write boundary", () => {
	it("normalizes and accepts a non-canonical profile key", async () => {
		const row = await store.store(inputFor("profile", " Interests.Reading -  Taste ", "store"));
		expect(sectionName(row)).toBe("preferences.reading_taste");
	});

	it.each(["persona", "episodic", "lesson", "summary"] as const)(
		"leaves %s section_name byte-for-byte unchanged",
		async (category) => {
			const original = "Mixed__Section-Name";
			const input = inputFor(category, original, category);
			const row = await store.store(input);
			expect(sectionName(row)).toBe(original);
		},
	);

	it("canonicalizes profile keys through store, bulkStore, importEntry, supersede, and update", async () => {
		const direct = await store.store(inputFor("profile", "goals.fitness", "store"));
		const [bulk] = await store.bulkStore([
			inputFor("profile", "INTERESTS.Movie-Genres", "bulk"),
		]);
		const importInput = inputFor("profile", "work.productivity", "import");
		const imported = await store.importEntry({
			id: randomUUID(),
			text: importInput.text,
			category: "profile",
			projectId: PROJECT_ID,
			importance: 0.7,
			timestamp: BASE_TS,
			metadata: importInput.metadata ?? "{}",
			contentHash: "recomputed-by-import",
			lane: "active",
			trusted: true,
		});
		const prior = await store.store(inputFor("profile", "preferences.travel", "prior"));
		const superseded = await store.supersede({
			create: inputFor("profile", "goals.travel", "supersede"),
			closes: [
				{
					id: prior.id,
					buildMetadata: (createdId) =>
						stringifyInsightMetadata({
							...parseInsightMetadata(prior.metadata, prior),
							invalidated_at: BASE_TS + 1,
							superseded_by: createdId,
						}),
				},
			],
		});
		const updatedMetadata = stringifyInsightMetadata({
			...parseInsightMetadata(direct.metadata, direct),
			section_name: " interests.reading ",
		});
		const updated = await store.update(direct.id, { metadata: updatedMetadata });

		expect(sectionName(direct)).toBe("preferences.fitness");
		expect(sectionName(bulk)).toBe("preferences.movie_genres");
		expect(sectionName(imported)).toBe("preferences.productivity");
		expect(sectionName(superseded)).toBe("preferences.travel");
		expect(sectionName(updated)).toBe("preferences.reading");
	});
});
