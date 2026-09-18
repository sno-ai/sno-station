/** @file reflection-store-writer.ts
 * @purpose Persist reflection payloads with semantic duplicate protection.
 * @boundary Store embedding, duplicate search, and write orchestration.
 */

import { parseReflectionMetadata } from "./entry-metadata-parser";
import {
	buildInsightMetadata,
	stringifyInsightMetadata,
} from "../extraction/memory-metadata-codec";
import type { ReflectionEventMetadata } from "./event-payload-builder";
import { buildReflectionAntiPatternSignature } from "./mapped-memory-metadata-builder";
import type { ReflectionSlices } from "./markdown-slice-parser";
import type { ReflectionItemMetadata } from "./slice-item-payload-builder";
import type { MemoryCategory, MemorySearchResult } from "../shared/types";
import type {
	ReflectionStoreKind,
	ReflectionStorePayload,
	StoreReflectionParams,
} from "./reflection-entry-projector-types";
import type { ReflectionLineSource } from "./reflection-line-loader";
import { buildReflectionStorePayloads } from "./reflection-store-payload-builder";

export async function storeReflectionEntries(params: StoreReflectionParams): Promise<{
	stored: boolean;
	eventId: string;
	slices: ReflectionSlices;
	storedKinds: ReflectionStoreKind[];
	derivedSources: ReflectionLineSource[];
}> {
	const { eventId, slices, payloads } = buildReflectionStorePayloads(params);
	const storedKinds: ReflectionStoreKind[] = [];
	const derivedSources: ReflectionLineSource[] = [];
	const dedupeThreshold = Number.isFinite(params.dedupeThreshold)
		? Number(params.dedupeThreshold)
		: 0.97;

	for (const payload of payloads) {
		const vector = await params.embed(payload.text);
		const existing = await params.searchSemantic(vector, {
			limit: 12,
			minScore: 0.1,
			projectIdFilter: [params.scope],
		});

		if (payload.kind === "combined-legacy") {
			const topMatch = existing[0];
			if (topMatch && topMatch.score > dedupeThreshold) {
				continue;
			}
		}
		if (hasDuplicateReflectionPayload(payload, existing)) {
			continue;
		}

		const stored = await params.store({
			text: payload.text,
			category: categoryForPayload(payload.kind),
			projectId: params.scope,
			importance: resolveReflectionImportance(payload.kind),
			metadata: metadataForPayload(payload, params.runAt),
			// Anchor every reflection row to the run time captured once at the
			// start of this reflection pass. Without it persistence falls back to
			// a per-row `Date.now()`, scattering sibling rows across ms-level
			// drift instead of sharing one event-time anchor.
			timestamp: params.runAt,
		});
		storedKinds.push(payload.kind);
		if (payload.kind === "item-derived" && stored.factId) {
			derivedSources.push({
				line: payload.text,
				rowId: stored.id,
				factId: stored.factId,
				sourceAgentId: params.agentId,
				memoryKind: stored.category ?? categoryForPayload(payload.kind),
				projectId: stored.projectId ?? params.scope,
				rank: derivedSources.length + 1,
				score: resolveReflectionImportance(payload.kind),
			});
		}
	}

	return {
		stored: storedKinds.length > 0,
		eventId,
		slices,
		storedKinds,
		derivedSources,
	};
}

function categoryForPayload(kind: ReflectionStoreKind): MemoryCategory {
	return kind === "episodic-reflection" ? "episodic" : "lesson";
}

function metadataForPayload(payload: ReflectionStorePayload, runAt: number): string {
	const category = categoryForPayload(payload.kind);
	const metadataPatch = {
		...payload.metadata,
		...(category === "lesson"
			? {
					anti_pattern_signature: buildReflectionAntiPatternSignature(
						payload.kind === "combined-legacy" ? "combined-legacy" : "reflection-item",
						payload.text,
					),
				}
			: { event_at: new Date(runAt).toISOString() }),
	};
	return stringifyInsightMetadata(
		buildInsightMetadata(
			{
				text: payload.text,
				category,
				timestamp: runAt,
			},
			metadataPatch,
		),
	);
}

function resolveReflectionImportance(kind: ReflectionStoreKind): number {
	if (kind === "episodic-reflection") return 0.55;
	if (kind === "item-invariant") return 0.82;
	if (kind === "item-derived") return 0.78;
	return 0.75;
}

function hasDuplicateReflectionPayload(
	payload: ReflectionStorePayload,
	matches: MemorySearchResult[],
): boolean {
	if (payload.kind === "combined-legacy") {
		return false;
	}

	return matches.some((match) => {
		const existingMetadata = parseReflectionMetadata(match.entry.metadata);

		if (payload.kind === "episodic-reflection") {
			const eventMetadata = payload.metadata as ReflectionEventMetadata;
			return (
				existingMetadata.type === "memory-reflection-event" &&
				existingMetadata.sessionKey === eventMetadata.sessionKey &&
				existingMetadata.sessionId === eventMetadata.sessionId &&
				existingMetadata.agentId === eventMetadata.agentId &&
				existingMetadata.command === eventMetadata.command
			);
		}

		const itemMetadata = payload.metadata as ReflectionItemMetadata;
		return (
			existingMetadata.type === "memory-reflection-item" &&
			existingMetadata.sessionId === itemMetadata.sessionId &&
			existingMetadata.agentId === itemMetadata.agentId &&
			existingMetadata.itemKind === itemMetadata.itemKind &&
			match.entry.text === payload.text
		);
	});
}
