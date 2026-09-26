import { describe, expect, it } from "vitest";
import {
	selectEndpointPreset,
} from "../../../../packages/memory/src/model/llm-endpoint-resolution.ts";
import type { ResolvedLlmConfig } from "../../../../packages/memory/src/model/llm-client-types.ts";
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
