/** Per-message delivery without a model pick: the real runtime, encrypted store, embedder and local relevance model. */
import { dirname } from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { defaultSettings, settingsToPluginConfig } from "../../../../packages/memory/config/settings";
import { MemoryContractRuntime } from "../../../../packages/memory/src/engine/contract-runtime";
import { PluginObservability } from "../../../../packages/memory/src/engine/observability/adapter";
import { AccessTracker } from "../../../../packages/memory/src/engine/retrieval/access-tracker";
import { createRetriever } from "../../../../packages/memory/src/engine/retrieval/retriever";
import { MemoryTelemetryUsageOutbox } from "../../../../packages/memory/src/engine/telemetry/memory-telemetry-outbox";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db";

let embedder: Awaited<ReturnType<typeof createTestEmbedder>>;
let database: ReturnType<typeof createTestDb>;
let store: MemoryStore;
let access: AccessTracker;
let runtime: MemoryContractRuntime;
const logger = { info: () => {}, warn: () => {}, error: vi.fn() };
const scope = { principal: "owner", project: "agent:precision", session: "prompt-relevance" };

const lmStudio = "The user now runs LM Studio as their local model server and has uninstalled Ollama, which they previously used for that purpose.";
const larry = "Larry Hope and Lawrence Hope are both the user themself.";
const texts = [lmStudio, larry,
	"The user requires the commit for a completed task with passing checks to be made on a new branch with a Conventional Commits message.",
	"The user expects the assistant to put the commit for a completed task on a new branch.",
	"lab-mba (macOS, ssh labmba) is Larry's Mac.",
	"The assistant must always write English text with the user's preferred style.",
	"Quotas are divided into two tiers: one for Auto own models and one for specified models."];

beforeAll(async () => {
	embedder = await createTestEmbedder();
	// The relevance model loads in the background on its first call; delivery is judged once it answers.
	await vi.waitFor(async () => { expect(await embedder.scoreRelevance("warm", ["up"])).toBeDefined(); },
		{ timeout: 120_000, interval: 500 });
}, 150_000);
beforeEach(async () => {
	database = createTestDb();
	store = new MemoryStore({ dbPath: database.dbPath, embedder });
	access = new AccessTracker({ store });
	for (const text of texts) {
		await store.store({ text, category: "episodic", projectId: scope.project, importance: 0.7,
			metadata: JSON.stringify({ precision_kind: "fact" }) });
	}
	const settings = defaultSettings();
	settings.mode = "local-first";
	settings.telemetry.observe.enabled = false;
	const config = settingsToPluginConfig(settings, "research");
	const retriever = createRetriever(store, embedder, undefined, config.retrieval);
	runtime = new MemoryContractRuntime({ config, store, embedder, retriever, accessTracker: access,
		telemetryUsage: new MemoryTelemetryUsageOutbox({ sqlite: store.sqlite, dbPath: database.dbPath }), logger,
		stateDir: dirname(database.dbPath), recallSettings: settings.recall,
		observability: new PluginObservability(config, dirname(database.dbPath), logger) });
	await runtime.init(scope, { skinId: "codex" });
});
afterEach(async () => {
	try { await runtime?.close(); }
	finally { await access?.destroy(); await store?.close(); database?.cleanup(); }
});

function delivered(result: { contextText: string }): string[] {
	return result.contextText.split("\n").slice(1).map(line => line.replace(/ \[id:[^\]]+\]$/, ""));
}

it("gives a task that needs a stored fact that fact, and not the unrelated rules beside it", async () => {
	const result = await runtime.getRecall("Point the Telegram bot's .env at my local model server.", scope,
		{ source: "auto", injectionPhase: "prompt" });
	expect(delivered(result)).toEqual([lmStudio]);
});

it("gives nothing to a message that only shares a name with stored rows", async () => {
	const result = await runtime.getRecall("Send larry an email with the weekly numbers.", scope,
		{ source: "auto", injectionPhase: "prompt" });
	expect(delivered(result)).toEqual([]);
});
