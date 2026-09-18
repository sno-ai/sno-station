import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { pluginConfigSchema } from "../../../../packages/sno-station-mem/src/engine/shared/types.ts";

/**
 * The local ranker, stated explicitly. Nothing in this file exercises the remote
 * reranker, and a mode that resolves to the cross-encoder is refused without its key
 * (owner ruling 2026-08-30), so the fixture names the ranker it has always used.
 */
const LOCAL_RERANK = { retrieval: { rerank: "lightweight" } } as const;

const manifest = JSON.parse(
	readFileSync(resolve(import.meta.dirname, "../../../../apps/mem-claw/openclaw.plugin.json"), "utf8"),
) as {
	configSchema: {
		properties: {
			extraction: {
				properties: {
					llm: { properties: Record<string, unknown> };
				};
			};
		};
	};
	uiHints: Record<string, unknown>;
};
const syncScript = readFileSync(
	resolve(import.meta.dirname, "../../../../dev-scripts/sync-plugin-to-vm.sh"),
	"utf8",
);

describe("mem-claw LLMIx user config", () => {
	it("accepts only the signed LLMIx presets and preserves user transport controls", () => {
		for (const preset of [
			"mem_claw/openai_gpt_5_nano",
			"mem_claw/openrouter_auto",
			"mem_claw/sno_ai_extract",
		] as const) {
			const parsed = pluginConfigSchema.parse({
				...LOCAL_RERANK,
				mode: "rem-enhanced",
				extraction: {
					llm: {
						preset,
						baseURL: "https://llm.example.test/v1",
						apiKey: "test-key",
						heliconeApiKey: "helicone-key",
						timeoutMs: 12_000,
					},
				},
			});
			expect(parsed.extraction.llm).toMatchObject({
				preset,
				baseURL: "https://llm.example.test/v1",
				apiKey: "test-key",
				heliconeApiKey: "helicone-key",
				timeoutMs: 12_000,
			});
		}
	});

	it("rejects unknown presets and old provider/model/gpuPath routing", () => {
		expect(() =>
			pluginConfigSchema.parse({
				...LOCAL_RERANK,
				mode: "rem-enhanced",
				extraction: {
					llm: { preset: "mem_claw/other", apiKey: "test-key" },
				},
			}),
		).toThrow();
		expect(() =>
			pluginConfigSchema.parse({
				...LOCAL_RERANK,
				mode: "rem-enhanced",
				extraction: {
					llm: {
						provider: "openai",
						model: "gpt-4o-mini",
						gpuPath: "extract",
						apiKey: "test-key",
					},
				},
			}),
		).toThrow();
	});

	it("exposes exactly the LLMIx preset control in the OpenClaw manifest", () => {
		const llmProperties = manifest.configSchema.properties.extraction.properties.llm.properties;
		expect(llmProperties.preset).toEqual({
			type: "string",
			enum: [
				"mem_claw/openai_gpt_5_nano",
				"mem_claw/openrouter_auto",
				"mem_claw/sno_ai_extract",
			],
			default: "mem_claw/openai_gpt_5_nano",
		});
		expect(llmProperties.provider).toBeUndefined();
		expect(llmProperties.model).toBeUndefined();
		expect(llmProperties.gpuPath).toBeUndefined();
		expect(manifest.uiHints["extraction.llm.preset"]).toBeDefined();
		expect(manifest.uiHints["extraction.llm.provider"]).toBeUndefined();
		expect(manifest.uiHints["extraction.llm.model"]).toBeUndefined();
		expect(manifest.uiHints["extraction.llm.gpuPath"]).toBeUndefined();
	});

	it("keeps the manifest and VM sync on the product-mode hard cut", () => {
		const rootProperties = manifest.configSchema.properties as Record<string, unknown>;
		const extractionProperties =
			manifest.configSchema.properties.extraction.properties as Record<string, unknown>;
		expect(rootProperties.mode).toBeDefined();
		expect(rootProperties.agentNative).toBeDefined();
		expect(rootProperties.remEnhanced).toBeDefined();
		expect(rootProperties.onboarding).toBeDefined();
		expect(extractionProperties.mode).toBeUndefined();

		expect(syncScript).toContain("--ensure-rem-enhanced");
		expect(syncScript).toContain("check_product_mode_boundary");
		expect(syncScript).toContain('.extraction | has("mode")');
		expect(syncScript).toContain('.config.mode = \\$mode |');
		expect(syncScript).not.toContain(["--ensure", "llm", "distill"].join("-"));
	});
});
