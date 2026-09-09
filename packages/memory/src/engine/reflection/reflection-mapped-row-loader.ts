/** @file reflection-mapped-row-loader.ts
 * @purpose Load and rank mapped reflection rows by mapped memory kind.
 * @boundary Reads in-memory entries only; no persistence or I/O.
 */

import { parseReflectionMetadata } from "./entry-metadata-parser";
import {
	computeReflectionScore,
	normalizeReflectionLineForAggregation,
} from "./line-quality-ranker";
import {
	getReflectionMappedDecayDefaults,
	type ReflectionMappedKind,
} from "./mapped-memory-metadata-builder";
import { sanitizeReflectionSliceLines } from "./markdown-slice-parser";
import type { MemoryEntry } from "../shared/types";
import { DEFAULT_REFLECTION_MAPPED_MAX_AGE_MS } from "./reflection-entry-projector-types";
import {
	isOwnedByAgent,
	metadataTimestamp,
	parseMappedKind,
	readClampedNumber,
	readPositiveNumber,
} from "./reflection-entry-utils";

export interface LoadReflectionMappedRowsParams {
	entries: MemoryEntry[];
	agentId: string;
	now?: number;
	maxAgeMs?: number;
	maxPerKind?: number;
}

export interface ReflectionMappedSlices {
	userModel: string[];
	agentModel: string[];
	lesson: string[];
	decision: string[];
}

type WeightedMapped = {
	text: string;
	mappedKind: ReflectionMappedKind;
	timestamp: number;
	midpointDays: number;
	k: number;
	baseWeight: number;
	quality: number;
	usedFallback: boolean;
};

export function loadReflectionMappedRowsFromEntries(
	params: LoadReflectionMappedRowsParams,
): ReflectionMappedSlices {
	const now = Number.isFinite(params.now) ? Number(params.now) : Date.now();
	const maxAgeMs = Number.isFinite(params.maxAgeMs)
		? Math.max(0, Number(params.maxAgeMs))
		: DEFAULT_REFLECTION_MAPPED_MAX_AGE_MS;
	const maxPerKind = Number.isFinite(params.maxPerKind)
		? Math.max(1, Math.floor(Number(params.maxPerKind)))
		: 10;

	const weighted = buildWeightedMappedRows(params.entries, params.agentId);
	const grouped = scoreMappedRows(weighted, now, maxAgeMs);

	const sortedByKind = (kind: ReflectionMappedKind) =>
		[...grouped.values()]
			.filter((row) => row.kind === kind)
			.sort((a, b) => {
				if (b.score !== a.score) return b.score - a.score;
				if (b.latestTs !== a.latestTs) return b.latestTs - a.latestTs;
				return a.text.localeCompare(b.text);
			})
			.slice(0, maxPerKind)
			.map((row) => row.text);

	return {
		userModel: sortedByKind("user-model"),
		agentModel: sortedByKind("agent-model"),
		lesson: sortedByKind("lesson"),
		decision: sortedByKind("decision"),
	};
}

function buildWeightedMappedRows(entries: MemoryEntry[], agentId: string): WeightedMapped[] {
	return entries
		.map((entry) => ({
			entry,
			metadata: parseReflectionMetadata(entry.metadata),
		}))
		.filter(
			({ metadata }) =>
				metadata.type === "memory-reflection-mapped" && isOwnedByAgent(metadata, agentId),
		)
		.flatMap(({ entry, metadata }) => {
			const mappedKind = parseMappedKind(metadata.mappedKind);
			if (!mappedKind) return [];

			const lines = sanitizeReflectionSliceLines([entry.text]);
			if (lines.length === 0) return [];

			const defaults = getReflectionMappedDecayDefaults(mappedKind);
			const timestamp = metadataTimestamp(metadata, entry.timestamp);

			return lines.map((line) => ({
				text: line,
				mappedKind,
				timestamp,
				midpointDays: readPositiveNumber(metadata.decayMidpointDays, defaults.midpointDays),
				k: readPositiveNumber(metadata.decayK, defaults.k),
				baseWeight: readPositiveNumber(metadata.baseWeight, defaults.baseWeight),
				quality: readClampedNumber(metadata.quality, defaults.quality, 0.2, 1),
				usedFallback: metadata.usedFallback === true,
			}));
		});
}

function scoreMappedRows(
	weighted: WeightedMapped[],
	now: number,
	maxAgeMs: number,
): Map<
	string,
	{
		text: string;
		score: number;
		latestTs: number;
		kind: ReflectionMappedKind;
	}
> {
	const grouped = new Map<
		string,
		{
			text: string;
			score: number;
			latestTs: number;
			kind: ReflectionMappedKind;
		}
	>();

	for (const item of weighted) {
		if (now - item.timestamp > maxAgeMs) continue;
		const ageDays = Math.max(0, (now - item.timestamp) / 86_400_000);
		const score = computeReflectionScore({
			ageDays,
			midpointDays: item.midpointDays,
			k: item.k,
			baseWeight: item.baseWeight,
			quality: item.quality,
			usedFallback: item.usedFallback,
		});
		if (!Number.isFinite(score) || score <= 0) continue;

		const normalized = normalizeReflectionLineForAggregation(item.text);
		if (!normalized) continue;

		const key = `${item.mappedKind}::${normalized}`;
		const current = grouped.get(key);
		if (!current) {
			grouped.set(key, {
				text: item.text,
				score,
				latestTs: item.timestamp,
				kind: item.mappedKind,
			});
			continue;
		}

		current.score += score;
		if (item.timestamp > current.latestTs) {
			current.latestTs = item.timestamp;
			current.text = item.text;
		}
	}

	return grouped;
}
