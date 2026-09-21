import { createHash } from "node:crypto";
import { configureLogger, createLogger, effectiveLogLevel, loggerFileStatus } from "@snoai/utils/logger";
import packageMetadata from "../../../package.json" with { type: "json" };
import attributeDictionary from "../../../config/attribute-dictionary.json" with { type: "json" };
import { ATOMIC_EXTRACTION_RESPONSE_JSON_SCHEMA } from "../extraction/atomic-extraction-reply";
import { ATOMIC_EXTRACTION_SKILL_HASH } from "../extraction/atomic-extraction-skill";
import type { LlmPreset, MemoryLlmAdapterSlot } from "../../model/llm-client-types";
import { pickLlmRoutingConfig, resolveLlmOccasion, resolveLlmRoute } from "../../model/llm-mode-routing";
import type { LlmRoutingConfigInput } from "../../../config/plugin-config-mode-schema";
import { logSiteCatalog } from "./log-site-catalog.generated";

const APPLICATION_NAME = "sno-station-mem";
const log = createLogger("sno-station-mem:runtime");
let snapshotEmitted = false;
const OCCASION_CALLS: ReadonlyArray<readonly [MemoryLlmAdapterSlot, string]> = [
	["memory-extract", "memory-extract-atomic-generic"],
	["memory-extract", "memory-extract-profile"],
	["dedup-decision", "dedup-decision"],
	["profile-merge", "profile-section-judgment"],
	["profile-merge", "profile-active-task-classify"],
	["profile-merge", "profile-active-task-match"],
	["conflict-adjudication", "conflict-adjudication"],
	["summary-build", "summary-build"],
	["intent-classifier", "intent-classifier"],
	["date-resolution", "date-resolution"],
];

export interface RuntimeDiagnosticSnapshot {
	runtimeMode: "plugin" | "sidecar";
	routing: LlmRoutingConfigInput;
	preset: LlmPreset;
	baseURL?: string;
	hostModel?: unknown;
}

export function initializeRuntimeDiagnostics(): void {
	configureLogger({ app: APPLICATION_NAME, serviceVersion: packageMetadata.version,
		buildId: logSiteCatalog.build_id, catalog: logSiteCatalog });
}

function contentHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function configuredHostModel(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && "primary" in value && typeof value.primary === "string") {
		return value.primary;
	}
	return undefined;
}

function endpointWithoutCredentials(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const endpoint = new URL(value);
		endpoint.username = "";
		endpoint.password = "";
		endpoint.search = "";
		endpoint.hash = "";
		return endpoint.toString();
	} catch { return undefined; }
}

export function emitRuntimeStartSnapshot(input: RuntimeDiagnosticSnapshot): void {
	initializeRuntimeDiagnostics();
	if (snapshotEmitted) return;
	snapshotEmitted = true;
	const hostModel = configuredHostModel(input.hostModel);
	const configuredRouting = pickLlmRoutingConfig(input.routing);
	const directAgent = configuredRouting.agentNative.flavor === "byok";
	const endpoint = endpointWithoutCredentials(input.baseURL);
	const routing = OCCASION_CALLS.map(([slot, callLabel]) => ({
		adapter_slot: slot, call_label: callLabel, occasion: resolveLlmOccasion(slot, callLabel),
		...resolveLlmRoute({ slot, callLabel, config: configuredRouting }),
	}));
	log.info("Memory process started", {
		runtime_mode: input.runtimeMode, product_mode: input.routing.mode,
		occasion_routing: routing,
		tiers: {
			snoRemMem: { preset: input.preset, model: "unavailable", model_reason: "resolved_at_request",
				...(endpoint ? { endpoint } : { route_reason: "resolved_at_request" }) },
			agent: directAgent
				? { model: "unavailable", model_reason: "resolved_at_request", preset: input.preset, transport: "chat-completions" }
				: { model: hostModel ?? "unavailable", model_reason: hostModel ? "host_configuration" : "host_owned_per_request",
					transport: "agent-host-seam" },
		},
		effective_level: effectiveLogLevel(), file_sink: loggerFileStatus(),
		extraction_skill_hash: ATOMIC_EXTRACTION_SKILL_HASH,
		extraction_reply_schema_hash: contentHash(ATOMIC_EXTRACTION_RESPONSE_JSON_SCHEMA),
		attribute_dictionary_hash: contentHash(attributeDictionary),
		config_hash: contentHash({ routing, preset: input.preset, endpoint, hostModel }),
	}, {
		event_name: "memory.process.started", file: "packages/sno-station-mem/src/engine/observability/runtime-diagnostics.ts",
		function: "emitRuntimeStartSnapshot", site_id: "runtime.process.started",
	});
}
