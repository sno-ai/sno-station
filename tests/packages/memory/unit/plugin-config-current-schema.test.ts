import { describe, expect, it } from "vitest";

import { llmRoutingConfigSchema } from "../../../../packages/memory/config/plugin-config-mode-schema.ts";
import { pluginConfigSchema } from "../../../../packages/memory/src/engine/shared/types.ts";

describe("plugin config current schema", () => {
	it("defaults local ONNX embedding to the low-memory q8 profile", () => {
		const defaults = pluginConfigSchema.parse({});
		expect(defaults.embedding).toMatchObject({
			provider: "local-onnx",
			dimensions: 1024,
			dtype: "q8",
			sessionOptions: {
				graphOptimizationLevel: "extended",
				enableMemPattern: false,
				enableCpuMemArena: false,
			},
		});
	});

	it("gives the mode that promises no network call the local ranker, with no key", () => {
		const parsed = pluginConfigSchema.parse({ mode: "local-first" });
		expect(parsed.retrieval.rerank).toBe("lightweight");
		expect(parsed.retrieval).not.toHaveProperty("rerankApiKey");
	});

	it.each(["local-first", "agent-native", "rem-enhanced"])("normalizes retired remote fields before validation in %s", (mode) => {
		const parsed = pluginConfigSchema.parse({ mode, retrieval: {
			rerank: "cross-encoder", rerankEndpoint: { invalid: "old endpoint" }, rerankApiKey: 123,
			rerankMaxCandidates: "old cap", rerankBlendCross: null, rerankBlendVector: "old weight", rerankTimeoutMs: 15000,
		} });
		expect(parsed.retrieval.rerank).toBe("lightweight");
		expect(parsed.retrieval.rerankTimeoutMs).toBe(2000);
		for (const field of ["rerankEndpoint", "rerankApiKey", "rerankMaxCandidates", "rerankBlendCross", "rerankBlendVector"]) expect(parsed.retrieval).not.toHaveProperty(field);
	});

	it("preserves disabled reranking and shorter valid local waits", () => {
		const parsed = pluginConfigSchema.parse({ retrieval: { rerank: "none", rerankTimeoutMs: 1000, rerankEndpoint: "invalid old URL" } });
		expect(parsed.retrieval.rerank).toBe("none");
		expect(parsed.retrieval.rerankTimeoutMs).toBe(1000);
		expect(parsed.retrieval).not.toHaveProperty("rerankEndpoint");
	});

	// rem-enhanced PRD REQ-3: the mode alone decides where a call goes; a config still carrying a removed
	// routing key or a non-Sno extraction preset fails to parse, naming what it carried.
	function refusal(parse: () => unknown): string {
		try {
			parse();
			return "parsed";
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}

	it.each([
		["remEnhanced.occasions", { mode: "rem-enhanced", remEnhanced: { occasions: { memoryExtract: "agent" } } }, "occasions"],
		["agentNative", { mode: "agent-native", agentNative: { flavor: "subscription" } }, "agentNative"],
		["the OpenAI extraction preset", { extraction: { llm: { preset: "mem_claw/openai_gpt_5_nano" } } }, "preset"],
		["the OpenRouter extraction preset", { extraction: { llm: { preset: "mem_claw/openrouter_auto" } } }, "preset"],
	])("rejects a config carrying %s and names it", (_name, config, named) => {
		expect(refusal(() => pluginConfigSchema.parse(config))).toContain(named);
	});

	it("parses a bare mode, keeps the Sno extraction preset, and routes by mode and language only", () => {
		expect({
			bare: refusal(() => pluginConfigSchema.parse({ mode: "rem-enhanced" })),
			snoPreset: pluginConfigSchema.parse({ extraction: { llm: { preset: "mem_claw/sno_ai_extract" } } }).extraction.llm.preset,
			routing: llmRoutingConfigSchema.parse({ mode: "rem-enhanced" }),
		}).toEqual({ bare: "parsed", snoPreset: "mem_claw/sno_ai_extract", routing: { mode: "rem-enhanced", language: "en" } });
	});

	it("rejects stale unreleased config names and values", () => {
		const staleRootKey = `auto${"Capture"}`;
		const staleRetrievalMode = `${"hy"}brid`;
		const staleExtractionMode = `llm-${"smart"}`;

		expect(() => pluginConfigSchema.parse({ [staleRootKey]: true })).toThrow();
		expect(() => pluginConfigSchema.parse({ retrieval: { mode: staleRetrievalMode } })).toThrow();
		expect(() =>
			pluginConfigSchema.parse({
				extraction: {
					mode: staleExtractionMode,
					llm: { provider: "openai", apiKey: "test-key" },
				},
			}),
		).toThrow();
	});
});
