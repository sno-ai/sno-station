/** The local relevance model must be ready for the first message after the memory service starts. */
import { tmpdir } from "node:os";
import { beforeAll, expect, it, vi } from "vitest";
import { createEmbedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";

beforeAll(async () => {
	// Put the model file in the cache first, so the timed wait below covers only its load. The last dispose releases
	// the loaded model, so the embedder in the test starts without one.
	const first = createEmbedder({ provider: "local-onnx" }, tmpdir());
	try {
		await vi.waitFor(async () => { expect(await first.scoreRelevance("warm", ["up"])).toBeDefined(); },
			{ timeout: 280_000, interval: 1000 });
	} finally {
		await first.dispose();
	}
}, 300_000);

it("answers the first relevance request after warmup, without an earlier request to start its load", async () => {
	const embedder = createEmbedder({ provider: "local-onnx" }, tmpdir());
	try {
		await embedder.warmup();
		// Time for the background load of the cached model (about two seconds measured); no call is made meanwhile,
		// because a call is what started the load before.
		await new Promise(resolve => setTimeout(resolve, 20_000));
		const logits = await embedder.scoreRelevance("Which local model server am I using now?",
			["The user's local model server is now LM Studio.", "The garden grows tomatoes in summer."]);
		expect(logits).toHaveLength(2);
		expect(logits?.[0]).toBeGreaterThan(logits?.[1] ?? Number.POSITIVE_INFINITY);
	} finally {
		await embedder.dispose();
	}
}, 120_000);
