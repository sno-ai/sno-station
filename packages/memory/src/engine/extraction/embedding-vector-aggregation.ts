/**
 * Compute L2-normalized weighted average of Float32Array vectors.
 * Weights are typically chunk char lengths so longer chunks contribute more.
 */
// LH: Chunked embedding uses length-weighted averaging so longer chunks contribute proportionally to the final vector.
// LH: The averaged vector is L2-normalized to keep cosine retrieval comparable with single-pass embeddings.
// LH: Float32Array output preserves the canonical vector representation expected by storage and ranking.
// LH: Do not average unnormalized provider vectors without this final normalization step.
export function weightedAverageFloat32(
	vectors: Float32Array[],
	weights: number[],
	dim: number,
): Float32Array {
	// Use a plain number array for accumulation to avoid noUncheckedIndexedAccess
	// friction on Float32Array — converted to Float32Array at the end.
	const acc = new Array<number>(dim).fill(0);
	let totalWeight = 0;
	for (let i = 0; i < vectors.length; i++) {
		const w = weights[i] ?? 1;
		const vec = vectors[i];
		if (!vec) continue;
		totalWeight += w;
		for (let j = 0; j < dim; j++) {
			acc[j] = (acc[j] ?? 0) + (vec[j] ?? 0) * w;
		}
	}
	if (totalWeight > 0) {
		for (let j = 0; j < dim; j++) {
			acc[j] = (acc[j] ?? 0) / totalWeight;
		}
	}
	let norm = 0;
	for (let j = 0; j < dim; j++) {
		const v = acc[j] ?? 0;
		norm += v * v;
	}
	norm = Math.sqrt(norm);
	if (norm > 0) {
		for (let j = 0; j < dim; j++) {
			acc[j] = (acc[j] ?? 0) / norm;
		}
	}
	return Float32Array.from(acc);
}
