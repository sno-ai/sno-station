import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	buildInsightMetadata,
	stringifyInsightMetadata,
} from "@/extraction/memory-metadata-codec";
import type { Embedder } from "@/extraction/embedding-provider-client";
import { StorageError } from "@/shared/errors";
import type { MemoryCategory, MemoryEntry } from "@/shared/types";
import { MemoryStore } from "@/storage/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db.ts";

const NOW = Date.parse("2026-07-24T19:00:00.000Z");

let embedder: Embedder;
let testDb: TestDb | undefined;
let store: MemoryStore | undefined;
let scopeCounter = 0;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

afterEach(() => {
	store?.closeSync();
	testDb?.cleanup();
	store = undefined;
	testDb = undefined;
});

function metadataFor(category: MemoryCategory, text: string): string {
	return stringifyInsightMetadata(
		buildInsightMetadata(
			{ text, category, timestamp: NOW },
			{
				...(category === "profile" || category === "persona"
					? { section_name: "preferences.update_authority" }
					: {}),
				...(category === "lesson"
					? { anti_pattern_signature: "update-authority" }
					: {}),
				...(category === "summary" ? { children_ids: ["authority-source"], depth: 1 } : {}),
			},
		),
	);
}

async function buildStore(): Promise<{ store: MemoryStore; scope: string }> {
	testDb = createTestDb();
	store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
	return { store, scope: `update-category-authority-${++scopeCounter}` };
}

async function seed(
	input: {
		store: MemoryStore;
		scope: string;
	},
	category: MemoryCategory,
): Promise<MemoryEntry> {
	const text = `Stored ${category} memory for category update authority.`;
	return input.store.store({
		text,
		category,
		projectId: input.scope,
		timestamp: NOW,
		metadata: metadataFor(category, text),
		// Seed at the boundary each category actually admits: episodic through the tool
		// lane, profile through the trusted profile writer, and every offline-owned
		// category through the offline family (25-extraction-simplification-prd.md §5).
		...(category === "episodic"
			? {}
			: category === "profile"
				? { trusted: true }
				: { offlineFamily: true }),
	});
}

describe("MemoryStore category-changing update authority", () => {
	it("allows a tool-writable episodic to episodic transition", async () => {
		const fixture = await buildStore();
		const row = await seed(fixture, "episodic");

		const updated = await fixture.store.update(row.id, {
			category: "episodic",
			metadata: metadataFor("episodic", row.text),
		});

		expect(updated?.category).toBe("episodic");
	});

	// Lesson left the tool lane when live extraction was cut back to episodic and profile,
	// so these transitions still work — but only for the writer that owns the category.
	it.each([
		["episodic", "lesson"],
		["lesson", "episodic"],
	] as const)(
		"allows an offline-family %s to %s transition",
		async (storedCategory, requestedCategory) => {
			const fixture = await buildStore();
			const row = await seed(fixture, storedCategory);

			const updated = await fixture.store.update(row.id, {
				category: requestedCategory,
				metadata: metadataFor(requestedCategory, row.text),
				writerAuthority: "offline-family",
			});

			expect(updated?.category).toBe(requestedCategory);
		},
	);

	it.each(["profile", "persona", "lesson", "summary"] as const)(
		"rejects an episodic row changing to restricted category %s",
		async (requestedCategory) => {
			const fixture = await buildStore();
			const row = await seed(fixture, "episodic");

			await expect(
				fixture.store.update(row.id, {
					category: requestedCategory,
					metadata: metadataFor(requestedCategory, row.text),
				}),
			).rejects.toThrow(StorageError);
			expect(fixture.store.getById(row.id)?.category).toBe("episodic");
		},
	);

	it.each(["profile", "persona", "lesson", "summary"] as const)(
		"rejects a category-changing update from restricted stored category %s",
		async (storedCategory) => {
			const fixture = await buildStore();
			const row = await seed(fixture, storedCategory);

			await expect(
				fixture.store.update(row.id, {
					category: "episodic",
					metadata: metadataFor("episodic", row.text),
				}),
			).rejects.toThrow(StorageError);
			expect(fixture.store.getById(row.id)?.category).toBe(storedCategory);
		},
	);

	it("leaves profile metadata-only and content-only update behavior unchanged", async () => {
		const fixture = await buildStore();
		const row = await seed(fixture, "profile");
		const metadataOnly = await fixture.store.update(row.id, {
			metadata: row.metadata,
			writerAuthority: "profile-writer",
		});
		const contentOnly = await fixture.store.update(row.id, {
			text: "Updated profile content without a category transition.",
			writerAuthority: "profile-writer",
		});

		expect(metadataOnly?.category).toBe("profile");
		expect(contentOnly).toMatchObject({
			category: "profile",
			text: "Updated profile content without a category transition.",
		});
	});
});
