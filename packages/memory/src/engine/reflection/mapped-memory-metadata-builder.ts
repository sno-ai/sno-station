/** @file mapped-memory-metadata-builder.ts
 * @purpose Maps raw reflection metadata into typed fields used by ranking and storage.
 * @boundary Reflection extraction output and schema-compatible persistence.
 * @see entry-metadata-parser.ts, slice-item-payload-builder.ts, types.ts.
 */

/**
 * Reflection mapped metadata builder.
 *
 * Builds metadata for "mapped" reflection items (user-model, agent-model,
 * lesson, decision) with kind-specific decay defaults.
 */

import { createHash } from "node:crypto";
import type { ReflectionMappedMemoryItem } from "./markdown-slice-parser";
import type { MemoryCategory } from "../shared/types";

export type ReflectionMappedKind = "user-model" | "agent-model" | "lesson" | "decision";
export type ReflectionMappedCategory = MemoryCategory;

export interface ReflectionMappedMetadata {
	type: "memory-reflection-mapped";
	reflectionVersion: 4;
	stage: "reflect-store";
	eventId: string;
	mappedKind: ReflectionMappedKind;
	mappedCategory: ReflectionMappedCategory;
	section: string;
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
	/**
	 * Issue #680 mdMirror heading recovery hook (PRD §3, §4.2). Set to the source
	 * reflection-markdown heading (e.g. "User model deltas (about the human)")
	 * when the row is built by the §4.2 mapped-memory loop. A future mdMirror
	 * walker can reconstruct the source section without re-parsing the markdown.
	 */
	_reflectionHeading?: string;
}

export interface ReflectionMappedDecayDefaults {
	midpointDays: number;
	k: number;
	baseWeight: number;
	quality: number;
}

const REFLECTION_MAPPED_DECAY_DEFAULTS: Record<
	ReflectionMappedKind,
	ReflectionMappedDecayDefaults
> = {
	decision: { midpointDays: 45, k: 0.25, baseWeight: 1.1, quality: 1 },
	"user-model": {
		midpointDays: 21,
		k: 0.3,
		baseWeight: 1,
		quality: 0.95,
	},
	"agent-model": {
		midpointDays: 10,
		k: 0.35,
		baseWeight: 0.95,
		quality: 0.93,
	},
	lesson: { midpointDays: 7, k: 0.45, baseWeight: 0.9, quality: 0.9 },
};

interface BuildReflectionMappedMetadataParams {
	mappedItem: ReflectionMappedMemoryItem;
	eventId: string;
	agentId: string;
	sessionKey: string;
	sessionId: string;
	runAt: number;
	usedFallback: boolean;
	toolErrorSignals: Array<{ signatureHash: string }>;
	sourceReflectionPath?: string;
}

type ReflectionMappedSessionFields = Pick<
	ReflectionMappedMetadata,
	"agentId" | "sessionKey" | "sessionId" | "storedAt" | "usedFallback"
>;

/**
 * Returns reflection mapped decay defaults from reflection metadata mapping state without side
 * effects.
 */
export function getReflectionMappedDecayDefaults(
	kind: ReflectionMappedKind,
): ReflectionMappedDecayDefaults {
	// Centralize the reflection capture fallback value at the boundary of this helper.
	return { ...REFLECTION_MAPPED_DECAY_DEFAULTS[kind] };
}

export function buildReflectionAntiPatternSignature(
	kind: ReflectionMappedKind | "reflection-item" | "combined-legacy",
	text: string,
): string {
	const normalized = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
	const hash = createHash("sha256").update(`${kind}\0${normalized}`).digest("hex").slice(0, 20);
	return `reflection:${kind}:${hash}`;
}

function mappedSessionFields(
	params: BuildReflectionMappedMetadataParams,
): ReflectionMappedSessionFields {
	return {
		agentId: params.agentId,
		sessionKey: params.sessionKey,
		sessionId: params.sessionId,
		storedAt: params.runAt,
		usedFallback: params.usedFallback,
	};
}

function mappedItemFields(
	item: ReflectionMappedMemoryItem,
): Pick<
	ReflectionMappedMetadata,
	"mappedKind" | "mappedCategory" | "section" | "ordinal" | "groupSize"
> {
	return {
		mappedKind: item.mappedKind,
		mappedCategory: item.category,
		section: item.heading,
		ordinal: item.ordinal,
		groupSize: item.groupSize,
	};
}

function mappedDecayFields(
	defaults: ReflectionMappedDecayDefaults,
): Pick<
	ReflectionMappedMetadata,
	"decayModel" | "decayMidpointDays" | "decayK" | "baseWeight" | "quality"
> {
	return {
		decayModel: "logistic",
		decayMidpointDays: defaults.midpointDays,
		decayK: defaults.k,
		baseWeight: defaults.baseWeight,
		quality: defaults.quality,
	};
}

/**
 * Assembles reflection mapped metadata from validated inputs for deterministic reflection
 * metadata mapping.
 */
export function buildReflectionMappedMetadata(params: {
	mappedItem: ReflectionMappedMemoryItem;
	eventId: string;
	agentId: string;
	sessionKey: string;
	sessionId: string;
	runAt: number;
	usedFallback: boolean;
	toolErrorSignals: Array<{ signatureHash: string }>;
	sourceReflectionPath?: string;
}): ReflectionMappedMetadata {
	const defaults = getReflectionMappedDecayDefaults(params.mappedItem.mappedKind);
	const sessionFields = mappedSessionFields(params);

	return {
		type: "memory-reflection-mapped",
		reflectionVersion: 4,
		stage: "reflect-store",
		eventId: params.eventId,
		...mappedItemFields(params.mappedItem),
		...sessionFields,
		errorSignals: params.toolErrorSignals.map((signal) => signal.signatureHash),
		...mappedDecayFields(defaults),
		...(params.sourceReflectionPath ? { sourceReflectionPath: params.sourceReflectionPath } : {}),
	};
}
