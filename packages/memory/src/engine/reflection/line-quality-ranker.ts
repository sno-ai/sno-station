/** @file line-quality-ranker.ts
 * @purpose Ranks reflection candidates by usefulness, severity, and recency signals.
 * @boundary Reflection metadata, cache state, and retrieval-style scoring rules.
 * @see daily-log-generator.ts, derived-line-cache.ts, entry-metadata-parser.ts.
 */

/**
 * Reflection relevance ranking — logistic decay scoring.
 */

export const REFLECTION_FALLBACK_SCORE_FACTOR = 0.75;

export interface ReflectionScoreInput {
	ageDays: number;
	midpointDays: number;
	k: number;
	baseWeight: number;
	quality: number;
	usedFallback: boolean;
}

function finiteAtLeast(value: number, minimum: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(minimum, value);
}

function finitePositive(value: number, fallback: number): number {
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clampUnit(value: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(0, Math.min(1, value));
}

/** Computes reflection logistic as a side-effect-free reflection result ranking value. */
export function computeReflectionLogistic(
	ageDays: number,
	midpointDays: number,
	k: number,
): number {
	const normalizedAgeDays = finiteAtLeast(ageDays, 0, 0);
	const normalizedMidpointDays = finitePositive(midpointDays, 1);
	const normalizedK = finitePositive(k, 0.1);
	const distanceFromMidpoint = normalizedAgeDays - normalizedMidpointDays;

	return 1 / (1 + Math.exp(normalizedK * distanceFromMidpoint));
}

/** Computes reflection score as a side-effect-free reflection result ranking value. */
export function computeReflectionScore(input: ReflectionScoreInput): number {
	const recencyWeight = computeReflectionLogistic(input.ageDays, input.midpointDays, input.k);
	const baseWeight = finitePositive(input.baseWeight, 1);
	const qualityWeight = clampUnit(input.quality, 1);
	const sourceReliability = input.usedFallback ? REFLECTION_FALLBACK_SCORE_FACTOR : 1;

	return recencyWeight * baseWeight * qualityWeight * sourceReliability;
}

/**
 * Normalizes reflection line for aggregation at the boundary before reflection result ranking
 * uses it.
 */
export function normalizeReflectionLineForAggregation(line: string): string {
	const trimmed = String(line).trim();
	const singleSpaced = trimmed.replace(/\s+/g, " ");
	return singleSpaced.toLowerCase();
}
