import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	bProfileSectionRegistrySchema,
	computeSectionRegistryHash,
	createSectionDictionaryCache,
	getActiveSectionRegistry,
	loadSectionDictionary,
	normalizeTopicToSectionName,
	restoreCachedSectionDictionary,
} from "../../../../packages/memory/src/engine/extraction/b-profile-section-dictionary-provider";
import {
	B_PROFILE_SECTION_REGISTRY,
	type BProfileSectionRegistry,
} from "../../../../packages/memory/src/engine/extraction/b-profile-section-registry";

const tempDirs: string[] = [];

function makeCache() {
	const stateDir = mkdtempSync(join(tmpdir(), "mem-claw-section-dictionary-"));
	tempDirs.push(stateDir);
	return createSectionDictionaryCache(stateDir);
}

function upgradedRegistry(): BProfileSectionRegistry {
	const registry: BProfileSectionRegistry = {
		...B_PROFILE_SECTION_REGISTRY,
		schema_version: B_PROFILE_SECTION_REGISTRY.schema_version + 1,
		frozen_at: "2026-07-22T00:00:00+00:00",
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
		section_registry_sha256: "a".repeat(64),
		source_git_rev: "b-profile-dictionary-test",
	};
	return { ...registry, section_registry_sha256: computeSectionRegistryHash(registry) };
}

beforeEach(async () => {
	await loadSectionDictionary({
		mode: "local-first",
		pluginVersion: "0.9.74",
		fetchFn: async () => upgradedRegistry(),
		cache: makeCache(),
	});
});

afterEach(() => {
	for (const tempDir of tempDirs.splice(0)) rmSync(tempDir, { recursive: true, force: true });
});

describe("B-profile section dictionary provider", () => {
	it("uses the bundled data resource in local-first mode without fetching", async () => {
		let fetchCalls = 0;
		const result = await loadSectionDictionary({
			mode: "local-first",
			pluginVersion: "0.9.74",
			fetchFn: async () => {
				fetchCalls++;
				return upgradedRegistry();
			},
			cache: makeCache(),
		});
		expect(fetchCalls).toBe(0);
		expect(result.registry).toEqual(B_PROFILE_SECTION_REGISTRY);
	});

	it("atomically activates an additive registry and its data-owned synonym", async () => {
		const upgraded = upgradedRegistry();
		const result = await loadSectionDictionary({
			mode: "rem-enhanced",
			pluginVersion: "0.9.75",
			fetchFn: async () => upgraded,
			cache: makeCache(),
		});
		expect(result.registry).toEqual(upgraded);
		expect(getActiveSectionRegistry()).toEqual(upgraded);
		expect(normalizeTopicToSectionName("focus ritual")).toBe("preferences.work_planning");
	});

	it("keeps the synonym registry out of matching TypeScript", () => {
		const matchingSource = readFileSync(
			new URL("../../../../packages/memory/src/engine/extraction/b-profile-section-registry.ts", import.meta.url),
			"utf8",
		);
		for (const section of B_PROFILE_SECTION_REGISTRY.sections) {
			for (const synonyms of Object.values(section.synonyms)) {
				for (const synonym of synonyms) {
					expect(matchingSource).not.toContain(JSON.stringify(synonym));
				}
			}
		}
	});

	it("enforces the 128-section load-time cap", () => {
		const first = B_PROFILE_SECTION_REGISTRY.sections[0];
		if (!first) throw new Error("bundled registry has no sections");
		const sections = Array.from({ length: 129 }, (_, index) => ({
			...first,
			name: `preferences.generated_${index}`,
			synonyms: {
				...first.synonyms,
				en: [`generated ${index}`],
			},
		}));
		expect(() =>
			bProfileSectionRegistrySchema.parse({ ...upgradedRegistry(), sections }),
		).toThrow();
	});

	it.each([
		[
			"a missing active_task_shape object",
			(({ active_task_shape: _activeTaskShape, ...registry }) => registry)(
				B_PROFILE_SECTION_REGISTRY,
			),
		],
		[
			"a missing projection_max_items field",
			{
				...B_PROFILE_SECTION_REGISTRY,
				active_task_shape: { projection_title_max_tokens: 128 },
			},
		],
		[
			"a missing projection_title_max_tokens field",
			{
				...B_PROFILE_SECTION_REGISTRY,
				active_task_shape: { projection_max_items: 25 },
			},
		],
		[
			"a zero projection_max_items value",
			{
				...B_PROFILE_SECTION_REGISTRY,
				active_task_shape: {
					projection_max_items: 0,
					projection_title_max_tokens: 128,
				},
			},
		],
		[
			"a negative projection_title_max_tokens value",
			{
				...B_PROFILE_SECTION_REGISTRY,
				active_task_shape: {
					projection_max_items: 25,
					projection_title_max_tokens: -128,
				},
			},
		],
		[
			"a fractional projection_max_items value",
			{
				...B_PROFILE_SECTION_REGISTRY,
				active_task_shape: {
					projection_max_items: 25.5,
					projection_title_max_tokens: 128,
				},
			},
		],
		[
			"a string-valued projection_title_max_tokens field",
			{
				...B_PROFILE_SECTION_REGISTRY,
				active_task_shape: {
					projection_max_items: 25,
					projection_title_max_tokens: "128",
				},
			},
		],
		[
			"an extra active_task_shape field",
			{
				...B_PROFILE_SECTION_REGISTRY,
				active_task_shape: {
					projection_max_items: 25,
					projection_title_max_tokens: 128,
					extra: true,
				},
			},
		],
	] as const)("rejects %s", (_label, registry) => {
		expect(() => bProfileSectionRegistrySchema.parse(registry)).toThrow();
	});

	it("round-trips the exact active task shape through the real file cache", async () => {
		const cache = makeCache();
		await cache.write({
			activeRegistry: B_PROFILE_SECTION_REGISTRY,
			appliedSchemaVersion: B_PROFILE_SECTION_REGISTRY.schema_version,
			canonicalFormRepairVersion: 1,
		});

		expect((await cache.read())?.activeRegistry.active_task_shape).toEqual({
			projection_max_items: 25,
			projection_title_max_tokens: 128,
		});
	});

	it("falls back to the bundled registry when an installed cache predates the token rename", async () => {
		// The upgrade path a real client hits: a dictionary cached by the previous
		// version carries active_task_shape.projection_title_max_characters. The
		// rename is a hard cut, so that file must fail loudly and self-heal rather
		// than wedge the boot or run on a stale bound.
		const stateDir = mkdtempSync(join(tmpdir(), "mem-claw-section-dictionary-legacy-"));
		tempDirs.push(stateDir);
		const cache = createSectionDictionaryCache(stateDir);
		const { projection_title_max_tokens: _dropped, ...legacyShape } =
			B_PROFILE_SECTION_REGISTRY.active_task_shape;
		writeFileSync(
			join(stateDir, "b-profile-section-dictionary.json"),
			JSON.stringify({
				activeRegistry: {
					...B_PROFILE_SECTION_REGISTRY,
					active_task_shape: { ...legacyShape, projection_title_max_characters: 128 },
				},
			}),
		);

		await expect(cache.read()).rejects.toThrow();

		const result = await loadSectionDictionary({
			mode: "rem-enhanced",
			pluginVersion: "0.9.75",
			fetchFn: async () => {
				throw new Error("network unavailable");
			},
			cache,
		});

		expect(result.registry).toEqual(B_PROFILE_SECTION_REGISTRY);
		expect(result.registry.active_task_shape.projection_title_max_tokens).toBe(128);
	});

	it("rejects a cached registry whose gate prompt predates the bundled contract", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "mem-claw-section-dictionary-stale-prompt-"));
		tempDirs.push(stateDir);
		const cache = createSectionDictionaryCache(stateDir);
		writeFileSync(
			join(stateDir, "b-profile-section-dictionary.json"),
			JSON.stringify({
				activeRegistry: {
					...B_PROFILE_SECTION_REGISTRY,
					gate_prompt: {
						...B_PROFILE_SECTION_REGISTRY.gate_prompt,
						instructions: "Use the legacy gate contract.",
					},
					section_registry_sha256:
						"86972fe8d95847f5270f694ac38da926032b90e8c60dbbe75cf52fd982d0208e",
				},
			}),
		);

		const restored = await restoreCachedSectionDictionary({ mode: "rem-enhanced", cache });

		expect(restored).toEqual(B_PROFILE_SECTION_REGISTRY);
	});

	it.each([
		[
			"a deleted section",
			{
				...upgradedRegistry(),
				sections: upgradedRegistry().sections.filter((section) => section.name !== "identity"),
			},
		],
		[
			"a deleted synonym",
			{
				...upgradedRegistry(),
				sections: upgradedRegistry().sections.map((section) =>
					section.name === "preferences.answer_length"
						? {
								...section,
								synonyms: {
									...section.synonyms,
									en: section.synonyms.en.filter((term) => term !== "response length"),
								},
							}
						: section,
				),
			},
		],
		[
			"an undeclared domain",
			{
				...upgradedRegistry(),
				sections: upgradedRegistry().sections.map((section, index) =>
					index === 0 ? { ...section, domain: "undeclared" } : section,
				),
			},
		],
	] as const)("rejects %s without replacing the active registry", async (_label, registry) => {
		const cache = makeCache();
		const result = await loadSectionDictionary({
			mode: "rem-enhanced",
			pluginVersion: "0.9.75",
			fetchFn: async () => registry,
			cache,
		});
		expect(result.registry).toEqual(B_PROFILE_SECTION_REGISTRY);
		expect((await cache.read())?.activeRegistry).toEqual(B_PROFILE_SECTION_REGISTRY);
	});

	it("fetches at most once per plugin version", async () => {
		const cache = makeCache();
		await cache.write({
			activeRegistry: B_PROFILE_SECTION_REGISTRY,
			fetchedForPluginVersion: "0.9.74",
			appliedSchemaVersion: B_PROFILE_SECTION_REGISTRY.schema_version,
			canonicalFormRepairVersion: 1,
		});
		let fetchCalls = 0;
		const fetchFn = async () => {
			fetchCalls++;
			return upgradedRegistry();
		};
		await loadSectionDictionary({
			mode: "agent-native",
			pluginVersion: "0.9.75",
			fetchFn,
			cache,
		});
		await loadSectionDictionary({
			mode: "agent-native",
			pluginVersion: "0.9.75",
			fetchFn,
			cache,
		});
		expect(fetchCalls).toBe(1);
		expect((await cache.read())?.canonicalFormRepairVersion).toBe(1);
	});
});
