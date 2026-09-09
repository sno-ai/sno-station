/** @file reflection-line-loader.ts
 * @purpose Load, score, and rank invariant and derived reflection lines.
 * @boundary Reads in-memory entries only; no persistence or I/O.
 */

import { parseReflectionMetadata } from "./entry-metadata-parser";
import {
	computeReflectionScore,
	normalizeReflectionLineForAggregation,
} from "./line-quality-ranker";
import { sanitizeInjectableReflectionLines } from "./markdown-slice-parser";
import {
	getReflectionItemDecayDefaults,
	REFLECTION_DERIVED_DECAY_K,
	REFLECTION_DERIVED_DECAY_MIDPOINT_DAYS,
	REFLECTION_INVARIANT_DECAY_K,
	REFLECTION_INVARIANT_DECAY_MIDPOINT_DAYS,
} from "./slice-item-payload-builder";
import type { MemoryEntry } from "../shared/types";
import {
	DEFAULT_REFLECTION_DERIVED_MAX_AGE_MS,
	REFLECTION_DERIVE_FALLBACK_BASE_WEIGHT,
	REFLECTION_DERIVE_LOGISTIC_K,
	REFLECTION_DERIVE_LOGISTIC_MIDPOINT_DAYS,
} from "./reflection-entry-projector-types";
import {
	isOwnedByAgent,
	isReflectionMetadataType,
	metadataTimestamp,
	readClampedNumber,
	readPositiveNumber,
	toStringArray,
} from "./reflection-entry-utils";

export interface LoadReflectionSlicesParams {
	entries: MemoryEntry[];
	agentId: string;
	now?: number;
	deriveMaxAgeMs?: number;
	invariantMaxAgeMs?: number;
}

type WeightedLineCandidate = {
	line: string;
	timestamp: number;
	midpointDays: number;
	k: number;
	baseWeight: number;
	quality: number;
	usedFallback: boolean;
	source?: ReflectionLineSourceCandidate;
};

export interface ReflectionLineSource {
	line: string;
	rowId: string;
	factId: string;
	sourceAgentId: string;
	memoryKind: string;
	projectId: string;
	rank: number;
	score: number;
}

export interface LoadedReflectionSlices {
	invariants: string[];
	derived: string[];
	invariantSources: ReflectionLineSource[];
	derivedSources: ReflectionLineSource[];
}

type ReflectionLineSourceCandidate = Omit<ReflectionLineSource, "rank" | "score">;

export function loadAgentReflectionSlicesFromEntries(
	params: LoadReflectionSlicesParams,
): LoadedReflectionSlices {
	const now = Number.isFinite(params.now) ? Number(params.now) : Date.now();
	const deriveMaxAgeMs = Number.isFinite(params.deriveMaxAgeMs)
		? Math.max(0, Number(params.deriveMaxAgeMs))
		: DEFAULT_REFLECTION_DERIVED_MAX_AGE_MS;
	const invariantMaxAgeMs = Number.isFinite(params.invariantMaxAgeMs)
		? Math.max(0, Number(params.invariantMaxAgeMs))
		: undefined;

	const reflectionRows = params.entries
		.map((entry) => ({
			entry,
			metadata: parseReflectionMetadata(entry.metadata),
		}))
		.filter(
			({ metadata }) =>
				isReflectionMetadataType(metadata.type) && isOwnedByAgent(metadata, params.agentId),
		)
		.sort((a, b) => b.entry.timestamp - a.entry.timestamp)
		.slice(0, 160);

	const itemRows = reflectionRows.filter(
		({ metadata }) => metadata.type === "memory-reflection-item",
	);
	const legacyRows = reflectionRows.filter(({ metadata }) => metadata.type === "memory-reflection");

	// P1 (PR #595): unresolved-only item rows are the candidate pool; resolved item
	// rows seed the normalized text sets used to filter legacy-fallback revivals.
	const unresolvedItemRows = itemRows.filter(
		({ metadata }) => metadata.resolvedAt === undefined,
	);
	const resolvedItemRows = itemRows.filter(
		({ metadata }) => metadata.resolvedAt !== undefined,
	);

	const hasItemRows = itemRows.length > 0;
	const hasLegacyRows = legacyRows.length > 0;

	const resolvedInvariantTexts = new Set(
		resolvedItemRows
			.filter(({ metadata }) => metadata.itemKind === "invariant")
			.flatMap(({ entry }) => sanitizeInjectableReflectionLines([entry.text]))
			.map((line) => normalizeReflectionLineForAggregation(line)),
	);
	const resolvedDerivedTexts = new Set(
		resolvedItemRows
			.filter(({ metadata }) => metadata.itemKind === "derived")
			.flatMap(({ entry }) => sanitizeInjectableReflectionLines([entry.text]))
			.map((line) => normalizeReflectionLineForAggregation(line)),
	);

	// Suppress-when-all-resolved: when every item is resolved AND every legacy row
	// only duplicates already-resolved content, return empty slices instead of
	// letting the legacy fallback revive just-resolved advice.
	const legacyHasUniqueInvariant = legacyRows.some(({ metadata }) =>
		sanitizeInjectableReflectionLines(toStringArray(metadata.invariants)).some(
			(line) => !resolvedInvariantTexts.has(normalizeReflectionLineForAggregation(line)),
		),
	);
	const legacyHasUniqueDerived = legacyRows.some(({ metadata }) =>
		sanitizeInjectableReflectionLines(toStringArray(metadata.derived)).some(
			(line) => !resolvedDerivedTexts.has(normalizeReflectionLineForAggregation(line)),
		),
	);
	const shouldSuppress =
		hasItemRows &&
		unresolvedItemRows.length === 0 &&
		(!hasLegacyRows || (!legacyHasUniqueInvariant && !legacyHasUniqueDerived));
	if (shouldSuppress) {
		return { invariants: [], derived: [], invariantSources: [], derivedSources: [] };
	}

	// P2 (PR #595): per-section legacy filtering. Exclude rows where every line
	// for that section is resolved, so a derived-only legacy row cannot revive
	// resolved invariants and vice versa.
	const invariantLegacyRows = legacyRows.filter(({ metadata }) => {
		const lines = sanitizeInjectableReflectionLines(toStringArray(metadata.invariants));
		if (lines.length === 0) return false;
		return lines.some(
			(line) => !resolvedInvariantTexts.has(normalizeReflectionLineForAggregation(line)),
		);
	});
	const derivedLegacyRows = legacyRows.filter(({ metadata }) => {
		const lines = sanitizeInjectableReflectionLines(toStringArray(metadata.derived));
		if (lines.length === 0) return false;
		return lines.some(
			(line) => !resolvedDerivedTexts.has(normalizeReflectionLineForAggregation(line)),
		);
	});

	const invariantLines = rankReflectionLines(
		buildInvariantCandidates(unresolvedItemRows, invariantLegacyRows, resolvedInvariantTexts),
		{
			now,
			maxAgeMs: invariantMaxAgeMs,
			limit: 8,
		},
	);
	const derivedLines = rankReflectionLines(
		buildDerivedCandidates(
			unresolvedItemRows,
			derivedLegacyRows,
			params.agentId,
			resolvedDerivedTexts,
		),
		{
			now,
			maxAgeMs: deriveMaxAgeMs,
			limit: 10,
		},
	);
	return {
		invariants: invariantLines.lines,
		derived: derivedLines.lines,
		invariantSources: invariantLines.sources,
		derivedSources: derivedLines.sources,
	};
}

function buildInvariantCandidates(
	itemRows: Array<{
		entry: MemoryEntry;
		metadata: Record<string, unknown>;
	}>,
	legacyRows: Array<{
		entry: MemoryEntry;
		metadata: Record<string, unknown>;
	}>,
	resolvedTexts: Set<string>,
): WeightedLineCandidate[] {
	const itemCandidates = itemRows
		.filter(({ metadata }) => metadata.itemKind === "invariant")
		.flatMap(({ entry, metadata }) => {
			const safeLines = sanitizeInjectableReflectionLines([entry.text]);
			if (safeLines.length === 0) return [];

			const defaults = getReflectionItemDecayDefaults("invariant");
			const timestamp = metadataTimestamp(metadata, entry.timestamp);
			return safeLines.map((line) => ({
				line,
				timestamp,
				midpointDays: readPositiveNumber(metadata.decayMidpointDays, defaults.midpointDays),
				k: readPositiveNumber(metadata.decayK, defaults.k),
				baseWeight: readPositiveNumber(metadata.baseWeight, defaults.baseWeight),
				quality: readClampedNumber(metadata.quality, defaults.quality, 0.2, 1),
				usedFallback: metadata.usedFallback === true,
				source: buildReflectionLineSource(entry, line, metadata),
			}));
		});

	if (itemCandidates.length > 0) return itemCandidates;

	// P2 (PR #595): legacy fallback must drop lines whose normalized form matches
	// an already-resolved item — `resolvedTexts` is pre-normalized by the caller.
	return legacyRows.flatMap(({ entry, metadata }) => {
		const defaults = getReflectionItemDecayDefaults("invariant");
		const timestamp = metadataTimestamp(metadata, entry.timestamp);
		const lines = sanitizeInjectableReflectionLines(toStringArray(metadata.invariants));
		return lines
			.filter((line) => !resolvedTexts.has(normalizeReflectionLineForAggregation(line)))
			.map((line) => ({
				line,
				timestamp,
				midpointDays: defaults.midpointDays,
				k: defaults.k,
				baseWeight: defaults.baseWeight,
				quality: defaults.quality,
				usedFallback: metadata.usedFallback === true,
				source: buildReflectionLineSource(entry, line, metadata),
			}));
	});
}

function buildDerivedCandidates(
	itemRows: Array<{
		entry: MemoryEntry;
		metadata: Record<string, unknown>;
	}>,
	legacyRows: Array<{
		entry: MemoryEntry;
		metadata: Record<string, unknown>;
	}>,
	queryingAgentId: string,
	resolvedTexts: Set<string>,
): WeightedLineCandidate[] {
	const itemCandidates = itemRows
		.filter(({ metadata }) => metadata.itemKind === "derived")
		.flatMap(({ entry, metadata }) => {
			const safeLines = sanitizeInjectableReflectionLines([entry.text]);
			if (safeLines.length === 0) return [];

			const defaults = getReflectionItemDecayDefaults("derived");
			const timestamp = metadataTimestamp(metadata, entry.timestamp);
			return safeLines.map((line) => ({
				line,
				timestamp,
				midpointDays: readPositiveNumber(metadata.decayMidpointDays, defaults.midpointDays),
				k: readPositiveNumber(metadata.decayK, defaults.k),
				baseWeight: readPositiveNumber(metadata.baseWeight, defaults.baseWeight),
				quality: readClampedNumber(metadata.quality, defaults.quality, 0.2, 1),
				usedFallback: metadata.usedFallback === true,
				source: buildReflectionLineSource(entry, line, metadata),
			}));
		});

	if (itemCandidates.length > 0) return itemCandidates;

	const ownedLegacyRows = legacyRows.filter(({ metadata }) => {
		const derivedLines = sanitizeInjectableReflectionLines(toStringArray(metadata.derived));
		if (derivedLines.length === 0) return true;
		const owner = typeof metadata.agentId === "string" ? metadata.agentId.trim() : "";
		return owner !== "" && owner === queryingAgentId;
	});

	return ownedLegacyRows.flatMap(({ entry, metadata }) => {
		const timestamp = metadataTimestamp(metadata, entry.timestamp);
		const lines = sanitizeInjectableReflectionLines(toStringArray(metadata.derived));
		if (lines.length === 0) return [];

		const defaults = {
			midpointDays: REFLECTION_DERIVE_LOGISTIC_MIDPOINT_DAYS,
			k: REFLECTION_DERIVE_LOGISTIC_K,
			baseWeight: resolveLegacyDeriveBaseWeight(metadata),
			quality: computeDerivedLineQuality(lines.length),
		};

		// P2 (PR #595): drop lines that duplicate an already-resolved derived item.
		return lines
			.filter((line) => !resolvedTexts.has(normalizeReflectionLineForAggregation(line)))
			.map((line) => ({
				line,
				timestamp,
				midpointDays: readPositiveNumber(metadata.decayMidpointDays, defaults.midpointDays),
				k: readPositiveNumber(metadata.decayK, defaults.k),
				baseWeight: readPositiveNumber(metadata.deriveBaseWeight, defaults.baseWeight),
				quality: readClampedNumber(metadata.deriveQuality, defaults.quality, 0.2, 1),
				usedFallback: metadata.usedFallback === true,
				source: buildReflectionLineSource(entry, line, metadata),
			}));
	});
}

function rankReflectionLines(
	candidates: WeightedLineCandidate[],
	options: { now: number; maxAgeMs?: number; limit: number },
): { lines: string[]; sources: ReflectionLineSource[] } {
	type WeightedLine = {
		line: string;
		score: number;
		latestTs: number;
		source?: ReflectionLineSourceCandidate;
	};
	const lineScores = new Map<string, WeightedLine>();

	for (const candidate of candidates) {
		const timestamp = Number.isFinite(candidate.timestamp) ? candidate.timestamp : options.now;

		const maxAge = options.maxAgeMs;
		if (
			maxAge !== undefined &&
			Number.isFinite(maxAge) &&
			maxAge >= 0 &&
			options.now - timestamp > maxAge
		) {
			continue;
		}

		const ageDays = Math.max(0, (options.now - timestamp) / 86_400_000);
		const score = computeReflectionScore({
			ageDays,
			midpointDays: candidate.midpointDays,
			k: candidate.k,
			baseWeight: candidate.baseWeight,
			quality: candidate.quality,
			usedFallback: candidate.usedFallback,
		});
		if (!Number.isFinite(score) || score <= 0) continue;

		const key = normalizeReflectionLineForAggregation(candidate.line);
		if (!key) continue;

		const current = lineScores.get(key);
		if (!current) {
			lineScores.set(key, {
				line: candidate.line,
				score,
				latestTs: timestamp,
				source: candidate.source,
			});
			continue;
		}

		current.score += score;
		if (timestamp > current.latestTs) {
			current.latestTs = timestamp;
			current.line = candidate.line;
			current.source = candidate.source;
		}
	}

	const ranked = [...lineScores.values()]
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			if (b.latestTs !== a.latestTs) return b.latestTs - a.latestTs;
			return a.line.localeCompare(b.line);
		})
		.slice(0, options.limit);
	return {
		lines: ranked.map((item) => item.line),
		sources: ranked.flatMap((item, index) =>
			item.source
				? [
						{
							...item.source,
							line: item.line,
							rank: index + 1,
							score: item.score,
						},
					]
				: [],
		),
	};
}

function buildReflectionLineSource(
	entry: MemoryEntry,
	line: string,
	metadata: Record<string, unknown>,
): ReflectionLineSourceCandidate | undefined {
	if (!entry.factId) return undefined;
	const sourceAgentId =
		typeof metadata.agentId === "string" && metadata.agentId.trim()
			? metadata.agentId.trim()
			: "main";
	return {
		line,
		rowId: entry.id,
		factId: entry.factId,
		sourceAgentId,
		memoryKind: entry.category,
		projectId: entry.projectId,
	};
}

export function computeDerivedLineQuality(nonPlaceholderLineCount: number): number {
	const n = Number.isFinite(nonPlaceholderLineCount)
		? Math.max(0, Math.floor(nonPlaceholderLineCount))
		: 0;
	if (n <= 0) return 0.2;
	return Math.min(1, 0.55 + Math.min(6, n) * 0.075);
}

export function resolveLegacyDeriveBaseWeight(metadata: Record<string, unknown>): number {
	const explicit = Number(metadata.deriveBaseWeight);
	if (Number.isFinite(explicit) && explicit > 0) {
		return Math.max(0.1, Math.min(1.2, explicit));
	}
	if (metadata.usedFallback === true) {
		return REFLECTION_DERIVE_FALLBACK_BASE_WEIGHT;
	}
	return 1;
}

export function getReflectionDerivedDecayDefaults(): {
	midpointDays: number;
	k: number;
} {
	return {
		midpointDays: REFLECTION_DERIVED_DECAY_MIDPOINT_DAYS,
		k: REFLECTION_DERIVED_DECAY_K,
	};
}

export function getReflectionInvariantDecayDefaults(): {
	midpointDays: number;
	k: number;
} {
	return {
		midpointDays: REFLECTION_INVARIANT_DECAY_MIDPOINT_DAYS,
		k: REFLECTION_INVARIANT_DECAY_K,
	};
}
