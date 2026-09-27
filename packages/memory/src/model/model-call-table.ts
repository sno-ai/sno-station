import {
	FIXED_MEMORY_SNO_CONFLICT_VERDICT,
	FIXED_MEMORY_SNO_EXTRACT_CHAT,
	FIXED_MEMORY_SNO_EXTRACT_PROFILE,
} from "./signed-registry-constants";
import type { LlmPreset } from "./llm-client-types";
import type { ProductMode, LlmOccasion } from "../../config/plugin-config-mode-schema";

export type ModelDestination = "off" | "host" | "sno-gpu";
export type ModelCallId = "E1" | "E2" | "E3" | "E4" | "E5" | "E6" | "E7" | "E8" | "E9" | "E10" | "E11" | "E12" | "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "T1" | "R1" | "REM1" | "REM2" | "REM3" | "REM4" | "REM5" | "REM6" | "REM7" | "REM8";
export type RsiModelCallId = "R2" | "R3" | "R4";
type ModelCall = {
	description: string;
	occasion: LlmOccasion;
	destinations: Record<ProductMode, ModelDestination>;
	snoPreset: LlmPreset;
	transport: { host: "agent-host-seam"; snoGpu: "chat-completions" | "raw-completions" };
	promptVariant: { host: "standard" | "adapter-a-chat"; snoGpu: "standard" | "adapter-a-raw" };
	replyParser: { host: "json" | "text" | "json-or-single-token-verdict"; snoGpu: "json" | "text" | "single-token-verdict" };
};

const extract = { "local-first": "off", "agent-native": "host", "rem-enhanced": "sno-gpu" } as const;
const host = { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" } as const;
const profile = { "local-first": "host", "agent-native": "host", "rem-enhanced": "host" } as const;
const rem = { "local-first": "host", "agent-native": "host", "rem-enhanced": "sno-gpu" } as const;
const remHost = { "local-first": "host", "agent-native": "host", "rem-enhanced": "host" } as const;
const chat = FIXED_MEMORY_SNO_EXTRACT_CHAT;
const verdict = FIXED_MEMORY_SNO_CONFLICT_VERDICT;

export const MODEL_CALLS: Record<ModelCallId, ModelCall> & Record<RsiModelCallId, {
	description: string;
	calledBy: "RSI skill";
	destinations: Record<ProductMode, ModelDestination>;
}> = {
	E1: { description: "conversation extraction", occasion: "memoryExtract", destinations: extract, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E2: { description: "fact enrichment", occasion: "memoryExtract", destinations: extract, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E3: { description: "missed figure recovery", occasion: "memoryExtract", destinations: extract, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E4: { description: "compound record split", occasion: "memoryExtract", destinations: extract, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E5: { description: "missing half recovery", occasion: "memoryExtract", destinations: extract, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E6: { description: "subject check", occasion: "memoryExtract", destinations: extract, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E7: { description: "unresolved subject recovery", occasion: "memoryExtract", destinations: extract, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E8: { description: "same entity judgment", occasion: "memoryExtract", destinations: extract, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E9: { description: "profile keying", occasion: "memoryExtract", destinations: extract, snoPreset: FIXED_MEMORY_SNO_EXTRACT_PROFILE, transport: { host: "agent-host-seam", snoGpu: "raw-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E10: { description: "arrival retirement judgment", occasion: "conflictAdjudication", destinations: extract, snoPreset: verdict, transport: { host: "agent-host-seam", snoGpu: "raw-completions" }, promptVariant: { host: "adapter-a-chat", snoGpu: "adapter-a-raw" }, replyParser: { host: "json-or-single-token-verdict", snoGpu: "single-token-verdict" } },
	E11: { description: "date resolution", occasion: "dateResolution", destinations: host, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "text", snoGpu: "text" } },
	E12: { description: "background state keying", occasion: "memoryExtract", destinations: extract, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	P1: { description: "profile conflict judgment", occasion: "conflictAdjudication", destinations: extract, snoPreset: verdict, transport: { host: "agent-host-seam", snoGpu: "raw-completions" }, promptVariant: { host: "adapter-a-chat", snoGpu: "adapter-a-raw" }, replyParser: { host: "json-or-single-token-verdict", snoGpu: "single-token-verdict" } },
	P2: { description: "profile lifecycle retirement", occasion: "profileSectionMerge", destinations: profile, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	P3: { description: "profile retirement recheck", occasion: "profileSectionMerge", destinations: profile, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	P4: { description: "profile section judgment", occasion: "profileSectionMerge", destinations: profile, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	P5: { description: "profile section text", occasion: "profileSectionMerge", destinations: profile, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	P6: { description: "retire by name", occasion: "profileSectionMerge", destinations: profile, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	T1: { description: "active task classification and match", occasion: "profileActiveTaskClassify", destinations: host, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	R1: { description: "session reflection", occasion: "summaryBuild", destinations: host, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "text", snoGpu: "text" } },
	R2: { description: "label local sessions before the nightly cloud upload", calledBy: "RSI skill", destinations: host },
	R3: { description: "upload sessions nightly for cloud experience and skill review", calledBy: "RSI skill", destinations: { "local-first": "off", "agent-native": "sno-gpu", "rem-enhanced": "sno-gpu" } },
	R4: { description: "recall one relevant cloud experience on a session's first prompt", calledBy: "RSI skill", destinations: { "local-first": "off", "agent-native": "sno-gpu", "rem-enhanced": "sno-gpu" } },
	REM1: { description: "replace conflict pair", occasion: "conflictAdjudication", destinations: rem, snoPreset: verdict, transport: { host: "agent-host-seam", snoGpu: "raw-completions" }, promptVariant: { host: "adapter-a-chat", snoGpu: "adapter-a-raw" }, replyParser: { host: "json-or-single-token-verdict", snoGpu: "single-token-verdict" } },
	REM2: { description: "replace clauses", occasion: "memoryExtract", destinations: remHost, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	REM3: { description: "replace coverage", occasion: "memoryExtract", destinations: rem, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	REM4: { description: "replace clause carry", occasion: "memoryExtract", destinations: rem, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	REM5: { description: "update judgment", occasion: "memoryExtract", destinations: rem, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	REM6: { description: "update verification", occasion: "memoryExtract", destinations: remHost, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	REM7: { description: "update relation", occasion: "memoryExtract", destinations: remHost, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	REM8: { description: "update retirement target", occasion: "memoryExtract", destinations: remHost, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
};

export function modelCallDestination(callId: ModelCallId, mode: ProductMode,
	modelCalls: Record<keyof typeof MODEL_CALLS, Record<ProductMode, ModelDestination>>): ModelDestination {
	return modelCalls[callId][mode];
}
