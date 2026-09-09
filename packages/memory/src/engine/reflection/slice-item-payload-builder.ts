/** @file slice-item-payload-builder.ts
 * @purpose Stores individual reflection items with metadata suitable for ranking.
 * @boundary Reflection schemas, mapped metadata, and item lifecycle updates.
 * @see daily-log-generator.ts, entry-metadata-parser.ts, line-quality-ranker.ts.
 */

/**
 * Reflection item payload builder (invariant/derived items).
 */

import type { ReflectionSliceItem } from "./markdown-slice-parser";

export type ReflectionItemKind = "invariant" | "derived";

export interface ReflectionItemMetadata {
	type: "memory-reflection-item";
	reflectionVersion: 4;
	stage: "reflect-store";
	eventId: string;
	itemKind: ReflectionItemKind;
	section: "Invariants" | "Derived";
	ordinal: number;
	groupSize: number;
	agentId: string;
	sessionKey: string;
	sessionId: string;
	storedAt: number;
	usedFallback: boolean;
	errorSignals: string[];
	decayModel: "logistic";
	decayMidpointDays: number;
	decayK: number;
	baseWeight: number;
	quality: number;
	sourceReflectionPath?: string;
	/** Unix timestamp (ms) when the item was marked resolved. Undefined = unresolved. */
	resolvedAt?: number;
	/** Agent ID that marked this item resolved. */
	resolvedBy?: string;
	/** Optional note explaining why the item was resolved. */
	resolutionNote?: string;
}

export interface ReflectionItemPayload {
	kind: "item-invariant" | "item-derived";
	text: string;
	metadata: ReflectionItemMetadata;
}

export interface BuildReflectionItemPayloadsParams {
	items: ReflectionSliceItem[];
	eventId: string;
	agentId: string;
	sessionKey: string;
	sessionId: string;
	runAt: number;
	usedFallback: boolean;
	toolErrorSignals: Array<{ signatureHash: string }>;
	sourceReflectionPath?: string;
}

export const REFLECTION_INVARIANT_DECAY_MIDPOINT_DAYS = 45;
export const REFLECTION_INVARIANT_DECAY_K = 0.22;
export const REFLECTION_INVARIANT_BASE_WEIGHT = 1.1;
export const REFLECTION_INVARIANT_QUALITY = 1;

export const REFLECTION_DERIVED_DECAY_MIDPOINT_DAYS = 7;
export const REFLECTION_DERIVED_DECAY_K = 0.65;
export const REFLECTION_DERIVED_BASE_WEIGHT = 1;
export const REFLECTION_DERIVED_QUALITY = 0.95;

interface ReflectionItemDecayDefaults {
	midpointDays: number;
	k: number;
	baseWeight: number;
	quality: number;
}

interface ReflectionItemPlan {
	source: ReflectionSliceItem;
	payloadKind: ReflectionItemPayload["kind"];
	defaults: ReflectionItemDecayDefaults;
	errorSignals: string[];
}

const REFLECTION_ITEM_DECAY_DEFAULTS: Record<ReflectionItemKind, ReflectionItemDecayDefaults> = {
	invariant: {
		midpointDays: REFLECTION_INVARIANT_DECAY_MIDPOINT_DAYS,
		k: REFLECTION_INVARIANT_DECAY_K,
		baseWeight: REFLECTION_INVARIANT_BASE_WEIGHT,
		quality: REFLECTION_INVARIANT_QUALITY,
	},
	derived: {
		midpointDays: REFLECTION_DERIVED_DECAY_MIDPOINT_DAYS,
		k: REFLECTION_DERIVED_DECAY_K,
		baseWeight: REFLECTION_DERIVED_BASE_WEIGHT,
		quality: REFLECTION_DERIVED_QUALITY,
	},
};

/**
 * Returns reflection item decay defaults from reflection item persistence state without side
 * effects.
 */
export function getReflectionItemDecayDefaults(itemKind: ReflectionItemKind): {
	midpointDays: number;
	k: number;
	baseWeight: number;
	quality: number;
} {
	return { ...REFLECTION_ITEM_DECAY_DEFAULTS[itemKind] };
}

function itemPayloadKind(itemKind: ReflectionItemKind): ReflectionItemPayload["kind"] {
	return itemKind === "invariant" ? "item-invariant" : "item-derived";
}

function itemPlansFromParams(params: BuildReflectionItemPayloadsParams): ReflectionItemPlan[] {
	const errorSignals = params.toolErrorSignals.map((signal) => signal.signatureHash);
	return params.items.map((source) => ({
		source,
		payloadKind: itemPayloadKind(source.itemKind),
		defaults: getReflectionItemDecayDefaults(source.itemKind),
		errorSignals,
	}));
}

function metadataFromItemPlan(
	params: BuildReflectionItemPayloadsParams,
	plan: ReflectionItemPlan,
): ReflectionItemMetadata {
	const { source, defaults } = plan;
	return {
		type: "memory-reflection-item",
		reflectionVersion: 4,
		stage: "reflect-store",
		eventId: params.eventId,
		itemKind: source.itemKind,
		section: source.section,
		ordinal: source.ordinal,
		groupSize: source.groupSize,
		agentId: params.agentId,
		sessionKey: params.sessionKey,
		sessionId: params.sessionId,
		storedAt: params.runAt,
		usedFallback: params.usedFallback,
		errorSignals: plan.errorSignals,
		decayModel: "logistic",
		decayMidpointDays: defaults.midpointDays,
		decayK: defaults.k,
		baseWeight: defaults.baseWeight,
		quality: defaults.quality,
		...(params.sourceReflectionPath ? { sourceReflectionPath: params.sourceReflectionPath } : {}),
	};
}

/**
 * Assembles reflection item payloads from validated inputs for deterministic reflection item
 * persistence.
 */
export function buildReflectionItemPayloads(
	params: BuildReflectionItemPayloadsParams,
): ReflectionItemPayload[] {
	return itemPlansFromParams(params).map((plan) => {
		return {
			kind: plan.payloadKind,
			text: plan.source.text,
			metadata: metadataFromItemPlan(params, plan),
		};
	});
}
