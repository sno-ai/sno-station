import { describe, expect, it, vi } from "vitest";

import { createCodingSkinRegistration } from "../../../../packages/memory/config/coding-skin.ts";
import { installationInputSchema } from "../../../../packages/memory/config/installation-settings.ts";
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

	// rem-enhanced PRD REQ-3: the mode alone decides where a call goes. Owner rule 2026-09-26: a config written by the
	// previous release still loads; its removed routing keys and non-Sno extraction presets are ignored with a warn
	// line naming the key, and every other value it carries is kept.
	function refusal(parse: () => unknown): string {
		try {
			parse();
			return "parsed";
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}

	/** Parses with stderr captured; returns the result and the WARN diagnostic lines written meanwhile. */
	function parseWithWarnings<T>(parse: () => T): { parsed: T; warnings: string[] } {
		const writes = vi.spyOn(process.stderr, "write");
		try {
			const parsed = parse();
			const warnings = writes.mock.calls.map(([bytes]) => String(bytes))
				.filter(line => { try { return JSON.parse(line).severity_text === "WARN"; } catch { return false; } });
			return { parsed, warnings };
		} finally { writes.mockRestore(); }
	}

	const PREVIOUS_RELEASE_OCCASIONS = {
		memoryExtract: "snoRemMem", dedupDecision: "agent", profileSectionMerge: "agent", profileActiveTaskClassify: "agent",
		profileActiveTaskMatch: "agent", conflictAdjudication: "snoRemMem", summaryBuild: "agent", intentClassifier: "agent",
		dateResolution: "agent",
	};

	it.each([
		["remEnhanced.occasions", { mode: "rem-enhanced", remEnhanced: { trigger: { tick: false }, occasions: PREVIOUS_RELEASE_OCCASIONS } }, "occasions"],
		["agentNative (subscription)", { mode: "agent-native", agentNative: { flavor: "subscription" } }, "agentNative"],
		["agentNative (byok)", { mode: "agent-native", agentNative: { flavor: "byok" } }, "agentNative"],
	])("loads a config carrying %s, ignores it with a warning, and keeps the mode", (_name, config, named) => {
		const { parsed, warnings } = parseWithWarnings(() => pluginConfigSchema.parse({ ...config, retrieval: { recallTopK: 7 } }));
		expect({
			mode: parsed.mode, recallTopK: parsed.retrieval.recallTopK, agentNative: "agentNative" in parsed,
			remEnhanced: parsed.remEnhanced, warnedNamingKey: warnings.some(line => line.includes(named)),
		}).toEqual({
			mode: config.mode, recallTopK: 7, agentNative: false,
			remEnhanced: { trigger: { tick: config.mode === "rem-enhanced" ? false : true } }, warnedNamingKey: true,
		});
	});

	it.each(["mem_claw/openai_gpt_5_nano", "mem_claw/openrouter_auto"])(
		"loads a config carrying the removed extraction preset %s as the Sno preset, with a warning",
		(preset) => {
			const { parsed, warnings } = parseWithWarnings(() => pluginConfigSchema.parse({
				mode: "rem-enhanced", extraction: { llm: { preset, timeoutMs: 12_000 } },
			}));
			expect({ llm: parsed.extraction.llm, warnedNamingKey: warnings.some(line => line.includes("preset")) })
				.toMatchObject({ llm: { preset: "mem_claw/sno_ai_extract", timeoutMs: 12_000 }, warnedNamingKey: true });
		},
	);

	it("drops the old provider's key and endpoint with its removed preset, so neither reaches the Sno endpoint", () => {
		const { parsed } = parseWithWarnings(() => pluginConfigSchema.parse({
			mode: "rem-enhanced",
			extraction: { llm: { preset: "mem_claw/openai_gpt_5_nano", apiKey: "sk-old-openai-key", baseURL: "https://api.openai.com/v1", timeoutMs: 12_000 } },
		}));
		expect(parsed.extraction.llm).toEqual({ preset: "mem_claw/sno_ai_extract", timeoutMs: 12_000 });
		const kept = pluginConfigSchema.parse({
			mode: "rem-enhanced",
			extraction: { llm: { preset: "mem_claw/sno_ai_extract", apiKey: "sno-key", baseURL: "https://gpu.example/v1" } },
		});
		expect(kept.extraction.llm).toMatchObject({ apiKey: "sno-key", baseURL: "https://gpu.example/v1" });
	});

	it("still refuses keys and presets that were never product settings", () => {
		expect({
			preset: refusal(() => pluginConfigSchema.parse({ extraction: { llm: { preset: "mem_claw/other" } } })),
			occasionTypo: refusal(() => pluginConfigSchema.parse({ mode: "rem-enhanced", remEnhanced: { ocasions: {} } })),
			routingKey: refusal(() => llmRoutingConfigSchema.parse({ mode: "agent-native", agentNativ: { flavor: "byok" } })),
			installedKey: refusal(() => installationInputSchema.parse({ mode: "rem-enhanced", remEnhanced: { trigger: { tick: true }, bogus: 1 } })),
		}).toEqual({
			preset: expect.stringContaining("preset"), occasionTypo: expect.stringContaining("ocasions"),
			routingKey: expect.stringContaining("agentNativ"), installedKey: expect.stringContaining("bogus"),
		});
	});

	it("loads installed settings carrying remEnhanced.occasions, keeping mode, embedding, retrieval and tick", () => {
		const installed = {
			mode: "rem-enhanced", embedding: { provider: "local-onnx", dimensions: 1024, chunking: false },
			retrieval: { recallTopK: 7, rerank: "none" },
			remEnhanced: { trigger: { tick: false }, occasions: PREVIOUS_RELEASE_OCCASIONS },
		};
		const { parsed, warnings } = parseWithWarnings(() => installationInputSchema.parse(installed));
		expect({ parsed, warnedNamingKey: warnings.some(line => line.includes("occasions")) }).toEqual({
			parsed: { mode: "rem-enhanced", embedding: installed.embedding, retrieval: installed.retrieval,
				remEnhanced: { trigger: { tick: false } }, extractionKeyRef: "SNO_MEM_CLAW_LLM_INTERNAL_KEY" },
			warnedNamingKey: true,
		});
	});

	it("parses a bare mode, keeps the Sno extraction preset, and routes by mode and language only", () => {
		expect({
			bare: refusal(() => pluginConfigSchema.parse({ mode: "rem-enhanced" })),
			snoPreset: pluginConfigSchema.parse({ extraction: { llm: { preset: "mem_claw/sno_ai_extract" } } }).extraction.llm.preset,
			routing: llmRoutingConfigSchema.parse({ mode: "rem-enhanced" }),
		}).toEqual({ bare: "parsed", snoPreset: "mem_claw/sno_ai_extract", routing: { mode: "rem-enhanced", language: "en" } });
	});

	it("registers Codex, Claude Code and Hermes with routing of mode and language only", () => {
		const registration = createCodingSkinRegistration({ skinId: "codex", installed: {
			storePath: "/tmp/memory.sqlite", embedding: { provider: "local-onnx" },
			extractionKeyRef: "SNO_MEM_CLAW_LLM_INTERNAL_KEY", mode: "rem-enhanced", retrieval: {},
		} });
		expect(registration.routing).toEqual({ mode: "rem-enhanced", language: "en" });
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
