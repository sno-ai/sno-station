import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeTestEnv, type TestEnv } from "../../sqlite-crypto/_helpers";
import { LocalEmbedProvider } from "../../../../packages/embedder/src/local-provider";
import { MemoryRuntimePool } from "../../../../packages/memory/src/sidecar/memory-runtime";
import { serveMemoryRoute } from "../../../../packages/memory/src/sidecar/memory-routes";
import { bindStore } from "../../../../packages/memory/src/engine/shared/paths";
import { pluginConfigSchema } from "../../../../packages/memory/config/plugin-config-schema";

// Resolve the package to current source, not a possibly stale dist artifact.
vi.mock("@snoai/embedder", async () => import("../../../../packages/embedder/src/index"));
const model = vi.hoisted(() => ({ loads: 0, releases: 0, fail: false }));
vi.mock("@huggingface/transformers", () => ({
	env: {},
	pipeline: async () => {
		model.loads++;
		let disposed = false;
		return Object.assign(async () => {
			if (disposed) throw new Error("ONNX session disposed");
			if (model.fail) throw new Error("ONNX inference failed");
			return { dims: [1, 3], data: new Float32Array([1, 0, 0]) };
		}, { dispose: async () => { disposed = true; model.releases++; } });
	},
}));

let root: string;
let crypto: TestEnv;
let pool: MemoryRuntimePool | undefined;
let server: Server | undefined;
let origin: string;
const tasks = new Set<Promise<void>>();
const config = pluginConfigSchema.parse({
	mode: "local-first", ambientLearning: true, captureAssistant: true,
	embedding: { nativeDim: 3, dimensions: 3, chunking: false },
	observe: { enabled: false }, memoryTelemetry: { enabled: false },
});
const { mode, remEnhanced, agentNative, language, ...settings } = config;
const registration = { skinId: "reinit-test", settings, routing: { mode, remEnhanced, agentNative, language } };

beforeEach(async () => {
	model.loads = 0; model.releases = 0; model.fail = false;
	LocalEmbedProvider.resetStaticState();
	crypto = makeTestEnv("memory-reinit");
	root = await mkdtemp(join(tmpdir(), "memory-reinit-"));
	vi.stubEnv("SNO_PROFILE_DIR", root);
	vi.stubEnv("SNO_OBSERVE_ENABLED", "false");
});
afterEach(async () => {
	if (server) await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
	await Promise.all(tasks);
	await pool?.close();
	pool = undefined; server = undefined;
	LocalEmbedProvider.resetStaticState();
	vi.restoreAllMocks(); vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
	crypto.cleanup();
});

async function openRoutes(): Promise<void> {
	await bindStore(join(root, "memory.sqlite"), { embedding: config.embedding, mode, memoryTelemetry: config.memoryTelemetry });
	pool = await MemoryRuntimePool.open();
	pool.stopTimers();
	const runtime = pool;
	server = createServer((request, response) => { void serveMemoryRoute(request, response, request.url ?? "", async () => runtime, tasks); });
	await new Promise<void>(resolve => server?.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing HTTP address");
	origin = `http://127.0.0.1:${address.port}`;
}
function scope() {
	if (!pool) throw new Error("Missing runtime");
	return { principal: pool.principal, project: "global", session: "agent:reinit-test:run", host: { agentId: "reinit-test", sessionTimezone: "America/Los_Angeles" } };
}
async function post(path: string, body: object): Promise<{ status: number; body: unknown }> {
	const response = await fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-sno-station-mem-skin": "reinit-test" }, body: JSON.stringify(body) });
	return { status: response.status, body: await response.json() };
}

it("retains the loaded model when an unused successor replaces its predecessor", async () => {
	const first = new LocalEmbedProvider({ nativeDim: 3 });
	let second: LocalEmbedProvider | undefined;
	try {
		expect(await first.embed("before registration")).toEqual([1, 0, 0]);
		second = new LocalEmbedProvider({ nativeDim: 3 });
		await first.dispose();
		expect(await second.embed("after registration")).toEqual([1, 0, 0]);
		expect(model.loads).toBe(1);
		expect(model.releases).toBe(0);
	} finally { await first.dispose(); await second?.dispose(); }
	expect(model.releases).toBe(1);
});

it("captures and reads a stored memory after two HTTP registrations without reloading", async () => {
	await openRoutes();
	for (let i = 0; i < 2; i++) {
		expect((await post("/v1/init", { scope: scope(), registration })).status).toBe(200);
		// Exercise the predecessor before replacement as in a running conversation.
		if (i === 0) {
			const recalled = await post("/v1/get-recall", { scope: scope(), query: "jasmine tea", options: { source: "manual" } });
			expect(recalled.status).toBe(200);
		}
	}
	const captured = await post("/v1/capture", { scope: scope(), turn: { turnId: "tea", rewindEpoch: 0,
		messages: [{ role: "user", content: "My stable personal preference is jasmine tea.", at: 1789236000000 }] } });
	expect(captured).toEqual({ status: 200, body: { degraded: false, turnId: "tea", committed: true } });
	const listed = await post("/v1/inspect", { scope: scope(), op: { op: "list" } });
	expect(listed.status).toBe(200);
	expect(listed.body).toMatchObject({ degraded: false, result: { entries: [{ text: "My stable personal preference is jasmine tea." }] } });
	expect(model.loads).toBe(1);
	expect(model.releases).toBe(0);
});

it("rejects an unusable successor at init and keeps the previous registration usable", async () => {
	await openRoutes();
	expect((await post("/v1/init", { scope: scope(), registration })).status).toBe(200);
	model.fail = true;
	expect(await post("/v1/init", { scope: scope(), registration })).toEqual({ status: 500, body: { degraded: true, reason: "engine-failed" } });
	model.fail = false;
	expect(await post("/v1/static-block", { scope: scope() })).toEqual({ status: 200, body: { degraded: false, contextText: "" } });
	expect(model.loads).toBe(1);
	expect(model.releases).toBe(0);
});

it("journals unexpected route errors at ERROR without exposing the cause in HTTP", async () => {
	await openRoutes();
	if (!pool) throw new Error("Missing runtime");
	const error = new Error("ONNX inference failed");
	error.stack = "Error: ONNX inference failed\n    at infer (packages/embedder/src/local-provider.ts:350:10)";
	vi.spyOn(pool, "invoke").mockRejectedValueOnce(error);
	const lines: string[] = [];
	vi.spyOn(process.stderr, "write").mockImplementation(chunk => { lines.push(String(chunk)); return true; });
	expect(await post("/v1/capture", {})).toEqual({ status: 500, body: { degraded: true, reason: "engine-failed" } });
	const records = lines.flatMap(line => line.trim().split("\n")).map(line => JSON.parse(line));
	expect(records).toContainEqual(expect.objectContaining({
		severity_text: "ERROR",
		source: expect.objectContaining({ file: "packages/memory/src/sidecar/memory-routes.ts", function: "serveMemoryRoute" }),
		attributes: expect.objectContaining({
			method: "capture", skinId: expect.objectContaining({ length: 11 }),
			error_message: expect.objectContaining({ length: 21 }),
			error: expect.objectContaining({ type: "Error", frames: [{ file: "packages/embedder/src/local-provider.ts", line: 350, column: 10 }] }),
		}),
	}));
});
