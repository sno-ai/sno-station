/** Real encrypted SQLite + real ONNX embedder. No mocks. */

import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import {
	buildInsightMetadata,
	parseInsightMetadata,
	stringifyInsightMetadata,
} from "../../../../packages/memory/src/engine/extraction/memory-metadata-codec";
import { StorageError } from "../../../../packages/memory/src/engine/shared/errors";
import {
	MEMORY_CATEGORIES,
	type MemoryCategory,
	type MemoryEntry,
	type MemoryMetadata,
} from "../../../../packages/memory/src/engine/shared/types";
import type { StoreInput } from "../../../../packages/memory/src/store/memory-store-base";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

const BASE_TS = Date.parse("2026-07-24T12:00:00.000Z");
const PROJECT_ID = "write-authority-real-sqlite";

type Boundary = "offline" | "system" | "trusted" | "tool";
type WriteOperation = "store" | "supersede" | "bulkStore" | "importEntry";

const EXPECTED: Record<Boundary, readonly MemoryCategory[]> = {
	offline: ["episodic", "lesson", "profile", "persona", "summary"],
	system: [],
	trusted: ["episodic", "profile"],
	tool: ["episodic"],
};

let embedder: Embedder;
let store: MemoryStore;
let cleanup: () => void;
let counter = 0;

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

function authority(
	boundary: Boundary,
): Pick<StoreInput, "offlineFamily" | "system" | "trusted"> {
	if (boundary === "offline") return { offlineFamily: true };
	if (boundary === "system") return { system: true };
	if (boundary === "trusted") return { trusted: true };
	return {};
}

function metadataFor(category: MemoryCategory, text: string, extra = {}): string {
	const categoryFields: Partial<MemoryMetadata> =
		category === "profile"
			? { section_name: "preferences.reading", tier: "core" }
			: category === "persona"
				? { section_name: "communication_style" }
				: category === "lesson"
					? { anti_pattern_signature: `authority-${++counter}` }
					: category === "summary"
						? { children_ids: ["source-a", "source-b"], depth: 1 }
						: {};
	return stringifyInsightMetadata(
		buildInsightMetadata(
			{ text, category, timestamp: BASE_TS },
			{ ...categoryFields, ...extra },
		),
	);
}

function inputFor(category: MemoryCategory, boundary: Boundary, label: string): StoreInput {
	const text = `${label} ${category} ${boundary} ${randomUUID()}`;
	return {
		text,
		category,
		projectId: PROJECT_ID,
		timestamp: BASE_TS + counter,
		metadata: metadataFor(category, text),
		...authority(boundary),
	};
}

async function seedClosable(category: MemoryCategory): Promise<MemoryEntry> {
	const boundary: Boundary =
		category === "summary" || category === "persona" || category === "lesson"
			? "offline"
			: category === "profile"
				? "trusted"
				: "tool";
	return store.store(inputFor(category, boundary, "supersede seed"));
}

async function invoke(
	operation: WriteOperation,
	category: MemoryCategory,
	boundary: Boundary,
): Promise<MemoryEntry[]> {
	const input = inputFor(category, boundary, operation);
	if (operation === "store") return [await store.store(input)];
	if (operation === "bulkStore") return await store.bulkStore([input]);
	if (operation === "importEntry") {
		const metadata = input.metadata;
		if (!metadata) throw new Error("authority fixture metadata missing");
		return [
			await store.importEntry({
				id: randomUUID(),
				text: input.text,
				category,
				projectId: PROJECT_ID,
				importance: 0.7,
				timestamp: input.timestamp ?? BASE_TS,
				metadata,
				contentHash: "recomputed-by-import",
				lane: "active",
				...authority(boundary),
			}),
		];
	}

	const prior = await seedClosable(category);
	return [
		await store.supersede({
			create: input,
			closes: [
				{
					id: prior.id,
					buildMetadata: (createdId) =>
						metadataFor(category, prior.text, {
							...parseInsightMetadata(prior.metadata, prior),
							invalidated_at: BASE_TS + 10_000,
							superseded_by: createdId,
						}),
				},
			],
		}),
	];
}

describe("memory write authority boundary", () => {
	for (const operation of [
		"store",
		"supersede",
		"bulkStore",
		"importEntry",
	] as const) {
		for (const boundary of ["offline", "system", "trusted", "tool"] as const) {
			for (const category of MEMORY_CATEGORIES) {
				const allowed = EXPECTED[boundary].includes(category);
				it(`${operation} ${boundary} boundary ${allowed ? "allows" : "rejects"} ${category}`, async () => {
					const result = invoke(operation, category, boundary);
					if (!allowed) {
						await expect(result).rejects.toThrow(StorageError);
						return;
					}
					await expect(result).resolves.toEqual([
						expect.objectContaining({ category, projectId: PROJECT_ID }),
					]);
				});
			}
		}
	}

	it("names the required boundary for restricted tool writes", async () => {
		await expect(store.store(inputFor("summary", "tool", "summary denied"))).rejects.toThrow(
			/requires an offline-family store boundary/,
		);
		await expect(store.store(inputFor("profile", "tool", "profile denied"))).rejects.toThrow(
			/requires a trusted store boundary/,
		);
		await expect(store.store(inputFor("persona", "trusted", "persona denied"))).rejects.toThrow(
			/requires an offline-family store boundary/,
		);
	});

	it.each([
		["profile", "confirmed", "core", "trusted"],
		["episodic", "confirmed", "working", "tool"],
		["episodic", "confirmed", "peripheral", "tool"],
	] as const)(
		"stores the legal live tuple %s/%s/%s",
		async (category, state, tier, boundary) => {
			const input = inputFor(category, boundary, "legal tuple");
			input.metadata = metadataFor(category, input.text, { state, tier });
			await expect(store.store(input)).resolves.toMatchObject({ category });
		},
	);

	it.each([
		["profile", "confirmed", "working", "trusted"],
		["profile", "confirmed", "peripheral", "trusted"],
		["profile", "archived", "core", "trusted"],
		["episodic", "confirmed", "core", "tool"],
		["episodic", "archived", "working", "tool"],
		["episodic", "pending", "working", "tool"],
		["lesson", "confirmed", "working", "tool"],
	] as const)(
		"rejects the forbidden live tuple %s/%s/%s",
		async (category, state, tier, boundary) => {
			const input = inputFor(category, boundary, "forbidden tuple");
			input.metadata = metadataFor(category, input.text, { state, tier });
			await expect(store.store(input)).rejects.toThrow(StorageError);
		},
	);

	it("rejects non-offline lifecycle and tier mutations", async () => {
		const row = await store.store(inputFor("episodic", "tool", "mutation seed"));

		await expect(store.updateTier(row.id, "core")).rejects.toThrow(
			/offline-family authority/,
		);
		await expect(store.updateMetadata(row.id, { state: "archived" })).rejects.toThrow(
			/offline-family authority/,
		);
		await expect(
			store.applyMetadataDelta(row.id, () => ({ tier: "peripheral" })),
		).rejects.toThrow(/offline-family authority/);
		await expect(
			store.update(row.id, {
				category: "lesson",
				metadata: metadataFor("lesson", row.text),
			}),
		).rejects.toThrow(/offline-family authority/);
	});

	it("enforces category writer authority on every generic metadata mutation surface", async () => {
		const rows = new Map<MemoryCategory, MemoryEntry>();
		for (const category of MEMORY_CATEGORIES) {
			rows.set(category, await seedClosable(category));
		}
		const operations = [
			{
				name: "update",
				invoke: async (id: string) => {
					const row = store.getById(id);
					if (!row) throw new Error(`missing ${id} update authority fixture`);
					const metadata = JSON.parse(row.metadata) as MemoryMetadata;
					await store.update(id, {
						metadata: JSON.stringify({ ...metadata, bad_recall_count: 2 }),
					});
				},
			},
			{
				name: "updateMetadata",
				invoke: (id: string) => store.updateMetadata(id, { bad_recall_count: 1 }),
			},
			{
				name: "applyMetadataDelta",
				invoke: (id: string) =>
					store.applyMetadataDelta(id, () => ({ last_accessed_at: BASE_TS + 20_000 })),
			},
			{
				name: "applyMetadataDeltas",
				invoke: (id: string) =>
					store.applyMetadataDeltas([
						{
							memoryId: id,
							deltaFn: () => ({ suppressed_until_ms: BASE_TS + 30_000 }),
						},
					]),
			},
		] as const;

		for (const operation of operations) {
			for (const category of MEMORY_CATEGORIES) {
				const row = rows.get(category);
				if (!row) throw new Error(`missing ${category} metadata authority fixture`);
				const before = store.getById(row.id)?.metadata;
				const result = operation.invoke(row.id);
				if (category === "episodic") {
					await expect(result, `${operation.name} should allow episodic`).resolves.toBeUndefined();
					expect(store.getById(row.id)?.metadata).not.toBe(before);
					continue;
				}
				await expect(
					result,
					`${operation.name} should reject ${category}`,
				).rejects.toThrow(StorageError);
				expect(store.getById(row.id)?.metadata).toBe(before);
			}
		}

		const profile = rows.get("profile");
		if (!profile) throw new Error("missing profile metadata authority fixture");
		const profileMetadata = JSON.parse(profile.metadata) as MemoryMetadata;
		await expect(
			store.update(profile.id, {
				writerAuthority: "profile-writer",
				metadata: JSON.stringify({ ...profileMetadata, bad_recall_count: 3 }),
			}),
		).resolves.toMatchObject({ id: profile.id });
		expect(JSON.parse(store.getById(profile.id)?.metadata ?? "{}")).toMatchObject({
			bad_recall_count: 3,
		});

		const summary = rows.get("summary");
		if (!summary) throw new Error("missing summary metadata authority fixture");
		const summaryMetadata = JSON.parse(summary.metadata) as MemoryMetadata;
		await expect(
			store.update(summary.id, {
				writerAuthority: "offline-family",
				metadata: JSON.stringify({ ...summaryMetadata, bad_recall_count: 4 }),
			}),
		).resolves.toMatchObject({ id: summary.id });
		expect(JSON.parse(store.getById(summary.id)?.metadata ?? "{}")).toMatchObject({
			bad_recall_count: 4,
		});
	});

	it("requires offline-family authority before resolving reflection metadata", async () => {
		const input = inputFor("lesson", "offline", "reflection resolution authority");
		input.metadata = metadataFor("lesson", input.text, {
			type: "memory-reflection-item",
			itemKind: "invariant",
		});
		const row = await store.store(input);
		const before = store.getById(row.id)?.metadata;

		await expect(
			store.resolveReflectionItem(row.id, { resolvedAt: BASE_TS + 40_000 }),
		).rejects.toThrow(/offline-family authority/);
		expect(store.getById(row.id)?.metadata).toBe(before);

		await expect(
			store.resolveReflectionItem(row.id, {
				writerAuthority: "offline-family",
				resolvedAt: BASE_TS + 40_000,
			}),
		).resolves.toBe("resolved");
		expect(JSON.parse(store.getById(row.id)?.metadata ?? "{}")).toMatchObject({
			resolvedAt: BASE_TS + 40_000,
		});
	});

	it("rejects non-string and unknown categories before authority evaluation", async () => {
		const base = inputFor("episodic", "system", "invalid category");
		await expect(store.store({ ...base, category: 42 as never })).rejects.toThrow(
			/memory category must be a string/,
		);
		await expect(store.store({ ...base, category: "event" as never })).rejects.toThrow(
			/memory category must be one of/,
		);
	});

	it("rejects row/category metadata disagreement", async () => {
		const text = "Profile row with episodic metadata must fail";
		await expect(
			store.store({
				text,
				category: "profile",
				projectId: PROJECT_ID,
				trusted: true,
				metadata: metadataFor("episodic", text),
			}),
		).rejects.toThrow(/row\/category\/kind mismatch/);
	});

	it("rejects empty and whitespace-only text", async () => {
		for (const text of ["", " \t\n "]) {
			await expect(
				store.store({
					text,
					category: "episodic",
					projectId: PROJECT_ID,
					metadata: metadataFor("episodic", "non-empty metadata source"),
				}),
			).rejects.toThrow(/empty text/);
		}
	});
});
