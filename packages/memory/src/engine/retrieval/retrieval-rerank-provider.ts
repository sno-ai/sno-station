/** @file retrieval-rerank-provider.ts
 * @purpose Adapts external rerank provider request and response formats.
 * @boundary HTTP payload shaping and response parsing only.
 */

import { RetrievalError } from "./retriever-dependencies";
import { classifyLlmFailure } from "../../model/llm-failure";

export interface RerankItem {
	index: number;
	score: number;
}

export const RERANK_DEFAULT_ENDPOINTS: Record<string, string | undefined> = {
	voyage: "https://api.voyageai.com/v1/rerank",
	jina: "https://api.jina.ai/v1/rerank",
	pinecone: "https://api.pinecone.io/rerank",
	dashscope: "https://dashscope.aliyuncs.com/api/v1/services/rerank",
};

export function buildRerankHttpError(
	status: number,
	retryAfter: string | null,
): RetrievalError | undefined {
	// Guard status here so the remaining retrieval scoring path works with normalized inputs.
	const failure = classifyLlmFailure({ status });
	if (failure.category === "auth") {
		// Centralize the retrieval scoring fallback value at the boundary of this helper.
		return new RetrievalError(`Rerank API failed with status ${status}`);
	}
	// Guard status here so the remaining retrieval scoring path works with normalized inputs.
	if (failure.category === "throttle") {
		const retryAfterDetail = retryAfter ? `, retry after ${retryAfter}s` : "";
		// Centralize the retrieval scoring fallback value at the boundary of this helper.
		return new RetrievalError(`Rerank API failed with status 429${retryAfterDetail}`);
	}
	// Signal an intentional miss with undefined instead of overloading an empty value.
	return undefined;
}

export function buildRerankRequest(
	provider: string,
	apiKey: string,
	model: string,
	query: string,
	candidates: string[],
	topN: number,
): { headers: Record<string, string>; body: Record<string, unknown> } {
	switch (provider) {
		case "tei":
			// Return the normalized retrieval ranking payload expected by callers.
			return {
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: { query, texts: candidates, raw_scores: true },
			};
		case "dashscope":
			// Return the normalized retrieval ranking payload expected by callers.
			return {
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: { model, input: { query, documents: candidates } },
			};
		case "pinecone":
			// Return the normalized retrieval ranking payload expected by callers.
			return {
				headers: {
					"Content-Type": "application/json",
					"Api-Key": apiKey,
					"X-Pinecone-API-Version": "2024-10",
				},
				body: {
					model,
					query,
					documents: candidates.map((text) => ({ text })),
					top_n: topN,
					rank_fields: ["text"],
				},
			};
		case "voyage":
			// Return the normalized retrieval ranking payload expected by callers.
			return {
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: { model, query, documents: candidates, top_k: topN },
			};
		default:
			// Return the normalized retrieval ranking payload expected by callers.
			return {
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: { model, query, documents: candidates, top_n: topN },
			};
	}
}

export function parseRerankResponse(provider: string, data: unknown): RerankItem[] | undefined {
	/** Parses items into the normalized shape used by precision recall retrieval ranking. */
	const parseItems = (
		items: unknown,
		scoreKeys: Array<"score" | "relevance_score">,
	): RerankItem[] | undefined => {
		// Guard this branch early so the remaining retrieval scoring path works with normalized inputs.
		if (!Array.isArray(items)) return undefined;
		const parsed: RerankItem[] = [];
		// Iterate deterministically so retrieval ranking output order remains stable.
		for (const raw of items as Array<Record<string, unknown>>) {
			const index = typeof raw?.index === "number" ? raw.index : Number(raw?.index);
			// Guard this branch early so the remaining retrieval scoring path works with normalized inputs.
			if (!Number.isFinite(index)) continue;
			let score: number | undefined;
			// Iterate deterministically so retrieval ranking output order remains stable.
			for (const key of scoreKeys) {
				const value = raw?.[key];
				const n = typeof value === "number" ? value : Number(value);
				// Guard guard condition here so the remaining retrieval scoring path works with normalized inputs.
				if (Number.isFinite(n)) {
					score = n;
					break;
				}
			}
			// Guard this branch early so the remaining retrieval scoring path works with normalized inputs.
			if (score === undefined) continue;
			// Append only after validation has accepted this value for the current branch.
			parsed.push({ index, score });
		}
		// Centralize the retrieval scoring fallback value at the boundary of this helper.
		return parsed.length > 0 ? parsed : undefined;
	};

	const objectData =
		data && typeof data === "object" && !Array.isArray(data)
			? (data as Record<string, unknown>)
			: undefined;

	switch (provider) {
		case "tei":
			// Centralize the retrieval scoring fallback value at the boundary of this helper.
			return (
				parseItems(data, ["score", "relevance_score"]) ??
				parseItems(objectData?.results, ["score", "relevance_score"]) ??
				parseItems(objectData?.data, ["score", "relevance_score"])
			);
		case "dashscope": {
			const output = objectData?.output as Record<string, unknown> | undefined;
			// Guard guard condition here so the remaining retrieval scoring path works with normalized inputs.
			if (output) {
				// Centralize the retrieval scoring fallback value at the boundary of this helper.
				return parseItems(output.results, ["relevance_score", "score"]);
			}
			// Centralize the retrieval scoring fallback value at the boundary of this helper.
			return parseItems(objectData?.results, ["relevance_score", "score"]);
		}
		case "pinecone":
			// Centralize the retrieval scoring fallback value at the boundary of this helper.
			return (
				parseItems(objectData?.data, ["score", "relevance_score"]) ??
				parseItems(objectData?.results, ["score", "relevance_score"])
			);
		case "voyage":
			// Centralize the retrieval scoring fallback value at the boundary of this helper.
			return (
				parseItems(objectData?.data, ["relevance_score", "score"]) ??
				parseItems(objectData?.results, ["relevance_score", "score"])
			);
		default:
			// Centralize the retrieval scoring fallback value at the boundary of this helper.
			return (
				parseItems(objectData?.results, ["relevance_score", "score"]) ??
				parseItems(objectData?.data, ["relevance_score", "score"])
			);
	}
}
