import { describe, expect, it } from "vitest";
import {
	MEMORY_CATEGORIES,
	type MemoryCategory,
	normalizeCategory,
} from "../../../../apps/mem-claw/src/shared/types.ts";
import {
	isAppendOnly,
	isMutationNative,
	isDerivedOnly,
	dedupePolicy,
	allowedWriters,
	canExtractorWrite,
	canOfflineFamilyWrite,
	canProfileWriterWrite,
	canTrustedWrite,
} from "../../../../apps/mem-claw/src/shared/memory-kind-policy.ts";
import {
	memoryMetadata,
} from "../../../../apps/mem-claw/src/extraction/memory-metadata-types.ts";
import {
	buildInsightMetadata,
	deriveFactKey,
	ExtractionError,
	parseInsightMetadata,
} from "../../../../apps/mem-claw/src/extraction/memory-metadata-codec.ts";

const NOW = 1718000000000;

function baseFields(kind: MemoryCategory) {
	return {
		kind,
		l0_abstract: "test abstract",
		l1_overview: "- test abstract",
		l2_content: "test content",
		memory_category: kind,
		tier: "core" as const,
		access_count: 0,
		confidence: 0.7,
		last_accessed_at: NOW,
		asserted_at: NOW,
		valid_from: NOW,
		state: "confirmed" as const,
		source: "ambient-learning" as const,
		memory_layer: "durable" as const,
		injected_count: 0,
		bad_recall_count: 0,
		suppressed_until_turn: 0,
	};
}

describe("memory kind taxonomy", () => {
	it("MEMORY_CATEGORIES contains the foundation kinds and state", () => {
		// `state` joined the set under PRD 150 (owner ruling 2026-09-04): a durable fact about a
		// named thing — a proposal's budget, an e-mail's recipients — as opposed to `profile`,
		// which is a durable fact about the person. The order is the declaration order, and this
		// assertion is what keeps a sixth value from being added without a ruling behind it.
		expect(MEMORY_CATEGORIES).toEqual([
			"episodic",
			"profile",
			"persona",
			"lesson",
			"summary",
			"state",
		]);
	});

	it("normalizeCategory accepts foundation kinds", () => {
		for (const kind of MEMORY_CATEGORIES) {
			expect(normalizeCategory(kind)).toBe(kind);
		}
	});

	it("normalizeCategory rejects old category values", () => {
		for (const old of ["identity", "preference", "entity", "event"]) {
			expect(normalizeCategory(old)).toBeUndefined();
		}
	});

	it("normalizeCategory rejects pre-five legacy values", () => {
		for (const legacy of ["fact", "decision", "other", "reflection"]) {
			expect(normalizeCategory(legacy)).toBeUndefined();
		}
	});

	it("normalizeCategory is case-insensitive", () => {
		expect(normalizeCategory("EPISODIC")).toBe("episodic");
		expect(normalizeCategory("Profile")).toBe("profile");
	});

	it("LEGACY_MEMORY_CATEGORIES is not exported from types", async () => {
		const mod = await import("../../../../apps/mem-claw/src/shared/types");
		expect("LEGACY_MEMORY_CATEGORIES" in mod).toBe(false);
	});

	it("remapLegacyMemoryCategory is not exported from types", async () => {
		const mod = await import("../../../../apps/mem-claw/src/shared/types");
		expect("remapLegacyMemoryCategory" in mod).toBe(false);
	});

	it("strategy sets are not exported from types", async () => {
		const mod = await import("../../../../apps/mem-claw/src/shared/types");
		expect("ALWAYS_MERGE_CATEGORIES" in mod).toBe(false);
		expect("MERGE_SUPPORTED_CATEGORIES" in mod).toBe(false);
		expect("TEMPORAL_VERSIONED_CATEGORIES" in mod).toBe(false);
		expect("APPEND_ONLY_CATEGORIES" in mod).toBe(false);
	});
});

describe("kind-policy helper", () => {
	it("episodic is append-only", () => {
		expect(isAppendOnly("episodic")).toBe(true);
		expect(isMutationNative("episodic")).toBe(false);
	});

	it("lesson is append-only with signature dedupe", () => {
		expect(isAppendOnly("lesson")).toBe(true);
		const policy = dedupePolicy("lesson");
		expect(policy.mode).toBe("signature");
		if (policy.mode === "signature") {
			expect(policy.field).toBe("anti_pattern_signature");
		}
	});

	it("profile is mutation-native", () => {
		expect(isMutationNative("profile")).toBe(true);
		expect(isAppendOnly("profile")).toBe(false);
	});

	it("persona is mutation-native and offline-family-only", () => {
		expect(isMutationNative("persona")).toBe(true);
		expect(canExtractorWrite("persona")).toBe(false);
		expect(canTrustedWrite("persona")).toBe(false);
		expect(allowedWriters("persona")).toEqual(["offline-family"]);
	});

	it("summary is derived-only and offline-family-only", () => {
		expect(isDerivedOnly("summary")).toBe(true);
		expect(canExtractorWrite("summary")).toBe(false);
		expect(canTrustedWrite("summary")).toBe(false);
		expect(allowedWriters("summary")).toEqual(["offline-family"]);
	});

	it("splits live writes between episodic extraction and the profile writer", () => {
		expect(canExtractorWrite("episodic")).toBe(true);
		expect(canExtractorWrite("lesson")).toBe(false);
		expect(canExtractorWrite("profile")).toBe(false);
		expect(canExtractorWrite("persona")).toBe(false);
		expect(canExtractorWrite("summary")).toBe(false);
		expect(canProfileWriterWrite("profile")).toBe(true);
		expect(canProfileWriterWrite("episodic")).toBe(false);
	});

	it("lets only the offline family address every stored category", () => {
		for (const category of MEMORY_CATEGORIES) {
			expect(canOfflineFamilyWrite(category)).toBe(true);
			expect(allowedWriters(category)).toContain("offline-family");
		}
	});
});

describe("Zod discriminated-union metadata schema", () => {
	it("valid episodic metadata parses", () => {
		const data = { ...baseFields("episodic"), event_at: "2026-05-20", entity_kind: "person" };
		const result = memoryMetadata.safeParse(data);
		expect(result.success).toBe(true);
	});

	it("valid profile metadata parses", () => {
		const data = { ...baseFields("profile"), section_name: "identity" };
		const result = memoryMetadata.safeParse(data);
		expect(result.success).toBe(true);
	});

	it("valid persona metadata parses", () => {
		const data = { ...baseFields("persona"), section_name: "tone" };
		const result = memoryMetadata.safeParse(data);
		expect(result.success).toBe(true);
	});

	it("valid lesson metadata parses", () => {
		const data = { ...baseFields("lesson"), anti_pattern_signature: "never-mock-db" };
		const result = memoryMetadata.safeParse(data);
		expect(result.success).toBe(true);
	});

	it("valid summary metadata parses", () => {
		const data = { ...baseFields("summary"), children_ids: ["a", "b"], depth: 1 };
		const result = memoryMetadata.safeParse(data);
		expect(result.success).toBe(true);
	});

	it("unknown extra fields survive round-trip", () => {
		const data = {
			...baseFields("episodic"),
			custom_field: "preserved",
			nested: { deep: true },
		};
		const result = memoryMetadata.safeParse(data);
		expect(result.success).toBe(true);
		if (result.success) {
			expect((result.data as Record<string, unknown>).custom_field).toBe("preserved");
			expect((result.data as Record<string, unknown>).nested).toEqual({ deep: true });
		}
	});

	it("profile metadata without section_name fails", () => {
		const data = baseFields("profile");
		const result = memoryMetadata.safeParse(data);
		expect(result.success).toBe(false);
	});

	it("persona metadata without section_name fails", () => {
		const data = baseFields("persona");
		const result = memoryMetadata.safeParse(data);
		expect(result.success).toBe(false);
	});

	it("lesson metadata without anti_pattern_signature fails", () => {
		const data = baseFields("lesson");
		const result = memoryMetadata.safeParse(data);
		expect(result.success).toBe(false);
	});

	it("summary metadata without children_ids fails", () => {
		const data = baseFields("summary");
		const result = memoryMetadata.safeParse(data);
		expect(result.success).toBe(false);
	});

	it("summary metadata with depth < 1 fails", () => {
		const data = { ...baseFields("summary"), children_ids: ["a"], depth: 0 };
		const result = memoryMetadata.safeParse(data);
		expect(result.success).toBe(false);
	});

	it("missing asserted_at fails", () => {
		const { asserted_at, ...noAsserted } = baseFields("episodic");
		const result = memoryMetadata.safeParse(noAsserted);
		expect(result.success).toBe(false);
	});

	it("kind/memory_category mismatch fails the discriminated union", () => {
		const mismatch = {
			...baseFields("episodic"),
			kind: "profile" as const,
			memory_category: "episodic" as const,
			section_name: "x",
		};
		const result = memoryMetadata.safeParse(mismatch);
		expect(result.success).toBe(false);
	});

	it("old category values fail the schema", () => {
		for (const old of ["identity", "preference", "entity", "event"]) {
			const data = { ...baseFields("episodic"), kind: old, memory_category: old };
			const result = memoryMetadata.safeParse(data);
			expect(result.success).toBe(false);
		}
	});
});

describe("metadata codec kind invariants", () => {
	it("deriveFactKey uses structured metadata fields, not l0_abstract text", () => {
		const profile = buildInsightMetadata(
			{ text: "preferences: this old text prefix must not define the key", category: "profile" },
			{ section_name: "identity" },
		);
		const persona = buildInsightMetadata(
			{ text: "behavior: this old text prefix must not define the key", category: "persona" },
			{ section_name: "behavior_rules" },
		);
		const lesson = buildInsightMetadata(
			{ text: "operator mistakes: this old text prefix must not define the key", category: "lesson" },
			{ anti_pattern_signature: "retry-after-path-check" },
		);

		expect(deriveFactKey(profile)).toBe("profile:identity");
		expect(profile.fact_key).toBe("profile:identity");
		expect(deriveFactKey(persona)).toBe("persona:behavior_rules");
		expect(persona.fact_key).toBe("persona:behavior_rules");
		expect(deriveFactKey(lesson)).toBe("lesson:retry-after-path-check");
		expect(lesson.fact_key).toBe("lesson:retry-after-path-check");
		expect(deriveFactKey({ kind: "episodic" })).toBeUndefined();
		expect(deriveFactKey({ kind: "summary" })).toBeUndefined();
	});

	it("parseInsightMetadata rejects profile/persona/lesson metadata missing required fields", () => {
		expect(() =>
			parseInsightMetadata(JSON.stringify(baseFields("profile")), { category: "profile" }),
		).toThrow(/section_name/);
		expect(() =>
			parseInsightMetadata(JSON.stringify(baseFields("persona")), { category: "persona" }),
		).toThrow(/section_name/);
		expect(() =>
			parseInsightMetadata(JSON.stringify(baseFields("lesson")), { category: "lesson" }),
		).toThrow(/anti_pattern_signature/);
	});

	it("parseInsightMetadata rejects blank required structured key fields", () => {
		expect(() =>
			parseInsightMetadata(
				JSON.stringify({ ...baseFields("profile"), section_name: "   " }),
				{ category: "profile" },
			),
		).toThrow(ExtractionError);
		expect(() =>
			parseInsightMetadata(
				JSON.stringify({ ...baseFields("profile"), section_name: "   " }),
				{ category: "profile" },
			),
		).toThrow(/section_name/);
		expect(() =>
			parseInsightMetadata(
				JSON.stringify({ ...baseFields("lesson"), anti_pattern_signature: "\t\n" }),
				{ category: "lesson" },
			),
		).toThrow(ExtractionError);
		expect(() =>
			parseInsightMetadata(
				JSON.stringify({ ...baseFields("lesson"), anti_pattern_signature: "\t\n" }),
				{ category: "lesson" },
			),
		).toThrow(/anti_pattern_signature/);
	});

	it("parseInsightMetadata rejects row/category/kind mismatches", () => {
		const profile = { ...baseFields("profile"), section_name: "identity" };
		expect(() =>
			parseInsightMetadata(JSON.stringify(profile), { category: "episodic" }),
		).toThrow(/row\/category\/kind mismatch/);
		expect(() =>
			parseInsightMetadata(
				JSON.stringify({ ...profile, kind: "profile", memory_category: "persona" }),
				{ category: "profile" },
			),
		).toThrow(/row\/category\/kind mismatch/);
	});

	it("writer and lookup derivations share the same fact_key for profile and lesson", () => {
		const profile = buildInsightMetadata(
			{ text: "The user prefers classic science fiction.", category: "profile", timestamp: NOW },
			{ section_name: "preferences.books" },
		);
		const profileCodec = parseInsightMetadata(JSON.stringify(profile), { category: "profile" });
		const profileLookupKey = deriveFactKey(profile);

		expect(profile.fact_key).toBe(profileLookupKey);
		expect(profileCodec.fact_key).toBe(profileLookupKey);
		expect(profileLookupKey).toBe("profile:preferences.books");

		const lesson = buildInsightMetadata(
			{ text: "When a file is missing, re-check the path before planning.", category: "lesson" },
			{ anti_pattern_signature: "path-missing-recheck-before-plan" },
		);
		const lessonCodec = parseInsightMetadata(JSON.stringify(lesson), { category: "lesson" });
		const lessonDedupeKey = deriveFactKey(lesson);

		expect(lesson.fact_key).toBe(lessonDedupeKey);
		expect(lessonCodec.fact_key).toBe(lessonDedupeKey);
		expect(lessonDedupeKey).toBe("lesson:path-missing-recheck-before-plan");
	});
});
