/** @file reflection-entry-projector-types.ts
 * @purpose Shared constants and contracts for reflection entry projection.
 * @boundary Types and public defaults only.
 */

import type { ReflectionEventMetadata } from "./event-payload-builder";
import type { ReflectionItemMetadata } from "./slice-item-payload-builder";
import type { MemoryCategory, MemorySearchResult } from "../shared/types";

export const REFLECTION_DERIVE_LOGISTIC_MIDPOINT_DAYS = 3;
export const REFLECTION_DERIVE_LOGISTIC_K = 1.2;
export const REFLECTION_DERIVE_FALLBACK_BASE_WEIGHT = 0.35;

export const DEFAULT_REFLECTION_DERIVED_MAX_AGE_MS: number = 14 * 24 * 60 * 60 * 1000;
export const DEFAULT_REFLECTION_MAPPED_MAX_AGE_MS: number = 60 * 24 * 60 * 60 * 1000;

export type ReflectionStoreKind =
	| "episodic-reflection"
	| "item-invariant"
	| "item-derived"
	| "combined-legacy";

export type ReflectionErrorSignalLike = {
	signatureHash: string;
};

export interface ReflectionStorePayload {
	text: string;
	metadata: ReflectionEventMetadata | ReflectionItemMetadata | Record<string, unknown>;
	kind: ReflectionStoreKind;
}

export interface BuildReflectionStorePayloadsParams {
	reflectionText: string;
	sessionKey: string;
	sessionId: string;
	agentId: string;
	command: string;
	scope: string;
	toolErrorSignals: ReflectionErrorSignalLike[];
	runAt: number;
	usedFallback: boolean;
	eventId?: string;
	sourceReflectionPath?: string;
	writeLegacyCombined?: boolean;
}

export interface ReflectionStoreDeps {
	embed: (text: string) => Promise<Float32Array>;
	searchSemantic: (
		vector: Float32Array,
		options: {
			limit?: number;
			minScore?: number;
			projectIdFilter?: string[];
		},
	) => Promise<MemorySearchResult[]>;
	store: (entry: {
		text: string;
		category: MemoryCategory;
		projectId: string;
		importance?: number;
		metadata?: string;
		timestamp?: number;
	}) => Promise<{ id: string; factId?: string; category?: MemoryCategory; projectId?: string }>;
}

export interface StoreReflectionParams
	extends BuildReflectionStorePayloadsParams,
		ReflectionStoreDeps {
	dedupeThreshold?: number;
}
