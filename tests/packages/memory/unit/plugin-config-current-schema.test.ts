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
		expect(parsed.retrieval.rerankApiKey).toBeUndefined();
	});

	it("gives a keyless remote-ranking mode the local ranker instead of the remote one", () => {
		// Owner ruling 2026-08-30 refused this pair outright; the same day's follow-up
		// (`preserve keyless rerank configs`) kept it loadable and moved it to the local
		// ranker, which is what ships. What the ruling actually forbids — ranking
		// remotely with no key — is still refused, by the case below.
		const parsed = pluginConfigSchema.parse({ mode: "rem-enhanced" });
		expect(parsed.retrieval.rerank).toBe("lightweight");
		expect(parsed.retrieval.rerankApiKey).toBeUndefined();
	});

	it("refuses an explicitly chosen remote ranker when no reranker key is supplied", () => {
		const result = pluginConfigSchema.safeParse({
			mode: "rem-enhanced",
			retrieval: {
				rerank: "cross-encoder",
				rerankProvider: "tei",
				rerankEndpoint: "http://127.0.0.1:19213/rerank",
			},
		});
		expect(result.success).toBe(false);
		const paths = result.success ? [] : result.error.issues.map((issue) => issue.path);
		expect(paths).toContainEqual(["retrieval", "rerankApiKey"]);
	});

	it("keeps the local ranker in every mode when only a reranker key is supplied", () => {
		for (const mode of ["local-first", "agent-native", "rem-enhanced"] as const) {
			const parsed = pluginConfigSchema.parse({
				mode,
				retrieval: { rerankApiKey: "test-rerank-key" },
			});
			expect(parsed.retrieval.rerank).toBe("lightweight");
		}
	});

	it("refuses a remote ranker that names no provider instead of calling one by default", () => {
		const result = pluginConfigSchema.safeParse({
			mode: "rem-enhanced",
			retrieval: { rerank: "cross-encoder", rerankApiKey: "test-rerank-key" },
		});
		expect(result.success).toBe(false);
		const paths = result.success ? [] : result.error.issues.map((issue) => issue.path);
		expect(paths).toContainEqual(["retrieval", "rerankProvider"]);
	});

	it("loads a remote ranker once provider, endpoint and key are all named", () => {
		const parsed = pluginConfigSchema.parse({
			mode: "agent-native",
			retrieval: {
				rerank: "cross-encoder",
				rerankProvider: "tei",
				rerankEndpoint: "http://127.0.0.1:19213/rerank",
				rerankApiKey: "test-rerank-key",
			},
		});
		expect(parsed.retrieval).toMatchObject({
			rerank: "cross-encoder",
			rerankProvider: "tei",
			rerankEndpoint: "http://127.0.0.1:19213/rerank",
		});
	});

	it("keeps an explicitly chosen ranker in a mode whose default is the other one", () => {
		const parsed = pluginConfigSchema.parse({
			mode: "rem-enhanced",
			retrieval: { rerank: "lightweight" },
		});
		expect(parsed.retrieval.rerank).toBe("lightweight");
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
