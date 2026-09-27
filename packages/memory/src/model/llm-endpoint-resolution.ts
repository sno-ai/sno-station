import { FIXED_PROTOCOL_VALUE_69 } from "./signed-registry-constants";
/** @file llm-endpoint-resolution.ts
 * @purpose Resolves signed LLMIx presets into complete sno-station-mem-owned inference endpoints.
 * @boundary The only place an inference origin and path are composed.
 */

import type { LlmPreset, LlmProvider, ResolvedLlmConfig } from "./llm-client-types";
import type { LlmTransport } from "./llm-mode-routing";
import { MODEL_CALLS, type ModelCallId } from "./model-call-table";
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
	callId: ModelCallId;
}): LlmPreset {
	return input.provider === "sno-gpu" ? MODEL_CALLS[input.callId].snoPreset : input.configuredPreset;
}

export async function resolveLlmEndpoint(input: {
	configuredPreset: LlmPreset;
	callId: ModelCallId;
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
				callId: input.callId,
			});
		},
		selectBaseSource: (provider) =>
			input.baseOverride ??
			(provider === "sno-gpu"
				? SNO_GPU_ORIGIN
				: PROVIDER_API_BASES[provider]),
	});
	return {
		...resolved,
		userBaseUrlOverride: input.baseOverride !== undefined,
	};
}
