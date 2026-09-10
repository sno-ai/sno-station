import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	createRetriever,
	DEFAULT_RETRIEVAL_CONFIG,
} from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever.ts";
import type { MemoryEntry, MemorySearchResult } from "../../../../packages/sno-station-mem/src/engine/shared/types.ts";

// Real integration test: the Sno cross-encoder reranker is hit over HTTP. No
// mock of the reranker — the whole point is to prove the mem-claw retriever's
// `rerank: "cross-encoder"` + `rerankProvider: "tei"` path is wired to the live
// Sno service (https://rt3-llm.sno.ai/rerank) and actually reorders results.
//
// The store/embedder are lightweight stubs only because they are NOT the system
// under test here — they exist purely to feed a fixed candidate set into the
// reranker. The single real dependency (the reranker HTTP call) is exercised for
// real, and the fetch spy below calls through to the real network.

const SNO_RERANK_ENDPOINT = "https://rt3-llm.sno.ai/rerank";

function loadInternalServiceSecret(): string {
	const fromEnv = process.env.INTERNAL_SERVICE_SECRET;
	if (fromEnv && fromEnv.length > 0) {
		return fromEnv;
	}
	// Fall back to the on-prem infra env file the eval scripts already source.
	const envPath = join(homedir(), "infra", "onprem-infra", ".env");
	const contents = readFileSync(envPath, "utf8");
	for (const line of contents.split("\n")) {
		const match = line.match(/^\s*INTERNAL_SERVICE_SECRET\s*=\s*(.+?)\s*$/);
		if (match?.[1]) {
			// Strip optional surrounding quotes.
			return match[1].replace(/^["']|["']$/g, "");
		}
	}
	throw new Error(
		`INTERNAL_SERVICE_SECRET not found in process.env or ${envPath}; ` +
			"cannot run the real Sno reranker integration test",
	);
}

function makeEntry(id: string, text: string): MemoryEntry {
	return {
		id,
		text,
		category: "episodic",
		lane: "active",
		projectId: "global",
		importance: 0.5,
		timestamp: Date.now(),
		metadata: "{}",
		contentHash: `hash-${id}`,
	};
}

// Candidates are ordered so the IRRELEVANT memories carry HIGHER raw vector
// scores than the one that actually answers the query. Only a working
// cross-encoder can promote "typescript" to rank 1; raw-vector order buries it
// last. This makes the test fail if the reranker is silently skipped or falls
// back to the local lightweight path.
const CANDIDATES: MemorySearchResult[] = [
	{ entry: makeEntry("hiking", "The user hikes in the Rocky Mountains every weekend."), score: 0.9 },
	{
		entry: makeEntry("sushi", "The user's favorite meal is Japanese sushi with green tea."),
		score: 0.86,
	},
	{ entry: makeEntry("tesla", "The user drives a red Tesla Model 3 to the office."), score: 0.82 },
	{
		entry: makeEntry(
			"typescript",
			"The user insists on TypeScript with strict mode for compile-time type safety.",
		),
		score: 0.7,
	},
];

const QUERY = "Which programming language does the user prefer for type safety?";

const storeStub = {
	hasFtsSupport: true,
	searchSemantic: async () => CANDIDATES,
	searchKeyword: async () => [] as MemorySearchResult[],
	getVectorsByIds: () => new Map<string, Float32Array>(),
};

const embedderStub = {
	embed: async () => new Float32Array([1, 0, 0]),
	providerKind: "local-onnx",
	model: "test",
	dimensions: 3,
};

// Neutralize every score-mutating stage except rerank so the test isolates the
// reranker's effect on ordering: no recency, no time-decay, no length-norm, no
// importance skew, pure-relevance MMR, and no score floors.
const BASE_CONFIG = {
	...DEFAULT_RETRIEVAL_CONFIG,
	minScore: 0,
	hardMinScore: 0,
	recencyWeight: 0,
	timeDecayHalfLifeDays: 0,
	lengthNormAnchor: 0,
	importanceWeightBase: 1,
	mmrLambda: 1,
	candidatePoolSize: 64,
};

const ORIGINAL_FETCH = globalThis.fetch;
let internalKey: string;

beforeAll(() => {
	internalKey = loadInternalServiceSecret();
});

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
});

describe("retriever cross-encoder rerank against the real Sno reranker", () => {
	it("control: without reranking the raw-vector order wins and the relevant memory is buried", async () => {
		const retriever = createRetriever(
			storeStub as never,
			embedderStub as never,
			{ warn: () => {} },
			{ ...BASE_CONFIG, rerank: "none" },
		);

		const results = await retriever.retrieve({ query: QUERY, limit: 4 });

		expect(results.length).toBeGreaterThan(0);
		// Highest raw vector score wins when nothing reranks; the actually-relevant
		// TypeScript memory sits last, not first.
		expect(results[0]?.entry.id).toBe("hiking");
		expect(results[0]?.entry.id).not.toBe("typescript");
		expect(results.at(-1)?.entry.id).toBe("typescript");
	});

	it(
		"cross-encoder promotes the relevant memory to rank 1 via a real Sno reranker call",
		async () => {
			const seenUrls: string[] = [];
			// Spy that CALLS THROUGH to the real fetch — the reranker request is
			// genuinely made; we only record the URLs to prove the Sno endpoint was hit.
			globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
				seenUrls.push(typeof input === "string" ? input : input.toString());
				return ORIGINAL_FETCH(input, init);
			}) as typeof fetch;

			const retriever = createRetriever(
				storeStub as never,
				embedderStub as never,
				{ warn: () => {} },
				{
					...BASE_CONFIG,
					rerank: "cross-encoder",
					rerankProvider: "tei",
					rerankEndpoint: SNO_RERANK_ENDPOINT,
					rerankApiKey: internalKey,
				},
			);

			const results = await retriever.retrieve({ query: QUERY, limit: 4 });

			// The real reranker must have judged the TypeScript memory most relevant
			// and lifted it from last place to rank 1.
			expect(results[0]?.entry.id).toBe("typescript");
			// Prove the Sno reranker was actually called — not silently skipped or
			// degraded to the local lightweight cosine path.
			expect(seenUrls.some((url) => url.startsWith(SNO_RERANK_ENDPOINT))).toBe(true);
		},
		30_000,
	);
});
