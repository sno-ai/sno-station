import { afterEach, describe, expect, it, vi } from "vitest";
import { RetrievalError } from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever-dependencies.ts";
import {
	createRetriever,
	DEFAULT_RETRIEVAL_CONFIG,
	type MemoryRetrieverInternals,
} from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever.ts";
import type { RetrievalResult } from "../../../../packages/sno-station-mem/src/engine/shared/types.ts";

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
		rerankProvider: "tei",
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
		expect(outcome.fallback).toEqual({ reason: "timeout", provider: "tei" });
		expect(outcome.candidates.map((c) => c.entry.id)).toEqual(["a", "b"]);
	});

	it("does not retry a fatal status", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("unauthorized", { status: 401 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			crossEncoderRetriever().rerank("query", twoCandidates(), queryVector),
		).rejects.toBeInstanceOf(RetrievalError);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
