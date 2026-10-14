import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { once } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
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
			expect(settingsToPluginConfig(settingsFor(mode)).retrieval.rerank).toBe("lightweight");
		}
		const noKey = settingsToPluginConfig(settingsFor("rem-enhanced", { snoGpu: { baseUrl: "https://rt3-llm.sno.ai", apiKey: "" } })).retrieval;
		expect(noKey.rerank).toBe("lightweight");
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

	async function reranker(respond: (call: number, texts: string[]) => { status: number; body?: unknown }) {
		const calls: Array<{ headers: IncomingHttpHeaders; texts: string[] }> = [];
		server = createServer(async (request, response) => {
			let raw = "";
			for await (const chunk of request) raw += chunk;
			const body = JSON.parse(raw) as { texts: string[] };
			calls.push({ headers: request.headers, texts: body.texts });
			const { status, body: reply } = respond(calls.length, body.texts);
			response.writeHead(status, { "content-type": "application/json" });
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

	it("a third-party reranker (voyage) gets no Sno labels", async () => {
		const { calls, url } = await reranker(() => ({ status: 200, body: { data: [] } }));
		const retriever = createRetriever(storeOf(manyCandidates().slice(0, 4)) as never, embedder, { warn: () => {} },
			{ ...BASE_CONFIG, rerank: "cross-encoder", rerankProvider: "voyage", rerankEndpoint: url, rerankApiKey: "k" });
		await retriever.retrieve({ query: QUERY, limit: 3 });
		expect(calls[0]?.headers["x-sno-source"]).toBeUndefined();
		expect(calls[0]?.headers["x-request-id"]).toBeUndefined();
	}, 30_000);
});

function internalSecret(): string | undefined {
	if (process.env.INTERNAL_SERVICE_SECRET) return process.env.INTERNAL_SERVICE_SECRET;
	try {
		const match = readFileSync(join(homedir(), "infra", "onprem-infra", ".env"), "utf8").match(/^\s*INTERNAL_SERVICE_SECRET\s*=\s*(.+?)\s*$/m);
		return match?.[1]?.replace(/^["']|["']$/g, "");
	} catch { return undefined; }
}

describe.skipIf(!internalSecret())("the real Sno reranker and Helicone, end to end", () => {
	it("a recall search is ranked by the real reranker and its row in Helicone carries the labels", async () => {
		const candidates: MemorySearchResult[] = [
			{ entry: entry("hiking", "The user hikes in the Rocky Mountains every weekend."), score: 0.9 },
			{ entry: entry("sushi", "The user's favorite meal is Japanese sushi with green tea."), score: 0.86 },
			{ entry: entry("typescript", "The user insists on TypeScript with strict mode for compile-time type safety."), score: 0.7 },
		];
		const seen: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes("/rerank")) seen.push(new Headers(init?.headers).get("x-request-id") ?? "");
			return realFetch(input, init);
		}) as typeof fetch;
		try {
			const retriever = createRetriever(storeOf(candidates) as never, embedder, { warn: () => {} },
				{ ...BASE_CONFIG, rerank: "cross-encoder", rerankProvider: "sno-gpu", rerankEndpoint: "https://rt3-llm.sno.ai/rerank", rerankApiKey: internalSecret() as string });
			const results = await retriever.retrieve({ query: QUERY, limit: 3 });
			expect(results[0]?.entry.id).toBe("typescript");
		} finally { globalThis.fetch = realFetch; }
		expect(seen).toHaveLength(1);
		const sql = `SELECT properties['sourcerepo'] AS source, properties['workload'] AS workload, properties['route'] AS route, properties['status'] AS status FROM default.request_response_rmt FINAL WHERE properties['clientrequestid']='${seen[0]}' FORMAT JSONEachRow`;
		let row: Record<string, string> | undefined;
		for (let attempt = 0; attempt < 20 && !row; attempt += 1) {
			const out = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "agentforge", "docker", "exec", "-i", "helicone-clickhouse", "clickhouse-client"], { input: sql, encoding: "utf8" });
			const line = out.stdout.trim().split("\n").filter(Boolean)[0];
			if (line) row = JSON.parse(line) as Record<string, string>;
			else await new Promise((resolve) => setTimeout(resolve, 1000));
		}
		expect(row).toEqual({ source: "sno-station", workload: "station-rerank", route: "rerank", status: "200" });
	}, 60_000);
});
