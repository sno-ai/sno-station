/** @file reflection-deps.ts
 * @purpose Defines dependency contracts shared by reflection hook registration.
 * @boundary Types only; no runtime hook wiring or side effects.
 */

import type { createEmbedder } from "../extraction/embedding-provider-client";
import type { createScopePolicy } from "../security/scopes";
import type { AgentLlmPort } from "../../model/agent-llm-port";
import type { MemoryStore } from "../../store/store";
import type { MemoryTelemetryUsageOutbox } from "../telemetry/memory-telemetry-outbox";

export interface ReflectionDeps {
	store: MemoryStore;
	embedder: ReturnType<typeof createEmbedder>;
	scopePolicy: ReturnType<typeof createScopePolicy>;
	parseAgentIdFromSessionKey: (sessionKey: string | undefined) => string | undefined;
	telemetryUsage?: MemoryTelemetryUsageOutbox;
	agentPort?: AgentLlmPort;
	/** Invoked once the reflection slice cache is built, exposing its invalidator. */
	onSliceCacheReady?: (clearAll: () => void) => void;
}
