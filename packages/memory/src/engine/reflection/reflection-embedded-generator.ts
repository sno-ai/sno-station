import { FIXED_MEMORY_SNO_AI_EXTRACT } from "../../model/signed-registry-constants";
/** @file reflection-embedded-generator.ts
 * @purpose Builds the LLMIx-backed reflection generator.
 */

import type { ReflectionGenerator } from "./daily-log-generator";
import {
	pruneReflectionDerivedCache,
	type ReflectionDerivedCache,
} from "./derived-line-cache";
import {
	pruneReflectionDerivedSuppression,
	type ReflectionDerivedSuppressionCache,
} from "./derived-suppression-cache";
import type { createErrorSignalTracker } from "../security/error-signals";
import type { AgentLlmPort } from "../../model/agent-llm-port";
import { createLlmClient } from "../../model/llm-client";
import type { LlmRoutingConfig } from "../../../config/plugin-config-mode-schema";
import type { PluginConfig } from "../shared/types";

export const DEFAULT_MEMORY_LLM_CONFIG: NonNullable<PluginConfig["extraction"]["llm"]> = {
	preset: FIXED_MEMORY_SNO_AI_EXTRACT,
	timeoutMs: 30_000,
};

export function isInternalReflectionSessionKey(sessionKey: unknown): boolean {
	return typeof sessionKey === "string" && sessionKey.trim().startsWith("temp:memory-reflection");
}

export function resolveWorkspaceDirFromEvent(context: Record<string, unknown> | undefined): string {
	const runtimePath = typeof context?.workspaceDir === "string" ? context.workspaceDir.trim() : "";
	return runtimePath || process.cwd();
}

export function createReflectionGenerator(
	llmConfig: PluginConfig["extraction"]["llm"] | undefined,
	routing?: LlmRoutingConfig,
	agentPort?: AgentLlmPort,
): ReflectionGenerator {
	return async (prompt: string, timeoutMs: number): Promise<string | null> => {
		if (!llmConfig) return null;
		const client = createLlmClient({
			preset: llmConfig.preset,
			...(llmConfig.apiKey ? { apiKey: llmConfig.apiKey } : {}),
			...(llmConfig.baseURL ? { baseURL: llmConfig.baseURL } : {}),
			...(llmConfig.heliconeApiKey ? { heliconeApiKey: llmConfig.heliconeApiKey } : {}),
			timeoutMs,
			...(routing ? { routing } : {}),
			...(agentPort ? { agentPort } : {}),
		});
		return client.completeText({
			prompt,
			callLabel: "memory-reflection",
			adapterSlot: "summary-build",
			timeoutMs,
		});
	};
}

export function pruneReflectionState(
	errorTracker: ReturnType<typeof createErrorSignalTracker>,
	derivedCache: ReflectionDerivedCache,
	suppressionCache: ReflectionDerivedSuppressionCache,
	ttlMs: number,
	maxSessions: number,
): void {
	errorTracker.prune(ttlMs, maxSessions);
	pruneReflectionDerivedCache(derivedCache, ttlMs, maxSessions);
	pruneReflectionDerivedSuppression(suppressionCache, ttlMs, maxSessions);
}
