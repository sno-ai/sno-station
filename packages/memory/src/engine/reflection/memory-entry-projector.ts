/** @file memory-entry-projector.ts
 * @purpose Public facade for reflection entry projection.
 * @boundary Compatibility exports for reflection storage, loading, and ranking.
 * @see reflection-store-payload-builder.ts, reflection-store-writer.ts.
 */

export type {
	BuildReflectionStorePayloadsParams,
	ReflectionErrorSignalLike,
	ReflectionStoreDeps,
	ReflectionStoreKind,
	ReflectionStorePayload,
	StoreReflectionParams,
} from "./reflection-entry-projector-types";
export {
	DEFAULT_REFLECTION_DERIVED_MAX_AGE_MS,
	DEFAULT_REFLECTION_MAPPED_MAX_AGE_MS,
	REFLECTION_DERIVE_FALLBACK_BASE_WEIGHT,
	REFLECTION_DERIVE_LOGISTIC_K,
	REFLECTION_DERIVE_LOGISTIC_MIDPOINT_DAYS,
} from "./reflection-entry-projector-types";
export type {
	LoadedReflectionSlices,
	LoadReflectionSlicesParams,
	ReflectionLineSource,
} from "./reflection-line-loader";
export {
	computeDerivedLineQuality,
	getReflectionDerivedDecayDefaults,
	getReflectionInvariantDecayDefaults,
	loadAgentReflectionSlicesFromEntries,
} from "./reflection-line-loader";
export type {
	LoadReflectionMappedRowsParams,
	ReflectionMappedSlices,
} from "./reflection-mapped-row-loader";
export { loadReflectionMappedRowsFromEntries } from "./reflection-mapped-row-loader";
export { buildReflectionStorePayloads } from "./reflection-store-payload-builder";
export { storeReflectionEntries } from "./reflection-store-writer";
