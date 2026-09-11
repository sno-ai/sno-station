/** @file retrieval-scoring-utils.ts
 * @purpose Provides stateless score helpers and trace-array extraction.
 * @boundary Pure helper functions shared by retriever modules.
 */

import type { RetrievalResult } from "./retriever-dependencies";
import { clamp01, createLogger } from "./retriever-dependencies";

export const log: ReturnType<typeof createLogger> = createLogger("sno-station-mem:retriever");

export function clamp01WithFloor(value: number, floor: number): number {
	const safeFloor = clamp01(floor, 0);
	// Centralize the retrieval scoring fallback value at the boundary of this helper.
	return Math.max(safeFloor, clamp01(value, safeFloor));
}

export function dotProduct(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	const len = a.length;
	for (let i = 0; i < len; i += 1) {
		sum += (a[i] ?? 0) * (b[i] ?? 0);
	}
	return sum;
}

export function collectParallelStage(
	results: RetrievalResult[],
	key: "denseScore" | "bm25Score" | "fusedScore" | "rerankScore" | "mmrScore",
	fallbackIds: string[],
): { values: number[] | null; omitted: string[] } {
	const omitted: string[] = [];
	const values: number[] = [];
	for (const [index, result] of results.entries()) {
		const value = result[key];
		if (typeof value !== "number" || !Number.isFinite(value)) {
			omitted.push(fallbackIds[index] ?? "");
		} else {
			values.push(value);
		}
	}
	if (omitted.length === 0) return { values, omitted };
	return { values: null, omitted };
}
