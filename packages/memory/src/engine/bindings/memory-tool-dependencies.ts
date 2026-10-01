/** @file memory-tool-dependencies.ts
 * @purpose Centralizes external dependencies shared by memory tool modules.
 * @boundary Re-export only; no tool execution behavior lives here.
 */

export { existsSync, realpathSync } from "node:fs";
export { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
export { homedir } from "node:os";
export { basename, dirname, join, resolve, sep } from "node:path";
export { countTokens } from "@snoai/chunking";
export { Type } from "@sinclair/typebox";
export { Mutex } from "async-mutex";

export { z } from "zod";
export {
	DEFAULT_IMPORTANCE,
	DEFAULT_LIST_LIMIT,
	DEFAULT_MIN_SCORE,
	DEFAULT_SCOPE,
	DEFAULT_TOP_K,
	FORGET_QUERY_DEFAULT_LIMIT,
	FORGET_QUERY_MIN_SCORE,
	DEFAULT_MAX_CONTEXT_TOKENS,
	MAX_AGGREGATION_ROWS,
	MAX_AGGREGATION_RESULT_TOKENS,
	MAX_CANDIDATE_POOL_SIZE,
	MAX_RECALL_TOOL_CANDIDATES,
	MAX_LIST_LIMIT,
	MAX_RECALLED_TODOS,
	MAX_RECALLED_TODO_TOKENS,
} from "../../../config/index";
export {
	detectCategory,
	looksLikePromptInjection,
} from "../extraction/capture-policy-detector";
export type { Embedder } from "../extraction/embedding-provider-client";
export { stripEnvelopeMetadata } from "../extraction/extraction-text-sanitizer";
export { deriveFactKey } from "../extraction/memory-metadata-codec";
export {
	classifyTemporal,
	inferExpiry,
	inferTemporalInterval,
	parseSessionTimestamp,
	serializeIntervalMetadata,
} from "../extraction/memory-temporality-classifier";
export { RESOURCES_BY_LOCALE } from "../i18n/all-resources";
export type { Locale } from "../i18n/locales";
export { DEFAULT_LOCALE } from "../i18n/locales";
export { readEstimatedSpendToday } from "../operations/daily-spend-estimator";
export { ensureSelfImprovementLearningFiles } from "../operations/learning-file-maintenance";
export {
	appendAuditEntry,
} from "../operations/runtime-audit-log";
export {
	formatAtDepth,
} from "../retrieval/intent-analyzer";
export type { MemoryRetriever } from "../retrieval/retriever";
export type { MemoryScopePolicy } from "../security/scopes";
export { isSystemBypassId } from "../security/scopes";
export { SnoStationMemError, RetrievalError, StorageError } from "../shared/errors";
export type { AggregationQuery, MemoryCategory } from "../shared/types";
export {
	AGGREGATION_OPERATIONS,
	MEMORY_CATEGORIES,
	normalizeCategory,
} from "../shared/types";
export { clamp01, clampInt, stableHash } from "../shared/utils";
export { truncateGraphemes } from "../shared/i18n-text";
export type { MemoryStore, TodoListResult } from "../../store/store";
