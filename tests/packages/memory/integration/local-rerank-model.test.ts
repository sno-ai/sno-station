/** @file local-rerank-model.test.ts
 * @purpose The local ranking's reranker model puts the memory that answers above one that only talks about the same
 * thing, in English and in Chinese (cases where the model's margin is wide; its 8-bit scores move by up to about one
 * logit with how texts are batched), and recall keeps the cosine order until the model has loaded.
 * @boundary Real encrypted store, real local embedder and reranker model (downloaded on first use), real retriever.
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { settingsToPluginConfig } from "../../../../packages/memory/config/settings.ts";
import { readSettings } from "../../../../packages/memory/src/contract/profile.ts";
import { writeSettingsFixture } from "../fixtures/settings-file-fixture.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

// The first memory shares more of the question's words; the second one answers it.
const MEMORIES: Record<string, string> = {
	"sister-talk": "Nate: My sister and I talk about work every week, she always asks where I want to go next.",
	"sister-job": "Nate: My sister started as a nurse at the city hospital in March.",
};

// Pairs the cosine order gets wrong and the model gets right by a wide margin, in English and in Chinese.
const MODEL_CASES: Record<string, string> = {
	"pet-wish": "Joanna: I've always wanted a pet, but my landlord says no.",
	"pet-cats": "Joanna: I have two cats at home, Doudou and Mimi.",
	"city-wish": "Joanna：我一直想换个城市住，可是工作走不开。",
	"city-home": "Joanna：我现在在杭州，离西湖很近。",
};

let embedder: Embedder;
let fixture: TestDb;
let store: MemoryStore;

beforeAll(async () => {
	embedder = await createTestEmbedder();
	fixture = createTestDb();
	store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	let order = 0;
	for (const [id, text] of Object.entries(MEMORIES)) {
		order += 1;
		await store.importEntry({
			id, text, category: "episodic", lane: "active", projectId: "global", importance: 0.7,
			timestamp: Date.UTC(2026, 0, 1) + order, metadata: "{}", contentHash: id,
		});
	}
}, 120_000);

afterAll(async () => {
	await store.close();
	fixture.cleanup();
});

it("keeps the cosine order until the model has loaded, then ranks the answering memory first", async () => {
	const own = createTestDb();
	const ownStore = new MemoryStore({ dbPath: own.dbPath, embedder });
	try {
		let order = 0;
		for (const [id, text] of Object.entries(MODEL_CASES)) {
			order += 1;
			await ownStore.importEntry({
				id, text, category: "episodic", lane: "active", projectId: "global", importance: 0.7,
				timestamp: Date.UTC(2026, 0, 1) + order, metadata: "{}", contentHash: id,
			});
		}
		const retriever = createRetriever(ownStore, embedder, { warn: () => {} }, { ...DEFAULT_RETRIEVAL_CONFIG, rerank: "lightweight", minScore: 0, hardMinScore: 0 });
		const top = async (query: string) => (await retriever.retrieve({ query, limit: 3 }))[0]?.entry.id;
		// The first call starts the model load and does not wait for it.
		expect(await top("What pet does Joanna have?")).toBe("pet-wish");
		const deadline = Date.now() + 240_000;
		while ((await embedder.scoreRelevance("probe", ["probe"])) === undefined && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
		expect(await top("What pet does Joanna have?")).toBe("pet-cats");
		expect(await top("Joanna 住在哪个城市？")).toBe("city-home");
	} finally {
		await ownStore.close();
		own.cleanup();
	}
}, 300_000);

it("keeps the model's answer first when the memory it demoted was stored as more important", async () => {
	const own = createTestDb();
	const ownStore = new MemoryStore({ dbPath: own.dbPath, embedder });
	try {
		// The near miss was written as important, the answer as an aside: recall weighs importance after the model.
		const importance: Record<string, number> = { "pet-wish": 0.9, "pet-cats": 0.3, "city-wish": 0.9, "city-home": 0.3 };
		let order = 0;
		for (const [id, text] of Object.entries(MODEL_CASES)) {
			order += 1;
			await ownStore.importEntry({
				id, text, category: "episodic", lane: "active", projectId: "global", importance: importance[id] ?? 0.7,
				timestamp: Date.UTC(2026, 0, 1) + order, metadata: "{}", contentHash: id,
			});
		}
		const deadline = Date.now() + 240_000;
		while ((await embedder.scoreRelevance("probe", ["probe"])) === undefined && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
		const retriever = createRetriever(ownStore, embedder, { warn: () => {} }, { ...DEFAULT_RETRIEVAL_CONFIG, rerank: "lightweight", minScore: 0, hardMinScore: 0 });
		const top = async (query: string) => (await retriever.retrieve({ query, limit: 3 }))[0]?.entry.id;
		expect(await top("What pet does Joanna have?")).toBe("pet-cats");
		expect(await top("Joanna 住在哪个城市？")).toBe("city-home");
	} finally {
		await ownStore.close();
		own.cleanup();
	}
}, 300_000);

it("returns the local ranking order at the caller's deadline when the model is slower, and when it fails", async () => {
	const order = async (scoreRelevance: Embedder["scoreRelevance"], rerankDeadlineAt?: number) => {
		const slowOrFailing = Object.create(embedder, { scoreRelevance: { value: scoreRelevance } }) as Embedder;
		const retriever = createRetriever(store, slowOrFailing, { warn: () => {} }, { ...DEFAULT_RETRIEVAL_CONFIG, rerank: "lightweight", minScore: 0, hardMinScore: 0 });
		const started = Date.now();
		const results = await retriever.retrieve({ query: "Where does Nate's sister work?", limit: 3, ...(rerankDeadlineAt ? { rerankDeadlineAt } : {}) });
		return { first: results[0]?.entry.id, ms: Date.now() - started };
	};
	// A model that would put the answer first, three seconds late.
	const late = (_query: string, texts: string[]) => new Promise<number[]>((resolve) => {
		setTimeout(() => resolve(texts.map((text) => (text.includes("nurse") ? 10 : -10))), 3_000);
	});
	// Auto-recall halves its timeout for the rerank deadline, so an odd timeout leaves a fraction of a millisecond.
	const slow = await order(late, Date.now() + 200.5);
	expect(slow.first).toBe("sister-talk");
	expect(slow.ms).toBeLessThan(2_000);
	const failed = await order(() => Promise.reject(new Error("onnx session failed")));
	expect(failed.first).toBe("sister-talk");
}, 60_000);

it("the model scores only the local ranking's first 32 candidates and serves the one it picks first", async () => {
	const big = createTestDb();
	const bigStore = new MemoryStore({ dbPath: big.dbPath, embedder });
	try {
		const topics = ["the garden", "a hiking trip", "the new laptop", "a cooking class", "the gym schedule", "a book club", "the car repair",
			"a birthday party", "the rent", "a concert", "the dentist", "a chess game", "the bakery", "a train ride", "the weather",
			"a movie night", "the office move", "a camping plan", "the guitar lessons", "a beach day", "the job interview", "a road trip",
			"the coffee shop", "a museum visit", ...Array.from({ length: 20 }, (_, index) => `weekend plan ${index}`)];
		let order = 0;
		for (const [index, topic] of topics.entries()) {
			order += 1;
			await bigStore.importEntry({
				id: `t${index}`, text: `Nate: My sister and I talked about ${topic} at work this week.`, category: "episodic", lane: "active",
				projectId: "global", importance: 0.7, timestamp: Date.UTC(2026, 0, 1) + order, metadata: "{}", contentHash: `t${index}`,
			});
		}
		await bigStore.importEntry({
			id: "sister-job", text: MEMORIES["sister-job"] ?? "", category: "episodic", lane: "active", projectId: "global", importance: 0.7,
			timestamp: Date.UTC(2026, 0, 1) + 100, metadata: "{}", contentHash: "sister-job",
		});
		const profile = mkdtempSync(join(tmpdir(), "local-rerank-head-"));
		let retrieval: ReturnType<typeof settingsToPluginConfig>["retrieval"];
		try {
			vi.stubEnv("SNO_PROFILE_DIR", profile);
			writeSettingsFixture(profile, { rerank: { mode: "cross-encoder", maxCandidates: 64, timeoutMs: 15000 } });
			retrieval = settingsToPluginConfig(readSettings()).retrieval;
		} finally {
			vi.unstubAllEnvs();
			rmSync(profile, { recursive: true, force: true });
		}
		const withModel = (scoreRelevance: Embedder["scoreRelevance"]) =>
			createRetriever(bigStore, Object.create(embedder, { scoreRelevance: { value: scoreRelevance } }) as Embedder, { warn: () => {} },
				{ ...DEFAULT_RETRIEVAL_CONFIG, ...retrieval, minScore: 0, hardMinScore: 0 });
		const query = "Where does Nate's sister work?";
		// A model that likes one memory and dislikes every other one it is shown.
		const shown: string[] = [];
		const picky = async (_q: string, texts: string[]) => {
			shown.push(...texts);
			return texts.map((text) => (text.includes("nurse") ? 10 : -10));
		};
		const ranked = (await withModel(picky).retrieve({ query, limit: 50 })).map((r) => r.entry.id);
		// Of 45 candidates the model sees the local ranking's first 32, and the one it picks is served first.
		expect(shown).toHaveLength(32);
		expect(ranked).toHaveLength(45);
		expect(ranked[0]).toBe("sister-job");
	} finally {
		await bigStore.close();
		big.cleanup();
	}
}, 120_000);

it("a recall with no deadline limits an old remote-sized timeout to the local two-second ceiling", async () => {
	const stalled = Object.create(embedder, { scoreRelevance: { value: () => new Promise<number[]>(() => {}) } }) as Embedder;
	const retriever = createRetriever(store, stalled, { warn: () => {} }, { ...DEFAULT_RETRIEVAL_CONFIG, rerank: "lightweight", minScore: 0, hardMinScore: 0, rerankTimeoutMs: 120_000 });
	const started = Date.now();
	const results = await retriever.retrieve({ query: "Where does Nate's sister work?", limit: 3 });
	expect(Date.now() - started).toBeLessThan(3_500);
	expect(results[0]?.entry.id).toBe("sister-talk");
}, 30_000);


it("caller cancellation rejects the search instead of returning a successful fallback", async () => {
	const controller = new AbortController();
	const reason = new Error("caller cancelled recall");
	let scoringStarted = () => {};
	const started = new Promise<void>((resolve) => { scoringStarted = resolve; });
	let modelSignal: AbortSignal | undefined;
	const stalled = Object.create(embedder, { scoreRelevance: { value: (_query: string, _texts: string[], signal?: AbortSignal) => {
		modelSignal = signal;
		scoringStarted();
		return new Promise<number[]>(() => {});
	} } }) as Embedder;
	const retriever = createRetriever(store, stalled, undefined, { ...DEFAULT_RETRIEVAL_CONFIG, minScore: 0, hardMinScore: 0 });
	const result = retriever.retrieve({ query: "Where does Nate's sister work?", limit: 3, signal: controller.signal });
	const rejected = expect(result).rejects.toThrow("caller cancelled recall");
	await started;
	controller.abort(reason);
	await rejected;
	expect(modelSignal?.aborted).toBe(true);
}, 10_000);
