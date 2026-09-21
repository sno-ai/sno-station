import { FIXED_MEMORY_SNO_CONFLICT_VERDICT, FIXED_MEMORY_SNO_EXTRACT_CHAT, FIXED_MEMORY_SNO_EXTRACT_PROFILE, FIXED_PROTOCOL_VALUE_69 } from "./signed-registry-constants";
/** @file llm-endpoint-resolution.ts
 * @purpose Resolves signed LLMIx presets into complete sno-station-mem-owned inference endpoints.
 * @boundary The only place an inference origin and path are composed.
 */

import type { LlmPreset, LlmProvider, ResolvedLlmConfig } from "./llm-client-types";
import type { LlmTransport } from "./llm-mode-routing";
import type { LlmOccasion } from "../../config/plugin-config-mode-schema";
import {
	resolveBundledLlmixPreset,
	resolveConfiguredBundledLlmixEndpoint,
} from "./llmix-registry";

const SNO_GPU_ORIGIN = "https://rt3-llm.sno.ai";
const PROVIDER_API_BASES: Record<Exclude<LlmProvider, "sno-gpu">, string> = {
	openai: FIXED_PROTOCOL_VALUE_69,
	openrouter: "https://openrouter.ai/api/v1",
};

type EndpointTransport = Exclude<LlmTransport, "agent-host-seam">;

export type ResolvedLlmEndpoint = {
	url: string;
	preset: ResolvedLlmConfig;
	userBaseUrlOverride: boolean;
};

export async function resolveSignedPreset(presetId: LlmPreset): Promise<ResolvedLlmConfig> {
	return resolveBundledLlmixPreset(presetId);
}

export function selectEndpointPreset(input: {
	configuredPreset: LlmPreset;
	provider: LlmProvider;
	occasion: LlmOccasion;
	transport: EndpointTransport;
}): LlmPreset {
	if (input.provider !== "sno-gpu") return input.configuredPreset;
	if (input.occasion === "conflictAdjudication") return FIXED_MEMORY_SNO_CONFLICT_VERDICT;
	if (input.occasion === "memoryExtract" && input.transport === "raw-completions") {
		return FIXED_MEMORY_SNO_EXTRACT_PROFILE;
	}
	return FIXED_MEMORY_SNO_EXTRACT_CHAT;
}

export async function resolveLlmEndpoint(input: {
	configuredPreset: LlmPreset;
	occasion: LlmOccasion;
	transport: EndpointTransport;
	baseOverride?: string;
}): Promise<ResolvedLlmEndpoint> {
	const resolved = await resolveConfiguredBundledLlmixEndpoint({
		configuredPresetId: input.configuredPreset,
		selectEndpointPreset: (provider) => {
			if (input.transport !== "chat-completions" && provider !== "sno-gpu") {
				throw new Error(`sno-station-mem llm-client: ${provider} does not support ${input.transport}`);
			}
			return selectEndpointPreset({
				configuredPreset: input.configuredPreset,
				provider,
				occasion: input.occasion,
				transport: input.transport,
			});
		},
		selectBaseSource: (provider) =>
			input.baseOverride ??
			(provider === "sno-gpu"
				? process.env.GPU_BASE_URL?.trim() || SNO_GPU_ORIGIN
				: PROVIDER_API_BASES[provider]),
	});
	return {
		...resolved,
		userBaseUrlOverride: input.baseOverride !== undefined,
	};
}
