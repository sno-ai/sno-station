import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import type { MemoryEntry, MemorySearchResult } from "../../../../packages/memory/src/engine/shared/types.ts";
import { defaultSettings, settingsToPluginConfig, type Settings } from "../../../../packages/memory/config/settings";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const QUERY = "Which programming language does the user prefer for type safety?";

function entry(id: string, text: string): MemoryEntry {
	return { id, text, category: "episodic", lane: "active", projectId: "global", importance: 0.5, timestamp: Date.now(), metadata: "{}", contentHash: `hash-${id}` };
}

function storeOf(candidates: MemorySearchResult[]) {
	return {
		hasFtsSupport: true,
		isMemoryOnFactSurface: (id: string) => candidates.some((c) => c.entry.id === id),
		searchSemantic: async () => candidates,
		searchKeyword: async () => [] as MemorySearchResult[],
		getVectorsByIds: () => new Map<string, Float32Array>(),
	};
}

const BASE_CONFIG = {
	...DEFAULT_RETRIEVAL_CONFIG, minScore: 0, hardMinScore: 0, lengthNormAnchor: 0, importanceWeightBase: 1, mmrLambda: 1, candidatePoolSize: 64,
};

let embedder: Embedder;
beforeAll(async () => { embedder = await createTestEmbedder(); });

function settingsFor(mode: Settings["mode"], patch: Partial<Settings> = {}): Settings {
	return { ...defaultSettings(), mode, snoGpu: { baseUrl: "https://rt3-llm.sno.ai", apiKey: "machine-key" }, ...patch };
}

describe("which settings send recall ranking to Sno GPU", () => {
	it("REM Enhanced with a Sno GPU key ranks on Sno's reranker at the Sno GPU address, with the same key", () => {
		const retrieval = settingsToPluginConfig(settingsFor("rem-enhanced")).retrieval;
		expect(retrieval).toMatchObject({ rerank: "cross-encoder", rerankProvider: "sno-gpu", rerankEndpoint: "https://rt3-llm.sno.ai/rerank", rerankApiKey: "machine-key" });
	});

	it("the other two modes and a missing key rank locally and never name a Sno GPU key", () => {
		for (const mode of ["local-first", "agent-native"] as const) {
			const retrieval = settingsToPluginConfig(settingsFor(mode)).retrieval;
			expect(retrieval.rerank).toBe("lightweight");
			expect(retrieval.rerankProvider).toBeUndefined();
			expect(retrieval.rerankEndpoint).toBeUndefined();
		}
		const noKey = settingsToPluginConfig(settingsFor("rem-enhanced", { snoGpu: { baseUrl: "https://rt3-llm.sno.ai", apiKey: "" } })).retrieval;
		expect(noKey.rerank).toBe("lightweight");
		expect(noKey.rerankProvider).toBeUndefined();
	});

	it("a third-party key or address left in the rerank settings is never sent to Sno GPU", () => {
		const own = settingsFor("rem-enhanced", { rerank: { ...defaultSettings().rerank, apiKey: "voyage-key", endpoint: "https://api.voyageai.com/v1/rerank" } });
		expect(settingsToPluginConfig(own).retrieval).toMatchObject({ rerankProvider: "sno-gpu", rerankEndpoint: "https://rt3-llm.sno.ai/rerank", rerankApiKey: "machine-key" });
	});

	it("a user's own third-party reranker settings are passed through untouched", () => {
		const own = settingsFor("rem-enhanced", { rerank: { ...defaultSettings().rerank, mode: "cross-encoder", provider: "voyage", apiKey: "voyage-key" } });
		expect(settingsToPluginConfig(own).retrieval).toMatchObject({ rerank: "cross-encoder", rerankProvider: "voyage", rerankApiKey: "voyage-key" });
		const lightweight = settingsFor("rem-enhanced", { rerank: { ...defaultSettings().rerank, mode: "lightweight", provider: "voyage" } });
		expect(settingsToPluginConfig(lightweight).retrieval.rerank).toBe("lightweight");
	});
});

describe("the recall search against a Sno-style reranker over real HTTP", () => {
	let server: Server | undefined;
	afterEach(async () => {
		server?.closeAllConnections();
		await new Promise((resolve) => server?.close(resolve));
		server = undefined;
	});

	async function reranker(respond: (call: number, texts: string[]) => { status: number; body?: unknown; delayMs?: number; headers?: Record<string, string> }) {
		const calls: Array<{ headers: IncomingHttpHeaders; texts: string[] }> = [];
		server = createServer(async (request, response) => {
			let raw = "";
			for await (const chunk of request) raw += chunk;
			const body = JSON.parse(raw) as { texts: string[] };
			calls.push({ headers: request.headers, texts: body.texts });
			const { status, body: reply, delayMs, headers } = respond(calls.length, body.texts);
			if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
			if (response.destroyed) return;
			response.writeHead(status, { "content-type": "application/json", ...headers });
			response.end(JSON.stringify(reply ?? {}));
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		let address = server.address();
		while (address && typeof address !== "string" && address.port <= 10_080) {
			server.close(); server.listen(0, "127.0.0.1"); await once(server, "listening"); address = server.address();
		}
		if (!address || typeof address === "string") throw new Error("no port");
		return { calls, url: `http://127.0.0.1:${address.port}/rerank` };
	}

	const manyCandidates = (): MemorySearchResult[] => Array.from({ length: 64 }, (_, i) => ({
		entry: entry(`m${i}`, i === 60 ? "The user insists on TypeScript with strict mode for type safety." : `Unrelated memory number ${i} about weekend plans.`),
		score: 0.9 - i * 0.01,
	}));
	const scoreByText = (texts: string[]) => texts.map((text, index) => ({ index, score: text.includes("TypeScript") ? 6 : -6 }));

	it("sends 64 candidates as batches of 50 and 14 with the source labels, a Bearer key and a UUID per request, and the best answer wins", async () => {
		const { calls, url } = await reranker((_n, texts) => ({ status: 200, body: scoreByText(texts) }));
		const retriever = createRetriever(storeOf(manyCandidates()) as never, embedder, { warn: () => {} },
			{ ...BASE_CONFIG, rerank: "cross-encoder", rerankProvider: "sno-gpu", rerankEndpoint: url, rerankApiKey: "machine-key", rerankMaxCandidates: 64 });
		const results = await retriever.retrieve({ query: QUERY, limit: 3 });
		expect(results[0]?.entry.id).toBe("m60");
		expect(calls.map((c) => c.texts.length).sort((a, b) => b - a)).toEqual([50, 14]);
		for (const call of calls) {
			expect(call.headers["x-sno-source"]).toBe("sno-station");
			expect(call.headers["x-sno-workload"]).toBe("station-rerank");
			expect(call.headers.authorization).toBe("Bearer machine-key");
			expect(call.headers["x-request-id"]).toMatch(UUID_V4);
			expect(call.headers["x-sno-user-id"]).toBeUndefined();
			expect(call.headers["x-sno-machine-id"]).toBeUndefined();
		}
		expect(new Set(calls.map((c) => c.headers["x-request-id"])).size).toBe(2);
	}, 30_000);

	it("a retried request after a 503 carries a new request id", async () => {
		const { calls, url } = await reranker((n, texts) => n === 1 ? { status: 503 } : { status: 200, body: scoreByText(texts) });
		const few = manyCandidates().slice(0, 4);
		const retriever = createRetriever(storeOf(few) as never, embedder, { warn: () => {} },
			{ ...BASE_CONFIG, rerank: "cross-encoder", rerankProvider: "sno-gpu", rerankEndpoint: url, rerankApiKey: "machine-key" });
		await retriever.retrieve({ query: QUERY, limit: 3 });
		expect(calls.length).toBeGreaterThanOrEqual(2);
		expect(calls[0]?.headers["x-request-id"]).toMatch(UUID_V4);
		expect(calls[1]?.headers["x-request-id"]).toMatch(UUID_V4);
		expect(calls[1]?.headers["x-request-id"]).not.toBe(calls[0]?.headers["x-request-id"]);
	}, 30_000);

	it("a Sno reranker that refuses the key (401) does not break the recall: the results come back in their earlier order", async () => {
		const { calls, url } = await reranker(() => ({ status: 401, body: { error: "Unauthorized" } }));
		const retriever = createRetriever(storeOf(manyCandidates().slice(0, 4)) as never, embedder, { warn: () => {} },
			{ ...BASE_CONFIG, rerank: "cross-encoder", rerankProvider: "sno-gpu", rerankEndpoint: url, rerankApiKey: "user-key" });
		const results = await retriever.retrieve({ query: QUERY, limit: 3 });
		expect(calls.length).toBeGreaterThanOrEqual(1);
		expect(results.map((r) => r.entry.id)).toEqual(["m0", "m1", "m2"]);
	}, 30_000);

	it("a third-party reranker that refuses the key (401) still fails the recall loudly", async () => {
		const { url } = await reranker(() => ({ status: 401, body: { error: "Unauthorized" } }));
		const retriever = createRetriever(storeOf(manyCandidates().slice(0, 4)) as never, embedder, { warn: () => {} },
			{ ...BASE_CONFIG, rerank: "cross-encoder", rerankProvider: "voyage", rerankEndpoint: url, rerankApiKey: "k" });
		await expect(retriever.retrieve({ query: QUERY, limit: 3 })).rejects.toThrow(/status 401/);
	}, 30_000);

	it("a Sno reranker that hangs does not hold the search past its 2 s budget: the earlier order comes back", async () => {
		const { calls, url } = await reranker(() => ({ status: 200, body: [], delayMs: 20_000 }));
		const retriever = createRetriever(storeOf(manyCandidates().slice(0, 4)) as never, embedder, { warn: () => {} },
			{ ...BASE_CONFIG, rerank: "cross-encoder", rerankProvider: "sno-gpu", rerankEndpoint: url, rerankApiKey: "user-key" });
		const started = Date.now();
		const results = await retriever.retrieve({ query: QUERY, limit: 3, source: "auto-recall" });
		const elapsed = Date.now() - started;
		expect(results.map((r) => r.entry.id)).toEqual(["m0", "m1", "m2"]);
		expect(elapsed).toBeLessThan(3_500);
		expect(calls).toHaveLength(1);
	}, 30_000);

	it("a 429 that asks to wait 5 s does not hold the search past the 2 s budget", async () => {
		const { calls, url } = await reranker(() => ({ status: 429, headers: { "retry-after": "5" } }));
		const retriever = createRetriever(storeOf(manyCandidates().slice(0, 4)) as never, embedder, { warn: () => {} },
			{ ...BASE_CONFIG, rerank: "cross-encoder", rerankProvider: "sno-gpu", rerankEndpoint: url, rerankApiKey: "user-key" });
		const started = Date.now();
		const results = await retriever.retrieve({ query: QUERY, limit: 3, source: "auto-recall" });
		expect(results.map((r) => r.entry.id)).toEqual(["m0", "m1", "m2"]);
		expect(Date.now() - started).toBeLessThan(3_500);
		expect(calls).toHaveLength(1);
	}, 30_000);

	it("an explicit recall waits for a Sno reranker that answers after 2.5 s and is ranked by it", async () => {
		const { url } = await reranker((_n, texts) => ({ status: 200, body: scoreByText(texts), delayMs: 2_500 }));
		const retriever = createRetriever(storeOf(manyCandidates()) as never, embedder, { warn: () => {} },
			{ ...BASE_CONFIG, rerank: "cross-encoder", rerankProvider: "sno-gpu", rerankEndpoint: url, rerankApiKey: "user-key", rerankMaxCandidates: 64 });
		const results = await retriever.retrieve({ query: QUERY, limit: 3 });
		expect(results[0]?.entry.id).toBe("m60");
	}, 30_000);

	it("the caller's deadline stops the reranker request and it is not sent again", async () => {
		const { calls, url } = await reranker(() => ({ status: 200, body: [], delayMs: 20_000 }));
		const retriever = createRetriever(storeOf(manyCandidates().slice(0, 4)) as never, embedder, { warn: () => {} },
			{ ...BASE_CONFIG, rerank: "cross-encoder", rerankProvider: "voyage", rerankEndpoint: url, rerankApiKey: "k" });
		const started = Date.now();
		await expect(retriever.retrieve({ query: QUERY, limit: 3, signal: AbortSignal.timeout(900) })).rejects.toBeDefined();
		expect(Date.now() - started).toBeLessThan(3_000);
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(calls).toHaveLength(1);
	}, 30_000);

	it("a third-party reranker (voyage) gets no Sno labels", async () => {
		const { calls, url } = await reranker(() => ({ status: 200, body: { data: [] } }));
		const retriever = createRetriever(storeOf(manyCandidates().slice(0, 4)) as never, embedder, { warn: () => {} },
			{ ...BASE_CONFIG, rerank: "cross-encoder", rerankProvider: "voyage", rerankEndpoint: url, rerankApiKey: "k" });
		await retriever.retrieve({ query: QUERY, limit: 3 });
		expect(calls[0]?.headers["x-sno-source"]).toBeUndefined();
		expect(calls[0]?.headers["x-request-id"]).toBeUndefined();
	}, 30_000);
});
