/** Per-message relevance selection through the real runtime, encrypted store and embedder. */
import { dirname } from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { defaultSettings, settingsToPluginConfig } from "../../../../packages/memory/config/settings";
import { MemoryContractRuntime } from "../../../../packages/memory/src/engine/contract-runtime";
import { PluginObservability } from "../../../../packages/memory/src/engine/observability/adapter";
import { AccessTracker } from "../../../../packages/memory/src/engine/retrieval/access-tracker";
import { retrieveForAutoRecall } from "../../../../packages/memory/src/engine/retrieval/rem-consumer-retrieval";
import { createRetriever } from "../../../../packages/memory/src/engine/retrieval/retriever";
import { MemoryTelemetryUsageOutbox } from "../../../../packages/memory/src/engine/telemetry/memory-telemetry-outbox";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db";
import { modelReply, startRecorder } from "./fixtures/model-recorders";

let embedder: Awaited<ReturnType<typeof createTestEmbedder>>;
let database: ReturnType<typeof createTestDb>;
let store: MemoryStore;
let access: AccessTracker;
let runtime: MemoryContractRuntime | undefined;
let recorder: Awaited<ReturnType<typeof startRecorder>>;
let closers: Array<() => Promise<void>>;
let answer: string;
let status: number;
let rows: Awaited<ReturnType<typeof store.store>>[];
const logger = { info: () => {}, warn: () => {}, error: vi.fn() };
const scope = { principal: "owner", project: "agent:precision", session: "recall-pick" };
const query = "The project release checklist requires owner approval.";
const limit = 2;

beforeAll(async () => { embedder = await createTestEmbedder(); });
beforeEach(async () => {
	closers = []; answer = '{"ids":[]}'; status = 200; runtime = undefined;
	logger.error.mockClear();
	recorder = await startRecorder(closers, ({ raw }) => status === 200
		? modelReply(answer, raw) : { status, body: { error: "recall pick unavailable" } });
	database = createTestDb();
	store = new MemoryStore({ dbPath: database.dbPath, embedder });
	access = new AccessTracker({ store });
	rows = [];
	for (const [index, text] of [query, "The owner drinks decaffeinated coffee.",
		"The garden grows tomatoes in summer.", "The lighthouse opens on Sundays.",
		"The database keeps snapshots every evening."].entries()) {
		rows.push(await store.store({ text, category: "episodic", projectId: scope.project, importance: 0.7,
			metadata: JSON.stringify({ precision_kind: "fact", ...(index === 4 ? { asserted_by: "assistant" } : {}) }) }));
	}
});
afterEach(async () => {
	try { await runtime?.close(); }
	finally {
		await access?.destroy();
		await store?.close();
		database?.cleanup();
		for (const close of closers) await close();
	}
});

async function start(mode: "rem-enhanced" | "local-first" = "rem-enhanced") {
	const settings = defaultSettings();
	settings.mode = mode;
	settings.snoGpu = { baseUrl: `${recorder.url}/v1`, apiKey: "fixture" };
	settings.rerank.mode = "none";
	settings.telemetry.observe.enabled = false;
	const config = settingsToPluginConfig(settings, "research");
	const retriever = createRetriever(store, embedder, undefined, config.retrieval);
	const usage = new MemoryTelemetryUsageOutbox({ sqlite: store.sqlite, dbPath: database.dbPath });
	runtime = new MemoryContractRuntime({ config, store, embedder, retriever, accessTracker: access,
		telemetryUsage: usage, logger, stateDir: dirname(database.dbPath), recallSettings: settings.recall,
		observability: new PluginObservability(config, dirname(database.dbPath), logger) });
	await runtime.init(scope, { skinId: "codex" });
	return { runtime, retriever };
}

it("delivers exactly the model's two picks in order, retaining assistant provenance and sending all candidates once", async () => {
	answer = JSON.stringify({ ids: [rows[2].id, rows[4].id] });
	const { runtime } = await start();
	const result = await runtime.getRecall(query, scope, { source: "auto", injectionPhase: "prompt", limit });
	expect.soft(result.degraded).toBe(false);
	expect.soft(result.contextText.split("\n").slice(1)).toEqual([
		`${rows[2].text} [id:${rows[2].id}]`,
		`${rows[4].text} [id:${rows[4].id}] (said by the assistant, not confirmed)`,
	]);
	expect.soft(result.memoryIds).toEqual([rows[2].id, rows[4].id]);
	expect(recorder.received).toHaveLength(1);
	const payload = JSON.parse(recorder.received[0].content.split("\n").at(-1) ?? "");
	expect(payload.message).toBe(query);
	expect(payload.memories).toHaveLength(rows.length);
	expect(payload.memories).toEqual(expect.arrayContaining(rows.map((row, index) => ({
		id: row.id, text: row.text, by: index === 4 ? "assistant" : "owner",
	}))));
});

it("delivers the full first sentence containing e.g. without the second sentence", async () => {
	const row = await store.store({
		text: "If the owner's checkout has uncommitted files of other agents (e.g. untracked docs), stage only your own paths. Then report.",
		category: "episodic", projectId: scope.project, importance: 0.7,
		metadata: JSON.stringify({ precision_kind: "fact" }),
	});
	answer = JSON.stringify({ ids: [row.id] });
	const { runtime } = await start();
	const result = await runtime.getRecall("Stage only your own paths when the owner's checkout has uncommitted files of other agents.",
		scope, { source: "auto", injectionPhase: "prompt", limit });
	expect(result.contextText.split("\n").slice(1)).toEqual([
		`If the owner's checkout has uncommitted files of other agents (e.g. untracked docs), stage only your own paths. [id:${row.id}]`,
	]);
});

it("sends exactly twenty candidates to the model for a prompt recall limit of two", async () => {
	for (const item of ["changelog entries", "API documentation", "database migrations", "package versions",
		"release notes", "installation instructions", "rollback procedures", "dependency updates",
		"configuration defaults", "command help", "translation updates", "license notices",
		"upgrade instructions", "data export formats", "telemetry settings", "error messages",
		"platform support", "archive contents", "package metadata", "compatibility requirements",
		"deprecation notices", "backup procedures", "deployment instructions", "troubleshooting guides"]) {
		await store.store({ text: `The project release checklist requires owner approval of ${item}.`,
			category: "episodic", projectId: scope.project, importance: 0.7,
			metadata: JSON.stringify({ precision_kind: "fact" }) });
	}
	const { runtime } = await start();
	await runtime.getRecall(query, scope, { source: "auto", injectionPhase: "prompt", limit: 2 });
	expect(recorder.received).toHaveLength(1);
	const payload = JSON.parse(recorder.received[0].content.split("\n").at(-1) ?? "");
	expect(payload.memories).toHaveLength(20);
});

it("delivers nothing when the model selects no ids", async () => {
	const { runtime } = await start();
	const result = await runtime.getRecall(query, scope, { source: "auto", injectionPhase: "prompt", limit });
	expect.soft(result).toMatchObject({ degraded: false, contextText: "", memoryIds: [] });
	expect(recorder.received).toHaveLength(1);
});

it("logs a recall pick HTTP failure and returns empty context without throwing or degrading", async () => {
	status = 500;
	const { runtime } = await start();
	const result = await runtime.getRecall(query, scope, { source: "auto", injectionPhase: "prompt", limit });
	expect.soft(result).toMatchObject({ degraded: false, contextText: "", memoryIds: [] });
	expect.soft(recorder.received.length).toBeGreaterThan(0);
	expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/recall[\s_-]*pick/iu));
});

it("ignores an unknown model id and delivers only the valid candidate", async () => {
	answer = JSON.stringify({ ids: ["unknown-memory-id", rows[3].id] });
	const { runtime } = await start();
	const result = await runtime.getRecall(query, scope, { source: "auto", injectionPhase: "prompt", limit });
	expect.soft(result.degraded).toBe(false);
	expect.soft(result.contextText.split("\n").slice(1)).toEqual([`${rows[3].text} [id:${rows[3].id}]`]);
	expect.soft(result.memoryIds).toEqual([rows[3].id]);
	expect(recorder.received).toHaveLength(1);
});

it("keeps the dense-score threshold and limit in local-first without calling the model", async () => {
	const { runtime, retriever } = await start("local-first");
	const hits = await retrieveForAutoRecall(retriever, { query, limit: limit * 4, minScore: 0,
		scopeFilter: [scope.project, "global"], nowMs: Date.now(), trackAccess: false });
	expect(hits.map(hit => hit.entry.id)).toContain(rows[0].id);
	expect(hits.some(hit => hit.denseScore !== undefined && hit.denseScore < 0.5)).toBe(true);
	const expected = hits.filter(hit => hit.denseScore === undefined || hit.denseScore >= 0.5).slice(0, limit);
	expect(expected.length).toBeGreaterThan(0);
	const result = await runtime.getRecall(query, scope, { source: "auto", injectionPhase: "prompt", limit });
	expect(result).toMatchObject({ degraded: false, memoryIds: expected.map(hit => hit.entry.id) });
	expect(result.contextText.split("\n").slice(1)).toEqual(expected.map(hit =>
		`${hit.entry.text} [id:${hit.entry.id}]${JSON.parse(hit.entry.metadata).asserted_by !== undefined
			? " (said by the assistant, not confirmed)" : ""}`));
	expect(recorder.received).toHaveLength(0);
});
