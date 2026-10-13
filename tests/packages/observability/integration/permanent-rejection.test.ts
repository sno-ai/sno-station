import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSnoObserve } from "../../../../packages/observability/src/index.ts";
import { BufferStore } from "../../../../packages/observability/src/internal/buffer-store.ts";
import { startMockServer } from "../fixtures/sno-ai-mock-server.mjs";
import { createTempSnoEnv, scope, validPayloads } from "../fixtures/temp-env.mjs";

afterEach(() => vi.unstubAllEnvs());

const rejectedId = "018f7d0c-fd8b-7ccf-9b9b-0a2ea938ad01";
const laterId = "018f7d0c-fd8b-7ccf-9b9b-0a2ea938ad02";

describe("permanent cloud rejection", () => {
	for (const [status, body] of [
		[400, { error: "invalid_event_payload" }],
		[403, { error: "identity_mismatch" }],
		[413, { error: "event_body_too_large" }],
		[422, { error: { code: "invalid_event_payload" } }],
		[500, { error: "invalid_event_payload" }],
	] as const) {
		it(`parks a ${status} rejection once and ships the same agent's later event`, async () => {
			const server = await startMockServer();
			const temp = createTempSnoEnv();
			vi.stubEnv("SNO_PROFILE_DIR", temp.dir);
			const observe = createSnoObserve({ env: temp.env, cwd: temp.dir, baseUrl: server.baseUrl, deferDelivery: true });
			const db = new Database(temp.env.SNO_BUFFER_PATH);
			try {
				server.enqueue("/api/v1/events", { status, body, match: (_req: unknown, bytes: string) => JSON.parse(bytes).event_id === rejectedId });
				await observe.emit({ event_id: rejectedId, event_type: "memory.write", lane: "memory", agent_id: "codex", payload: validPayloads["memory.write"] });
				await observe.emit({ event_id: laterId, event_type: "memory.write", lane: "memory", agent_id: "codex", payload: validPayloads["memory.write"] });
				expect(await observe.flush()).toEqual({ shipped: 3, terminal: 1, retryable: 0 });
				await observe.shutdown();
				const restarted = createSnoObserve({ env: temp.env, cwd: temp.dir, baseUrl: server.baseUrl });
				try { expect(await restarted.flush()).toEqual({ shipped: 0, terminal: 0, retryable: 0 }); }
				finally { await restarted.shutdown(); }
				const posted = server.calls.filter((call: { url: string }) => call.url === "/api/v1/events").map((call: { body: string }) => JSON.parse(call.body));
				expect(posted.map((event: { event_type: string }) => event.event_type)).toEqual(["agent.identify", "memory.write", "agent.identify", "memory.write"]);
				expect(posted.filter((event: { event_id: string }) => event.event_id === rejectedId).length).toBe(1);
				expect(posted.at(-1)).toMatchObject({ event_id: laterId, chain_epoch: 1, seq: 1 });
				expect(db.prepare("SELECT event_id, status FROM quarantine").all()).toEqual([{ event_id: rejectedId, status }]);
				expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE shipped = 0 AND terminal = 0").get()).toEqual({ n: 0 });
				const logs = readFileSync(join(temp.dir, "observe.log"), "utf8").trim().split("\n").map(line => JSON.parse(line));
				expect(logs.filter(row => row.attributes?.event_id === rejectedId).length).toBe(1);
			} finally {
				await observe.shutdown();
				db.close();
				await server.stop();
				rmSync(temp.dir, { recursive: true, force: true });
			}
		});
	}

	it("replaces one rejected identify so the later event can ship", async () => {
		const server = await startMockServer({ script: [{ status: 400, body: { error: "invalid_event_payload" } }] });
		const temp = createTempSnoEnv();
		vi.stubEnv("SNO_PROFILE_DIR", temp.dir);
		const observe = createSnoObserve({ env: temp.env, cwd: temp.dir, baseUrl: server.baseUrl, deferDelivery: true });
		try {
			await observe.emit({ event_id: laterId, event_type: "memory.write", lane: "memory", agent_id: "codex", payload: validPayloads["memory.write"] });
			expect(await observe.flush()).toEqual({ shipped: 2, terminal: 1, retryable: 0 });
			const events = server.calls.filter((call: { url: string }) => call.url === "/api/v1/events").map((call: { body: string }) => JSON.parse(call.body));
			expect(events.map((event: { event_type: string; chain_epoch: number; seq: number }) => [event.event_type, event.chain_epoch, event.seq])).toEqual([["agent.identify", 0, 0], ["agent.identify", 1, 0], ["memory.write", 1, 1]]);
		} finally {
			await observe.shutdown();
			await server.stop();
			rmSync(temp.dir, { recursive: true, force: true });
		}
	});

	it("stops recreating permanently rejected identifies and still ships another agent", async () => {
		const server = await startMockServer();
		const temp = createTempSnoEnv();
		vi.stubEnv("SNO_PROFILE_DIR", temp.dir);
		const observe = createSnoObserve({ env: temp.env, cwd: temp.dir, baseUrl: server.baseUrl, deferDelivery: true });
		try {
			for (let i = 0; i < 110; i++) server.enqueue("/api/v1/events", { status: 403, body: { error: "identity_mismatch" }, match: (_req: unknown, bytes: string) => JSON.parse(bytes).scope.agent_id === "codex" });
			await observe.emit({ event_id: laterId, event_type: "memory.write", lane: "memory", agent_id: "codex", payload: validPayloads["memory.write"] });
			await observe.emit({ event_type: "memory.write", lane: "memory", agent_id: "hermes", payload: validPayloads["memory.write"] });
			expect(await observe.flush()).toEqual({ shipped: 2, terminal: 3, retryable: 0 });
			expect(await observe.flush()).toEqual({ shipped: 0, terminal: 0, retryable: 0 });
			const db = new Database(temp.env.SNO_BUFFER_PATH, { readonly: true });
			try {
				expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE shipped = 0 AND terminal = 0").get()).toEqual({ n: 0 });
				expect(db.prepare("SELECT COUNT(*) AS n FROM quarantine").get()).toEqual({ n: 3 });
			} finally { db.close(); }
			const events = server.calls.filter((call: { url: string }) => call.url === "/api/v1/events").map((call: { body: string }) => JSON.parse(call.body));
			expect(events.map((event: { scope: { agent_id: string } }) => event.scope.agent_id)).toEqual(["codex", "hermes", "hermes", "codex"]);
		} finally {
			await observe.shutdown();
			await server.stop();
			rmSync(temp.dir, { recursive: true, force: true });
		}
	});
});

describe("pending buffer capacity", () => {
	it("drops complete oldest pending chains over the byte limit and logs the loss once", () => {
		const dir = mkdtempSync(join(tmpdir(), "observe-pending-capacity-"));
		vi.stubEnv("SNO_PROFILE_DIR", dir);
		const store = new BufferStore(join(dir, "buffer.db"));
		try {
			store.append({ eventId: "identify", eventType: "agent.identify", lane: "memory", tsEdgeMs: 1, consentLevel: "metadata-only", redacted: false, scope, payload: validPayloads["agent.identify"], terminal: false });
			for (let i = 0; i < 300; i++) store.append({ eventId: `pending-${i}`, eventType: "memory.write", lane: "memory", tsEdgeMs: 2, consentLevel: "metadata-only", redacted: false, scope, payload: validPayloads["memory.write"], terminal: false });
			expect(store.pruneRetention(64 * 1024)).toEqual({ deletedEvents: 0, overflowDeleted: 301 });
			expect(store.getAllRows()).toEqual([]);
			expect(store.countPending()).toBe(0);
			const logs = readFileSync(join(dir, "observe.log"), "utf8").trim().split("\n").map(line => JSON.parse(line));
			expect(logs.map(row => row.attributes.dropped)).toEqual([301]);
		} finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
	});

	it("bounds new writes during retry backoff and delivers fresh work after eviction", async () => {
		const server = await startMockServer();
		const temp = createTempSnoEnv();
		vi.stubEnv("SNO_PROFILE_DIR", temp.dir);
		const observe = createSnoObserve({ env: temp.env, cwd: temp.dir, baseUrl: server.baseUrl, deferDelivery: true });
		const db = new Database(temp.env.SNO_BUFFER_PATH);
		try {
			await observe.emit({ event_id: rejectedId, event_type: "memory.write", lane: "memory", agent_id: "codex", payload: validPayloads["memory.write"] });
			// Pad valid persisted JSON with whitespace, avoiding an unrelated large-payload serializer test.
			db.prepare("UPDATE events SET payload = CAST(payload || printf('%*s', 268435456, '') AS BLOB) WHERE event_id = ?").run(rejectedId);
			db.prepare("UPDATE sender_control SET retry_not_before = ?").run(Date.now() + 3_600_000);
			await observe.emit({ event_id: laterId, event_type: "memory.write", lane: "memory", agent_id: "codex", payload: validPayloads["memory.write"] });
			expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE shipped = 0 AND terminal = 0").get()).toEqual({ n: 0 });
			const pageSize = Number(db.pragma("page_size", { simple: true }));
			const pages = Number(db.pragma("page_count", { simple: true }));
			const free = Number(db.pragma("freelist_count", { simple: true }));
			expect((pages - free) * pageSize < 268_435_456).toBe(true);
			const freshId = "018f7d0c-fd8b-7ccf-9b9b-0a2ea938ad03";
			await observe.emit({ event_id: freshId, event_type: "memory.write", lane: "memory", agent_id: "codex", payload: validPayloads["memory.write"] });
			db.prepare("UPDATE sender_control SET retry_not_before = 0").run();
			server.enqueue("/api/v1/events", { status: 422, body: { error: "chain_seed_required" } });
			expect(await observe.flush()).toEqual({ shipped: 2, terminal: 0, retryable: 0 });
			const events = server.calls.filter((call: { url: string }) => call.url === "/api/v1/events").map((call: { body: string }) => JSON.parse(call.body));
			expect(events.map((event: { event_type: string }) => event.event_type)).toEqual(["memory.write", "agent.identify", "memory.write"]);
			expect(events.at(-1)).toMatchObject({ event_id: "018f7d0c-fd8b-7ccf-9b9b-0a2ea938ad03", chain_epoch: 1, seq: 1 });
		} finally {
			await observe.shutdown();
			db.close();
			await server.stop();
			rmSync(temp.dir, { recursive: true, force: true });
		}
	});
});
