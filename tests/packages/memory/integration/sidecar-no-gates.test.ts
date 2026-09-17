import { existsSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { runMaintenancePass } from "../../../../packages/sno-station-mem/src/store/maintenance";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pluginConfigSchema } from "../../../../packages/sno-station-mem/src/contract/config/plugin-config-schema";
import { bindStore } from "../../../../packages/sno-station-mem/src/engine/shared/paths";
import { startRemSidecar } from "../../../../packages/sno-station-mem/src/sidecar/server";
import { MemoryRuntimePool } from "../../../../packages/sno-station-mem/src/sidecar/memory-runtime";
import { MemoryContractRuntime } from "../../../../packages/sno-station-mem/src/engine/contract-runtime";
import { MemoryRetriever } from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db";

let root: string;
let database: ReturnType<typeof createTestDb>;
let sidecar: Awaited<ReturnType<typeof startRemSidecar>> | undefined;
const previousProfile = process.env.SNO_PROFILE_DIR;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "sidecar-no-gates-"));
	database = createTestDb();
	process.env.SNO_PROFILE_DIR = root;
	await bindStore(database.dbPath, { mode: "local-first", retrieval: { rerank: "none" } });
	mkdirSync(join(root, "sno-station-mem"), { recursive: true });
});
afterEach(async () => {
	await sidecar?.stop();
	sidecar = undefined;
	database.cleanup();
	rmSync(root, { recursive: true, force: true });
	if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
	else process.env.SNO_PROFILE_DIR = previousProfile;
});

async function health(authenticated = true): Promise<void> {
	sidecar = await startRemSidecar();
	const token = JSON.parse(readFileSync(join(root, "station", "sidecar.json"), "utf8")).token;
	const response = await fetch(`http://127.0.0.1:${sidecar.port}/healthz`, { headers: authenticated ? { Authorization: `Bearer ${token}` } : {} });
	expect(response.status).toBe(200);
	expect((await response.json()).status).toBe("ok");
}

describe("sidecar keeps serving", () => {
	it("serves without a bearer token", () => health(false));
	it.each(["/v1/inspect", "/rem/run"])("rejects oversized request bodies at %s", async (route) => {
		await health();
		if (!sidecar) throw new Error("missing test sidecar");
		const response = await fetch(`http://127.0.0.1:${sidecar.port}${route}`, { method: "POST",
			body: JSON.stringify({ scope: { principal: userInfo().username, project: "global", session: "x".repeat(8 * 1024 * 1024) }, op: { op: "list" } }),
		});
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "payload_too_large" });
		expect(database.sqlite.prepare("SELECT count(*) AS count FROM nodix_memories").get()).toEqual({ count: 0 });
		expect((await fetch(`http://127.0.0.1:${sidecar.port}/healthz`)).status).toBe(200);
	});
	it("accepts a memory body of exactly eight MiB", async () => {
		await health();
		if (!sidecar) throw new Error("missing test sidecar");
		const body = JSON.stringify({ scope: { principal: userInfo().username, project: "global", session: "limit" }, op: { op: "list" } });
		const response = await fetch(`http://127.0.0.1:${sidecar.port}/v1/inspect`, { method: "POST", body: body.padEnd(8 * 1024 * 1024, " ") });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ degraded: false, result: { op: "list", project: "global", entries: [] } });
	});
	it("rejects invalid REM requests without allocating jobs", async () => {
		await health();
		if (!sidecar) throw new Error("missing test sidecar");
		for (const [body, error] of [
			[{}, "invalid_request"], [{ type: "rem-update", scope: " " }, "invalid_request"],
			[{ types: [], scope: "global" }, "invalid_request"],
			[{ type: "typo", scope: "global" }, "unsupported_rem_type"],
		] as const) {
			const response = await fetch(`http://127.0.0.1:${sidecar.port}/rem/run`, { method: "POST", body: JSON.stringify(body) });
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual(error === "unsupported_rem_type" ? { error, unknownTypes: ["typo"] } : { error });
		}
		const journal = join(root, "sno-station-mem", "rem-wave-jobs.jsonl");
		expect(existsSync(journal)).toBe(false);
	});
	it("rejects mixed REM types without allocating jobs", async () => {
		await health();
		if (!sidecar) throw new Error("missing test sidecar");
		const response = await fetch(`http://127.0.0.1:${sidecar.port}/rem/run`, { method: "POST",
			body: JSON.stringify({ types: ["typo", "rem-update", "old-operation"], scope: "global" }),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "unsupported_rem_type", unknownTypes: ["typo", "old-operation"] });
		expect(existsSync(join(root, "sno-station-mem", "rem-wave-jobs.jsonl"))).toBe(false);
	});
	it("times out a never resolving runtime call, serves another request, and stops", async () => {
		const opening = vi.spyOn(MemoryRuntimePool, "open");
		const inspection = vi.spyOn(MemoryContractRuntime.prototype, "inspect")
			.mockImplementationOnce(() => new Promise(() => {}));
		let bound: ReturnType<typeof setTimeout> | undefined;
		try {
			await health();
			if (!sidecar) throw new Error("missing test sidecar");
			const body = JSON.stringify({ scope: { principal: "caller", project: "global", session: "deadline" }, op: { op: "list" } });
			const response = await fetch(`http://127.0.0.1:${sidecar.port}/v1/inspect`, { method: "POST", body });
			expect(response.status).toBe(504);
			expect(await response.json()).toEqual({ degraded: true, reason: "timeout" });
			const later = await fetch(`http://127.0.0.1:${sidecar.port}/v1/inspect`, { method: "POST", body });
			expect(later.status).toBe(200);
			expect(await later.json()).toEqual({ degraded: false, result: { op: "list", project: "global", entries: [] } });
			const stopping = sidecar.stop();
			sidecar = undefined;
			expect(await Promise.race([stopping.then(() => "stopped"), new Promise(resolve => {
				bound = setTimeout(() => resolve("still running"), 1_000);
			})])).toBe("stopped");
			expect(existsSync(join(root, "station", "sidecar.json"))).toBe(false);
		} finally {
			clearTimeout(bound);
			inspection.mockRestore();
			for (const result of opening.mock.results) if (result.type === "return") await (await result.value).close();
			opening.mockRestore();
		}
	}, 45_000);
	it("bounds shutdown while a runtime call is still before its deadline", async () => {
		const opening = vi.spyOn(MemoryRuntimePool, "open");
		const entered = Promise.withResolvers<void>();
		const inspection = vi.spyOn(MemoryContractRuntime.prototype, "inspect").mockImplementationOnce(() => {
			entered.resolve();
			return new Promise(() => {});
		});
		const controller = new AbortController();
		let bound: ReturnType<typeof setTimeout> | undefined;
		try {
			await health();
			if (!sidecar) throw new Error("missing test sidecar");
			const request = fetch(`http://127.0.0.1:${sidecar.port}/v1/inspect`, { method: "POST", signal: controller.signal,
				body: JSON.stringify({ scope: { principal: "caller", project: "global", session: "shutdown" }, op: { op: "list" } }),
			}).catch(() => undefined);
			await entered.promise;
			const stopping = sidecar.stop();
			sidecar = undefined;
			expect(await Promise.race([stopping.then(() => "stopped"), new Promise(resolve => {
				bound = setTimeout(() => resolve("still running"), 6_000);
			})])).toBe("stopped");
			expect(existsSync(join(root, "station", "sidecar.json"))).toBe(false);
			controller.abort();
			await request;
		} finally {
			controller.abort();
			clearTimeout(bound);
			inspection.mockRestore();
			for (const result of opening.mock.results) if (result.type === "return") await (await result.value).close();
			opening.mockRestore();
		}
	}, 12_000);
	it.each([
		{ source: "manual" },
		{ source: "manual", aggregation: { operation: "count", terms: ["notebook"] } },
	])("aborts retrieval at the HTTP deadline for %j", async options => {
		const entered = Promise.withResolvers<void>();
		let aborted = false;
		const blocked = Promise.withResolvers<[]>();
		const retrieval = vi.spyOn(MemoryRetriever.prototype, "retrieve").mockImplementationOnce(context => {
			context.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
			entered.resolve();
			return blocked.promise;
		});
		try {
			await health();
			if (!sidecar) throw new Error("missing test sidecar");
			const scope = { principal: "caller", project: "global", session: "abort" };
			await fetch(`http://127.0.0.1:${sidecar.port}/v1/inspect`, { method: "POST", body: JSON.stringify({ scope, op: { op: "list" } }) });
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const request = fetch(`http://127.0.0.1:${sidecar.port}/v1/get-recall`, { method: "POST",
				body: JSON.stringify({ scope, query: "What notebook records do you remember?", options }),
			});
			await entered.promise;
			await vi.advanceTimersByTimeAsync(120_000);
			vi.useRealTimers();
			const response = await request;
			expect(response.status).toBe(504);
			expect(await response.json()).toEqual({ degraded: true, reason: "timeout" });
			expect(aborted).toBe(true);
		} finally {
			vi.useRealTimers();
			blocked.resolve([]);
			retrieval.mockRestore();
		}
	});
	it("passes cancellation through automatic recall", async () => {
		const pool = await MemoryRuntimePool.open();
		const entered = Promise.withResolvers<void>();
		const blocked = Promise.withResolvers<[]>();
		const controller = new AbortController();
		let aborted = false;
		const retrieval = vi.spyOn(MemoryRetriever.prototype, "retrieve").mockImplementationOnce(context => {
			context.signal?.addEventListener("abort", () => { aborted = true; blocked.resolve([]); }, { once: true });
			entered.resolve();
			return blocked.promise;
		});
		const result = pool.invoke("getRecall", {
			scope: { principal: "caller", project: "global", session: "auto-abort" },
			query: "What notebook records do you remember?", options: { source: "auto" },
		}, "auto-abort", controller.signal).catch(error => error);
		try {
			await entered.promise;
			controller.abort(new Error("test cancelled"));
			expect(aborted).toBe(true);
			expect((await result).message).toBe("test cancelled");
		} finally {
			blocked.resolve([]);
			await result;
			retrieval.mockRestore();
			await pool.close();
		}
	});
	it("answers an unfinished memory request at its route deadline and keeps serving", async () => {
		await health();
		if (!sidecar) throw new Error("missing test sidecar");
		const request = httpRequest(`http://127.0.0.1:${sidecar.port}/v1/inspect`, { method: "POST" });
		let timer: ReturnType<typeof setTimeout> | undefined;
		const result = new Promise<{ status: number; body: unknown }>((resolve) => {
			request.on("response", response => {
				let text = "";
				response.on("data", chunk => { text += chunk; });
				response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }));
			});
			request.on("error", () => resolve({ status: 0, body: null }));
			timer = setTimeout(() => resolve({ status: 0, body: "no response" }), 33_000);
		});
		request.write('{"scope":');
		try {
			expect(await result).toEqual({ status: 504, body: { degraded: true, reason: "timeout" } });
			expect((await fetch(`http://127.0.0.1:${sidecar.port}/healthz`)).status).toBe(200);
		} finally { clearTimeout(timer); request.destroy(); }
	}, 40_000);
	it("retries an outstanding database setup step on maintenance until it succeeds", async () => {
		database.sqlite.exec("DROP INDEX IF EXISTS nodix_idx_memories_project_fact_key_active; CREATE TABLE nodix_idx_memories_project_fact_key_active (blocked TEXT)");
		const store = new MemoryStore({ dbPath: database.dbPath, embedder: await createTestEmbedder() });
		const deps = { store, dbPath: database.dbPath, stateDir: root, backupDir: join(root, "backups") };
		try {
			runMaintenancePass(deps, new Set());
			expect(store.sqlite.prepare("SELECT type FROM sqlite_master WHERE name = 'nodix_idx_memories_project_fact_key_active'").get()).toEqual({ type: "table" });
			store.sqlite.exec("DROP TABLE nodix_idx_memories_project_fact_key_active");
			runMaintenancePass(deps, new Set());
			expect(store.sqlite.prepare("SELECT type FROM sqlite_master WHERE name = 'nodix_idx_memories_project_fact_key_active'").get()).toEqual({ type: "index" });
		} finally { await store.close(); }
	});
	it("retries a failed migration and serves the missing table after repair", async () => {
		database.sqlite.exec("DROP TABLE nodix_todos; DELETE FROM __drizzle_migrations WHERE created_at = 1740000000033");
		const store = new MemoryStore({ dbPath: database.dbPath, embedder: await createTestEmbedder() });
		const deps = { store, dbPath: database.dbPath, stateDir: root, backupDir: join(root, "backups") };
		const query = { projectIdFilter: ["global"], includeHistory: false, limit: 5 };
		try {
			expect(() => store.listTodos(query)).toThrow("no such table: nodix_todos");
			runMaintenancePass(deps, new Set());
			expect(() => store.listTodos(query)).toThrow("no such table: nodix_todos");
			store.sqlite.exec("DROP TABLE nodix_todo_migration_receipts");
			runMaintenancePass(deps, new Set());
			expect(store.listTodos(query)).toEqual({ items: [], totalCount: 0 });
			expect(store.sqlite.prepare("SELECT migration_id, before_count, after_count FROM nodix_todo_migration_receipts").all())
				.toEqual([{ migration_id: "0033_todo_own_store", before_count: 0, after_count: 0 }]);
		} finally { await store.close(); }
	});
	it("loads explicit reranker settings without an available credential", () => {
		const config = pluginConfigSchema.parse({ mode: "rem-enhanced", retrieval: { rerank: "cross-encoder", rerankApiKey: "" } });
		expect(config.retrieval.rerank).toBe("cross-encoder");
		expect(config.retrieval.rerankApiKey).toBe("");
	});
	it("starts with an unreadable audit path", async () => {
		mkdirSync(join(root, "sno-station-mem", "audit.jsonl"));
		await health();
	});
	it("starts with an audit log larger than the JavaScript string limit", async () => {
		const audit = join(root, "sno-station-mem", "audit.jsonl");
		const descriptor = openSync(audit, "w");
		const line = `${JSON.stringify({ event: "probe", padding: "x".repeat(65500) })}\n`;
		try { for (let index = 0; index < 17200; index++) writeSync(descriptor, line); }
		finally { closeSync(descriptor); }
		expect(statSync(audit).size).toBeGreaterThan(1125716658);
		await health();
	});
	it("starts another sidecar while the first instance is running", async () => {
		await health();
		const second = await startRemSidecar();
		try { expect((await fetch(`http://127.0.0.1:${second.port}/healthz`)).status).toBe(200); }
		finally { await second.stop(); }
	});
	it("keeps keyword recall during a vector mismatch and retries vectors on reopen", async () => {
		const embedder = await createTestEmbedder();
		const first = new MemoryStore({ dbPath: database.dbPath, embedder });
		try { await first.store({ text: "First vector dimension marker.", category: "episodic", projectId: "dimension-probe" }); }
		finally { await first.close(); }
		const reopened = new MemoryStore({ dbPath: database.dbPath, vectorDim: 3, embedder });
		try {
			expect(await reopened.searchSemantic(new Float32Array(3), { projectIdFilter: ["dimension-probe"] })).toEqual([]);
			expect((await reopened.searchKeyword("marker", { projectIdFilter: ["dimension-probe"] })).map(hit => hit.entry.text))
				.toEqual(["First vector dimension marker."]);
		} finally { await reopened.close(); }
		const recovered = new MemoryStore({ dbPath: database.dbPath, embedder });
		try {
			const vector = await embedder.embed("First vector dimension marker.");
			expect((await recovered.searchSemantic(vector, { projectIdFilter: ["dimension-probe"], minScore: 0 })).map(hit => hit.entry.text))
				.toEqual(["First vector dimension marker."]);
		} finally { await recovered.close(); }
	});
	it("loads and writes while an obsolete parent FTS table remains", async () => {
		database.sqlite.exec("CREATE TABLE nodix_memories_fts (unused TEXT)");
		const store = new MemoryStore({ dbPath: database.dbPath, embedder: await createTestEmbedder() });
		try {
			await store.store({ text: "The current store still accepts writes.", category: "episodic", projectId: "schema-probe" });
			expect(store.sqlite.prepare("SELECT text FROM nodix_memories WHERE project_id = 'schema-probe'").all())
				.toEqual([{ text: "The current store still accepts writes." }]);
		} finally { await store.close(); }
	});
	it("starts with an invalid job journal and still serves", async () => {
		writeFileSync(join(root, "sno-station-mem", "rem-wave-jobs.jsonl"), "{broken}\n");
		await health();
	});
	it("serves a bound store without the installation config file", async () => {
		rmSync(join(root, "station", `sno-station-mem-${userInfo().username}.config.json`));
		const pool = await MemoryRuntimePool.open();
		try {
			expect(await pool.invoke("inspect", { scope: { principal: "caller", project: "global", session: "probe" }, op: { op: "stats" } }, "new-skin"))
				.toEqual({ degraded: false, result: { op: "stats", total: 0, projectBreakdown: {}, categoryBreakdown: {} } });
		} finally { await pool.close(); }
	});
	it("uses installed embedding settings when a registration names another model and store", async () => {
		const config = pluginConfigSchema.parse({ mode: "local-first", retrieval: { rerank: "none" }, dbPath: "/unused/requested.sqlite", embedding: { model: "not-installed", dimensions: 3 } });
		const { mode, remEnhanced, agentNative, language: _language, ...settings } = config;
		const pool = await MemoryRuntimePool.open();
		try {
			expect(await pool.invoke("init", { scope: { principal: userInfo().username, project: "global", session: "probe" },
				registration: { skinId: "header-skin", settings, routing: { mode, remEnhanced, agentNative, language: "en" } } }, "header-skin"))
				.toMatchObject({ degraded: false, skinId: "header-skin" });
			expect(await pool.invoke("inspect", { scope: { principal: userInfo().username, project: "global", session: "probe" }, op: { op: "list" } }, "header-skin"))
				.toEqual({ degraded: false, result: { op: "list", project: "global", entries: [] } });
		} finally { await pool.close(); }
	});
	it("runs REM without enable artifacts or operational configuration", async () => {
		await health();
		if (!sidecar) throw new Error("missing test sidecar");
		const response = await fetch(`http://127.0.0.1:${sidecar.port}/rem/run`, { method: "POST", headers: { Authorization: `Bearer ${JSON.parse(readFileSync(join(root, "station", "sidecar.json"), "utf8")).token}` }, body: JSON.stringify({ type: "rem-update", scope: "global" }) });
		expect(response.status).toBe(202);
		const started = await response.json();
		let job: { state?: string; stats?: { operations: number }; error?: string } = {};
		for (let attempt = 0; attempt < 100; attempt++) {
			job = await (await fetch(`http://127.0.0.1:${sidecar.port}/rem/jobs/${started.job_id}`, { headers: { Authorization: `Bearer ${JSON.parse(readFileSync(join(root, "station", "sidecar.json"), "utf8")).token}` } })).json();
			if (job.state === "done" || job.state === "failed") break;
			await delay(100);
		}
		expect(job).toMatchObject({ state: "done", stats: { operations: 0 } });
	});
	it("serves an unregistered skin with installed settings", async () => {
		const pool = await MemoryRuntimePool.open();
		try {
			const result = await pool.invoke("inspect", {
				scope: { principal: userInfo().username, project: "global", session: "probe" },
				op: { op: "list", limit: 5 },
			}, "fresh-skin");
			expect(result).toEqual({ degraded: false, result: { op: "list", project: "global", entries: [] } });
		} finally { await pool.close(); }
	});
	it("stores an explicitly requested category without write-authority admission", async () => {
		const pool = await MemoryRuntimePool.open();
		try {
			await pool.invoke("mutate", { scope: { principal: userInfo().username, project: "global", session: "category-probe" },
				op: { op: "store", content: "Use a notebook for clear records.", category: "lesson", metadata: { anti_pattern_signature: "notebook-record" } } }, "category-probe");
			expect(pool.store.sqlite.prepare("SELECT text, category FROM nodix_memories WHERE project_id = 'global'").all())
				.toEqual([{ text: "Use a notebook for clear records.", category: "lesson" }]);
		} finally { await pool.close(); }
	});
	it("updates time and an explicitly addressed row without operator or scope admission", async () => {
		const pool = await MemoryRuntimePool.open();
		try {
			const row = await pool.store.store({ text: "An editable notebook record.", category: "episodic", projectId: "global" });
			const scope = { principal: userInfo().username, project: "global", session: "update-probe" };
			await pool.invoke("mutate", { scope, op: { op: "update", id: row.id, timestamp: 1789606000000 } }, "update-probe");
			expect(pool.store.sqlite.prepare("SELECT timestamp FROM nodix_memories WHERE id = ?").get(row.id))
				.toEqual({ timestamp: 1789606000000 });
			await pool.invoke("mutate", { scope: { ...scope, project: "other-project" }, op: { op: "update", id: row.id, importance: 0.42 } }, "update-probe");
			expect(pool.store.sqlite.prepare("SELECT importance FROM nodix_memories WHERE id = ?").get(row.id))
				.toEqual({ importance: 0.42 });
		} finally { await pool.close(); }
	});
	it("serves native recall without host workspace registration", async () => {
		const pool = await MemoryRuntimePool.open();
		try {
			const { mode, remEnhanced, agentNative, language: _language, ...settings } = pool.config;
			const scope = { principal: userInfo().username, project: "global", session: "native-probe" };
			await pool.invoke("init", { scope, registration: { skinId: "native-probe", settings, routing: { mode, remEnhanced, agentNative, language: "en" } } }, "native-probe");
			await pool.store.store({ text: "Native notebook marker.", category: "episodic", projectId: "global" });
			expect(await pool.invoke("getRecall", { scope, query: "Native notebook marker.", options: { source: "native", limit: 5, minScore: 0 } }, "native-probe"))
				.toMatchObject({ degraded: false, nativeHits: [{ snippet: "Native notebook marker." }] });
		} finally { await pool.close(); }
	});
	it("ignores a persisted kill switch when capturing a turn", async () => {
		writeFileSync(join(root, "sno-station-mem", "killswitch"), JSON.stringify({ reason: "integrity failure", activatedBy: "maintenance", activated: "2026-09-17T01:37:54Z" }));
		const pool = await MemoryRuntimePool.open();
		try {
			const { mode, remEnhanced, agentNative, language: _language, ...settings } = pool.config;
			const scope = { principal: userInfo().username, project: "global", session: "agent:probe:session" };
			await pool.invoke("init", { scope, registration: { skinId: "capture-probe", settings, routing: { mode, remEnhanced, agentNative, language: "en" } } }, "capture-probe");
			const result = await pool.invoke("capture", { scope,
				turn: { turnId: "capture-probe", rewindEpoch: 0, messages: [{ role: "user", content: "I keep a blue notebook.", at: 1789606800000 }] },
			}, "capture-probe");
			expect(result).toMatchObject({ degraded: false, committed: true });
			expect(pool.store.sqlite.prepare("SELECT count(*) AS count FROM nodix_memories").get()).toEqual({ count: 1 });
		} finally { await pool.close(); }
	});
});
