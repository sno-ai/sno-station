import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createRetriever,
	DEFAULT_RETRIEVAL_CONFIG,
	type MemoryRetrieverInternals,
} from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import type { RetrievalResult } from "../../../../packages/memory/src/engine/shared/types.ts";

// Issue #222: a transient rerank transport failure (socket reset, per-call timeout, 502-504)
// fell back to the un-reranked order on the first miss. `fetch` is the only external boundary
// of `rerank()`, so it is the one thing substituted here; everything else is the real retriever.
const noopStore = {
	getVectorsByIds: () => new Map<string, Float32Array>(),
} as never;
const noopEmbedder = {
	embed: async () => new Float32Array([1, 0, 0]),
	// Queries and candidates here are a few words, so the reranker's token window never binds:
	// one token per whitespace-separated word is enough to keep the budget positive, and the
	// cut is then the identity.
	countTokens: (text: string) => text.split(/\s+/).filter(Boolean).length,
	truncateToTokens: (text: string) => text,
} as never;

function candidate(id: string, score: number): RetrievalResult {
	return {
		entry: {
			id,
			text: `memory ${id}`,
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
	const retriever = createRetriever(noopStore, noopEmbedder, { warn: () => {} }, {
		...DEFAULT_RETRIEVAL_CONFIG,
		rerank: "cross-encoder",
		rerankApiKey: "test-key",
		rerankEndpoint: "http://127.0.0.1:9/rerank",
		rerankTimeoutMs: 1_000,
	});
	return retriever as unknown as MemoryRetrieverInternals;
}

// TEI answers with the second document first, so a reranked result is distinguishable
// from the pre-rerank order by inspection.
function teiResponse(): Response {
	return new Response(
		JSON.stringify([
			{ index: 1, score: 0.99 },
			{ index: 0, score: 0.01 },
		]),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

// undici's shape for a reset connection (measured on Node 24: TypeError "fetch failed",
// cause code UND_ERR_SOCKET).
function socketReset(): TypeError {
	return new TypeError("fetch failed", { cause: new Error("UND_ERR_SOCKET") });
}

const twoCandidates = () => [candidate("a", 0.9), candidate("b", 0.8)];
const queryVector = new Float32Array([1, 0, 0]);

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("rerank transient-failure retry (issue #222)", () => {
	it("blends the local model's logit range with cosine while retaining the head's score slots", async () => {
		const embedder = { scoreRelevance: async () => [10, 9, 11] } as never;
		const retriever = createRetriever(noopStore, embedder, undefined, DEFAULT_RETRIEVAL_CONFIG) as unknown as MemoryRetrieverInternals;
		const outcome = await retriever.rerankLocalModel("query", [candidate("first", 0.9), candidate("second", 0.8), candidate("third", 0.1)]);
		expect(outcome.modelOrder).toEqual(["first", "third", "second"]);
		expect(outcome.candidates.map((result) => result.score)).toEqual([0.9, 0.8, 0.1]);
	});

	it("preserves distinct positive model scores through source blending and final diversity", async () => {
		// The high positive logits and competing source scores reproduce the saturation failure.
		vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([
			{ index: 0, score: 9.5 }, { index: 1, score: 9.25 }, { index: 2, score: 8.1875 },
		]), { status: 200, headers: { "content-type": "application/json" } })));
		const vectors = new Map([
			["first", new Float32Array([1, 0, 0])],
			["gold", new Float32Array([1, 0, 0])],
			["distractor", new Float32Array([0, 1, 0])],
		]);
		const retriever = createRetriever({ getVectorsByIds: () => vectors } as never, noopEmbedder, undefined, {
			...DEFAULT_RETRIEVAL_CONFIG, rerank: "cross-encoder", rerankApiKey: "test-key",
			rerankEndpoint: "http://127.0.0.1:9/rerank",
		}) as unknown as MemoryRetrieverInternals;
		const candidates = [candidate("first", 0.5), candidate("gold", 0.480465), candidate("distractor", 0.514725)]
			.map((result) => ({ ...result, chunkId: result.entry.id }));
		const outcome = await retriever.rerank("query", candidates, queryVector);
		const final = retriever.applyScoringPipeline(outcome.candidates);
		expect(outcome.fallback).toBeUndefined();
		expect(outcome.candidates.every((result) => result.rerankScore === result.score)).toBe(true);
		expect(final.map((result) => result.entry.id)).toEqual(["first", "gold", "distractor"]);
	});

	it("retries a socket reset and returns the reranked order without a fallback", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(socketReset())
			.mockResolvedValueOnce(teiResponse());
		vi.stubGlobal("fetch", fetchMock);

		const outcome = await crossEncoderRetriever().rerank("query", twoCandidates(), queryVector);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(outcome.fallback).toBeUndefined();
		expect(outcome.candidates.map((c) => c.entry.id)).toEqual(["b", "a"]);
	});

	it("retries when the body read fails after a 200 header", async () => {
		// The socket can die after the headers: fetch() resolves, response.json() rejects.
		const brokenBody = new Response(
			new ReadableStream({
				pull(controller) {
					controller.error(new TypeError("terminated", { cause: new Error("UND_ERR_SOCKET") }));
				},
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(brokenBody)
			.mockResolvedValueOnce(teiResponse());
		vi.stubGlobal("fetch", fetchMock);

		const outcome = await crossEncoderRetriever().rerank("query", twoCandidates(), queryVector);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(outcome.fallback).toBeUndefined();
		expect(outcome.candidates.map((c) => c.entry.id)).toEqual(["b", "a"]);
	});

	it("gives up after three timeouts and reports the fallback as a timeout", async () => {
		// Node's fetch with AbortSignal.timeout() rejects with a DOMException named
		// "TimeoutError" (measured on Node 24), not "AbortError".
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
		vi.stubGlobal("fetch", fetchMock);

		const outcome = await crossEncoderRetriever().rerank("query", twoCandidates(), queryVector);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(outcome.fallback).toEqual({ reason: "timeout" });
		expect(outcome.candidates.map((c) => c.entry.id)).toEqual(["a", "b"]);
	});

	it("does not retry a refused key and ranks locally instead", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("unauthorized", { status: 401 }));
		vi.stubGlobal("fetch", fetchMock);

		const outcome = await crossEncoderRetriever().rerank("query", twoCandidates(), queryVector);
		expect(outcome.fallback).toEqual({ reason: "http_error" });
		expect(outcome.candidates).toHaveLength(2);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
