import { afterEach, describe, expect, it } from "vitest";
import {
	createRetriever,
	DEFAULT_RETRIEVAL_CONFIG,
} from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever.ts";
import { RetrievalError } from "../../../../packages/sno-station-mem/src/engine/shared/errors.ts";
import { truncateToTokens } from "../../../../packages/sno-station-mem/src/engine/shared/token-bound.ts";
import {
	DEFAULT_MAX_CONTEXT_TOKENS,
	RERANK_PROMPT_TEMPLATE_TOKENS,
} from "../../../../packages/sno-station-mem/config/index.ts";

const ORIGINAL_FETCH = globalThis.fetch;

const TEST_ENTRY = {
	id: "mem-1",
	text: "TypeScript strict mode avoids implicit any bugs.",
	category: "episodic" as const,
	projectId: "global",
	importance: 0.7,
	timestamp: Date.now(),
	metadata: "{}",
	contentHash: "hash-1",
};

const TEST_RESULTS = [
	{
		entry: TEST_ENTRY,
		score: 0.95,
	},
];

const storeStub = {
	hasFtsSupport: true,
	isMemoryOnFactSurface: () => true,
	searchSemantic: async () => TEST_RESULTS,
	searchKeyword: async () => TEST_RESULTS,
};

// One token per character keeps the ceiling arithmetic readable in the assertions below.
const embedderStub = {
	embed: async () => new Float32Array([1, 0, 0]),
	countTokens: (text: string) => text.length,
	truncateToTokens: (text: string, maxTokens: number) =>
		truncateToTokens(text, maxTokens, (t) => t.length),
};

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
});

describe("retriever rerank error handling", () => {
	it("surfaces 401 rerank failures instead of silently degrading", async () => {
		globalThis.fetch = async () => new Response("unauthorized", { status: 401 });

		const retriever = createRetriever(
			storeStub as never,
			embedderStub as never,
			{ warn: () => {} },
			{
				...DEFAULT_RETRIEVAL_CONFIG,
				rerank: "cross-encoder",
				rerankApiKey: "test-key",
				minScore: 0,
				hardMinScore: 0,
			},
		);

		try {
			await retriever.retrieve({ query: "typescript", limit: 1 });
			throw new Error("expected retrieve() to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(RetrievalError);
			const cause =
				error instanceof Error &&
				"cause" in error &&
				error.cause instanceof Error
					? error.cause
					: null;
			expect(cause).toBeInstanceOf(RetrievalError);
			expect(cause?.message).toContain("status 401");
		}
	});

	it("includes retry-after details for 429 rerank failures", async () => {
		globalThis.fetch = async () =>
			new Response("rate limited", {
				status: 429,
				headers: { "retry-after": "7" },
			});

		const retriever = createRetriever(
			storeStub as never,
			embedderStub as never,
			{ warn: () => {} },
			{
				...DEFAULT_RETRIEVAL_CONFIG,
				rerank: "cross-encoder",
				rerankApiKey: "test-key",
				minScore: 0,
				hardMinScore: 0,
			},
		);

		try {
			await retriever.retrieve({ query: "typescript", limit: 1 });
			throw new Error("expected retrieve() to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(RetrievalError);
			const cause =
				error instanceof Error &&
				"cause" in error &&
				error.cause instanceof Error
					? error.cause
					: null;
			expect(cause).toBeInstanceOf(RetrievalError);
			expect(cause?.message).toContain("retry after 7s");
		}
	});

	it("wraps retrieveWithTrace rerank failures in RetrievalError", async () => {
		globalThis.fetch = async () => new Response("unauthorized", { status: 401 });

		const retriever = createRetriever(
			storeStub as never,
			embedderStub as never,
			{ warn: () => {} },
			{
				...DEFAULT_RETRIEVAL_CONFIG,
				rerank: "cross-encoder",
				rerankApiKey: "test-key",
				minScore: 0,
				hardMinScore: 0,
			},
		);

		try {
			await retriever.retrieveWithTrace({ query: "typescript", limit: 1 });
			throw new Error("expected retrieveWithTrace() to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(RetrievalError);
			const cause =
				error instanceof Error &&
				"cause" in error &&
				error.cause instanceof Error
					? error.cause
					: null;
			expect(cause).toBeInstanceOf(RetrievalError);
			expect(cause?.message).toContain("status 401");
		}
	});

	it("applies minScore after reranking so strong rerank hits are retained", async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					data: [{ index: 0, relevance_score: 1.0 }],
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);

		const lowScoreResults = [
			{
				entry: TEST_ENTRY,
				score: 0.3,
			},
		];
		const retriever = createRetriever(
			{
				hasFtsSupport: true,
				isMemoryOnFactSurface: () => true,
				searchSemantic: async () => lowScoreResults,
				searchKeyword: async () => lowScoreResults,
			} as never,
			embedderStub as never,
			{ warn: () => {} },
			{
				...DEFAULT_RETRIEVAL_CONFIG,
				rerank: "cross-encoder",
				rerankApiKey: "test-key",
				minScore: 0.5,
				hardMinScore: 0,
				lengthNormAnchor: 0,
				importanceWeightBase: 0.5,
			},
		);

		const results = await retriever.retrieve({ query: "typescript", limit: 1 });

		expect(results).toHaveLength(1);
		expect(results[0]?.score).toBeGreaterThanOrEqual(0.5);
	});

	it("applies minScore in bm25-only tagged queries", async () => {
		const taggedResults = [
			{
				entry: {
					...TEST_ENTRY,
					id: "mem-low",
					text: "proj:AIF low score tagged match",
					importance: 1,
					contentHash: "hash-low",
				},
				score: 0.49,
			},
			{
				entry: {
					...TEST_ENTRY,
					id: "mem-pass",
					text: "proj:AIF passing tagged match",
					importance: 1,
					contentHash: "hash-pass",
				},
				score: 0.55,
			},
		];

		const retriever = createRetriever(
			{
				hasFtsSupport: true,
				isMemoryOnFactSurface: () => true,
				searchSemantic: async () => {
					throw new Error("vector search should not run for tagged queries");
				},
				searchKeyword: async () => taggedResults,
			} as never,
			embedderStub as never,
			{ warn: () => {} },
			{
				...DEFAULT_RETRIEVAL_CONFIG,
				rerank: "none",
				minScore: 0.5,
				hardMinScore: 0,
				lengthNormAnchor: 0,
				importanceWeightBase: 0.5,
			},
		);

		const results = await retriever.retrieve({
			query: "proj:AIF deploy",
			limit: 5,
		});

		expect(results.map((result) => result.entry.id)).toEqual(["mem-pass"]);
	});

	it("demotes unreturned high-bm25 entries below reranked hits", async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					data: [{ index: 1, relevance_score: 1.0 }],
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);

		const highBm25Entry = {
			...TEST_ENTRY,
			id: "mem-lexical",
			text: "proj:AIF release checklist with rollback steps",
			importance: 1,
			contentHash: "hash-lexical",
		};
		const rerankedEntry = {
			...TEST_ENTRY,
			id: "mem-reranked",
			text: "AIF deployment playbook with release guidance",
			importance: 1,
			contentHash: "hash-reranked",
		};

		const retriever = createRetriever(
			{
				hasFtsSupport: true,
				isMemoryOnFactSurface: () => true,
				searchSemantic: async () => [
					{ entry: highBm25Entry, score: 0.72 },
					{ entry: rerankedEntry, score: 0.68 },
				],
				searchKeyword: async () => [
					{ entry: highBm25Entry, score: 0.98 },
					{ entry: rerankedEntry, score: 0.05 },
				],
			} as never,
			embedderStub as never,
			{ warn: () => {} },
			{
				...DEFAULT_RETRIEVAL_CONFIG,
				rerank: "cross-encoder",
				rerankApiKey: "test-key",
				minScore: 0,
				hardMinScore: 0,
				lengthNormAnchor: 0,
				importanceWeightBase: 0.5,
				rerankBlendCross: 0.7,
				rerankBlendVector: 0.3,
			},
		);

		const results = await retriever.retrieve({
			query: "AIF deployment rollback",
			limit: 2,
		});

		expect(results.map((result) => result.entry.id)).toEqual([
			"mem-reranked",
			"mem-lexical",
		]);
		expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
	});

	it("refuses a cross-encoder with no key instead of ranking with a different ranker", async () => {
		// This used to fall back to the local cosine blend and tag the stage `missing_api_key`.
		// A deployment then ran a ranker nobody had chosen and one warning line was its only
		// trace, so configuration that cannot be honoured is now refused outright.
		const retriever = createRetriever(
			storeStub as never,
			embedderStub as never,
			{ warn: () => {} },
			{
				...DEFAULT_RETRIEVAL_CONFIG,
				rerank: "cross-encoder",
				minScore: 0,
				hardMinScore: 0,
			},
		);

		await expect(
			retriever.retrieveWithTrace({ query: "typescript", limit: 1 }),
		).rejects.toThrow("requires retrieval.rerankApiKey");
	});

	it("tags no_endpoint fallback when provider lacks a default endpoint", async () => {
		const retriever = createRetriever(
			storeStub as never,
			embedderStub as never,
			{ warn: () => {} },
			{
				...DEFAULT_RETRIEVAL_CONFIG,
				rerank: "cross-encoder",
				rerankApiKey: "test-key",
				rerankProvider: "no-such-provider",
				minScore: 0,
				hardMinScore: 0,
			},
		);

		const { trace } = await retriever.retrieveWithTrace({
			query: "typescript",
			limit: 1,
		});
		const rerankStage = trace.stages.find((s) => s.name === "rerank");
		expect(rerankStage?.metadata).toEqual({
			rerankFallbackReason: "no_endpoint",
			rerankFallbackProvider: "no-such-provider",
		});
	});

	it("tags http_error fallback on non-fatal upstream status", async () => {
		globalThis.fetch = async () => new Response("upstream broken", { status: 500 });

		const retriever = createRetriever(
			storeStub as never,
			embedderStub as never,
			{ warn: () => {} },
			{
				...DEFAULT_RETRIEVAL_CONFIG,
				rerank: "cross-encoder",
				rerankApiKey: "test-key",
				minScore: 0,
				hardMinScore: 0,
			},
		);

		const { trace } = await retriever.retrieveWithTrace({
			query: "typescript",
			limit: 1,
		});
		const rerankStage = trace.stages.find((s) => s.name === "rerank");
		expect(rerankStage?.metadata).toEqual({
			rerankFallbackReason: "http_error",
			rerankFallbackProvider: "voyage",
		});
	});

	it("tags invalid_response fallback on unparseable rerank payload", async () => {
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ unexpected: "shape" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});

		const retriever = createRetriever(
			storeStub as never,
			embedderStub as never,
			{ warn: () => {} },
			{
				...DEFAULT_RETRIEVAL_CONFIG,
				rerank: "cross-encoder",
				rerankApiKey: "test-key",
				minScore: 0,
				hardMinScore: 0,
			},
		);

		const { trace } = await retriever.retrieveWithTrace({
			query: "typescript",
			limit: 1,
		});
		const rerankStage = trace.stages.find((s) => s.name === "rerank");
		expect(rerankStage?.metadata).toEqual({
			rerankFallbackReason: "invalid_response",
			rerankFallbackProvider: "voyage",
		});
	});

	it("reports rerank coverage counts on the happy path", async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({ data: [{ index: 0, relevance_score: 0.9 }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);

		const retriever = createRetriever(
			storeStub as never,
			embedderStub as never,
			{ warn: () => {} },
			{
				...DEFAULT_RETRIEVAL_CONFIG,
				rerank: "cross-encoder",
				rerankApiKey: "test-key",
				minScore: 0,
				hardMinScore: 0,
			},
		);

		const { trace } = await retriever.retrieveWithTrace({
			query: "typescript",
			limit: 1,
		});
		const rerankStage = trace.stages.find((s) => s.name === "rerank");
		expect(rerankStage).toBeDefined();
		expect(rerankStage?.metadata).toEqual({
			rerankSentCount: 1,
			rerankReturnedCount: 1,
			rerankBeyondCapCount: 0,
		});
	});

	it("keeps returned high-signal rerank candidates distinct below score saturation", async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					data: [
						{ index: 0, relevance_score: 0.96 },
						{ index: 1, relevance_score: 0.78 },
					],
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);

		const firstEntry = {
			...TEST_ENTRY,
			id: "mem-top",
			text: "proj:AIF release checklist and deployment notes",
			importance: 1,
			contentHash: "hash-top",
		};
		const secondEntry = {
			...TEST_ENTRY,
			id: "mem-second",
			text: "proj:AIF deployment runbook and rollback details",
			importance: 1,
			contentHash: "hash-second",
		};

		const retriever = createRetriever(
			{
				hasFtsSupport: true,
				isMemoryOnFactSurface: () => true,
				searchSemantic: async () => [
					{ entry: firstEntry, score: 0.98 },
					{ entry: secondEntry, score: 0.93 },
				],
				searchKeyword: async () => [
					{ entry: firstEntry, score: 0.99 },
					{ entry: secondEntry, score: 0.97 },
				],
			} as never,
			embedderStub as never,
			{ warn: () => {} },
			{
				...DEFAULT_RETRIEVAL_CONFIG,
				rerank: "cross-encoder",
				rerankApiKey: "test-key",
				minScore: 0,
				hardMinScore: 0,
				lengthNormAnchor: 0,
				importanceWeightBase: 0.5,
				rerankBlendCross: 0.7,
				rerankBlendVector: 0.3,
			},
		);

		const results = await retriever.retrieve({
			query: "AIF deployment release runbook",
			limit: 2,
		});

		expect(results.map((result) => result.entry.id)).toEqual([
			"mem-top",
			"mem-second",
		]);
		expect(results[0]?.score).toBeLessThan(1);
		expect(results[1]?.score).toBeLessThan(1);
		expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
	});

	it("caps what reaches the reranker at rerankMaxCandidates, carries the rest through, and never misindexes", async () => {
		// Regression test for a real bug found 2026-07-06: the Sno TEI reranker
		// rejects a batch over 50 texts outright ({"error":"too many texts: max
		// 50, got 64"}), which the retriever silently swallowed as an
		// http_error fallback — every LoCoMo cross-encoder eval run was
		// silently degrading to raw fusion scores with candidatePoolSize=64.
		const requestedBatches: string[][] = [];
		globalThis.fetch = async (_url, init) => {
			const body = JSON.parse(String(init?.body)) as { documents: string[] };
			requestedBatches.push(body.documents);
			// The one request (3 texts): promote the LAST sent candidate (index 2, entry
			// "mem-2") to the top — proves the returned index is resolved against what
			// was sent, not the original 5-candidate array.
			const scores = [
				{ index: 2, relevance_score: 0.99 },
				{ index: 0, relevance_score: 0.5 },
				{ index: 1, relevance_score: 0.4 },
			];
			return new Response(JSON.stringify({ data: scores }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const entries = Array.from({ length: 5 }, (_, i) => ({
			...TEST_ENTRY,
			id: `mem-${i}`,
			contentHash: `hash-${i}`,
		}));
		const searchResults = entries.map((entry, i) => ({ entry, score: 0.99 - i * 0.05 }));

		const retriever = createRetriever(
			{
				hasFtsSupport: true,
				isMemoryOnFactSurface: () => true,
				searchSemantic: async () => searchResults,
				searchKeyword: async () => [],
			} as never,
			embedderStub as never,
			{ warn: () => {} },
			{
				...DEFAULT_RETRIEVAL_CONFIG,
				rerank: "cross-encoder",
				rerankProvider: "voyage",
				rerankApiKey: "test-key",
				rerankMaxCandidates: 3,
				minScore: 0,
				hardMinScore: 0,
				lengthNormAnchor: 0,
				importanceWeightBase: 1,
			},
		);

		const results = await retriever.retrieve({ query: "test query", limit: 5 });

		// The cap is the TOTAL sent: one request of 3; the other two never leave.
		expect(requestedBatches.map((batch) => batch.length)).toEqual([3]);

		// No candidate may be dropped — all 5 originals must still be present.
		expect(new Set(results.map((r) => r.entry.id))).toEqual(
			new Set(["mem-0", "mem-1", "mem-2", "mem-3", "mem-4"]),
		);

		// index:2 in the reranker's response must resolve to the 3rd candidate
		// SENT (mem-2), not candidates[2] of some other slice — and it must
		// rank first.
		expect(results[0]?.entry.id).toBe("mem-2");

		// mem-3 and mem-4 were never sent; they are carried through at a penalised
		// score and must rank below the reranked winner.
		const rank = new Map(results.map((r, i) => [r.entry.id, i]));
		expect(rank.get("mem-3")).toBeGreaterThan(rank.get("mem-2") as number);
		expect(rank.get("mem-4")).toBeGreaterThan(rank.get("mem-2") as number);
	});

	it("defaults rerankMaxCandidates to 50 for the tei provider when unset, so production users are protected without configuring it", async () => {
		// The "too many texts" bug is a silent-degrade trap for anyone who
		// configures rerankProvider: "tei" without also knowing to set
		// rerankMaxCandidates. This is the safety net for that case.
		const requestedTextCounts: number[] = [];
		globalThis.fetch = async (_url, init) => {
			const body = JSON.parse(String(init?.body)) as { texts: string[] };
			requestedTextCounts.push(body.texts.length);
			return new Response(JSON.stringify(body.texts.map((_, i) => ({ index: i, score: 0.5 }))), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const entries = Array.from({ length: 60 }, (_, i) => ({
			...TEST_ENTRY,
			id: `mem-${i}`,
			contentHash: `hash-${i}`,
		}));
		const searchResults = entries.map((entry, i) => ({ entry, score: 0.99 - i * 0.001 }));

		const retriever = createRetriever(
			{
				hasFtsSupport: true,
				isMemoryOnFactSurface: () => true,
				searchSemantic: async () => searchResults,
				searchKeyword: async () => [],
			} as never,
			embedderStub as never,
			{ warn: () => {} },
			{
				...DEFAULT_RETRIEVAL_CONFIG,
				rerank: "cross-encoder",
				rerankProvider: "tei",
				rerankEndpoint: "https://example.test/rerank",
				rerankApiKey: "test-key",
				// rerankMaxCandidates intentionally left unset.
				candidatePoolSize: 60,
				minScore: 0,
				hardMinScore: 0,
			},
		);

		await retriever.retrieve({ query: "test query", limit: 60 });

		expect(requestedTextCounts).toEqual([50, 10]);
	});

	it("cuts a candidate over the record token ceiling for the rerank request without mutating the returned entry", async () => {
		// The Sno reranker truncates silently past its window (measured 2026-09-14: a claim
		// placed past the cut scored 0.0001), so a row written before the ceiling existed is
		// cut by exact token count, to what the query leaves inside the window, before it is sent.
		let requestedTextLengths: number[] = [];
		globalThis.fetch = async (_url, init) => {
			const body = JSON.parse(String(init?.body)) as { texts: string[] };
			requestedTextLengths = body.texts.map((t) => t.length);
			return new Response(JSON.stringify(body.texts.map((_, i) => ({ index: i, score: 0.5 }))), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const longText = "x".repeat(DEFAULT_MAX_CONTEXT_TOKENS * 2);
		const shortText = "a short memory chunk";
		const longEntry = { ...TEST_ENTRY, id: "mem-long", text: longText, contentHash: "hash-long" };
		const shortEntry = {
			...TEST_ENTRY,
			id: "mem-short",
			text: shortText,
			contentHash: "hash-short",
		};

		const retriever = createRetriever(
			{
				hasFtsSupport: true,
				isMemoryOnFactSurface: () => true,
				searchSemantic: async () => [
					{ entry: longEntry, score: 0.9 },
					{ entry: shortEntry, score: 0.8 },
				],
				searchKeyword: async () => [],
			} as never,
			embedderStub as never,
			{ warn: () => {} },
			{
				...DEFAULT_RETRIEVAL_CONFIG,
				rerank: "cross-encoder",
				rerankProvider: "tei",
				rerankEndpoint: "https://example.test/rerank",
				rerankApiKey: "test-key",
				minScore: 0,
				hardMinScore: 0,
			},
		);

		const results = await retriever.retrieve({ query: "test query", limit: 2 });

		// The document gets what the query leaves inside the reranker's window, not the whole
		// ceiling: the window holds the query, the model's own prompt and ONE document together.
		// This stub counts one token per character, so "test query" is 10 of them.
		const documentBudget = DEFAULT_MAX_CONTEXT_TOKENS - RERANK_PROMPT_TEMPLATE_TOKENS - 10;
		expect(documentBudget).toBe(499);
		expect(requestedTextLengths).toEqual([documentBudget, shortText.length]);

		// The returned candidate's actual text must be the full, untruncated original.
		const longResult = results.find((r) => r.entry.id === "mem-long");
		expect(longResult?.entry.text).toBe(longText);
		expect(longResult?.entry.text.length).toBe(DEFAULT_MAX_CONTEXT_TOKENS * 2);
	});
});


/**
 * A real reranker on a real socket. The behaviour under test is how the retriever SCHEDULES its
 * batches, and Node's own HTTP client is part of that: a fetch substitute cannot show whether four
 * requests are genuinely in flight together or whether the transport serialized them anyway.
 */
interface RerankProbe {
	url: string;
	maxInFlight: number;
	requestCount: number;
	close: () => Promise<void>;
}

async function startRerankProbe(
	respond: (
		texts: string[],
		reply: (body: unknown, status?: number, headers?: Record<string, string>) => void,
	) => void,
): Promise<RerankProbe> {
	const { createServer } = await import("node:http");
	const probe = { url: "", maxInFlight: 0, requestCount: 0 } as RerankProbe;
	let inFlight = 0;
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			inFlight += 1;
			probe.requestCount += 1;
			probe.maxInFlight = Math.max(probe.maxInFlight, inFlight);
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { texts: string[] };
			respond(body.texts, (payload, status = 200, headers = {}) => {
				inFlight -= 1;
				response.writeHead(status, { "Content-Type": "application/json", ...headers });
				response.end(JSON.stringify(payload));
			});
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("probe has no port");
	probe.url = `http://127.0.0.1:${address.port}/rerank`;
	probe.close = () =>
		new Promise<void>((resolve) => {
			server.closeAllConnections();
			server.close(() => resolve());
		});
	return probe;
}

/** 250 rows, so a tei batch of 50 is five requests and the wave scheduling is observable. */
const BATCHED_ENTRIES = Array.from({ length: 250 }, (_, index) => ({
	entry: {
		...TEST_ENTRY,
		id: `mem-batch-${index}`,
		text: `Row ${index}: TypeScript strict mode avoids implicit any bugs.`,
		contentHash: `hash-batch-${index}`,
	},
	score: 0.5,
}));

const batchedStoreStub = {
	hasFtsSupport: true,
	isMemoryOnFactSurface: () => true,
	searchSemantic: async () => BATCHED_ENTRIES,
	searchKeyword: async () => BATCHED_ENTRIES,
};

describe("retriever rerank batching", () => {
	it("surfaces 401 when an earlier batch times out on every attempt", async () => {
		const probe = await startRerankProbe((texts, reply) => {
			// Leave batch zero unanswered on every attempt to exercise real fetch timeouts.
			if (texts.length !== 50) reply("unauthorized", 401);
		});
		try {
			const searchResults = BATCHED_ENTRIES.slice(0, 51);
			const retriever = createRetriever(
				{
					...batchedStoreStub,
					searchSemantic: async () => searchResults,
					searchKeyword: async () => searchResults,
				} as never,
				embedderStub as never,
				{ warn: () => {} },
				{
					...DEFAULT_RETRIEVAL_CONFIG,
					rerank: "cross-encoder",
					rerankProvider: "tei",
					rerankEndpoint: probe.url,
					rerankTimeoutMs: 50,
					rerankApiKey: "test-key",
					candidatePoolSize: 51,
					minScore: 0,
					hardMinScore: 0,
				},
			);

			try {
				await retriever.retrieve({ query: "typescript", limit: 51 });
				throw new Error("expected retrieve() to fail");
			} catch (error) {
				expect(error).toBeInstanceOf(RetrievalError);
				const cause =
					error instanceof Error &&
					"cause" in error &&
					error.cause instanceof Error
						? error.cause
						: null;
				expect(cause).toBeInstanceOf(RetrievalError);
				expect(cause?.message).toBe("Rerank API failed with status 401");
			}
		} finally {
			await probe.close();
		}
	});

	it("surfaces 429 with retry-after when an earlier batch exhausts 503 retries", async () => {
		const probe = await startRerankProbe((texts, reply) => {
			// Batch zero always fails with 503, including retries; batch one is fatal.
			if (texts.length === 50) reply("upstream unavailable", 503);
			else reply("rate limited", 429, { "retry-after": "7" });
		});
		try {
			const searchResults = BATCHED_ENTRIES.slice(0, 51);
			const retriever = createRetriever(
				{
					...batchedStoreStub,
					searchSemantic: async () => searchResults,
					searchKeyword: async () => searchResults,
				} as never,
				embedderStub as never,
				{ warn: () => {} },
				{
					...DEFAULT_RETRIEVAL_CONFIG,
					rerank: "cross-encoder",
					rerankProvider: "tei",
					rerankEndpoint: probe.url,
					rerankApiKey: "test-key",
					candidatePoolSize: 51,
					minScore: 0,
					hardMinScore: 0,
				},
			);

			try {
				await retriever.retrieve({ query: "typescript", limit: 51 });
				throw new Error("expected retrieve() to fail");
			} catch (error) {
				expect(error).toBeInstanceOf(RetrievalError);
				const cause =
					error instanceof Error &&
					"cause" in error &&
					error.cause instanceof Error
						? error.cause
						: null;
				expect(cause).toBeInstanceOf(RetrievalError);
				expect(cause?.message).toBe("Rerank API failed with status 429, retry after 7s");
			}
		} finally {
			await probe.close();
		}
	});

	it("sends the batches in bounded waves and keeps every score on its own row", async () => {
		// Every text carries its own row number, so the reply can score row N as N. The final order
		// is then fully determined, and any batch whose indices were re-based onto the wrong offset
		// puts a row in the wrong place.
		const probe = await startRerankProbe((texts, reply) => {
			const results = texts.map((text, index) => {
				const rowNumber = Number(/^Row (\d+):/.exec(text)?.[1] ?? "-1");
				return { index, score: rowNumber / 1_000 };
			});
			setTimeout(() => reply(results), 40);
		});
		try {
			const retriever = createRetriever(
				batchedStoreStub as never,
				embedderStub as never,
				{ warn: () => {} },
				{
					...DEFAULT_RETRIEVAL_CONFIG,
					rerank: "cross-encoder",
					rerankProvider: "tei",
					rerankEndpoint: probe.url,
					rerankApiKey: "test-key",
					minScore: 0,
					hardMinScore: 0,
				},
			);

			const results = await retriever.retrieve({ query: "typescript", limit: 250 });

			expect(probe.requestCount, "the candidates did not go out in five tei batches").toBe(5);
			expect(
				probe.maxInFlight,
				"the batches were still sent one after another",
			).toBeGreaterThan(1);
			expect(probe.maxInFlight, "more batches were in flight than the wave allows").toBeLessThanOrEqual(4);

			// Every row must carry the score the reranker gave for ITS OWN text. An index re-based
			// onto the wrong batch offset shows up here as a row wearing a neighbour's score, which
			// checking the final blended ordering alone cannot reliably detect.
			const misplaced = results.filter((result) => {
				const rowNumber = Number(/^Row (\d+):/.exec(result.entry.text)?.[1] ?? "-1");
				const sources = result.sources as { reranked?: { score: number } };
				return sources.reranked?.score !== rowNumber / 1_000;
			});
			expect(
				misplaced.map((result) => result.entry.id),
				"a batch's scores landed on rows from another batch",
			).toEqual([]);
			expect(
				results.filter((result) => (result.sources as { reranked?: unknown }).reranked).length,
				"not every candidate came back scored, so the check above saw only a subset",
			).toBe(250);
		} finally {
			await probe.close();
		}
	});

	it("does not multiply a slow reranker's latency by the batch count", async () => {
		// A healthy reranker under load, not a broken one: every batch answers, each takes 300 ms.
		// Serially that is five round trips on one tool call; in waves of four it is two.
		const LATENCY_MS = 300;
		const probe = await startRerankProbe((texts, reply) => {
			const results = texts.map((_text, index) => ({ index, score: 0.5 }));
			setTimeout(() => reply(results), LATENCY_MS);
		});
		try {
			const retriever = createRetriever(
				batchedStoreStub as never,
				embedderStub as never,
				{ warn: () => {} },
				{
					...DEFAULT_RETRIEVAL_CONFIG,
					rerank: "cross-encoder",
					rerankProvider: "tei",
					rerankEndpoint: probe.url,
					rerankApiKey: "test-key",
					minScore: 0,
					hardMinScore: 0,
				},
			);

			const startedAt = Date.now();
			const results = await retriever.retrieve({ query: "typescript", limit: 250 });
			const elapsed = Date.now() - startedAt;

			expect(probe.requestCount, "the candidates did not go out in five tei batches").toBe(5);
			expect(results.length, "the reranked candidates were not returned").toBe(250);
			// Two waves plus overhead. Five serial round trips would be 1,500 ms.
			expect(
				elapsed,
				`each batch waited for the one before it (${elapsed} ms for five ${LATENCY_MS} ms batches)`,
			).toBeLessThan(LATENCY_MS * 4);
		} finally {
			await probe.close();
		}
	}, 30_000);
});

it("retries 429 backpressure and serves the reranked result", async () => {
	const probe = await startRerankProbe((_texts, reply) => {
		if (probe.requestCount === 1) {
			reply("rate limited", 429, { "retry-after": "1" });
			return;
		}
		reply([{ index: 1, score: 10 }, { index: 0, score: -10 }]);
	});
	try {
		const searchResults = BATCHED_ENTRIES.slice(0, 2);
		const retriever = createRetriever(
			{
				...batchedStoreStub,
				searchSemantic: async () => searchResults,
				searchKeyword: async () => searchResults,
			} as never,
			embedderStub as never,
			{ warn: () => {} },
			{
				...DEFAULT_RETRIEVAL_CONFIG,
				rerank: "cross-encoder",
				rerankProvider: "tei",
				rerankEndpoint: probe.url,
				rerankApiKey: "test-key",
				minScore: 0,
				hardMinScore: 0,
			},
		);

		const results = await retriever.retrieve({ query: "typescript", limit: 2 });

		expect(results.map((result) => result.entry.text)).toEqual([
			"Row 1: TypeScript strict mode avoids implicit any bugs.",
			"Row 0: TypeScript strict mode avoids implicit any bugs.",
		]);
		expect(results.map((result) => result.sources.reranked?.score)).toEqual([10, -10]);
		expect(probe.requestCount).toBe(2);
	} finally {
		await probe.close();
	}
});
