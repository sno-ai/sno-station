import { describe, expect, it } from "vitest";
import {
	selectEndpointPreset,
} from "../../../../packages/memory/src/model/llm-endpoint-resolution.ts";
import type { ResolvedLlmConfig } from "../../../../packages/memory/src/model/llm-client-types.ts";
import { resolveProviderApiKey } from "../../../../packages/memory/src/model/llm-provider-transport.ts";
import { materializeBundledLlmixEndpoint } from "../../../../packages/memory/src/model/llmix-registry.ts";

function snoPreset(path: string): ResolvedLlmConfig {
	return {
		preset: "mem_claw/sno_extract_chat",
		provider: "sno-gpu",
		model: "qwen3.8-27b-extract",
		providerOptions: { "sno-gpu": { gpuPath: path } },
	};
}

describe("LLM endpoint resolution", () => {
	it("accepts a trailing-slash ccproxy override without an API key", () => {
		expect(
			resolveProviderApiKey(
				{
					preset: "mem_claw/openai_gpt_5_nano",
					baseURL: "http://localhost:8070/codex/v1/",
				},
				{
					preset: "mem_claw/openai_gpt_5_nano",
					provider: "openai",
					model: "gpt-5.6-terra",
				},
				true,
			),
		).toBe("ccproxy-placeholder");
	});

	it.each([
		["E1", "mem_claw/sno_extract_chat"],
		["E9", "mem_claw/sno_extract_profile"],
		["E10", "mem_claw/sno_conflict_verdict"],
		["P1", "mem_claw/sno_conflict_verdict"],
		["REM1", "mem_claw/sno_conflict_verdict"],
		["REM2", "mem_claw/sno_extract_chat"],
	] as const)("selects call %s's signed Sno GPU preset", (callId, expected) => {
		expect(
			selectEndpointPreset({
				configuredPreset: "mem_claw/sno_ai_extract",
				provider: "sno-gpu",
				callId,
			}),
		).toBe(expected);
	});

	it("keeps the configured preset for a non-Sno provider", () => {
		expect(
			selectEndpointPreset({
				configuredPreset: "mem_claw/openai_gpt_5_nano",
				provider: "openai",
				callId: "E10",
			}),
		).toBe("mem_claw/openai_gpt_5_nano");
	});

	it("accepts the recorded Tailscale GPU origin over internal HTTP", () => {
		expect(
			materializeBundledLlmixEndpoint({
				preset: snoPreset("/extract/v1/chat/completions"),
				baseSource: "http://100.100.200.71:8080",
			}),
		).toMatchObject({ url: "http://100.100.200.71:8080/extract/v1/chat/completions" });
	});

	it("rejects unapproved HTTP endpoint hosts", () => {
		expect(() =>
			materializeBundledLlmixEndpoint({
				preset: snoPreset("/extract/v1/chat/completions"),
				baseSource: "http://gpu.example.test:8080",
			}),
		).toThrow(/must use https/);
	});

	it("uses the Sno origin default for a preset-only fresh install", () => {
		expect(
			materializeBundledLlmixEndpoint({
				preset: snoPreset("/extract/v1/chat/completions"),
				baseSource: "https://rt3-llm.sno.ai",
			}),
		).toMatchObject({ url: "https://rt3-llm.sno.ai/extract/v1/chat/completions" });
	});

	it.each([
		"https://gpu.example.test",
		"https://gpu.example.test/extract/v1",
		"https://gpu.example.test/extract/v1/",
	])("treats a configured Sno base as an origin source: %s", (baseOverride) => {
		expect(
			materializeBundledLlmixEndpoint({
				preset: snoPreset("/extract/profile/v1/completions"),
				baseSource: baseOverride,
			}),
		).toMatchObject({ url: "https://gpu.example.test/extract/profile/v1/completions" });
	});

	it.each([
		["openai", "mem_claw/openai_gpt_5_nano", "http://localhost:8070/codex/v1/chat/completions"],
		["openrouter", "mem_claw/openrouter_auto", "https://openrouter.ai/api/v1/chat/completions"],
	] as const)("materializes the %s provider endpoint inside the boundary", (provider, preset, url) => {
		expect(
			materializeBundledLlmixEndpoint({
				preset: {
					preset,
					provider,
					model: "test-model",
				},
				baseSource:
					provider === "openai"
						? "http://localhost:8070/codex/v1"
						: "https://openrouter.ai/api/v1",
			}),
		).toMatchObject({ url });
	});

	it("ignores internal endpoint paths on third-party provider presets", () => {
		expect(
			materializeBundledLlmixEndpoint({
				preset: {
					preset: "mem_claw/openrouter_auto",
					provider: "openrouter",
					model: "test-model",
					providerOptions: { "sno-gpu": { gpuPath: "v2/responses" } },
				},
				baseSource: "https://openrouter.ai/api/v1",
			}),
		).toMatchObject({ url: "https://openrouter.ai/api/v1/chat/completions" });
	});

	it("fails closed when a Sno signed preset has no path", () => {
		expect(() =>
			materializeBundledLlmixEndpoint({
				preset: {
					preset: "mem_claw/sno_extract_chat",
					provider: "sno-gpu",
					model: "qwen3.8-27b-extract",
				},
				baseSource: "https://rt3-llm.sno.ai",
			}),
		).toThrow(/signed endpoint path/);
	});
});
