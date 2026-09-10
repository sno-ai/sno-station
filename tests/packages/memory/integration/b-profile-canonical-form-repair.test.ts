import { dirname } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createSectionDictionaryCache,
	loadSectionDictionary,
} from "@/extraction/b-profile-section-dictionary-provider";
import { B_PROFILE_SECTION_REGISTRY } from "@/extraction/b-profile-section-registry";
import {
	B_PROFILE_CANONICAL_FORM_REPAIR_VERSION,
	runBProfileSectionRekey,
} from "@/extraction/b-profile-section-rekey";
import { buildIndexedText } from "@/extraction/extraction-text-sanitizer";
import { runProfileSectionUpdate } from "@/extraction/profile-section-writer";
import {
	buildInsightMetadata,
	deriveFactKey,
	parseInsightMetadata,
	stringifyInsightMetadata,
} from "@/extraction/memory-metadata-codec";
import type { Embedder } from "@/extraction/embedding-provider-client";
import type { MemoryCategory, MemoryEntry } from "@/shared/types";
import { MemoryStore } from "@/storage/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db.ts";

const NOW = Date.parse("2026-07-24T18:00:00.000Z");
const FROZEN_PROFILE_SPLIT_REFERENCE = {
	laneActiveRows: 563,
	distinctSectionNames: 170,
} as const;

interface Fixture {
	store: MemoryStore;
	testDb: TestDb;
	cache: ReturnType<typeof createSectionDictionaryCache>;
	scope: string;
}

let embedder: Embedder;
let fixture: Fixture | undefined;
let scopeCounter = 0;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

afterEach(() => {
	fixture?.store.closeSync();
	fixture?.testDb.cleanup();
	fixture = undefined;
});

async function buildFixture(): Promise<Fixture> {
	const testDb = createTestDb();
	const store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
	const cache = createSectionDictionaryCache(dirname(testDb.dbPath));
	await loadSectionDictionary({
		mode: "local-first",
		pluginVersion: "0.9.75",
		fetchFn: async () => B_PROFILE_SECTION_REGISTRY,
		cache,
	});
	await cache.write({
		activeRegistry: B_PROFILE_SECTION_REGISTRY,
		appliedSchemaVersion: B_PROFILE_SECTION_REGISTRY.schema_version,
	});
	return {
		store,
		testDb,
		cache,
		scope: `canonical-form-repair-${++scopeCounter}`,
	};
}

async function seedLegacyRow(args: {
	fixture: Fixture;
	sectionName: string;
	content: string;
	category?: MemoryCategory;
	projectId?: string;
	timestamp?: number;
	invalidatedAt?: number;
	idempotencyKey?: string;
	rawTopicPhrase?: string;
	storedText?: string;
}): Promise<MemoryEntry> {
	const category = args.category ?? "profile";
	const timestamp = args.timestamp ?? NOW;
	const rawMetadata = stringifyInsightMetadata(
		buildInsightMetadata(
			{ text: args.content, category, timestamp },
			{
				section_name: args.sectionName,
				...(args.invalidatedAt === undefined ? {} : { invalidated_at: args.invalidatedAt }),
				...(args.idempotencyKey === undefined
					? {}
					: { idempotency_key: args.idempotencyKey }),
				...(args.rawTopicPhrase === undefined
					? {}
					: { rawTopicPhrase: args.rawTopicPhrase }),
			},
		),
	);
	const stored = await args.fixture.store.store({
		text: args.storedText ?? args.content,
		category,
		projectId: args.projectId ?? args.fixture.scope,
		timestamp,
		metadata: rawMetadata,
		trusted: true,
		offlineFamily:
			category === "lesson" || category === "persona" || category === "summary",
	});
	args.fixture.testDb.sqlite
		.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?")
		.run(rawMetadata, stored.id);
	const legacy = args.fixture.store.getById(stored.id);
	if (!legacy) throw new Error(`seeded row '${stored.id}' disappeared`);
	return legacy;
}

async function activeProfileRows(input: Fixture): Promise<MemoryEntry[]> {
	const rows = await input.store.list({
		projectId: input.scope,
		category: "profile",
		limit: 100,
	});
	return rows.filter(
		(row) => parseInsightMetadata(row.metadata, row).invalidated_at === undefined,
	);
}

function snapshotRows(input: Fixture): Array<{ id: string; metadata: string }> {
	return input.testDb.sqlite
		.prepare(
			"SELECT id, metadata FROM nodix_memories WHERE project_id = ? ORDER BY timestamp, id",
		)
		.all(input.scope) as Array<{ id: string; metadata: string }>;
}

async function seedFrozenSplitReference(input: Fixture): Promise<string> {
	const separatorSections = Array.from({ length: 8 }, (_, index) => [
		`preferences.separator-${index}`,
		`preferences.separator_${index}`,
	]).flat();
	const domainSections = Array.from({ length: 10 }, (_, index) => [
		`interests.domain${index}`,
		`preferences.domain${index}`,
	]).flat();
	const openSections = [
		"preferences.general",
		"preferences.quantum_computing",
		...Array.from({ length: 130 }, (_, index) => `preferences.open_topic_${index}`),
	];
	const sections = [
		...separatorSections,
		...domainSections,
		"preferences.reading",
		"preferences.books",
		...openSections,
	];
	expect(sections).toHaveLength(FROZEN_PROFILE_SPLIT_REFERENCE.distinctSectionNames);

	const candidate = await seedLegacyRow({
		fixture: input,
		sectionName: "preferences.separator-0",
		content: "Frozen profile reference row 0.",
		timestamp: NOW + FROZEN_PROFILE_SPLIT_REFERENCE.laneActiveRows + 1,
	});
	const insert = input.testDb.sqlite.prepare(
		"INSERT INTO nodix_memories(id, fact_id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash) VALUES (?, ?, ?, 'profile', ?, 0.7, ?, 'UTC', ?, ?)",
	);
	input.testDb.sqlite.transaction(() => {
		for (let index = 1; index < FROZEN_PROFILE_SPLIT_REFERENCE.laneActiveRows; index += 1) {
			const sectionName = sections[index % sections.length];
			if (!sectionName) throw new Error(`frozen split reference section missing at ${index}`);
			const id = `frozen-profile-${index}`;
			const text = `Frozen profile reference row ${index}.`;
			const timestamp = NOW + index;
			const metadata = stringifyInsightMetadata(
				buildInsightMetadata(
					{ text, category: "profile", timestamp },
					{
						section_name: sectionName,
						...(index === 0 ? {} : { invalidated_at: timestamp + 1 }),
						...(sectionName === "preferences.reading"
							? { rawTopicPhrase: "reading taste" }
							: sectionName === "preferences.quantum_computing"
								? { rawTopicPhrase: "quantum basket weaving" }
								: {}),
					},
				),
			);
			insert.run(
				id,
				id,
				text,
				input.scope,
				timestamp,
				metadata,
				`frozen-profile-hash-${index}`,
			);
		}
	}).immediate();
	return candidate.id;
}

function seedPaginatedRepairCandidates(input: Fixture): string[] {
	const insert = input.testDb.sqlite.prepare(
		"INSERT INTO nodix_memories(id, fact_id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash) VALUES (?, ?, ?, 'profile', ?, 0.7, ?, 'UTC', ?, ?)",
	);
	const ids = Array.from(
		{ length: FROZEN_PROFILE_SPLIT_REFERENCE.laneActiveRows },
		(_, index) => `paged-profile-${index}`,
	);
	input.testDb.sqlite.transaction(() => {
		for (const [index, id] of ids.entries()) {
			const text = `Paginated profile row ${index}.`;
			const timestamp = NOW + index;
			const metadata = stringifyInsightMetadata(
				buildInsightMetadata(
					{ text, category: "profile", timestamp },
					{ section_name: `preferences.paged-topic-${index}` },
				),
			);
			insert.run(
				id,
				id,
				text,
				input.scope,
				timestamp,
				metadata,
				`paged-profile-hash-${index}`,
			);
		}
	}).immediate();
	return ids;
}

async function seedCollision(input: Fixture): Promise<[MemoryEntry, MemoryEntry]> {
	const first = await seedLegacyRow({
		fixture: input,
		sectionName: "preferences.reading-interests",
		content: "The user reads historical fiction.",
	});
	const second = await seedLegacyRow({
		fixture: input,
		sectionName: "preferences.reading_interests",
		content: "The user reads climate journalism.",
		timestamp: NOW + 1,
	});
	return [first, second];
}

async function seedExactCanonicalCollision(input: Fixture): Promise<[MemoryEntry, MemoryEntry]> {
	const target = await seedLegacyRow({
		fixture: input,
		sectionName: "preferences.work_planning",
		content:
			"The user plans work in written checklists. The user avoids ad hoc prioritization.",
	});
	const source = await seedLegacyRow({
		fixture: input,
		sectionName: "work.work-planning",
		content: "The user avoids ad hoc prioritization.",
		timestamp: NOW + 1,
	});
	return [target, source];
}

describe("B-profile canonical-form repair", () => {
	it("scans every active profile row, preserves non-profile rows, and writes its own marker", async () => {
		fixture = await buildFixture();
		const separatorRow = await seedLegacyRow({
			fixture,
			sectionName: "preferences.movie-genres",
			content: "The user enjoys quiet science fiction films.",
		});
		const domainRow = await seedLegacyRow({
			fixture,
			sectionName: "interests.reading",
			content: "The user reads historical fiction.",
			timestamp: NOW + 1,
		});
		const inactiveRow = await seedLegacyRow({
			fixture,
			sectionName: "work.old-topic",
			content: "The user used an obsolete planning ritual.",
			timestamp: NOW + 2,
			invalidatedAt: NOW + 3,
		});
		const personaRow = await seedLegacyRow({
			fixture,
			category: "persona",
			sectionName: "Interests.Reading-Style",
			content: "The user presents as a deliberate reader.",
			timestamp: NOW + 4,
		});
		const personaBefore = fixture.store.getById(personaRow.id);

		const result = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});

		expect(
			parseInsightMetadata(fixture.store.getById(separatorRow.id)?.metadata, separatorRow),
		).toMatchObject({
			section_name: "preferences.movie_genres",
			fact_key: deriveFactKey({
				kind: "profile",
				section_name: "preferences.movie_genres",
			}),
		});
		expect(parseInsightMetadata(fixture.store.getById(domainRow.id)?.metadata, domainRow)).toMatchObject({
			section_name: "preferences.reading",
			fact_key: deriveFactKey({ kind: "profile", section_name: "preferences.reading" }),
		});
		expect(fixture.store.getById(inactiveRow.id)?.metadata).toBe(inactiveRow.metadata);
		expect(fixture.store.getById(personaRow.id)).toEqual(personaBefore);
		expect(result.applied).toMatchObject({ sourceRows: 2, migrated: 2, merged: 0 });
		expect((await fixture.cache.read())?.canonicalFormRepairVersion).toBe(
			B_PROFILE_CANONICAL_FORM_REPAIR_VERSION,
		);
		expect((await fixture.cache.read())?.appliedSchemaVersion).toBe(
			B_PROFILE_SECTION_REGISTRY.schema_version,
		);
	});

	it("repairs a collision through one replacement while keeping both prior rows recoverable", async () => {
		fixture = await buildFixture();
		const [first, second] = await seedCollision(fixture);

		const result = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});

		const active = await activeProfileRows(fixture);
		expect(active).toHaveLength(1);
		const replacement = active[0];
		if (!replacement) throw new Error("repair replacement missing");
		expect(replacement.id).not.toBe(first.id);
		expect(replacement.id).not.toBe(second.id);
		expect(replacement.text).toContain("The user reads historical fiction.");
		expect(replacement.text).toContain("The user reads climate journalism.");
		expect(parseInsightMetadata(replacement.metadata, replacement).section_name).toBe(
			"preferences.reading_interests",
		);
		const replacementFactKey = deriveFactKey({
			kind: "profile",
			section_name: "preferences.reading_interests",
		});
		if (!replacementFactKey) throw new Error("replacement fact key missing");
		for (const prior of [first, second]) {
			const recovered = fixture.store.getById(prior.id);
			expect(recovered).toBeDefined();
			expect(parseInsightMetadata(recovered?.metadata, recovered)).toMatchObject({
				invalidated_at: expect.any(Number),
				superseded_by: replacement.id,
			});
		}
		expect(
			fixture.store.getByFactKey(
				fixture.scope,
				replacementFactKey,
			),
		).toEqual(replacement);
		expect(result.applied).toMatchObject({
			sourceRows: 2,
			targetKeys: 1,
			collisions: 1,
			migrated: 0,
			merged: 1,
			finalCount: 1,
		});
		for (const row of [first, second, replacement]) {
			expect(
				await fixture.store.update(row.id, {
					writerAuthority: "profile-writer",
					importance: 0.7,
				}),
			).toBeDefined();
		}
	});

	it("does not inherit an idempotency key when merging a canonical collision", async () => {
		fixture = await buildFixture();
		await seedLegacyRow({
			fixture,
			sectionName: "preferences.reading-interests",
			content: "The user reads historical fiction.",
			idempotencyKey: "a".repeat(64),
		});
		await seedLegacyRow({
			fixture,
			sectionName: "preferences.reading_interests",
			content: "The user reads climate journalism.",
			timestamp: NOW + 1,
		});

		await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});

		const active = await activeProfileRows(fixture);
		expect(active).toHaveLength(1);
		expect(parseInsightMetadata(active[0]?.metadata, active[0]).idempotency_key).toBeUndefined();
	});

	it("keeps collision sources active when the replacement hash belongs to an invalidated row", async () => {
		fixture = await buildFixture();
		const firstContent = "The user reads historical fiction.";
		const secondContent = "The user reads climate journalism.";
		const mergedContent = `${firstContent}\n${secondContent}`;
		await seedLegacyRow({
			fixture,
			sectionName: "preferences.archived_reading",
			content: mergedContent,
			storedText: buildIndexedText(firstContent, mergedContent),
			timestamp: NOW - 2,
			invalidatedAt: NOW - 1,
		});
		await seedCollision(fixture);
		const before = snapshotRows(fixture);

		await expect(
			runBProfileSectionRekey({
				store: fixture.store,
				cache: fixture.cache,
			}),
		).rejects.toThrow("Cannot supersede with an inactive content-hash match");

		expect(snapshotRows(fixture)).toEqual(before);
		expect(await activeProfileRows(fixture)).toHaveLength(2);
		expect((await fixture.cache.read())?.canonicalFormRepairVersion).toBeUndefined();
	});

	it("keeps collision sources active when the replacement hash belongs to another section", async () => {
		fixture = await buildFixture();
		const firstContent = "The user reads historical fiction.";
		const secondContent = "The user reads climate journalism.";
		const mergedContent = `${firstContent}\n${secondContent}`;
		await seedLegacyRow({
			fixture,
			sectionName: "preferences.archived_reading",
			content: mergedContent,
			storedText: buildIndexedText(firstContent, mergedContent),
			timestamp: NOW - 1,
		});
		await seedCollision(fixture);
		const before = snapshotRows(fixture);
		let thrown: unknown;

		try {
			await runBProfileSectionRekey({
				store: fixture.store,
				cache: fixture.cache,
			});
		} catch (error) {
			thrown = error;
		}

		expect(snapshotRows(fixture)).toEqual(before);
		expect(thrown).toMatchObject({
			message: "Cannot supersede with a content-hash match from another fact",
		});
		expect(await activeProfileRows(fixture)).toHaveLength(3);
		expect((await fixture.cache.read())?.canonicalFormRepairVersion).toBeUndefined();
	});

	it("preserves each general row until its raw topic phrase is re-keyed", async () => {
		fixture = await buildFixture();
		await fixture.cache.write({
			activeRegistry: B_PROFILE_SECTION_REGISTRY,
		});
		await seedLegacyRow({
			fixture,
			sectionName: "Preferences.General",
			content: "The user likes instrumental jazz.",
			rawTopicPhrase: "music",
		});
		await seedLegacyRow({
			fixture,
			sectionName: "preferences.general",
			content: "The user plans work with written checklists.",
			rawTopicPhrase: "work planning",
			timestamp: NOW + 1,
		});

		await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});

		const active = await activeProfileRows(fixture);
		expect(active).toHaveLength(2);
		const bySection = new Map(
			active.map((row) => [parseInsightMetadata(row.metadata, row).section_name, row]),
		);
		expect(bySection.get("preferences.music")?.text).toContain(
			"The user likes instrumental jazz.",
		);
		expect(bySection.get("preferences.music")?.text).not.toContain("written checklists");
		expect(bySection.get("preferences.work_planning")?.text).toContain(
			"The user plans work with written checklists.",
		);
		expect(bySection.get("preferences.work_planning")?.text).not.toContain("instrumental jazz");
		expect((await fixture.cache.read())?.appliedSchemaVersion).toBe(
			B_PROFILE_SECTION_REGISTRY.schema_version,
		);
		expect((await fixture.cache.read())?.canonicalFormRepairVersion).toBe(
			B_PROFILE_CANONICAL_FORM_REPAIR_VERSION,
		);
	});

	it("keeps general writable while a topic-bearing alias is repaired", async () => {
		fixture = await buildFixture();
		await seedLegacyRow({
			fixture,
			sectionName: "Preferences.General",
			content: "The user likes instrumental jazz.",
			rawTopicPhrase: "music",
		});
		await seedLegacyRow({
			fixture,
			sectionName: "preferences.general",
			content: "The user plans work with written checklists.",
			timestamp: NOW + 1,
		});
		const activeFixture = fixture;
		const originalUpdate = activeFixture.store.update.bind(activeFixture.store);
		let writeAttempted = false;
		let writeOutcome: Awaited<ReturnType<typeof runProfileSectionUpdate>> | undefined;
		vi.spyOn(activeFixture.store, "update").mockImplementation(async (id, changes) => {
			const updated = await originalUpdate(id, changes);
			if (!writeAttempted) {
				writeAttempted = true;
				writeOutcome = await runProfileSectionUpdate({
					scope: activeFixture.scope,
					sectionName: "preferences.general",
					newAssertion: "The user prefers dark roast coffee.",
					evidence: "The user prefers dark roast coffee.",
					source: { sessionKey: "general-write-during-repair" },
					store: activeFixture.store,
					at: Date.now() + 1,
				});
			}
			return updated;
		});

		await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});

		expect(writeAttempted).toBe(true);
		expect(writeOutcome).toMatchObject({ outcome: "merged" });
		const active = await activeProfileRows(fixture);
		expect(active).toHaveLength(2);
		expect(
			active.map((row) => parseInsightMetadata(row.metadata, row).section_name).sort(),
		).toEqual(["preferences.general", "preferences.music"]);
	});

	it("consolidates general residues before later profile writes", async () => {
		fixture = await buildFixture();
		await seedLegacyRow({
			fixture,
			sectionName: "interests.general",
			content: "The user likes instrumental jazz.",
		});
		await seedLegacyRow({
			fixture,
			sectionName: "preferences.general",
			content: "The user plans work with written checklists.",
			timestamp: NOW + 1,
		});

		await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});

		const repaired = await activeProfileRows(fixture);
		expect(repaired).toHaveLength(1);
		expect(repaired[0]?.text).toContain("The user likes instrumental jazz.");
		expect(repaired[0]?.text).toContain("The user plans work with written checklists.");

		await expect(
			runProfileSectionUpdate({
				scope: fixture.scope,
				sectionName: "preferences.general",
				newAssertion: "The user prefers dark roast coffee.",
				evidence: "The user prefers dark roast coffee.",
				source: { sessionKey: "general-residue-regression" },
				store: fixture.store,
				at: Date.now() + 1,
			}),
		).resolves.toMatchObject({ outcome: "merged" });
		expect(await activeProfileRows(fixture)).toHaveLength(1);
	});

	it("runs the registry re-key after canonicalizing a general row", async () => {
		fixture = await buildFixture();
		const source = await seedLegacyRow({
			fixture,
			sectionName: "Preferences.General",
			content: "The user likes instrumental jazz.",
			rawTopicPhrase: "music",
		});

		await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});

		expect(parseInsightMetadata(fixture.store.getById(source.id)?.metadata, source)).toMatchObject({
			section_name: "preferences.music",
			fact_key: deriveFactKey({ kind: "profile", section_name: "preferences.music" }),
		});
		expect((await fixture.cache.read())?.appliedSchemaVersion).toBe(
			B_PROFILE_SECTION_REGISTRY.schema_version,
		);
		expect((await fixture.cache.read())?.canonicalFormRepairVersion).toBe(
			B_PROFILE_CANONICAL_FORM_REPAIR_VERSION,
		);
	});

	it("does not inherit an idempotency key when a registry merge creates a replacement", async () => {
		fixture = await buildFixture();
		await fixture.cache.write({
			activeRegistry: B_PROFILE_SECTION_REGISTRY,
			canonicalFormRepairVersion: B_PROFILE_CANONICAL_FORM_REPAIR_VERSION,
		});
		await seedLegacyRow({
			fixture,
			sectionName: "preferences.work_planning",
			content: "The user plans work with written checklists.",
			idempotencyKey: "b".repeat(64),
		});
		await seedLegacyRow({
			fixture,
			sectionName: "preferences.general",
			content: "The user begins with a written planning ritual.",
			rawTopicPhrase: "work planning",
			timestamp: NOW + 1,
		});

		await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});

		const active = await activeProfileRows(fixture);
		expect(active).toHaveLength(1);
		expect(parseInsightMetadata(active[0]?.metadata, active[0]).idempotency_key).toBeUndefined();
	});

	it("preserves the active canonical target for an exact-content collision", async () => {
		fixture = await buildFixture();
		const [target, source] = await seedExactCanonicalCollision(fixture);
		const targetBefore = fixture.store.getById(target.id);

		const result = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});

		expect((await activeProfileRows(fixture)).map((row) => row.id)).toEqual([target.id]);
		expect(fixture.store.getById(target.id)).toEqual(targetBefore);
		const recoveredSource = fixture.store.getById(source.id);
		expect(recoveredSource).toBeDefined();
		expect(parseInsightMetadata(recoveredSource?.metadata, recoveredSource)).toMatchObject({
			section_name: "preferences.work_planning",
			invalidated_at: expect.any(Number),
			superseded_by: target.id,
		});
		const factKey = deriveFactKey({
			kind: "profile",
			section_name: "preferences.work_planning",
		});
		if (!factKey) throw new Error("exact-content target fact key missing");
		expect(fixture.store.getByFactKey(fixture.scope, factKey)?.id).toBe(target.id);
		expect(result.applied).toMatchObject({ collisions: 1, merged: 1, finalCount: 1 });
	});

	it("preserves a newer canonical target when exact clauses use a different order", async () => {
		fixture = await buildFixture();
		const source = await seedLegacyRow({
			fixture,
			sectionName: "work.work-planning",
			content: "The user avoids ad hoc prioritization.",
		});
		const target = await seedLegacyRow({
			fixture,
			sectionName: "preferences.work_planning",
			content:
				"The user plans work in written checklists. The user avoids ad hoc prioritization.",
			timestamp: NOW + 1,
		});
		const targetBefore = fixture.store.getById(target.id);

		const result = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});

		expect((await activeProfileRows(fixture)).map((row) => row.id)).toEqual([target.id]);
		expect(fixture.store.getById(target.id)).toEqual(targetBefore);
		const recoveredSource = fixture.store.getById(source.id);
		expect(parseInsightMetadata(recoveredSource?.metadata, recoveredSource)).toMatchObject({
			invalidated_at: expect.any(Number),
			superseded_by: target.id,
		});
		expect(result.applied).toMatchObject({ collisions: 1, merged: 1, finalCount: 1 });
	});

	it("preserves the newest exact canonical target when duplicate canonical rows exist", async () => {
		fixture = await buildFixture();
		const content =
			"The user plans work in written checklists. The user avoids ad hoc prioritization.";
		const olderTarget = await seedLegacyRow({
			fixture,
			sectionName: "preferences.work_planning",
			content,
		});
		const source = await seedLegacyRow({
			fixture,
			sectionName: "work.work-planning",
			content: "The user avoids ad hoc prioritization.",
			timestamp: NOW + 1,
		});
		const newerTarget = await seedLegacyRow({
			fixture,
			sectionName: "preferences.work_planning",
			content:
				"The user avoids ad hoc prioritization. The user plans work in written checklists.",
			timestamp: NOW + 2,
		});
		const newerTargetBefore = fixture.store.getById(newerTarget.id);

		const result = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});

		expect((await activeProfileRows(fixture)).map((row) => row.id)).toEqual([newerTarget.id]);
		expect(fixture.store.getById(newerTarget.id)).toEqual(newerTargetBefore);
		for (const closed of [olderTarget, source]) {
			const recovered = fixture.store.getById(closed.id);
			expect(parseInsightMetadata(recovered?.metadata, recovered)).toMatchObject({
				invalidated_at: expect.any(Number),
				superseded_by: newerTarget.id,
			});
		}
		expect(result.applied).toMatchObject({ collisions: 1, merged: 1, finalCount: 1 });
	});

	it("rekeys an exact alias target before closing its canonical subset", async () => {
		fixture = await buildFixture();
		const canonicalSource = await seedLegacyRow({
			fixture,
			sectionName: "preferences.reading",
			content: "The user reads historical fiction.",
		});
		const aliasContent =
			"The user reads historical fiction.\nThe user reads climate journalism.";
		const aliasTarget = await seedLegacyRow({
			fixture,
			sectionName: "interests.reading",
			content: aliasContent,
			storedText: `The user reads historical fiction.\n${aliasContent}`,
			timestamp: NOW + 1,
		});

		const result = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});

		expect((await activeProfileRows(fixture)).map((row) => row.id)).toEqual([aliasTarget.id]);
		expect(
			parseInsightMetadata(fixture.store.getById(aliasTarget.id)?.metadata, aliasTarget),
		).toMatchObject({
			section_name: "preferences.reading",
			invalidated_at: undefined,
		});
		expect(
			parseInsightMetadata(
				fixture.store.getById(canonicalSource.id)?.metadata,
				canonicalSource,
			),
		).toMatchObject({
			invalidated_at: expect.any(Number),
			superseded_by: aliasTarget.id,
		});
		expect(result.applied).toMatchObject({ collisions: 1, merged: 1, finalCount: 1 });
	});

	it("rolls back an exact alias rekey when the redundant close fails", async () => {
		fixture = await buildFixture();
		const canonicalSource = await seedLegacyRow({
			fixture,
			sectionName: "preferences.reading",
			content: "The user reads historical fiction.",
		});
		const aliasContent =
			"The user reads historical fiction.\nThe user reads climate journalism.";
		await seedLegacyRow({
			fixture,
			sectionName: "interests.reading",
			content: aliasContent,
			storedText: `The user reads historical fiction.\n${aliasContent}`,
			timestamp: NOW + 1,
		});
		const before = snapshotRows(fixture);
		fixture.testDb.sqlite.exec(`
			CREATE TRIGGER fail_exact_alias_source_close
			BEFORE UPDATE OF metadata ON nodix_memories
			WHEN OLD.id = '${canonicalSource.id}'
			BEGIN SELECT RAISE(ABORT, 'injected exact alias source close failure'); END;
		`);

		await expect(
			runBProfileSectionRekey({
				store: fixture.store,
				cache: fixture.cache,
			}),
		).rejects.toThrow("injected exact alias source close failure");

		expect(snapshotRows(fixture)).toEqual(before);
		expect((await fixture.cache.read())?.canonicalFormRepairVersion).toBeUndefined();
	});

	it("rolls back an exact-content source close and converges without replacing the target", async () => {
		fixture = await buildFixture();
		const [target, source] = await seedExactCanonicalCollision(fixture);
		const before = snapshotRows(fixture);
		fixture.testDb.sqlite.exec(`
			CREATE TRIGGER fail_exact_content_source_close
			BEFORE UPDATE OF metadata ON nodix_memories
			WHEN OLD.id = '${source.id}'
			BEGIN SELECT RAISE(ABORT, 'injected exact-content source close failure'); END;
		`);

		await expect(
			runBProfileSectionRekey({
				store: fixture.store,
				cache: fixture.cache,
			}),
		).rejects.toThrow("injected exact-content source close failure");
		expect(snapshotRows(fixture)).toEqual(before);
		expect((await fixture.cache.read())?.canonicalFormRepairVersion).toBeUndefined();

		fixture.testDb.sqlite.exec("DROP TRIGGER fail_exact_content_source_close");
		const retry = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});

		expect(retry.applied).toMatchObject({ collisions: 1, merged: 1, finalCount: 1 });
		expect((await activeProfileRows(fixture)).map((row) => row.id)).toEqual([target.id]);
		const recoveredSource = fixture.store.getById(source.id);
		expect(parseInsightMetadata(recoveredSource?.metadata, recoveredSource)).toMatchObject({
			invalidated_at: expect.any(Number),
			superseded_by: target.id,
		});
		expect((await fixture.cache.read())?.canonicalFormRepairVersion).toBe(
			B_PROFILE_CANONICAL_FORM_REPAIR_VERSION,
		);
	});

	it("rolls back every redundant close when a later exact-content close fails", async () => {
		fixture = await buildFixture();
		const firstSource = await seedLegacyRow({
			fixture,
			sectionName: "work.work-planning",
			content: "The user avoids ad hoc prioritization.",
		});
		const secondSource = await seedLegacyRow({
			fixture,
			sectionName: "work.work-planning",
			content: "The user starts with a written checklist.",
			timestamp: NOW + 1,
		});
		const target = await seedLegacyRow({
			fixture,
			sectionName: "preferences.work_planning",
			content:
				"The user plans work carefully. The user avoids ad hoc prioritization. The user starts with a written checklist.",
			timestamp: NOW + 2,
		});
		const before = snapshotRows(fixture);
		fixture.testDb.sqlite.exec(`
			CREATE TRIGGER fail_second_exact_content_close
			BEFORE UPDATE OF metadata ON nodix_memories
			WHEN OLD.id = '${secondSource.id}'
			BEGIN SELECT RAISE(ABORT, 'injected second exact-content close failure'); END;
		`);

		await expect(
			runBProfileSectionRekey({
				store: fixture.store,
				cache: fixture.cache,
			}),
		).rejects.toThrow("injected second exact-content close failure");

		expect(snapshotRows(fixture)).toEqual(before);
		expect((await fixture.cache.read())?.canonicalFormRepairVersion).toBeUndefined();
		fixture.testDb.sqlite.exec("DROP TRIGGER fail_second_exact_content_close");

		const retry = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});
		expect(retry.applied).toMatchObject({ collisions: 1, merged: 1, finalCount: 1 });
		expect((await activeProfileRows(fixture)).map((row) => row.id)).toEqual([target.id]);
		expect(
			parseInsightMetadata(fixture.store.getById(firstSource.id)?.metadata, firstSource),
		).toMatchObject({
			invalidated_at: expect.any(Number),
			superseded_by: target.id,
		});
	});

	it("aborts when a repair source changes before the write transaction", async () => {
		fixture = await buildFixture();
		const [first, second] = await seedCollision(fixture);
		const originalSupersede = fixture.store.supersede.bind(fixture.store);
		vi.spyOn(fixture.store, "supersede").mockImplementationOnce(async (args) => {
			await fixture?.store.update(first.id, {
				writerAuthority: "profile-writer",
				text: "The user now reads historical fiction only on weekends.",
			});
			return originalSupersede(args);
		});

		await expect(
			runBProfileSectionRekey({
				store: fixture.store,
				cache: fixture.cache,
			}),
		).rejects.toThrow("Cannot close changed memory");

		expect((await activeProfileRows(fixture)).map((row) => row.id).sort()).toEqual(
			[first.id, second.id].sort(),
		);
		expect(fixture.store.getById(first.id)?.text).toBe(
			"The user now reads historical fiction only on weekends.",
		);
		expect((await fixture.cache.read())?.canonicalFormRepairVersion).toBeUndefined();
	});

	it("aborts when the preserved target changes before the write transaction", async () => {
		fixture = await buildFixture();
		const [target, source] = await seedExactCanonicalCollision(fixture);
		const originalSupersede = fixture.store.supersede.bind(fixture.store);
		let liveUpdate: MemoryEntry | undefined;
		vi.spyOn(fixture.store, "supersede").mockImplementationOnce(async (args) => {
			liveUpdate =
				(await fixture?.store.update(target.id, {
					writerAuthority: "profile-writer",
					text: "The user changed the planning checklist during startup.",
				})) ?? undefined;
			return originalSupersede(args);
		});

		await expect(
			runBProfileSectionRekey({
				store: fixture.store,
				cache: fixture.cache,
			}),
		).rejects.toThrow("Cannot preserve changed memory");

		expect(liveUpdate).toBeDefined();
		expect(fixture.store.getById(target.id)).toEqual(liveUpdate);
		expect(parseInsightMetadata(fixture.store.getById(source.id)?.metadata, source)).toMatchObject({
			invalidated_at: undefined,
			superseded_by: undefined,
		});
		expect((await fixture.cache.read())?.canonicalFormRepairVersion).toBeUndefined();
	});

	it("aborts when a migration source changes before the write transaction", async () => {
		fixture = await buildFixture();
		const source = await seedLegacyRow({
			fixture,
			sectionName: "work.weekly-plan",
			content: "The user keeps a written weekly plan.",
		});
		const originalUpdate = fixture.store.update.bind(fixture.store);
		let liveUpdate: MemoryEntry | undefined;
		vi.spyOn(fixture.store, "update").mockImplementationOnce(async (id, changes) => {
			liveUpdate =
				(await originalUpdate(id, {
					writerAuthority: "profile-writer",
					text: "The user changed the weekly plan during startup.",
				})) ?? undefined;
			return originalUpdate(id, changes);
		});

		await expect(
			runBProfileSectionRekey({
				store: fixture.store,
				cache: fixture.cache,
			}),
		).rejects.toThrow("Cannot update changed memory");

		expect(liveUpdate).toBeDefined();
		expect(fixture.store.getById(source.id)).toEqual(liveUpdate);
		expect((await fixture.cache.read())?.canonicalFormRepairVersion).toBeUndefined();
	});

	it("aborts a canonical migration when its target appears after the dry run", async () => {
		fixture = await buildFixture();
		const currentFixture = fixture;
		const source = await seedLegacyRow({
			fixture: currentFixture,
			sectionName: "work.weekly-plan",
			content: "The user keeps a written weekly plan.",
		});
		const sourceBefore = currentFixture.store.getById(source.id);
		const originalUpdate = currentFixture.store.update.bind(currentFixture.store);
		let target: MemoryEntry | undefined;
		vi.spyOn(currentFixture.store, "update").mockImplementationOnce(async (id, changes) => {
			target = await seedLegacyRow({
				fixture: currentFixture,
				sectionName: "preferences.weekly_plan",
				content: "The user keeps a separate quarterly plan.",
				timestamp: NOW + 1,
			});
			return originalUpdate(id, changes);
		});

		await expect(
			runBProfileSectionRekey({
				store: currentFixture.store,
				cache: currentFixture.cache,
			}),
		).rejects.toThrow("appeared before initial write");

		expect(currentFixture.store.getById(source.id)).toEqual(sourceBefore);
		expect(target).toBeDefined();
		expect(
			parseInsightMetadata(currentFixture.store.getById(target?.id ?? "")?.metadata, target)
				.section_name,
		).toBe("preferences.weekly_plan");
		expect((await currentFixture.cache.read())?.canonicalFormRepairVersion).toBeUndefined();
	});

	it("runs once when the registry marker is current, then becomes a no-op", async () => {
		fixture = await buildFixture();
		await seedLegacyRow({
			fixture,
			sectionName: "goals.running-plan",
			content: "The user follows a gradual running plan.",
		});

		const first = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});
		const firstSnapshot = snapshotRows(fixture);
		const second = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});

		expect(first.skippedByVersion).toBe(false);
		expect(first.applied.migrated).toBe(1);
		expect(second.skippedByVersion).toBe(true);
		expect(second.applied.sourceRows).toBe(0);
		expect(snapshotRows(fixture)).toEqual(firstSnapshot);
	});

	it("does not count a canonical row written after an empty dry run as an applied repair", async () => {
		fixture = await buildFixture();
		const currentFixture = fixture;
		const originalList = currentFixture.store.list.bind(currentFixture.store);
		vi.spyOn(currentFixture.store, "list").mockImplementationOnce(async (options) => {
			const plannedRows = await originalList(options);
			await seedLegacyRow({
				fixture: currentFixture,
				sectionName: "preferences.reading",
				content: "The user reads historical fiction.",
			});
			return plannedRows;
		});

		const result = await runBProfileSectionRekey({
			store: currentFixture.store,
			cache: currentFixture.cache,
		});

		expect(result.dryRun).toEqual(result.applied);
		expect(result.applied).toMatchObject({ sourceRows: 0, finalCount: 1 });
		expect(await activeProfileRows(currentFixture)).toHaveLength(1);
		expect((await currentFixture.cache.read())?.canonicalFormRepairVersion).toBe(
			B_PROFILE_CANONICAL_FORM_REPAIR_VERSION,
		);
	});

	it("leaves persona rows unchanged when their keys would collide under profile rules", async () => {
		fixture = await buildFixture();
		const first = await seedLegacyRow({
			fixture,
			category: "persona",
			sectionName: "interests.reading",
			content: "The user presents as a curious reader.",
		});
		const second = await seedLegacyRow({
			fixture,
			category: "persona",
			sectionName: "preferences.reading",
			content: "The user presents as a deliberate reader.",
			timestamp: NOW + 1,
		});
		const before = [fixture.store.getById(first.id), fixture.store.getById(second.id)];

		const result = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});

		expect([fixture.store.getById(first.id), fixture.store.getById(second.id)]).toEqual(before);
		for (const row of [first, second]) {
			expect(parseInsightMetadata(fixture.store.getById(row.id)?.metadata, row).invalidated_at).toBeUndefined();
		}
		expect(result.applied.sourceRows).toBe(0);
	});

	it("merges duplicate rows that share the same non-canonical section", async () => {
		fixture = await buildFixture();
		await seedLegacyRow({
			fixture,
			sectionName: "interests.reading",
			content: "The user reads historical fiction.",
		});
		await seedLegacyRow({
			fixture,
			sectionName: "interests.reading",
			content: "The user reads climate journalism.",
			timestamp: NOW + 1,
		});

		const result = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});

		const active = await activeProfileRows(fixture);
		expect(active).toHaveLength(1);
		expect(active[0]?.text).toContain("The user reads historical fiction.");
		expect(active[0]?.text).toContain("The user reads climate journalism.");
		expect(parseInsightMetadata(active[0]?.metadata, active[0]).section_name).toBe(
			"preferences.reading",
		);
		expect(result.applied).toMatchObject({
			collisions: 1,
			merged: 1,
			unchanged: 0,
			finalCount: 1,
		});
	});

	it("consolidates active rows that already use the same canonical key", async () => {
		fixture = await buildFixture();
		await seedLegacyRow({
			fixture,
			sectionName: "preferences.same_key",
			content: "The user keeps a written plan.",
		});
		await seedLegacyRow({
			fixture,
			sectionName: "preferences.same_key",
			content: "The user reviews the plan every Friday.",
			timestamp: NOW + 1,
		});

		const result = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});

		const repaired = await activeProfileRows(fixture);
		expect(repaired).toHaveLength(1);
		expect(repaired[0]?.text).toContain("The user keeps a written plan.");
		expect(repaired[0]?.text).toContain("The user reviews the plan every Friday.");
		expect(result.applied).toMatchObject({
			collisions: 1,
			merged: 1,
			unchanged: 0,
			finalCount: 1,
		});

		await expect(
			runProfileSectionUpdate({
				scope: fixture.scope,
				sectionName: "preferences.same_key",
				newAssertion: "The user also reviews the plan on Mondays.",
				evidence: "The user also reviews the plan on Mondays.",
				source: { sessionKey: "canonical-duplicate-regression" },
				store: fixture.store,
				at: Date.now() + 1,
			}),
		).resolves.toMatchObject({ outcome: "merged" });
		expect(await activeProfileRows(fixture)).toHaveLength(1);
	});

	it("aborts a canonical collision when a new target appears before the transaction", async () => {
		fixture = await buildFixture();
		const currentFixture = fixture;
		const first = await seedLegacyRow({
			fixture: currentFixture,
			sectionName: "interests.reading",
			content: "The user reads historical fiction.",
		});
		const second = await seedLegacyRow({
			fixture: currentFixture,
			sectionName: "interests.reading",
			content: "The user reads climate journalism.",
			timestamp: NOW + 1,
		});
		const originalSupersede = currentFixture.store.supersede.bind(currentFixture.store);
		let concurrentTarget: MemoryEntry | undefined;
		vi.spyOn(currentFixture.store, "supersede").mockImplementationOnce(async (args) => {
			concurrentTarget = await seedLegacyRow({
				fixture: currentFixture,
				sectionName: "preferences.reading",
				content: "The user started reading technical papers during startup.",
				timestamp: NOW + 2,
			});
			return originalSupersede(args);
		});

		await expect(
			runBProfileSectionRekey({
				store: currentFixture.store,
				cache: currentFixture.cache,
			}),
		).rejects.toThrow("Active fact");

		expect(concurrentTarget).toBeDefined();
		expect((await activeProfileRows(currentFixture)).map((row) => row.id).sort()).toEqual(
			[first.id, second.id, concurrentTarget?.id].filter((id): id is string => id !== undefined).sort(),
		);
		for (const source of [first, second]) {
			expect(parseInsightMetadata(currentFixture.store.getById(source.id)?.metadata, source)).toMatchObject({
				invalidated_at: undefined,
				superseded_by: undefined,
			});
		}
		expect((await currentFixture.cache.read())?.canonicalFormRepairVersion).toBeUndefined();
	});

	it("excludes invalidated rows from profile split metrics", async () => {
		fixture = await buildFixture();
		await seedLegacyRow({
			fixture,
			sectionName: "preferences.reading",
			content: "The user reads before bed.",
		});
		await seedLegacyRow({
			fixture,
			sectionName: "interests.reading",
			content: "The user previously read during lunch.",
			timestamp: NOW + 1,
			invalidatedAt: NOW + 2,
		});

		const result = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});

		expect(result.dryRun).toMatchObject({
			sourceRows: 1,
			separatorSplitGroups: 0,
			domainPrefixSplitGroups: 0,
			crossPathSplitGroups: 0,
		});
	});

	it("measures separator, domain-prefix, and cross-path split groups independently", async () => {
		fixture = await buildFixture();
		await seedCollision(fixture);
		await seedLegacyRow({
			fixture,
			sectionName: "interests.coffee",
			content: "The user likes washed coffee.",
			timestamp: NOW + 2,
		});
		await seedLegacyRow({
			fixture,
			sectionName: "preferences.coffee",
			content: "The user likes light coffee roasts.",
			timestamp: NOW + 3,
		});
		await seedLegacyRow({
			fixture,
			sectionName: "preferences.reading",
			content: "The user reads before bed.",
			rawTopicPhrase: "reading taste",
			timestamp: NOW + 4,
		});
		await seedLegacyRow({
			fixture,
			sectionName: "preferences.books",
			content: "The user likes historical fiction.",
			rawTopicPhrase: "books",
			timestamp: NOW + 5,
		});

		const result = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});

		expect(result.dryRun).toMatchObject({
			separatorSplitGroups: 1,
			domainPrefixSplitGroups: 1,
			crossPathSplitGroups: 1,
		});
		expect(await activeProfileRows(fixture)).toHaveLength(4);
	});

	it("repairs the active candidate without counting invalidated split rows", async () => {
		fixture = await buildFixture();
		const candidateId = await seedFrozenSplitReference(fixture);
		const before = snapshotRows(fixture);
		const candidateBefore = fixture.store.getById(candidateId);
		expect(candidateBefore).toBeDefined();
		expect(
			parseInsightMetadata(candidateBefore?.metadata, candidateBefore).invalidated_at,
		).toBeUndefined();
		const population = fixture.testDb.sqlite
			.prepare(
				"SELECT COUNT(*) AS rows, COUNT(DISTINCT json_extract(metadata, '$.section_name')) AS sectionNames FROM nodix_memories WHERE project_id = ? AND lane = 'active' AND category = 'profile'",
			)
			.get(fixture.scope) as { rows: number; sectionNames: number };

		const result = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});

		expect(population).toEqual({
			rows: FROZEN_PROFILE_SPLIT_REFERENCE.laneActiveRows,
			sectionNames: FROZEN_PROFILE_SPLIT_REFERENCE.distinctSectionNames,
		});
		expect(result.dryRun).toMatchObject({
			sourceRows: 1,
			separatorSplitGroups: 0,
			domainPrefixSplitGroups: 0,
			crossPathSplitGroups: 0,
		});
		const after = snapshotRows(fixture);
		const changedIds = after
			.filter((row, index) => row.metadata !== before[index]?.metadata)
			.map((row) => row.id);
		expect(result.applied).toMatchObject({ sourceRows: 1, migrated: 1, merged: 0 });
		expect(changedIds).toEqual([candidateId]);
	});

	it("repairs every profile row beyond one clamped storage page and reruns as a no-op", async () => {
		fixture = await buildFixture();
		const candidateIds = seedPaginatedRepairCandidates(fixture);
		const before = snapshotRows(fixture);

		const first = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});

		expect(first.applied).toMatchObject({
			sourceRows: FROZEN_PROFILE_SPLIT_REFERENCE.laneActiveRows,
			migrated: FROZEN_PROFILE_SPLIT_REFERENCE.laneActiveRows,
			merged: 0,
		});
		const afterFirst = snapshotRows(fixture);
		const changedIds = afterFirst
			.filter((row, index) => row.metadata !== before[index]?.metadata)
			.map((row) => row.id);
		expect(changedIds).toEqual(candidateIds);

		const second = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});
		expect(second.skippedByVersion).toBe(true);
		expect(second.applied.sourceRows).toBe(0);
		expect(snapshotRows(fixture)).toEqual(afterFirst);
	});

	it.each(["replacement insertion", "first prior close", "second prior close"] as const)(
		"rolls back %s failure, leaves the marker absent, and converges on retry",
		async (failurePoint) => {
			fixture = await buildFixture();
			const [first, second] = await seedCollision(fixture);
			const before = snapshotRows(fixture);
			const triggerName = "fail_canonical_form_repair";
			if (failurePoint === "replacement insertion") {
				fixture.testDb.sqlite.exec(`
					CREATE TRIGGER ${triggerName}
					BEFORE INSERT ON nodix_memories
					WHEN NEW.category = 'profile'
					BEGIN SELECT RAISE(ABORT, 'injected replacement insertion failure'); END;
				`);
			} else {
				const failedId = failurePoint === "first prior close" ? first.id : second.id;
				fixture.testDb.sqlite.exec(`
					CREATE TRIGGER ${triggerName}
					BEFORE UPDATE OF metadata ON nodix_memories
					WHEN OLD.id = '${failedId}'
					BEGIN SELECT RAISE(ABORT, 'injected prior close failure'); END;
				`);
			}

			await expect(
				runBProfileSectionRekey({
					store: fixture.store,
					cache: fixture.cache,
				}),
			).rejects.toThrow(/injected/);
			expect(snapshotRows(fixture)).toEqual(before);
			expect((await fixture.cache.read())?.canonicalFormRepairVersion).toBeUndefined();

			fixture.testDb.sqlite.exec(`DROP TRIGGER ${triggerName}`);
			const retry = await runBProfileSectionRekey({
				store: fixture.store,
				cache: fixture.cache,
			});
			expect(retry.applied).toMatchObject({ collisions: 1, merged: 1, finalCount: 1 });
			expect(await activeProfileRows(fixture)).toHaveLength(1);
			expect((await fixture.cache.read())?.canonicalFormRepairVersion).toBe(
				B_PROFILE_CANONICAL_FORM_REPAIR_VERSION,
			);
		},
	);

	it("keeps earlier actions idempotent and converges when a later collision is retried", async () => {
		fixture = await buildFixture();
		const singleton = await seedLegacyRow({
			fixture,
			sectionName: "work.solo-plan",
			content: "The user keeps one weekly plan.",
			timestamp: NOW - 1,
		});
		await seedCollision(fixture);
		const before = snapshotRows(fixture);
		fixture.testDb.sqlite.exec(`
			CREATE TRIGGER fail_later_collision
			BEFORE INSERT ON nodix_memories
			WHEN NEW.category = 'profile'
			BEGIN SELECT RAISE(ABORT, 'injected later collision failure'); END;
		`);

		await expect(
			runBProfileSectionRekey({
				store: fixture.store,
				cache: fixture.cache,
			}),
		).rejects.toThrow("injected later collision failure");
		expect(snapshotRows(fixture)).not.toEqual(before);
		expect(
			parseInsightMetadata(fixture.store.getById(singleton.id)?.metadata, singleton).section_name,
		).toBe("preferences.solo_plan");
		expect((await fixture.cache.read())?.canonicalFormRepairVersion).toBeUndefined();

		fixture.testDb.sqlite.exec("DROP TRIGGER fail_later_collision");
		const retry = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});
		expect(retry.applied).toMatchObject({ migrated: 0, merged: 1, finalCount: 2 });
		const active = await activeProfileRows(fixture);
		expect(active).toHaveLength(2);
		expect(active.filter((row) => row.id === singleton.id)).toHaveLength(1);
		expect(active.find((row) => row.id !== singleton.id)?.text).toContain(
			"The user reads historical fiction.",
		);
		expect(active.find((row) => row.id !== singleton.id)?.text).toContain(
			"The user reads climate journalism.",
		);
	});
});
