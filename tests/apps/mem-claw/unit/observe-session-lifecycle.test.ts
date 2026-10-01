import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostAggregator } from "../../../../packages/memory/src/engine/observability/cost-aggregator.ts";
import { createRuntimeObservabilityController } from "../../../../apps/mem-claw/src/hooks/openclaw-observe-controller.ts";
import { memClawPlugin } from "../../../../apps/mem-claw/src/install/openclaw-plugin-runtime.ts";
import { OpenClawPluginApiHarness } from "../helpers/openclaw-harness.ts";
import { createTestDb } from "../helpers/test-db.ts";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture.ts";

type ObserveEnvelope = {
	event_type?: unknown;
	payload?: unknown;
};

function readRequestBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function listen(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

describe("observe session lifecycle", () => {
	let stateDir: string;
	let dbCleanup: () => void;
	let dbPath: string;
	let prevStateDir: string | undefined;
	let prevSnoProfileDir: string | undefined;
	let observeServer: Server;
	let observeBaseUrl: string;
	let observeEvents: ObserveEnvelope[];
	const runtimeHarnesses: OpenClawPluginApiHarness[] = [];

	beforeEach(async () => {
		prevStateDir = process.env.OPENCLAW_STATE_DIR;
		prevSnoProfileDir = process.env.SNO_PROFILE_DIR;
		stateDir = mkdtempSync(join(tmpdir(), "mem-claw-observe-session-"));
		process.env.OPENCLAW_STATE_DIR = stateDir;
		process.env.SNO_PROFILE_DIR = join(stateDir, "sno");
		observeEvents = [];

		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		dbCleanup = testDb.cleanup;
		process.env.SNO_PROFILE_DIR = join(stateDir, "sno");

		observeServer = createServer(async (req, res) => {
			if (req.method === "POST" && req.url === "/api/v1/identity/register-machine") {
				const body = JSON.parse(await readRequestBody(req)) as {
					user_cuid: string;
					machine_uuid: string;
				};
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						user_cuid: body.user_cuid,
						machine_uuid: body.machine_uuid,
						claimed: false,
					}),
				);
				return;
			}
			if (req.method === "POST" && req.url === "/api/v1/events") {
				observeEvents.push(JSON.parse(await readRequestBody(req)) as ObserveEnvelope);
				res.writeHead(202, { "Content-Type": "application/json" });
				res.end("{}");
				return;
			}
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end("{}");
		});
		await listen(observeServer);
		const address = observeServer.address() as AddressInfo;
		observeBaseUrl = `http://127.0.0.1:${address.port}`;
		writeSettingsFixture(join(stateDir, "sno"), { mode: "local-first", store: { path: dbPath, encryptionKey: testDb.encryptionKey }, embedding: { cacheDir: "" }, capture: { ambient: false, sessionStrategy: "none" }, recall: { auto: false }, telemetry: { observe: { enabled: true, baseUrl: observeBaseUrl } } });
	});

	afterEach(async () => {
		for (const harness of runtimeHarnesses) await harness.stopServices?.();
		runtimeHarnesses.length = 0;
		await close(observeServer);
		dbCleanup();
		rmSync(stateDir, { recursive: true, force: true });
		if (prevStateDir === undefined) {
			delete process.env.OPENCLAW_STATE_DIR;
		} else {
			process.env.OPENCLAW_STATE_DIR = prevStateDir;
		}
		if (prevSnoProfileDir === undefined) {
			delete process.env.SNO_PROFILE_DIR;
		} else {
			process.env.SNO_PROFILE_DIR = prevSnoProfileDir;
		}
	});

	it("finalizes a UUID-v7 observe session at agent_end", async () => {
		const harness = new OpenClawPluginApiHarness(
			{
				embedding: { dimensions: 1024 },
				dbPath,
				ambientLearning: false,
				autoRecall: false,
				sessionStrategy: "none",
				observe: {
					enabled: true,
					baseUrl: observeBaseUrl,
				},
			},
			{ runtimeAgentId: "parsed-agent" },
		);
		runtimeHarnesses.push(harness);
		await memClawPlugin.register?.(harness);

		const agentEnd = harness.getOnHookHandler("agent_end");
		expect(agentEnd).toBeDefined();
		if (!agentEnd) throw new Error("agent_end hook missing");
		const sessionEnd = harness.getOnHookHandler("session_end");
		expect(sessionEnd).toBeDefined();
		if (!sessionEnd) throw new Error("session_end hook missing");

		const sessionId = "01949f3a-7dc4-7e40-8c5b-2a9b1e7c8d3f";
		const hookCtx = { sessionId, agentId: "parsed-agent" };
		const agentEndEvent = {
			success: true,
			messages: [],
			durationMs: 123,
		};

		await (
			// Hook registry erases the concrete event/context pair; this calls the registered runtime shape.
			agentEnd as unknown as (
				event: typeof agentEndEvent,
				ctx: typeof hookCtx,
			) => Promise<void>
		)(
			agentEndEvent,
			hookCtx,
		);
		await (
			sessionEnd as unknown as (
				event: { sessionId: string; messageCount: number; durationMs?: number },
				ctx: typeof hookCtx,
			) => Promise<void>
		)({ sessionId, messageCount: 2, durationMs: 123 }, hookCtx);

		expect(observeEvents.filter((event) => event.event_type === "cost.summary")).toHaveLength(1);
		expect(observeEvents.filter((event) => event.event_type === "session.start")).toHaveLength(1);
		expect(observeEvents.filter((event) => event.event_type === "session.end")).toHaveLength(1);
		const sessionEndUuids = observeEvents
			.filter((event) => event.event_type === "session.end")
			.map((event) => (event.payload as { session_uuid?: unknown }).session_uuid);
		expect(sessionEndUuids).toEqual([sessionId]);
		const sessionEndSnapshotUuids = observeEvents
			.filter(
				(event) =>
					event.event_type === "memory.snapshot" &&
					(event.payload as { snapshot_reason?: unknown }).snapshot_reason === "session_end",
			)
			.map((event) => (event.payload as { session_uuid?: unknown }).session_uuid);
		expect(sessionEndSnapshotUuids).toEqual(sessionEndUuids);
	});

	it("finalizes observe sessions when session_end only carries a sessionId alias", async () => {
		const harness = new OpenClawPluginApiHarness(
			{
				embedding: { dimensions: 1024 },
				dbPath,
				ambientLearning: false,
				autoRecall: false,
				sessionStrategy: "none",
				observe: {
					enabled: true,
					baseUrl: observeBaseUrl,
				},
			},
			{ runtimeAgentId: "parsed-agent" },
		);
		runtimeHarnesses.push(harness);
		await memClawPlugin.register?.(harness);

		const beforeAgentStart = harness.getOnHookHandler("before_prompt_build");
		expect(beforeAgentStart).toBeDefined();
		if (!beforeAgentStart) throw new Error("before_prompt_build hook missing");
		const sessionEnd = harness.getOnHookHandler("session_end");
		expect(sessionEnd).toBeDefined();
		if (!sessionEnd) throw new Error("session_end hook missing");

		const startCtx = {
			sessionKey: "gateway-session-key",
			sessionId: "openclaw-session-id",
			agentId: "parsed-agent",
		};
		const endCtx = { sessionId: "openclaw-session-id" };
		const beforeAgentStartEvent = { prompt: "remember this session" };

		await (
			beforeAgentStart as unknown as (
				event: typeof beforeAgentStartEvent,
				ctx: typeof startCtx,
			) => Promise<void>
		)(beforeAgentStartEvent, startCtx);
		await (
			sessionEnd as unknown as (
				event: { sessionId: string; messageCount: number; durationMs?: number },
				ctx: typeof endCtx,
			) => Promise<void>
		)({ sessionId: "openclaw-session-id", messageCount: 1, durationMs: 456 }, endCtx);

		expect(observeEvents.filter((event) => event.event_type === "session.start")).toHaveLength(1);
		expect(observeEvents.filter((event) => event.event_type === "cost.summary")).toHaveLength(1);
		expect(observeEvents.filter((event) => event.event_type === "session.end")).toHaveLength(1);

		const sessionStartUuid = (
			observeEvents.find((event) => event.event_type === "session.start")?.payload as
				| { session_uuid?: unknown }
				| undefined
		)?.session_uuid;
		const sessionEndUuid = (
			observeEvents.find((event) => event.event_type === "session.end")?.payload as
				| { session_uuid?: unknown }
				| undefined
		)?.session_uuid;
		const sessionEndDuration = (
			observeEvents.find((event) => event.event_type === "session.end")?.payload as
				| { duration_ms?: unknown }
				| undefined
		)?.duration_ms;
		expect(sessionEndUuid).toBe(sessionStartUuid);
		expect(sessionEndUuid).not.toBe("gateway-session-key");
		expect(sessionEndUuid).not.toBe("openclaw-session-id");
		expect(sessionEndDuration).toBe(456);
	});

	it("finalizes agent_end without duration", async () => {
		const harness = new OpenClawPluginApiHarness(
			{
				embedding: { dimensions: 1024 },
				dbPath,
				ambientLearning: false,
				autoRecall: false,
				sessionStrategy: "none",
				observe: {
					enabled: true,
					baseUrl: observeBaseUrl,
				},
			},
			{ runtimeAgentId: "parsed-agent" },
		);
		runtimeHarnesses.push(harness);
		await memClawPlugin.register?.(harness);

		const agentEnd = harness.getOnHookHandler("agent_end");
		expect(agentEnd).toBeDefined();
		if (!agentEnd) throw new Error("agent_end hook missing");
		const sessionEnd = harness.getOnHookHandler("session_end");
		expect(sessionEnd).toBeDefined();
		if (!sessionEnd) throw new Error("session_end hook missing");

		const hookCtx = {
			sessionId: "01949f3a-7dc4-7e40-8c5b-2a9b1e7c8d3e",
			agentId: "parsed-agent",
		};
		const agentEndEvent = {
			success: true,
			messages: [],
		};

		await (
			agentEnd as unknown as (
				event: typeof agentEndEvent,
				ctx: typeof hookCtx,
			) => Promise<void>
		)(
			agentEndEvent,
			hookCtx,
		);

		expect(observeEvents.filter((event) => event.event_type === "session.end")).toHaveLength(1);
		const agentEndDuration = (
			observeEvents.find((event) => event.event_type === "session.end")?.payload as
				| { duration_ms?: unknown }
				| undefined
		)?.duration_ms;
		expect(agentEndDuration).toBeUndefined();

		await (
			// Hook registry erases the concrete event/context pair; this calls the registered runtime shape.
			sessionEnd as unknown as (
				event: { sessionId: string; messageCount: number; durationMs?: number },
				ctx: typeof hookCtx,
			) => Promise<void>
		)({ sessionId: hookCtx.sessionId, messageCount: 0 }, hookCtx);

		expect(observeEvents.filter((event) => event.event_type === "session.end")).toHaveLength(1);
	});

	it("retries a cost summary emit failure to completion on the next finalize call", async () => {
		const aggregator = new CostAggregator();
		const emitted: ObserveEnvelope[] = [];
		let failCostSummary = true;
		const observability = {
			aggregator,
			drain: vi.fn(async () => undefined),
			emit: vi.fn(async (input: { eventType: string; payload: unknown }) => {
				if (input.eventType === "cost.summary" && failCostSummary) {
					failCostSummary = false;
					throw new Error("cost summary append failed");
				}
				emitted.push({
					event_type: input.eventType,
					payload: input.payload,
				});
			}),
			flush: vi.fn(async () => undefined),
			hashText: vi.fn(() => "a".repeat(64)),
		};
		const controller = createRuntimeObservabilityController({
			api: {
				logger: { info: vi.fn(), warn: vi.fn() },
			} as never,
			config: {
				embedding: { dimensions: 1024 },
				sessionStrategy: "none",
			} as never,
			stateDir,
			observability: observability as never,
		});
		const ctx = { sessionId: "01949f3a-7dc4-7e40-8c5b-2a9b1e7c8d3f" };

		const sessionUuid = await controller.startObserveSession(ctx);
		expect(sessionUuid).toBeDefined();
		if (!sessionUuid) throw new Error("observe session missing");
		aggregator.record("llm.call", sessionUuid, {
			prompt_tokens: 9,
			completion_tokens: 2,
			token_source: "plugin_internal_paid",
		});

		await controller.finalizeObserveSession(ctx, 100);

		expect(emitted.filter((event) => event.event_type === "session.end")).toHaveLength(1);
		expect(emitted.filter((event) => event.event_type === "cost.summary")).toHaveLength(0);
		expect(
			aggregator.summary(sessionUuid),
			expect.objectContaining({
				session_uuid: sessionUuid,
				llm_calls: 0,
			}),
		);
		expect(controller.lookupActiveObserveSession(ctx)).toBeUndefined();

		// Progress survives the failed attempt (codex adversarial review
		// 2026-07-13: the old code wiped it in a `finally`, so a retry could
		// never resume — session.end would silently duplicate and cost.summary
		// would never emit). The mock only fails cost.summary once, so this
		// second call must complete it without re-emitting session.end.
		await controller.finalizeObserveSession(ctx, 100);

		expect(emitted.filter((event) => event.event_type === "session.end")).toHaveLength(1);
		expect(emitted.filter((event) => event.event_type === "cost.summary")).toHaveLength(1);
		expect(controller.lookupActiveObserveSession(ctx)).toBeUndefined();
	});

	it("retries a snapshot emit failure to completion on the next finalize call", async () => {
		const aggregator = new CostAggregator();
		const emitted: ObserveEnvelope[] = [];
		let failSnapshot = true;
		const observability = {
			aggregator,
			drain: vi.fn(async () => undefined),
			emit: vi.fn(async (input: { eventType: string; payload: unknown }) => {
				if (input.eventType === "memory.snapshot" && failSnapshot) {
					failSnapshot = false;
					throw new Error("snapshot append failed");
				}
				emitted.push({
					event_type: input.eventType,
					payload: input.payload,
				});
			}),
			flush: vi.fn(async () => undefined),
			hashText: vi.fn(() => "a".repeat(64)),
		};
		const controller = createRuntimeObservabilityController({
			api: {
				logger: { info: vi.fn(), warn: vi.fn() },
			} as never,
			config: {
				embedding: { dimensions: 1024 },
				sessionStrategy: "none",
			} as never,
			stateDir,
			observability: observability as never,
		});
		const ctx = { sessionId: "01949f3a-7dc4-7e40-8c5b-2a9b1e7c8d40" };

		const sessionUuid = await controller.startObserveSession(ctx);
		expect(sessionUuid).toBeDefined();
		if (!sessionUuid) throw new Error("observe session missing");

		await controller.finalizeObserveSession(ctx, 100);
		expect(controller.lookupActiveObserveSession(ctx)).toBeUndefined();

		// Progress survives the failed attempt, so this retry resumes at the
		// snapshot stage instead of re-emitting session.end/cost.summary or
		// giving up permanently (codex adversarial review 2026-07-13).
		await controller.finalizeObserveSession(ctx, 100);

		expect(emitted.filter((event) => event.event_type === "session.end")).toHaveLength(1);
		expect(emitted.filter((event) => event.event_type === "cost.summary")).toHaveLength(1);
		expect(emitted.filter((event) => event.event_type === "memory.snapshot")).toHaveLength(1);
		expect(controller.lookupActiveObserveSession(ctx)).toBeUndefined();
	});
});
