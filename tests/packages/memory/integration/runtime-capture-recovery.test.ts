import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeTestEnv, type TestEnv } from "../../sqlite-crypto/_helpers";
import { LocalEmbedProvider } from "../../../../packages/embedder/src/local-provider";
import { MemoryRuntimePool } from "../../../../packages/memory/src/sidecar/memory-runtime";
import { flushAuditWrites } from "../../../../packages/memory/src/engine/operations/runtime-audit-log";
import { settingsToPluginConfig, type Settings } from "../../../../packages/memory/config/settings";
import { writeSettingsFixture } from "../fixtures/settings-file-fixture";

// Only the external ONNX loader is substituted; the pool, extraction, HTTP and SQLite are real.
vi.mock("@snoai/embedder", async () => import("../../../../packages/embedder/src/index"));
const model = vi.hoisted(() => ({ dimension: 1024, fail: false }));
vi.mock("@huggingface/transformers", () => ({
	env: {},
	pipeline: async () => {
		if (model.fail) throw new Error("Model unavailable");
		return Object.assign(async () => {
			const data = new Float32Array(model.dimension);
			data[0] = 1;
			return { dims: [1, model.dimension], data };
		}, { tokenizer: { encode: (text: string) => text.split(/\s+/) }, dispose: async () => {} });
	},
}));

let root: string;
let crypto: TestEnv;
let pool: MemoryRuntimePool | undefined;
let server: Server | undefined;
let endpoint: string;
let reply: "failure" | "disconnect" | "success";
const requests: string[] = [];
const logs: string[] = [];

beforeEach(async () => {
	crypto = makeTestEnv("capture-recovery");
	root = await mkdtemp(join(tmpdir(), "capture-recovery-"));
	vi.stubEnv("SNO_PROFILE_DIR", root);
	LocalEmbedProvider.resetStaticState();
	model.fail = false;
	requests.length = 0;
	logs.length = 0;
	reply = "failure";
	vi.spyOn(process.stderr, "write").mockImplementation(chunk => { logs.push(String(chunk)); return true; });
	server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		requests.push(body);
		if (reply === "disconnect") { request.socket.destroy(); return; }
		response.writeHead(reply === "failure" ? 400 : 200, { "content-type": "application/json" });
		const text = JSON.stringify({ claims_found: [], decisions: [{ turn_index: 0, progress_only: false }], facts: [] });
		response.end(JSON.stringify(reply === "failure" ? { error: "temporarily unavailable" } : {
			model: "loopback-model", choices: [{ message: { content: text }, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1 },
		}));
	});
	await new Promise<void>(done => server?.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing host address");
	endpoint = `http://127.0.0.1:${address.port}/v1`;
	const { settings } = writeSettingsFixture(root, { mode: "agent-native",
		store: { path: join(root, "memory.sqlite"), encryptionKey: crypto.keyHex },
		embedding: { cacheDir: "" }, rerank: { mode: "none" }, rem: { tick: false },
	});
	model.dimension = settingsToPluginConfig(settings as Settings).embedding.dimensions;
});

afterEach(async () => {
	await pool?.close();
	pool = undefined;
	await flushAuditWrites();
	if (server) {
		server.closeAllConnections();
		await new Promise<void>(done => server?.close(() => done()));
	}
	server = undefined;
	LocalEmbedProvider.resetStaticState();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
	crypto.cleanup();
});

function capture(turnId: string, text = "I am checking build progress.") {
	if (!pool) throw new Error("Missing runtime");
	return { scope: { principal: pool.principal, project: "global", session: `agent:recovery:${turnId}` },
		turn: { turnId, rewindEpoch: 0, messages: text ? [{ role: "user", content: text, at: 1789236000000 }] : [] } };
}

async function register(): Promise<void> {
	if (!pool) throw new Error("Missing runtime");
	await pool.invoke("init", { scope: capture("init").scope, registration: { skinId: "recovery",
		model: { baseUrl: endpoint, credential: "loopback", model: "loopback-model" } } }, "recovery");
}

function seed(): void {
	if (!pool) throw new Error("Missing runtime");
	pool.store.sqlite.prepare("INSERT INTO pending_captures (id, skin_id, request) VALUES (?, ?, ?)")
		.run("failed-turn", "recovery", JSON.stringify(capture("failed-turn")));
}

it("parks a repeatedly failed capture across restarts and registrations without more model requests", async () => {
	for (let attempt = 0; attempt < 3; attempt++) {
		pool = await MemoryRuntimePool.open();
		if (attempt === 0) seed();
		await register();
		await pool.close();
		pool = undefined;
	}
	requests.length = 0;
	pool = await MemoryRuntimePool.open();
	await register();
	await register();
	await pool.close();
	pool = await MemoryRuntimePool.open();
	expect(requests).toEqual([]);
	expect(pool.store.sqlite.prepare("SELECT id FROM pending_captures").all()).toEqual([{ id: "failed-turn" }]);
	expect(logs.filter(line => line.includes('"event_name":"memory.sidecar.pending_capture.parked"'))).toHaveLength(1);
	const insert = pool.store.sqlite.prepare("INSERT INTO pending_captures (id, skin_id, request) VALUES (?, ?, ?)");
	pool.store.sqlite.transaction(() => {
		for (let index = 0; index < 999; index++) insert.run(`retained-${index}`, "recovery", JSON.stringify(capture(`retained-${index}`)));
	})();
	model.fail = true;
	expect(await pool.invoke("capture", capture("replacement"), "recovery"))
		.toEqual({ degraded: false, turnId: "replacement", committed: false, accepted: true });
	expect(pool.store.sqlite.prepare("SELECT id FROM pending_captures WHERE id = 'failed-turn'").all()).toEqual([]);
	expect(pool.store.sqlite.prepare("SELECT COUNT(*) AS count FROM pending_captures").get()).toEqual({ count: 1000 });
});

it("bounds accepted captures when model preparation never succeeds and keeps duplicate acceptance", async () => {
	model.fail = true;
	pool = await MemoryRuntimePool.open();
	for (let index = 0; index < 1000; index++) {
		expect(await pool.invoke("capture", capture(`turn-${index}`), "recovery"))
			.toMatchObject({ degraded: false, committed: false, accepted: true });
	}
	expect(await pool.invoke("capture", capture("overflow"), "recovery"))
		.toMatchObject({ degraded: true, reason: "engine-failed", committed: false, accepted: false });
	expect(pool.store.sqlite.prepare("SELECT COUNT(*) AS count FROM pending_captures").get()).toEqual({ count: 1000 });
	expect(await pool.invoke("capture", capture("turn-0"), "recovery"))
		.toMatchObject({ degraded: false, committed: false, accepted: true });
});

it("bounds a pre-existing oversized table on opening and reports the removed oldest capture", async () => {
	pool = await MemoryRuntimePool.open();
	const insert = pool.store.sqlite.prepare("INSERT INTO pending_captures (id, skin_id, request) VALUES (?, ?, ?)");
	pool.store.sqlite.transaction(() => {
		for (let index = 0; index < 1001; index++) insert.run(`old-${index}`, "recovery", JSON.stringify(capture(`old-${index}`)));
	})();
	await pool.close();
	pool = await MemoryRuntimePool.open();
	expect(pool.store.sqlite.prepare("SELECT COUNT(*) AS count FROM pending_captures").get()).toEqual({ count: 1000 });
	expect(pool.store.sqlite.prepare("SELECT id FROM pending_captures WHERE id IN ('old-0', 'old-1000')").all()).toEqual([{ id: "old-1000" }]);
	expect(logs.filter(line => line.includes('"event_name":"memory.sidecar.pending_capture.pruned"'))).toHaveLength(1);
});

it("replays a transient extraction failure after a successful capture without registering again", async () => {
	pool = await MemoryRuntimePool.open();
	seed();
	await register();
	await vi.waitFor(() => expect(logs.some(line => line.includes('"event_name":"memory.sidecar.pending_capture.failed"'))).toBe(true), { timeout: 3000 });
	expect(pool.store.sqlite.prepare("SELECT id FROM pending_captures").all()).toEqual([{ id: "failed-turn" }]);
	reply = "success";
	expect(await pool.invoke("capture", capture("recovered", "I am checking deployment progress."), "recovery"))
		.toEqual({ degraded: false, turnId: "recovered", committed: true });
	// The backlog replays in the background after the capture returns.
	await vi.waitFor(() => expect(pool?.store.sqlite.prepare("SELECT id FROM pending_captures").all()).toEqual([]), { timeout: 5000 });
	expect(pool.store.sqlite.prepare("SELECT state FROM nodix_atomic_extraction_ledger").all()).toEqual([{ state: "complete" }, { state: "complete" }]);
});

it("uses the same registered host after it disconnects and comes back", async () => {
	pool = await MemoryRuntimePool.open();
	await register();
	reply = "disconnect";
	expect(await pool.connectedRemPort()?.complete({ prompt: "question", timeoutMs: 2000 }))
		.toEqual({ kind: "error", category: "transport", message: "no-agent-endpoint" });
	reply = "success";
	expect(await pool.connectedRemPort()?.complete({ prompt: "question", timeoutMs: 2000 }))
		.toEqual({ kind: "ok", text: '{"claims_found":[],"decisions":[{"turn_index":0,"progress_only":false}],"facts":[]}',
			model: "loopback-model", usage: { inputTokens: 1, outputTokens: 1 } });
});

it("already restores a disconnected host after a new registration", async () => {
	pool = await MemoryRuntimePool.open();
	await register();
	reply = "disconnect";
	await pool.connectedRemPort()?.complete({ prompt: "question", timeoutMs: 2000 });
	reply = "success";
	await register();
	expect(await pool.connectedRemPort()?.complete({ prompt: "question", timeoutMs: 2000 }))
		.toEqual({ kind: "ok", text: '{"claims_found":[],"decisions":[{"turn_index":0,"progress_only":false}],"facts":[]}',
			model: "loopback-model", usage: { inputTokens: 1, outputTokens: 1 } });
});
