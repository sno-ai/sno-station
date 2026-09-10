/** @file live-mutation-addressing-real-route.test.ts
 * @purpose Proves model-supplied profile aliases are canonicalized before identity derivation.
 * @boundary Real Sno model route, real profile writer, and fresh encrypted SQLite per repeat.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseInsightMetadata } from "../../../../apps/mem-claw/src/extraction/memory-metadata-codec.ts";
import { runProfileSectionUpdate } from "../../../../apps/mem-claw/src/extraction/profile-section-writer.ts";
import { createLlmClient } from "../../../../apps/mem-claw/src/shared/llm-client.ts";
import { MemoryStore } from "../../../../apps/mem-claw/src/storage/store.ts";
import { requireEnv } from "../helpers/env.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

const REPEAT = Number.parseInt(process.env.LIVE_MUTATION_ADDRESS_REPEAT ?? "1", 10);
const CANONICAL_SECTION = "preferences.renewable_energy";
const MODEL_ALIAS = "interests.renewable-energy";
const modelAddressSchema = z.object({ sectionName: z.literal(MODEL_ALIAS) }).strict();

describe("live mutation canonical addressing", () => {
	it("pairs a model-supplied alias while preserving the cross-section fence", async () => {
		expect(REPEAT).toBeGreaterThanOrEqual(1);
		expect(REPEAT).toBeLessThanOrEqual(3);
		const llm = createLlmClient({
			apiKey: requireEnv("SNO_MEM_CLAW_LLM_INTERNAL_KEY"),
			preset: "mem_claw/sno_ai_extract",
			timeoutMs: 90_000,
		});

		const fixture = createTestDb();
		const store = new MemoryStore({
			dbPath: fixture.dbPath,
			embedder: await createTestEmbedder(),
		});
		try {
				const modelAddress = modelAddressSchema.parse(await llm.completeJson<unknown>({
					prompt: [
						"Return JSON only.",
						`Return exactly {"sectionName":${JSON.stringify(MODEL_ALIAS)}}.`,
						"Do not normalize, explain, or add fields.",
					].join("\n"),
					callLabel: "memory-extract-profile",
					adapterSlot: "memory-extract",
					requestId: `dingo-j-e6f0b9e9-address-extraction-${REPEAT}`,
				}));
				expect(modelAddress).toEqual({ sectionName: MODEL_ALIAS });

				const first = await runProfileSectionUpdate({
					scope: `prd27-address-${REPEAT}`,
					sectionName: modelAddress.sectionName,
					newAssertion: "The user follows renewable energy research.",
					source: { messageId: `prd27-address-first-${REPEAT}` },
					store,
					at: Date.parse("2026-08-04T09:00:00.000Z"),
				});
				const second = await runProfileSectionUpdate({
					scope: `prd27-address-${REPEAT}`,
					sectionName: CANONICAL_SECTION,
					newAssertion: "The user tracks renewable energy storage research.",
					source: { messageId: `prd27-address-second-${REPEAT}` },
					store,
					at: Date.parse("2026-08-04T09:01:00.000Z"),
				});
				const crossSection = await runProfileSectionUpdate({
					scope: `prd27-address-${REPEAT}`,
					sectionName: "preferences.energy_policy",
					newAssertion: "The user tracks renewable energy policy research.",
					source: { messageId: `prd27-address-cross-${REPEAT}` },
					store,
					at: Date.parse("2026-08-04T09:02:00.000Z"),
				});

				const canonical = store.getByFactKey(
					`prd27-address-${REPEAT}`,
					`profile:${CANONICAL_SECTION}`,
				);
				const other = store.getByFactKey(
					`prd27-address-${REPEAT}`,
					"profile:preferences.energy_policy",
				);
				if (!canonical || !other) throw new Error("expected both canonical profile rows");
				expect(second.outcome).toBe("merged");
				expect(second.rowId).not.toBe(first.rowId);
				expect(canonical.id).toBe(second.rowId);
				expect(parseInsightMetadata(canonical.metadata, canonical)).toMatchObject({
					section_name: CANONICAL_SECTION,
					fact_key: `profile:${CANONICAL_SECTION}`,
					supersedes: first.rowId,
				});
				expect(other.id).toBe(crossSection.rowId);
				expect(other.id).not.toBe(canonical.id);
				expect(parseInsightMetadata(other.metadata, other).section_name).toBe(
					"preferences.energy_policy",
				);
		} finally {
			fixture.cleanup();
		}
	});
});
