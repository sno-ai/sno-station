/** @file retriever-rerank-over-window.test.ts
 * @purpose The reranker refuses a whole batch when one pair is over its token window and
 *   names the texts at fault. The retriever must cut those to the size the endpoint's own
 *   count says fits and send the batch again, so the other candidates still get scored
 *   instead of the search silently serving raw fusion order.
 * @boundary Real retriever; `fetch` is the one external boundary substituted.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_MAX_CONTEXT_TOKENS,
	RERANK_PROMPT_TEMPLATE_TOKENS,
} from "../../../../packages/memory/config/index.ts";
import {
	createRetriever,
	DEFAULT_RETRIEVAL_CONFIG,
	type MemoryRetrieverInternals,
} from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import type { RetrievalResult } from "../../../../packages/memory/src/engine/shared/types.ts";

const noopStore = {
	getVectorsByIds: () => new Map<string, Float32Array>(),
} as never;

// One token per whitespace-separated word, so the arithmetic under test is readable in the
// assertions. The real embedder's tokenizer is not the ranking model's either, which is the
// whole reason the repair reads the server's count instead of trusting a local one.
const wordEmbedder = {
	embed: async () => new Float32Array([1, 0, 0]),
	countTokens: (text: string) => text.split(/\s+/).filter(Boolean).length,
	truncateToTokens: (text: string, maxTokens: number) =>
		text.split(/\s+/).filter(Boolean).slice(0, maxTokens).join(" "),
} as never;

function candidate(id: string, text: string, score: number): RetrievalResult {
	return {
		entry: {
			id,
			text,
			category: "episodic",
			lane: "active",
			projectId: "global",
			importance: 1,
			timestamp: Date.now(),
			metadata: "",
			contentHash: `hash-${id}`,
		},
		score,
		sources: { vector: { score, rank: 1 } },
	};
}

function crossEncoderRetriever(): MemoryRetrieverInternals {
	const retriever = createRetriever(noopStore, wordEmbedder, { warn: () => {} }, {
		...DEFAULT_RETRIEVAL_CONFIG,
		rerank: "cross-encoder",
		rerankProvider: "tei",
		rerankApiKey: "test-key",
		rerankEndpoint: "http://127.0.0.1:9/rerank",
		rerankTimeoutMs: 1_000,
	});
	return retriever as unknown as MemoryRetrieverInternals;
}

/** The endpoint's own refusal body, measured 2026-09-14 against the deployed reranker. */
function overWindowRefusal(index: number, inputTokens: number): Response {
	return new Response(
		JSON.stringify({
			detail: {
				error: "reranker input exceeds token limit; no candidates were scored or truncated",
				code: "input_token_limit_exceeded",
				max_input_tokens: DEFAULT_MAX_CONTEXT_TOKENS,
				candidates: [
					{
						index,
						input_tokens: inputTokens,
						excess_tokens: inputTokens - DEFAULT_MAX_CONTEXT_TOKENS,
					},
				],
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

function scored(): Response {
	return new Response(
		JSON.stringify([
			{ index: 1, score: 0.99 },
			{ index: 0, score: 0.01 },
		]),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function textsOf(call: unknown): string[] {
	const init = (call as [string, { body: string }])[1];
	const body: unknown = JSON.parse(init.body);
	const texts = (body as { texts?: unknown }).texts;
	if (!Array.isArray(texts)) throw new Error("rerank request carried no texts array");
	return texts.map((text) => String(text));
}

const queryVector = new Float32Array([1, 0, 0]);
const longText = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
// A query big enough that its own share of the window is not a rounding detail.
const QUERY_WORDS = 100;
const query = Array.from({ length: QUERY_WORDS }, (_, i) => `ask${i}`).join(" ");
const veryLongText = Array.from({ length: 500 }, (_, i) => `word${i}`).join(" ");

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("rerank batch refused over the reranker's token window", () => {
	it("cuts only the named text and scores the batch on the second try", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(overWindowRefusal(0, 728))
			.mockResolvedValueOnce(scored());
		vi.stubGlobal("fetch", fetchMock);

		const retriever = crossEncoderRetriever();
		const outcome = await retriever.rerank(
			"q",
			[candidate("a", longText, 0.9), candidate("b", "short memory", 0.8)],
			queryVector,
		);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const first = textsOf(fetchMock.mock.calls[0]);
		const second = textsOf(fetchMock.mock.calls[1]);
		// The pair the endpoint counted is the query plus the document, so the document keeps the
		// allowance the query does not take: scale the whole local pair by the ratio the refusal
		// reports, then give the query its own local tokens back.
		const allowed = DEFAULT_MAX_CONTEXT_TOKENS - RERANK_PROMPT_TEMPLATE_TOKENS;
		const queryTokens = 1;
		expect(first[0]?.split(" ").length).toBe(100);
		expect(second[0]?.split(" ").length).toBe(
			Math.floor((allowed * (queryTokens + 100)) / 728) - queryTokens,
		);
		// The text that was inside the window is sent again untouched.
		expect(second[1]).toBe(first[1]);
		// The batch was scored, so the search is not serving the pre-rerank order.
		expect(outcome.fallback).toBeUndefined();
		expect(outcome.candidates[0]?.entry.id).toBe("b");
		// The stored row keeps its full text; only the request copy was cut.
		expect(outcome.candidates.find((c) => c.entry.id === "a")?.entry.text).toBe(longText);
	});

	it("pays for the query's own share of the window, so a long query still repairs", async () => {
		// The ranking model counts half again what the embedder does — the divergence the repair
		// exists for. This mock answers by the endpoint's own rule instead of a fixed script, so
		// the test measures whether the resent batch actually fits rather than pinning arithmetic.
		const RANKER_RATE = 1.5;
		const pairTokens = (words: number) =>
			Math.floor(RANKER_RATE * (QUERY_WORDS + words)) + RERANK_PROMPT_TEMPLATE_TOKENS;
		const fetchMock = vi.fn((_url: string, init: { body: string }) => {
			const texts = textsOf([_url, init]);
			const overLong = texts
				.map((text, index) => ({ index, tokens: pairTokens(text.split(/\s+/).filter(Boolean).length) }))
				.filter((entry) => entry.tokens > DEFAULT_MAX_CONTEXT_TOKENS);
			if (overLong.length === 0) return Promise.resolve(scored());
			return Promise.resolve(
				new Response(
					JSON.stringify({
						detail: {
							code: "input_token_limit_exceeded",
							max_input_tokens: DEFAULT_MAX_CONTEXT_TOKENS,
							candidates: overLong.map((entry) => ({
								index: entry.index,
								input_tokens: entry.tokens,
								excess_tokens: entry.tokens - DEFAULT_MAX_CONTEXT_TOKENS,
							})),
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const retriever = crossEncoderRetriever();
		const outcome = await retriever.rerank(
			query,
			[candidate("a", veryLongText, 0.9), candidate("b", "short memory", 0.8)],
			queryVector,
		);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const resent = textsOf(fetchMock.mock.calls[1]);
		const resentWords = resent[0]?.split(" ").length ?? 0;
		// Scaling the document by the pair's ratio alone leaves 271 words here, which the endpoint
		// refuses again and the whole batch's scores are lost.
		expect(pairTokens(resentWords)).toBeLessThanOrEqual(DEFAULT_MAX_CONTEXT_TOKENS);
		expect(outcome.fallback).toBeUndefined();
		expect(outcome.candidates[0]?.entry.id).toBe("b");
	});

	it("gives up after one repair rather than asking again forever", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(overWindowRefusal(0, 728))
			.mockResolvedValueOnce(overWindowRefusal(0, 600));
		vi.stubGlobal("fetch", fetchMock);

		const retriever = crossEncoderRetriever();
		const outcome = await retriever.rerank(
			"q",
			[candidate("a", longText, 0.9), candidate("b", "short memory", 0.8)],
			queryVector,
		);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(outcome.fallback?.reason).toBe("http_error");
	});
});
