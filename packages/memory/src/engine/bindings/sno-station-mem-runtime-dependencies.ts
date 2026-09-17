/** @file sno-station-mem-runtime-dependencies.ts
 * @purpose Centralizes SnoStationMem runtime imports while runtime responsibilities live in focused modules.
 * @boundary Re-export only; no runtime orchestration belongs here.
 */

export { AsyncLocalStorage } from "node:async_hooks";
export { default as path } from "node:path";
export { SnoStationCoreCryptoError } from "@snoai/sno-station-core-crypto";

export {
	BACKUP_INTERVAL_MS,
	DEFAULT_IMPORTANCE,
	MAX_SESSION_RECALL_ENTRIES,
	MAX_TRACKED_SESSIONS,
	SNO_OBSERVE_FLUSH_TIMEOUT_MS,
} from "../../../config/index";
export { normalizeAmbientLearningText } from "../extraction/ambient-learning-text-normalizer";
export {
	detectCategory,
	detectCategoryVote,
	formatRelevantMemoriesContext,
	shouldCapture,
} from "../extraction/capture-policy-detector";
export type { Embedder } from "../extraction/embedding-provider-client";
export { AtomicInsightDistiller } from "../extraction/atomic-memory-extraction";
export {
	inferTemporalInterval,
	parseSessionTimestamp,
	serializeIntervalMetadata,
} from "../extraction/memory-temporality-classifier";
export { DEFAULT_LOCALE } from "../i18n/locales";
export { PluginObservability } from "../observability/adapter";
export { readMemorySnapshotPayload } from "../observability/memory-snapshot";
export { ObservableEmbedder } from "../observability/observable-embedder";
export { ObservableLlmClient } from "../observability/observable-llm-client";
export { ObservableMemoryStore } from "../observability/observable-memory-store";
export { ObservableMemoryRetriever } from "../observability/observable-retriever";
export { ObserveSessionRegistry } from "../observability/session-registry";


export { createTierPromoter } from "../operations/memory-tier-promoter";
export {
	appendAuditEntry,
	flushAuditWrites,
} from "../operations/runtime-audit-log";



export { shouldSkipReflectionMessage } from "../reflection/daily-log-generator";
export {
	DEFAULT_MEMORY_LLM_CONFIG,
	createReflectionGenerator,
} from "../reflection/reflection-embedded-generator";
export {
	isInternalReflectionSessionKey,
} from "../reflection/strategy-hook-runner";
export { AccessTracker } from "../retrieval/access-tracker";
export {
	normalizeQuery,
	shouldSkipRetrieval,
} from "../retrieval/retrieval-gate";
export {
	DEFAULT_RETRIEVAL_CONFIG,
	type MemoryRetriever,
	type RetrievalConfig,
} from "../retrieval/retriever";
export { redactSecrets } from "../security/redact";
export { createScopePolicy, isSystemBypassId } from "../security/scopes";
export { ConfigError } from "../shared/errors";
export { createLlmClient } from "../../model/llm-client";
export { pruneOldestEntries, setLruEntry, touchLruEntry } from "../shared/lru";
export { resolveSnoStationMemDbPath } from "../shared/paths";
export type { PluginConfig } from "../shared/types";
export { pluginConfigSchema } from "../shared/types";
export { debugContentPreview, stableHash } from "../shared/utils";
export { validateStoragePath } from "../../store/connection";
export {
	type BootstrapResult,
	bootstrapDataLayout,
} from "../../store/data-bootstrap";
export {
	getBackupsDir,
	getSnoStationMemDataDir,
} from "../../store/data-paths";
export { initSqliteRuntimeSync } from "../../store/sqlite-runtime";
export type { MemoryStore } from "../../store/store";

/** Legacy parameters carry only an unused logger slot; no host operations are exposed. */
export type SnoStationMemPluginApi = { logger: unknown };
