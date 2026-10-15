/** @file retrieval-rerank-provider.ts
 * @purpose Shapes the request to Sno's reranker and parses its reply.
 * @boundary HTTP payload shaping and response parsing only.
 */

export interface RerankItem {
	index: number;
	score: number;
}

export function buildRerankRequest(
	apiKey: string,
	query: string,
	candidates: string[],
): { headers: Record<string, string>; body: Record<string, unknown> } {
	return {
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
			// Self-reported labels for Sno GPU request statistics (GPU_REQUEST_METADATA_STANDARD), never identity.
			"X-Sno-Source": "sno-station",
			"X-Sno-Workload": "station-rerank",
		},
		body: { query, texts: candidates, raw_scores: true },
	};
}

/** Sno's reranker answers a list of `{index, score}`, bare or under `results` / `data`. */
export function parseRerankResponse(data: unknown): RerankItem[] | undefined {
	const parseItems = (items: unknown): RerankItem[] | undefined => {
		if (!Array.isArray(items)) return undefined;
		const parsed: RerankItem[] = [];
		for (const raw of items as Array<Record<string, unknown>>) {
			const index = typeof raw?.index === "number" ? raw.index : Number(raw?.index);
			if (!Number.isFinite(index)) continue;
			let score: number | undefined;
			for (const key of ["score", "relevance_score"] as const) {
				const value = raw?.[key];
				const n = typeof value === "number" ? value : Number(value);
				if (Number.isFinite(n)) {
					score = n;
					break;
				}
			}
			if (score === undefined) continue;
			parsed.push({ index, score });
		}
		return parsed.length > 0 ? parsed : undefined;
	};

	const objectData =
		data && typeof data === "object" && !Array.isArray(data)
			? (data as Record<string, unknown>)
			: undefined;
	return parseItems(data) ?? parseItems(objectData?.results) ?? parseItems(objectData?.data);
}
