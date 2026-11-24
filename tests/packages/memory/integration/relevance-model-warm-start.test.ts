/** The local relevance model must be ready for the first message after the memory service starts, when it is in use. */
import { tmpdir } from "node:os";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { defaultSettings, settingsToPluginConfig } from "../../../../packages/memory/config/settings";
import { createEmbedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { createRetriever } from "../../../../packages/memory/src/engine/retrieval/retriever";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db";

let database: ReturnType<typeof createTestDb>;
let embedder: ReturnType<typeof createEmbedder>;
let store: MemoryStore;

beforeAll(async () => {
	// Put the model file in the cache first, so the timed waits below cover only its load. The last dispose releases
	// the loaded model, so each test starts without one.
	const first = createEmbedder({ provider: "local-onnx" }, tmpdir());
	try {
		await vi.waitFor(async () => { expect(await first.scoreRelevance("warm", ["up"])).toBeDefined(); },
			{ timeout: 280_000, interval: 1000 });
	} finally {
		await first.dispose();
	}
}, 300_000);
beforeEach(() => {
	database = createTestDb();
	embedder = createEmbedder({ provider: "local-onnx" }, tmpdir());
	store = new MemoryStore({ dbPath: database.dbPath, embedder });
});
afterEach(async () => {
	await store.close();
	await embedder.dispose();
	database.cleanup();
});

function startRetriever(rerank: "lightweight" | "none"): void {
	const settings = defaultSettings();
	settings.rerank.mode = rerank;
	settings.telemetry.observe.enabled = false;
	createRetriever(store, embedder, undefined, settingsToPluginConfig(settings, "research").retrieval);
}
const texts = ["The user's local model server is now LM Studio.", "The garden grows tomatoes in summer."];

it("answers the first relevance request after lookup starts, without an earlier request to start its load", async () => {
	startRetriever("lightweight");
	// Time for the background load of the cached model (about two seconds measured); no call is made meanwhile,
	// because a call is what started the load before.
	await new Promise(resolve => setTimeout(resolve, 20_000));
	const logits = await embedder.scoreRelevance("Which local model server am I using now?", texts);
	expect(logits).toHaveLength(2);
	expect(logits?.[0]).toBeGreaterThan(logits?.[1] ?? Number.POSITIVE_INFINITY);
}, 120_000);

it("does not load the relevance model when reranking is turned off", async () => {
	startRetriever("none");
	await embedder.warmup();
	await new Promise(resolve => setTimeout(resolve, 20_000));
	expect(await embedder.scoreRelevance("Which local model server am I using now?", texts)).toBeUndefined();
}, 120_000);
