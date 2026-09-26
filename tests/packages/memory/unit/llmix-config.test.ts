import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import { pluginConfigSchema } from "../../../../packages/memory/src/engine/shared/types.ts";

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
		for (const preset of ["mem_claw/sno_ai_extract"] as const) {
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

	it("reads the removed presets as the Sno preset and rejects unknown presets and old provider/model/gpuPath routing", () => {
		for (const preset of ["mem_claw/openai_gpt_5_nano", "mem_claw/openrouter_auto"]) {
			expect(pluginConfigSchema.parse({
				...LOCAL_RERANK, mode: "rem-enhanced", extraction: { llm: { preset, apiKey: "test-key" } },
			}).extraction.llm).toMatchObject({ preset: "mem_claw/sno_ai_extract", apiKey: "test-key" });
		}
		expect(() =>
			pluginConfigSchema.parse({
				...LOCAL_RERANK,
				mode: "rem-enhanced",
				extraction: {
					llm: { preset: "mem_claw/other", apiKey: "test-key" },
				},
			}),
		).toThrow(/preset/);
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

	it("exposes exactly the LLMIx preset control in the OpenClaw manifest, still loading the removed presets", () => {
		const llmProperties = manifest.configSchema.properties.extraction.properties.llm.properties;
		expect(llmProperties.preset).toMatchObject({ type: "string", default: "mem_claw/sno_ai_extract" });
		expect(new Set((llmProperties.preset as { enum: string[] }).enum))
			.toEqual(new Set(["mem_claw/sno_ai_extract", "mem_claw/openai_gpt_5_nano", "mem_claw/openrouter_auto"]));
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
		// agentNative and remEnhanced.occasions stay declared only so an older installation still loads (owner, 2026-09-26).
		expect(rootProperties.agentNative).toBeDefined();
		expect(Object.keys((rootProperties.remEnhanced as { properties: object }).properties).sort()).toEqual(["occasions", "trigger"]);
		expect(rootProperties.onboarding).toBeDefined();
		expect(extractionProperties.mode).toBeUndefined();

		expect(syncScript).toContain("--ensure-rem-enhanced");
		expect(syncScript).toContain("check_product_mode_boundary");
		expect(syncScript).toContain('.extraction | has("mode")');
		expect(syncScript).toContain('.config.mode = \\$mode |');
		expect(syncScript).not.toContain(["--ensure", "llm", "distill"].join("-"));
	});

	// OpenClaw validates the plugin entry against this manifest schema before it loads the plugin; a config written by
	// the previous release must pass that check and the runtime parse, and a key that never existed must still fail.
	it("loads an OpenClaw config written by the previous release through the manifest schema and the runtime parse", () => {
		const ajv = new Ajv({ allErrors: true, strict: false });
		const validate = ajv.compile(manifest.configSchema);
		const previousRelease = {
			mode: "agent-native",
			agentNative: { flavor: "byok" },
			extraction: { llm: { preset: "mem_claw/openai_gpt_5_nano" } },
		};
		const withOccasions = { mode: "rem-enhanced", remEnhanced: { trigger: { tick: true }, occasions: { memoryExtract: "snoRemMem" } } };
		const verdict = (config: unknown) => validate(config) ? "valid" : ajv.errorsText(validate.errors);
		expect({
			previousRelease: verdict(previousRelease),
			withOccasions: verdict(withOccasions),
			neverAKey: verdict({ mode: "agent-native", agentNativ: { flavor: "byok" } }),
			neverAPreset: verdict({ extraction: { llm: { preset: "mem_claw/other" } } }),
		}).toEqual({
			previousRelease: "valid", withOccasions: "valid",
			neverAKey: expect.stringContaining("additional properties"), neverAPreset: expect.stringContaining("allowed values"),
		});
		const parsed = pluginConfigSchema.parse(previousRelease);
		expect({ mode: parsed.mode, preset: parsed.extraction.llm.preset, agentNative: "agentNative" in parsed })
			.toEqual({ mode: "agent-native", preset: "mem_claw/sno_ai_extract", agentNative: false });
	});
});
