/** @file sno-station-mem-insight-distill-factory.ts
 * @purpose Builds the optional Insight Distill LLM extractor from validated plugin runtime config.
 * @boundary Extractor construction only; capture execution lives in the Ambient Learning hook.
 */

import { createLogger as createDiagnosticLogger } from "@snoai/utils/logger";
const diagnosticLog = createDiagnosticLogger("sno-station-mem:sno-station-mem-insight-distill-factory");
import {
	AtomicInsightDistiller,
	createSignedAtomicMemoryExtractionTransports,
} from "../extraction/atomic-memory-extraction";
import {
	appendAuditEntry,
	type Embedder,
	type MemoryStore,
	type SnoStationMemPluginApi,
	type PluginConfig,
	type PluginObservability,
} from "./sno-station-mem-runtime-dependencies";
import type { AgentLlmPort } from "../../model/agent-llm-port";
import { pickLlmRoutingConfig, resolveLlmRoute } from "../../model/llm-mode-routing";

// Insight Distill factory.

type InsightDistillFactoryConfig = Omit<PluginConfig, "remEnhanced" | "agentNative"> &
	Partial<Pick<PluginConfig, "remEnhanced" | "agentNative">>;

/**
 * Assembles Insight Distill from validated inputs for deterministic plugin lifecycle
 * orchestration.
 */
// LH: Insight Distill is created only when the product mode enables LLM extraction because it changes cost, latency, and evaluation semantics.
// LH: The distilled path uses extracted-memory retrieval quality as its baseline, not raw chunk migration metrics.
// LH: This guard is the main product switch between deterministic capture and LLM-assisted memory formation.
export function buildInsightDistiller(
	api: SnoStationMemPluginApi,
	config: InsightDistillFactoryConfig,
	store: MemoryStore,
	_embedder: Embedder,
	_observability: PluginObservability,
	_sessionUuidProvider: () => string | undefined,
	stateDir: string,
	agentPort?: AgentLlmPort,
): AtomicInsightDistiller | undefined {
	const routing = pickLlmRoutingConfig(config);
	// The product mode gates LLM extraction: local-first never distills, while
	// both supported extraction transports share the routed client below.
	const extractRoute = resolveLlmRoute({
		slot: "memory-extract",
		callLabel: "memory-extract-atomic-generic",
		config: routing,
	});
	if ("off" in extractRoute) {
		diagnosticLog.info("Memory extraction disabled", { outcome: "skipped", reason_code: extractRoute.reason }, { event_name: "memory.sno-station-mem_insight_distill_factory.memory.extraction.disabled", file: "packages/sno-station-mem/src/engine/bindings/sno-station-mem-insight-distill-factory.ts", function: "buildInsightDistiller", site_id: "plugin.sno-station-mem-insight-distill-factory.buildInsightDistiller.8b084be5ca" });
		return undefined;
	}
	if (
		extractRoute.transport !== "chat-completions" &&
		extractRoute.transport !== "agent-host-seam"
	) {
		diagnosticLog.info("Memory extraction transport unavailable", { outcome: "skipped", transport: extractRoute.transport }, { event_name: "memory.sno-station-mem_insight_distill_factory.memory.extraction.transport.unavailable", file: "packages/sno-station-mem/src/engine/bindings/sno-station-mem-insight-distill-factory.ts", function: "buildInsightDistiller", site_id: "plugin.sno-station-mem-insight-distill-factory.buildInsightDistiller.6cdc733c64" });
		return undefined;
	}
	if (extractRoute.transport === "agent-host-seam" && !agentPort) {
		diagnosticLog.info("sno-station-mem insight-distill disabled (host agent binding unavailable)", undefined, {
			event_name: "sno_station_mem.sno-station-mem-insight-distill-factory.sno.station.mem.insight.distill.disabled.host.agent.binding.unavailable",
			file: "packages/sno-station-mem/src/engine/bindings/sno-station-mem-insight-distill-factory.ts",
			function: "buildInsightDistiller",
			site_id: "sno-station-mem-insight-distill-factory.buildInsightDistiller.847c5ab779",
		});
		return undefined;
	}
	// Branch on configuration before selecting the runtime strategy.
	if (config.mode === "local-first") return undefined;
	const llmCfg = config.extraction.llm;
	// Guard llm cfg here so the remaining module behavior path works with normalized inputs.
	if (!llmCfg) {
		throw new Error(`sno-station-mem mode "${config.mode}" requires extraction.llm.preset`);
	}
	// Isolate the plugin lifecycle operation that can fail because of runtime I/O or input shape.
	try {
		const transports = createSignedAtomicMemoryExtractionTransports({
			preset: llmCfg.preset,
			...(llmCfg.apiKey ? { apiKey: llmCfg.apiKey } : {}),
			...(llmCfg.baseURL ? { baseURL: llmCfg.baseURL } : {}),
			...(llmCfg.heliconeApiKey ? { heliconeApiKey: llmCfg.heliconeApiKey } : {}),
			timeoutMs: llmCfg.timeoutMs,
			routing,
			...(agentPort ? { agentPort } : {}),
			onTransportAttempt: ({ adapterSlot, callLabel, transport }) => {
				appendAuditEntry(stateDir, {
					event: "ambient_learning",
					hook: "agent_end",
					resultStatus: "ok",
					decision: "llm_distill_attempted",
					details: { mode: config.mode, adapterSlot, callLabel, transport },
				});
			},
			onProviderResponse: ({ adapterSlot, callLabel, provider, requestId, model, usage }) => {
				appendAuditEntry(stateDir, {
					event: "ambient_learning",
					hook: "agent_end",
					resultStatus: "ok",
					decision: "llm_distill_response",
					details: {
						mode: config.mode,
						adapterSlot,
						callLabel,
						requestId: requestId ?? null,
						provider,
						model: model ?? null,
						usage: usage ? { ...usage, source: "provider-returned" } : null,
					},
				});
			},
		});
		diagnosticLog.info("Memory extraction enabled", { outcome: "success", model: llmCfg.preset }, { event_name: "memory.sno-station-mem_insight_distill_factory.memory.extraction.enabled", file: "packages/sno-station-mem/src/engine/bindings/sno-station-mem-insight-distill-factory.ts", function: "buildInsightDistiller", site_id: "plugin.sno-station-mem-insight-distill-factory.buildInsightDistiller.888f96bfef" });
		return new AtomicInsightDistiller(store, transports, {
			defaultScope: config.scopes.default,
			locale: config.language,
		});
	} catch (err) {
		throw new Error(
			`sno-station-mem insight-distill init failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
