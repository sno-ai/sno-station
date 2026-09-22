import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	computeSectionRegistryHash,
	createSectionDictionaryCache,
	loadSectionDictionary,
} from "../../../../packages/memory/src/engine/extraction/b-profile-section-dictionary-provider";
import {
	B_PROFILE_SECTION_REGISTRY,
	type BProfileSectionRegistry,
} from "../../../../packages/memory/src/engine/extraction/b-profile-section-registry";
import { runBProfileSectionRekey } from "../../../../packages/memory/src/engine/extraction/b-profile-section-rekey";
import { buildIndexedText } from "../../../../packages/memory/src/engine/extraction/extraction-text-sanitizer";
import {
	buildInsightMetadata,
	deriveFactKey,
	parseInsightMetadata,
	stringifyInsightMetadata,
} from "../../../../packages/memory/src/engine/extraction/memory-metadata-codec";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import type { MemoryEntry } from "../../../../packages/memory/src/engine/shared/types";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

const NOW = Date.parse("2026-07-18T12:00:00.000Z");

interface Fixture {
	store: MemoryStore;
	testDb: TestDb;
	cache: ReturnType<typeof createSectionDictionaryCache>;
	scope: string;
}

let embedder: Embedder;
let fixture: Fixture | undefined;
let scopeCounter = 0;

function upgradedRegistry(): BProfileSectionRegistry {
	const registry: BProfileSectionRegistry = {
		...B_PROFILE_SECTION_REGISTRY,
		schema_version: B_PROFILE_SECTION_REGISTRY.schema_version + 1,
		frozen_at: "2026-07-18T00:00:00+00:00",
		sections: B_PROFILE_SECTION_REGISTRY.sections.map((section) =>
			section.name === "preferences.work_planning"
				? {
						...section,
						synonyms: {
							...section.synonyms,
							en: [...section.synonyms.en, "focus ritual"],
						},
					}
				: section,
		),
		section_registry_sha256: "c".repeat(64),
		source_git_rev: "d".repeat(40),
	};
	return { ...registry, section_registry_sha256: computeSectionRegistryHash(registry) };
}

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
		mode: "rem-enhanced",
		pluginVersion: "0.9.75",
		fetchFn: async () => upgradedRegistry(),
		cache,
	});
	const cached = await cache.read();
	if (!cached) throw new Error("section dictionary cache was not persisted");
	await cache.write({
		...cached,
		appliedSchemaVersion: B_PROFILE_SECTION_REGISTRY.schema_version,
	});
	return {
		store,
		testDb,
		cache,
		scope: `section-rekey-${++scopeCounter}`,
	};
}

async function seedProfileRow(args: {
	fixture: Fixture;
	sectionName: string;
	content: string;
	projectId?: string;
	rawTopicPhrase?: string;
	missingTopicFlag?: boolean;
	timestamp?: number;
	invalidatedAt?: number;
	storedText?: string;
}): Promise<MemoryEntry> {
	const timestamp = args.timestamp ?? NOW;
	const metadata = buildInsightMetadata(
		{ text: args.content, category: "profile", timestamp },
		{
			section_name: args.sectionName,
			...(args.rawTopicPhrase ? { rawTopicPhrase: args.rawTopicPhrase } : {}),
			...(args.missingTopicFlag ? { "profile.preference.missing_topic": true } : {}),
			...(args.invalidatedAt === undefined ? {} : { invalidated_at: args.invalidatedAt }),
		},
	);
	return args.fixture.store.store({
		text: args.storedText ?? args.content,
		category: "profile",
		projectId: args.projectId ?? args.fixture.scope,
		timestamp,
		metadata: stringifyInsightMetadata(metadata),
		trusted: true,
	});
}

function snapshotRows(input: Fixture): Array<{ id: string; metadata: string }> {
	return input.testDb.sqlite
		.prepare(
			"SELECT id, metadata FROM nodix_memories WHERE project_id = ? ORDER BY timestamp, id",
		)
		.all(input.scope) as Array<{ id: string; metadata: string }>;
}

async function liveProfileRows(input: Fixture): Promise<MemoryEntry[]> {
	const rows = await input.store.list({
		projectId: input.scope,
		category: "profile",
		limit: 100,
	});
	return rows.filter(
		(row) => parseInsightMetadata(row.metadata, row).invalidated_at === undefined,
	);
}

describe("B-profile section registry re-key", () => {
	it("repairs through a malformed dictionary cache and replaces it after success", async () => {
		fixture = await buildFixture();
		const source = await seedProfileRow({
			fixture,
			sectionName: "preferences.general",
			content: "The user prefers a written focus ritual before planning.",
			rawTopicPhrase: "focus ritual",
		});
		await writeFile(
			join(dirname(fixture.testDb.dbPath), "b-profile-section-dictionary.json"),
			"{malformed",
			"utf8",
		);

		const result = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});

		expect(result.applied.migrated).toBe(1);
		expect(
			parseInsightMetadata(fixture.store.getById(source.id)?.metadata, source).section_name,
		).toBe("preferences.work_planning");
		const repairedCache = await fixture.cache.read();
		expect(repairedCache).toMatchObject({
			appliedSchemaVersion: upgradedRegistry().schema_version,
			canonicalFormRepairVersion: expect.any(Number),
		});
	});

	it("re-keys newly recognized general rows and leaves fall-through rows unchanged", async () => {
		fixture = await buildFixture();
		const source = await seedProfileRow({
			fixture,
			sectionName: "preferences.general",
			content: "The user prefers a written focus ritual before planning.",
			rawTopicPhrase: "focus ritual",
			missingTopicFlag: true,
		});
		const control = await seedProfileRow({
			fixture,
			sectionName: "preferences.general",
			content: "The user likes hand-thrown ceramic mugs.",
			rawTopicPhrase: "ceramic mug texture",
			timestamp: NOW + 1,
		});

		const result = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
			projectIdFilter: [fixture.scope],
		});

		const migrated = fixture.store.getById(source.id);
		const migratedMetadata = parseInsightMetadata(migrated?.metadata, migrated);
		expect(migratedMetadata.section_name).toBe("preferences.work_planning");
		expect(migratedMetadata.fact_key).toBe(
			deriveFactKey({ kind: "profile", section_name: "preferences.work_planning" }),
		);
		expect(migratedMetadata).not.toHaveProperty("profile.preference.missing_topic");
		expect(parseInsightMetadata(fixture.store.getById(control.id)?.metadata, control).section_name).toBe(
			"preferences.general",
		);
		expect(result.dryRun.migrated).toBe(1);
		expect(result.applied).toEqual(result.dryRun);
	});

	it("leaves a row without rawTopicPhrase unchanged and counts it", async () => {
		fixture = await buildFixture();
		const source = await seedProfileRow({
			fixture,
			sectionName: "preferences.general",
			content: "The user prefers a written focus ritual before planning.",
		});

		const result = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
			projectIdFilter: [fixture.scope],
		});

		expect(fixture.store.getById(source.id)?.metadata).toBe(source.metadata);
		expect(result.dryRun.missingRawPhrase).toBe(1);
		expect(result.dryRun.migrated).toBe(0);
	});

	it("converges without duplicate rows when an applied pass is replayed", async () => {
		fixture = await buildFixture();
		await seedProfileRow({
			fixture,
			sectionName: "preferences.general",
			content: "The user prefers a written focus ritual before planning.",
			rawTopicPhrase: "focus ritual",
		});

		const first = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});
		const cached = await fixture.cache.read();
		if (!cached) throw new Error("section dictionary cache disappeared");
		await fixture.cache.write({
			...cached,
			appliedSchemaVersion: B_PROFILE_SECTION_REGISTRY.schema_version,
		});
		const replay = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});
		const fastPath = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});

		expect(first.applied.migrated).toBe(1);
		expect(replay.applied.migrated).toBe(0);
		expect(replay.applied.merged).toBe(0);
		expect(fastPath.skippedByVersion).toBe(true);
		expect(await liveProfileRows(fixture)).toHaveLength(1);
	});

	it("merges a collision into one deterministic target and closes the source", async () => {
		fixture = await buildFixture();
		const target = await seedProfileRow({
			fixture,
			sectionName: "preferences.work_planning",
			content: "The user plans work in written checklists. The user avoids ad hoc prioritization.",
			rawTopicPhrase: "work planning",
		});
		const source = await seedProfileRow({
			fixture,
			sectionName: "preferences.general",
			content: "The user avoids ad hoc prioritization. The user begins with a focus ritual.",
			rawTopicPhrase: "focus ritual",
			timestamp: NOW + 1,
		});

		const result = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
			projectIdFilter: [fixture.scope],
		});

		const rows = await liveProfileRows(fixture);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.text).toContain("The user plans work in written checklists.");
		expect(rows[0]?.text).toContain("The user begins with a focus ritual.");
		expect(rows[0]?.text.match(/avoids ad hoc prioritization/g)).toHaveLength(1);
		expect(parseInsightMetadata(rows[0]?.metadata, rows[0]).section_name).toBe(
			"preferences.work_planning",
		);
		expect(parseInsightMetadata(fixture.store.getById(source.id)?.metadata, source).invalidated_at).toBeDefined();
		expect(parseInsightMetadata(fixture.store.getById(target.id)?.metadata, target).invalidated_at).toBeDefined();
		expect(result.dryRun.collisions).toBeGreaterThanOrEqual(1);
		expect(result.dryRun.merged).toBeGreaterThanOrEqual(1);
		expect(result.applied).toEqual(result.dryRun);
		expect(result.applied.finalCount).toBe(1);
	});

	it("keeps registry collision sources active when the replacement hash is inactive", async () => {
		fixture = await buildFixture();
		const targetContent = "The user plans work in written checklists.";
		const sourceContent = "The user begins with a focus ritual.";
		const mergedContent = `${targetContent}\n${sourceContent}`;
		await seedProfileRow({
			fixture,
			sectionName: "preferences.archived_planning",
			content: mergedContent,
			storedText: buildIndexedText(targetContent, mergedContent),
			timestamp: NOW - 2,
			invalidatedAt: NOW - 1,
		});
		await seedProfileRow({
			fixture,
			sectionName: "preferences.work_planning",
			content: targetContent,
		});
		await seedProfileRow({
			fixture,
			sectionName: "preferences.general",
			content: sourceContent,
			rawTopicPhrase: "focus ritual",
			timestamp: NOW + 1,
		});
		const before = snapshotRows(fixture);

		await expect(
			runBProfileSectionRekey({
				store: fixture.store,
				cache: fixture.cache,
				projectIdFilter: [fixture.scope],
			}),
		).rejects.toThrow("Cannot supersede with an inactive content-hash match");

		expect(snapshotRows(fixture)).toEqual(before);
		expect(await liveProfileRows(fixture)).toHaveLength(2);
	});

	it("keeps registry collision sources active when the replacement hash belongs to another section", async () => {
		fixture = await buildFixture();
		const targetContent = "The user plans work in written checklists.";
		const sourceContent = "The user begins with a focus ritual.";
		const mergedContent = `${targetContent}\n${sourceContent}`;
		await seedProfileRow({
			fixture,
			sectionName: "preferences.archived_planning",
			content: mergedContent,
			storedText: buildIndexedText(targetContent, mergedContent),
			timestamp: NOW - 1,
		});
		await seedProfileRow({
			fixture,
			sectionName: "preferences.work_planning",
			content: targetContent,
		});
		await seedProfileRow({
			fixture,
			sectionName: "preferences.general",
			content: sourceContent,
			rawTopicPhrase: "focus ritual",
			timestamp: NOW + 1,
		});
		const before = snapshotRows(fixture);
		let thrown: unknown;

		try {
			await runBProfileSectionRekey({
				store: fixture.store,
				cache: fixture.cache,
				projectIdFilter: [fixture.scope],
			});
		} catch (error) {
			thrown = error;
		}

		expect(snapshotRows(fixture)).toEqual(before);
		expect(thrown).toMatchObject({
			message: "Cannot supersede with a content-hash match from another fact",
		});
		expect(await liveProfileRows(fixture)).toHaveLength(3);
	});

	it("closes a duplicate-only collision against the existing target without cloning it", async () => {
		fixture = await buildFixture();
		const target = await seedProfileRow({
			fixture,
			sectionName: "preferences.work_planning",
			content:
				"The user plans work in written checklists. The user avoids ad hoc prioritization.",
			rawTopicPhrase: "work planning",
		});
		const source = await seedProfileRow({
			fixture,
			sectionName: "preferences.general",
			content: "The user avoids ad hoc prioritization.",
			rawTopicPhrase: "focus ritual",
			timestamp: NOW + 1,
		});

		const result = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
			projectIdFilter: [fixture.scope],
		});

		const rows = await liveProfileRows(fixture);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe(target.id);
		expect(parseInsightMetadata(fixture.store.getById(source.id)?.metadata, source)).toMatchObject({
			invalidated_at: expect.any(Number),
			superseded_by: target.id,
		});
		expect(result.dryRun).toMatchObject({
			sourceRows: 2,
			targetKeys: 1,
			collisions: 1,
			migrated: 0,
			merged: 1,
			rejected: 0,
			finalCount: 1,
		});
		expect(result.applied).toEqual(result.dryRun);
	});

	it("leaves a duplicate-only collision unchanged when its single source close fails", async () => {
		fixture = await buildFixture();
		const target = await seedProfileRow({
			fixture,
			sectionName: "preferences.work_planning",
			content:
				"The user plans work in written checklists. The user avoids ad hoc prioritization.",
			rawTopicPhrase: "work planning",
		});
		const source = await seedProfileRow({
			fixture,
			sectionName: "preferences.general",
			content: "The user avoids ad hoc prioritization.",
			rawTopicPhrase: "focus ritual",
			timestamp: NOW + 1,
		});
		const before = {
			source: fixture.store.getById(source.id),
			target: fixture.store.getById(target.id),
		};
		fixture.testDb.sqlite.exec(`
			CREATE TRIGGER fail_duplicate_source_close
			BEFORE UPDATE OF metadata ON nodix_memories
			WHEN OLD.id = '${source.id}'
			BEGIN SELECT RAISE(ABORT, 'injected duplicate source close failure'); END;
		`);

		await expect(
			runBProfileSectionRekey({
				store: fixture.store,
				cache: fixture.cache,
				projectIdFilter: [fixture.scope],
			}),
		).rejects.toThrow("injected duplicate source close failure");

		expect(fixture.store.getById(source.id)).toEqual(before.source);
		expect(fixture.store.getById(target.id)).toEqual(before.target);
		expect((await liveProfileRows(fixture)).map((row) => row.id).sort()).toEqual(
			[source.id, target.id].sort(),
		);
		fixture.testDb.sqlite.exec("DROP TRIGGER fail_duplicate_source_close");
	});

	it("keeps multilingual clauses when merging a collision", async () => {
		fixture = await buildFixture();
		await seedProfileRow({
			fixture,
			sectionName: "preferences.work_planning",
			content: "The user plans work in written checklists.",
			rawTopicPhrase: "work planning",
		});
		await seedProfileRow({
			fixture,
			sectionName: "preferences.general",
			content: "用户喜欢先写计划再开始工作。",
			rawTopicPhrase: "focus ritual",
			timestamp: NOW + 1,
		});

		const result = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
			projectIdFilter: [fixture.scope],
		});

		const rows = await liveProfileRows(fixture);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.text).toContain("用户喜欢先写计划再开始工作。");
		expect(result.applied).toMatchObject({ merged: 1, rejected: 0, finalCount: 1 });
	});

	it("keeps two clauses that differ only in punctuation when merging a collision", async () => {
		fixture = await buildFixture();
		await seedProfileRow({
			fixture,
			sectionName: "preferences.work_planning",
			content: "The user writes tools in C.",
			rawTopicPhrase: "work planning",
		});
		await seedProfileRow({
			fixture,
			sectionName: "preferences.general",
			content: "The user writes tools in C++.",
			rawTopicPhrase: "focus ritual",
			timestamp: NOW + 1,
		});

		const result = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
			projectIdFilter: [fixture.scope],
		});

		const rows = await liveProfileRows(fixture);
		expect(rows).toHaveLength(1);
		// Two different languages, not one preference stated twice: dropping the "++" merged them.
		expect(rows[0]?.text).toContain("The user writes tools in C.");
		expect(rows[0]?.text).toContain("The user writes tools in C++.");
		expect(result.applied).toMatchObject({ merged: 1, rejected: 0, finalCount: 1 });
	});

	it("rejects a collision when the source has no mergeable clause", async () => {
		fixture = await buildFixture();
		await seedProfileRow({
			fixture,
			sectionName: "preferences.work_planning",
			content: "The user plans work in written checklists.",
			rawTopicPhrase: "work planning",
		});
		const source = await seedProfileRow({
			fixture,
			sectionName: "preferences.general",
			content: "😀✨",
			rawTopicPhrase: "focus ritual",
			timestamp: NOW + 1,
		});

		const result = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
			projectIdFilter: [fixture.scope],
		});

		expect(fixture.store.getById(source.id)?.metadata).toBe(source.metadata);
		expect(await liveProfileRows(fixture)).toHaveLength(2);
		expect(result.applied).toMatchObject({ merged: 0, rejected: 1, finalCount: 2 });
	});

	it("does not advance the global marker after a filtered pass", async () => {
		fixture = await buildFixture();
		const otherProjectId = `${fixture.scope}-other`;
		const filteredSource = await seedProfileRow({
			fixture,
			sectionName: "preferences.general",
			content: "The user prefers a written focus ritual before planning.",
			rawTopicPhrase: "focus ritual",
		});
		const otherSource = await seedProfileRow({
			fixture,
			projectId: otherProjectId,
			sectionName: "preferences.general",
			content: "The user uses a focus ritual before weekly planning.",
			rawTopicPhrase: "focus ritual",
		});

		const filtered = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
			projectIdFilter: [fixture.scope],
		});
		const afterFiltered = await fixture.cache.read();
		const unfiltered = await runBProfileSectionRekey({
			store: fixture.store,
			cache: fixture.cache,
		});
		const afterUnfiltered = await fixture.cache.read();

		expect(filtered.applied.migrated).toBe(1);
		expect(afterFiltered?.appliedSchemaVersion).toBe(
			B_PROFILE_SECTION_REGISTRY.schema_version,
		);
		expect(parseInsightMetadata(fixture.store.getById(filteredSource.id)?.metadata, filteredSource).section_name).toBe(
			"preferences.work_planning",
		);
		expect(parseInsightMetadata(fixture.store.getById(otherSource.id)?.metadata, otherSource).section_name).toBe(
			"preferences.work_planning",
		);
		expect(unfiltered.skippedByVersion).toBe(false);
		expect(unfiltered.applied.migrated).toBe(1);
		expect(afterUnfiltered?.appliedSchemaVersion).toBe(
			B_PROFILE_SECTION_REGISTRY.schema_version + 1,
		);
	});
});
