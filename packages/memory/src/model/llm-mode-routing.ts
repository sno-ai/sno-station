/** @file llm-mode-routing.ts
 * @purpose Request-time LLM route resolution: (slot, callLabel, mode) → tier target or OFF.
 * @boundary Pure decision logic; no I/O, no client construction, no transport code.
 */

import type { MemoryLlmAdapterSlot } from "./llm-client-types";
import {
	type LlmOccasion,
	type LlmRoutingConfig,
	type LlmRoutingConfigInput,
	type LlmTier,
	llmRoutingConfigSchema,
} from "../../config/plugin-config-mode-schema";

export type { LlmRoutingConfig };

export type LlmTransport = "chat-completions" | "raw-completions" | "agent-host-seam";

export type LlmParser =
	| "json"
	| "json-or-single-token-verdict"
	| "single-token-verdict"
	| "text";

export type LlmRouteTarget = {
	tier: LlmTier;
	transport: LlmTransport;
	parser: LlmParser;
};

export type LlmRouteOff = {
	off: true;
	reason: "mode-local-first" | "unknown-call-label" | "slot-retired";
};

export type LlmRouteDecision = LlmRouteTarget | LlmRouteOff;

/**
 * The profile-merge slot splits into three occasions by callLabel. The label
 * set is a closed enum: any other label on this slot fails closed (OFF), so a
 * mislabeled destructive mutation can never ride a slot-level default.
 */
const PROFILE_MERGE_OCCASIONS: Record<string, LlmOccasion> = {
	"profile-section-judgment": "profileSectionMerge",
	"profile-section-text": "profileSectionMerge",
	// PRD 130's lifecycle classification shipped without this row, so the call failed closed
	// on every run and the work stayed deferred (measured 2026-09-01: "no LLM occasion").
	"profile-section-lifecycle-retirement": "profileSectionMerge",
	"profile-retirement-recheck": "profileSectionMerge",
	"profile-active-task-classify": "profileActiveTaskClassify",
	"profile-active-task-match": "profileActiveTaskMatch",
};

const MEMORY_EXTRACT_CALL_LABELS = new Set([
	"memory-extract-episodic",
	"memory-extract-atomic-generic",
	"memory-extract-atomic-missing-half",
	"memory-extract-atomic-resplit",
	"memory-extract-atomic-subject-guard",
	"memory-extract-fallback-projection-gate",
	"memory-extract-profile",
	"memory-extract-profile-gate",
	"rem-replace-clause-carry",
	"rem-replace-clauses",
	"rem-replace-coverage",
	"rem-update-judgment",
	"rem-update-verification",
	"rem-update-relation-judgment",
	"rem-update-retirement-target",
]);

export function resolveLlmOccasion(
	slot: MemoryLlmAdapterSlot,
	callLabel: string,
): LlmOccasion | undefined {
	switch (slot) {
		case "memory-extract": {
			if (!MEMORY_EXTRACT_CALL_LABELS.has(callLabel)) {
				throw new Error(`Unknown LLM call label ${JSON.stringify(callLabel)} for slot ${slot}`);
			}
			return "memoryExtract";
		}
		case "dedup-decision":
			return "dedupDecision";
		case "profile-merge":
			return PROFILE_MERGE_OCCASIONS[callLabel];
		case "conflict-adjudication":
			return "conflictAdjudication";
		case "summary-build":
			return "summaryBuild";
		case "date-resolution":
			if (callLabel !== "date-resolution") {
				throw new Error(`Unknown LLM call label ${JSON.stringify(callLabel)} for slot ${slot}`);
			}
			return "dateResolution";
		case "intent-classifier":
			return "intentClassifier";
		case "compaction-merge":
			// Compaction is retired dead code; the slot survives in the enum only.
			return undefined;
	}
}

function snoRemMemTarget(occasion: LlmOccasion): LlmRouteTarget {
	if (occasion === "conflictAdjudication") {
		// Adapter A judges on the raw-completions surface with a one-token verdict.
		return { tier: "snoRemMem", transport: "raw-completions", parser: "single-token-verdict" };
	}
	return { tier: "snoRemMem", transport: "chat-completions", parser: "json" };
}

function agentTarget(occasion: LlmOccasion, routing: LlmRoutingConfig): LlmRouteTarget {
	return {
		tier: "agent",
		transport: routing.agentNative.flavor === "byok" ? "chat-completions" : "agent-host-seam",
		parser: occasion === "conflictAdjudication" ? "json-or-single-token-verdict" : "json",
	};
}

/** Extracts and schema-defaults the routing slice from any config carrying it. */
export function pickLlmRoutingConfig(config: LlmRoutingConfigInput): LlmRoutingConfig {
	return llmRoutingConfigSchema.parse({
		mode: config.mode,
		remEnhanced: config.remEnhanced,
		agentNative: config.agentNative,
		language: config.language,
	});
}

/**
 * Resolve one LLM call to its tier target, or OFF. OFF is a graceful no-op
 * for the caller (its deterministic fallback runs), never an error. There is
 * no substitute-tier fallback anywhere: a route resolves to exactly the
 * configured tier or to OFF.
 */
export function resolveLlmRoute(input: {
	slot: MemoryLlmAdapterSlot;
	callLabel: string;
	config: LlmRoutingConfigInput;
}): LlmRouteDecision {
	const { slot, callLabel } = input;
	const routing = pickLlmRoutingConfig(input.config);
	if (slot === "compaction-merge") {
		return { off: true, reason: "slot-retired" };
	}
	const occasion = resolveLlmOccasion(slot, callLabel);
	if (occasion === undefined) {
		return { off: true, reason: "unknown-call-label" };
	}
	switch (routing.mode) {
		case "local-first":
			return { off: true, reason: "mode-local-first" };
		case "agent-native":
			return agentTarget(occasion, routing);
		case "rem-enhanced": {
			const tier = routing.remEnhanced.occasions[occasion];
			if (slot === "memory-extract") {
				if (tier === "snoRemMem") {
					return callLabel === "memory-extract-profile"
						? { tier: "snoRemMem", transport: "raw-completions", parser: "json" }
						: { tier: "snoRemMem", transport: "chat-completions", parser: "json" };
				}
				return agentTarget(occasion, routing);
			}
			if (tier === "snoRemMem") {
				return snoRemMemTarget(occasion);
			}
			return agentTarget(occasion, routing);
		}
	}
}
