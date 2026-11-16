import {
	FIXED_MEMORY_SNO_CONFLICT_VERDICT,
	FIXED_MEMORY_SNO_EXTRACT_CHAT,
	FIXED_MEMORY_SNO_EXTRACT_PROFILE,
} from "./signed-registry-constants";
import type { LlmPreset } from "./llm-client-types";
import type { ProductMode, LlmOccasion } from "../../config/plugin-config-mode-schema";

export type ModelDestination = "off" | "host" | "sno-gpu";
export type ModelCallId = "E1" | "E2" | "E3" | "E4" | "E5" | "E6" | "E7" | "E8" | "E9" | "E10" | "E11" | "E12" | "E13" | "E14" | "E15" | "E16" | "E17" | "E19" | "E20" | "E21" | "E22" | "E23" | "E24" | "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "T1" | "R1";
export type RsiModelCallId = "R2" | "R3" | "R4" | "R5";
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
// REM Enhanced keeps Sno GPU for extraction and the LoRA-backed calls; the other extraction steps use the agent.
const extractHost = { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" } as const;
const host = { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" } as const;
// Measured 2026-10-13: the missed-figure re-ask recovered 4 of 1144 turns for 22% of GPU time; set it on per mode to use it.
const offByDefault = { "local-first": "off", "agent-native": "off", "rem-enhanced": "off" } as const;
const profile = { "local-first": "host", "agent-native": "host", "rem-enhanced": "host" } as const;
const chat = FIXED_MEMORY_SNO_EXTRACT_CHAT;
const verdict = FIXED_MEMORY_SNO_CONFLICT_VERDICT;

export const MODEL_CALLS: Record<ModelCallId, ModelCall> & Record<RsiModelCallId, {
	description: string;
	calledBy: "Self Learning";
	destinations: Record<ProductMode, ModelDestination>;
}> = {
	E1: { description: "conversation extraction", occasion: "memoryExtract", destinations: extract, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E2: { description: "fact enrichment", occasion: "memoryExtract", destinations: extractHost, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E3: { description: "missed figure recovery", occasion: "memoryExtract", destinations: offByDefault, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E4: { description: "compound record split", occasion: "memoryExtract", destinations: extractHost, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E5: { description: "missing half recovery", occasion: "memoryExtract", destinations: extractHost, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E6: { description: "subject check", occasion: "memoryExtract", destinations: extractHost, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E7: { description: "unresolved subject recovery", occasion: "memoryExtract", destinations: extractHost, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E8: { description: "same entity judgment", occasion: "memoryExtract", destinations: extractHost, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E9: { description: "profile keying", occasion: "memoryExtract", destinations: extract, snoPreset: FIXED_MEMORY_SNO_EXTRACT_PROFILE, transport: { host: "agent-host-seam", snoGpu: "raw-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E10: { description: "arrival retirement judgment", occasion: "conflictAdjudication", destinations: extract, snoPreset: verdict, transport: { host: "agent-host-seam", snoGpu: "raw-completions" }, promptVariant: { host: "adapter-a-chat", snoGpu: "adapter-a-raw" }, replyParser: { host: "json-or-single-token-verdict", snoGpu: "single-token-verdict" } },
	E11: { description: "date resolution", occasion: "dateResolution", destinations: host, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "text", snoGpu: "text" } },
	E12: { description: "background state keying", occasion: "memoryExtract", destinations: extractHost, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E13: { description: "capture mode judgment", occasion: "memoryExtract", destinations: host, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E14: { description: "profile scope judgment", occasion: "memoryExtract", destinations: extract, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	// Model call E15: judge loaded files against memory rows in nightly work.
	E15: { description: "loaded-file judgment", occasion: "memoryExtract", destinations: extractHost, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	// Model call E16: judge existing memory rows during cleanup.
	E16: { description: "cleanup row judgment", occasion: "memoryExtract", destinations: host, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E17: { description: "per-message relevance pick", occasion: "memoryExtract", destinations: { "local-first": "off", "agent-native": "off", "rem-enhanced": "sno-gpu" }, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E19: { description: "session-start label", occasion: "memoryExtract", destinations: extractHost, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E20: { description: "session-start pick", occasion: "memoryExtract", destinations: extractHost, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E21: { description: "write judgement", occasion: "memoryExtract", destinations: host, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E22: { description: "replacement confirmation", occasion: "memoryExtract", destinations: extractHost, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E23: { description: "nightly change confirmation", occasion: "memoryExtract", destinations: extractHost, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	E24: { description: "merged row", occasion: "memoryExtract", destinations: host, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	P1: { description: "profile conflict judgment", occasion: "conflictAdjudication", destinations: extract, snoPreset: verdict, transport: { host: "agent-host-seam", snoGpu: "raw-completions" }, promptVariant: { host: "adapter-a-chat", snoGpu: "adapter-a-raw" }, replyParser: { host: "json-or-single-token-verdict", snoGpu: "single-token-verdict" } },
	P2: { description: "profile lifecycle retirement", occasion: "profileSectionMerge", destinations: profile, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	P3: { description: "profile retirement recheck", occasion: "profileSectionMerge", destinations: profile, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	P4: { description: "profile section judgment", occasion: "profileSectionMerge", destinations: profile, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	P5: { description: "profile section text", occasion: "profileSectionMerge", destinations: profile, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	P6: { description: "retire by name", occasion: "profileSectionMerge", destinations: profile, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	T1: { description: "active task classification and match", occasion: "profileActiveTaskClassify", destinations: host, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "json", snoGpu: "json" } },
	R1: { description: "session reflection", occasion: "summaryBuild", destinations: host, snoPreset: chat, transport: { host: "agent-host-seam", snoGpu: "chat-completions" }, promptVariant: { host: "standard", snoGpu: "standard" }, replyParser: { host: "text", snoGpu: "text" } },
	R2: { description: "label local sessions before the Self Learning cloud upload", calledBy: "Self Learning", destinations: host },
	R3: { description: "upload sessions nightly for Self Learning", calledBy: "Self Learning", destinations: { "local-first": "off", "agent-native": "sno-gpu", "rem-enhanced": "sno-gpu" } },
	R4: { description: "recall one relevant cloud experience on a session's first prompt", calledBy: "Self Learning", destinations: { "local-first": "off", "agent-native": "sno-gpu", "rem-enhanced": "sno-gpu" } },
	R5: { description: "generate local lessons and skill reminders nightly for Self Learning", calledBy: "Self Learning", destinations: { "local-first": "host", "agent-native": "off", "rem-enhanced": "off" } },
};

/** Sno GPU workload label per call (GPU_REQUEST_METADATA_STANDARD): what the caller is doing, one stable value per group. */
export const MODEL_CALL_WORKLOAD: Record<ModelCallId, string> = {
	E1: "station-extract", E2: "station-extract", E3: "station-extract", E4: "station-extract", E5: "station-extract",
	E6: "station-subject", E7: "station-subject", E8: "station-subject",
	E9: "station-profile-key", E12: "station-profile-key",
	E13: "station-capture-mode", E14: "station-profile-scope",
	E15: "station-loaded-file", E16: "station-cleanup",
	E17: "station-recall-pick",
	E19: "station-start-label",
	E20: "station-start-pick",
	E21: "station-verdict", E22: "station-verdict", E23: "station-verdict", E24: "station-extract",
	E10: "station-verdict", P1: "station-verdict",
	P2: "station-profile-merge", P3: "station-profile-merge", P4: "station-profile-merge", P5: "station-profile-merge", P6: "station-profile-merge",
	E11: "station-aux", T1: "station-aux", R1: "station-aux",
};

export function modelCallDestination(callId: ModelCallId, mode: ProductMode,
	modelCalls: Record<keyof typeof MODEL_CALLS, Record<ProductMode, ModelDestination>>): ModelDestination {
	return modelCalls[callId][mode];
}
