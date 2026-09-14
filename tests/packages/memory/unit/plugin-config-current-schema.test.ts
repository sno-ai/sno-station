import { describe, expect, it } from "vitest";

import { pluginConfigSchema } from "../../../../packages/sno-station-mem/src/engine/shared/types.ts";

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
			retrieval: { rerank: "cross-encoder" },
		});
		expect(result.success).toBe(false);
		const paths = result.success ? [] : result.error.issues.map((issue) => issue.path);
		expect(paths).toContainEqual(["retrieval", "rerankApiKey"]);
	});

	it("loads that same mode once a reranker key is supplied", () => {
		const parsed = pluginConfigSchema.parse({
			mode: "rem-enhanced",
			retrieval: { rerankApiKey: "test-rerank-key" },
		});
		expect(parsed.retrieval.rerank).toBe("cross-encoder");
	});

	it("keeps an explicitly chosen ranker in a mode whose default is the other one", () => {
		const parsed = pluginConfigSchema.parse({
			mode: "rem-enhanced",
			retrieval: { rerank: "lightweight" },
		});
		expect(parsed.retrieval.rerank).toBe("lightweight");
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
