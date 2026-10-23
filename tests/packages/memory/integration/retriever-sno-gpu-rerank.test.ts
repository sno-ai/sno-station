/** Historical remote configuration now serves a real local-model answer without remote rerank traffic. */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { settingsToPluginConfig } from "../../../../packages/memory/config/settings.ts";
import { readSettings } from "../../../../packages/memory/src/contract/profile.ts";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";
import { writeSettingsFixture } from "../fixtures/settings-file-fixture.ts";

it("reads a historical GPU profile, promotes the answering memory with the real local model, and makes no remote rerank request", async () => {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		requests.push(request.url ?? "");
		request.resume();
		response.writeHead(200, { "content-type": "application/json" });
		response.end("[]");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no loopback port");
	const baseUrl = `http://127.0.0.1:${address.port}`;
	const profile = mkdtempSync(join(tmpdir(), "local-rerank-profile-"));
	const fixture = createTestDb();
	const embedder = await createTestEmbedder();
	const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	try {
		// A positive observation proves that this server can detect a request; the old product path also recorded two before removal.
		await (await fetch(`${baseUrl}/probe`)).text();
		expect(requests).toEqual(["/probe"]);
		vi.stubEnv("SNO_PROFILE_DIR", profile);
		writeSettingsFixture(profile, { mode: "rem-enhanced", snoGpu: { baseUrl, apiKey: "historical-key" }, rerank: { mode: "cross-encoder", maxCandidates: 64, timeoutMs: 15000 } });
		const retrieval = settingsToPluginConfig(readSettings()).retrieval;
		const memories = {
			"pet-wish": "Joanna: I've always wanted a pet, but my landlord says no.",
			"pet-cats": "Joanna: I have two cats at home, Doudou and Mimi.",
		};
		for (const [id, text] of Object.entries(memories)) await store.importEntry({ id, text, category: "episodic", lane: "active", projectId: "global", importance: 0.7, timestamp: Date.UTC(2026, 0, 1), metadata: "{}", contentHash: id });
		const config = { ...DEFAULT_RETRIEVAL_CONFIG, ...retrieval, minScore: 0, hardMinScore: 0 };
		const query = "What pet does Joanna have?";
		const initialOnly = Object.create(embedder, { scoreRelevance: { value: async () => undefined } });
		expect((await createRetriever(store, initialOnly, undefined, config).retrieve({ query, limit: 2 }))[0]?.entry.id).toBe("pet-wish");
		const loadingDeadline = Date.now() + 90_000;
		while ((await embedder.scoreRelevance("probe", ["probe"])) === undefined && Date.now() < loadingDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
		expect(await embedder.scoreRelevance("probe", ["probe"])).toHaveLength(1);
		const results = await createRetriever(store, embedder, undefined, config).retrieve({ query, limit: 2 });
		expect(results[0]?.entry.id).toBe("pet-cats");
		expect(requests).toEqual(["/probe"]);
	} finally {
		vi.unstubAllEnvs();
		await store.close();
		fixture.cleanup();
		rmSync(profile, { recursive: true, force: true });
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}, 120_000);
