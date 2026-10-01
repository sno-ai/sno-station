/**
 * A coding skin never names its own observe session: the sidecar names one per host session,
 * reports every event under the skin's own agent id, and closes the session on session end.
 * The ingest endpoint is a local stand-in for www.sno.ai; everything before it is real.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REM_SIDECAR_TOKEN_HEADER } from "../../../../packages/memory/src/contract/routes";
import { startRemSidecar } from "../../../../packages/memory/src/sidecar/server";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db";
import { writeSettingsFixture } from "../fixtures/settings-file-fixture";
import { untilModelReady } from "./fixtures/model-ready";

type Envelope = {
	event_type: string;
	lane: string;
	scope: { agent_id: string; session_uuid?: string };
	payload: Record<string, unknown>;
};

const ingest = await vi.hoisted(async () => {
	const { createServer } = await import("node:http");
	const events: Envelope[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", chunk => { body += chunk; });
		request.on("end", () => {
			const reply = (status: number, json: unknown): void => {
				response.writeHead(status, { "Content-Type": "application/json" });
				response.end(JSON.stringify(json));
			};
			if (request.url === "/api/v1/identity/register-machine") {
				const { user_cuid, machine_uuid } = JSON.parse(body) as { user_cuid: string; machine_uuid: string };
				return reply(200, { user_cuid, machine_uuid, claimed: false });
			}
			if (request.url === "/api/v1/events") {
				const envelope = JSON.parse(body) as Envelope & { event_id: string };
				events.push(envelope);
				return reply(202, { receipt_id: envelope.event_id });
			}
			reply(404, { error: "not_found" });
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("ingest stand-in did not listen");
	process.env.SNO_STATION_MEM_NODE_ENV = "test";
	return { events, server, baseUrl: `http://127.0.0.1:${address.port}` };
});

let root: string;
let database: ReturnType<typeof createTestDb>;
let sidecar: Awaited<ReturnType<typeof startRemSidecar>> | undefined;
const previousProfile = process.env.SNO_PROFILE_DIR;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "sidecar-observe-lifecycle-"));
	database = createTestDb();
	process.env.SNO_PROFILE_DIR = root;
	writeSettingsFixture(root, { mode: "local-first", rerank: { mode: "none" },
		store: { path: database.dbPath, encryptionKey: database.encryptionKey },
		telemetry: { observe: { enabled: true, baseUrl: ingest.baseUrl } } });
	mkdirSync(join(root, "sno-station-mem"), { recursive: true });
	ingest.events.length = 0;
});

afterEach(async () => {
	await sidecar?.stop();
	sidecar = undefined;
	database.cleanup();
	rmSync(root, { recursive: true, force: true });
	if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
	else process.env.SNO_PROFILE_DIR = previousProfile;
});

afterAll(() => {
	return new Promise<void>(resolve => ingest.server.close(() => resolve()));
});

const tokenOf = (): string => JSON.parse(readFileSync(join(root, "station", "sidecar.json"), "utf8")).token;

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

async function post(path: string, body: unknown, skin: string): Promise<unknown> {
	if (!sidecar) throw new Error("missing test sidecar");
	const response = await fetch(`http://127.0.0.1:${sidecar.port}${path}`, {
		method: "POST", headers: { [REM_SIDECAR_TOKEN_HEADER]: tokenOf(), "x-sno-station-mem-skin": skin },
		body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
	});
	expect(response.status, path).toBe(200);
	return response.json();
}

async function shippedTypes(sessionUuid: string, last: string): Promise<string[]> {
	for (let waited = 0; waited < 20_000; waited += 250) {
		const types = ingest.events.filter(event => event.scope.session_uuid === sessionUuid).map(event => event.event_type);
		if (types.includes(last)) return types;
		await delay(250);
	}
	throw new Error(`ingest never received ${last} for ${sessionUuid}`);
}

describe("sidecar-owned observe sessions for coding skins", () => {
	it("reports the whole session under the skin's agent id with one UUID-v7 session", async () => {
		sidecar = await startRemSidecar();
		const port = sidecar.port;
		// The service prepares its model on start; recall answers `model-preparing` until then.
		await untilModelReady(async ({ scope: probe, ...recall }) => (await fetch(`http://127.0.0.1:${port}/v1/get-recall`, {
			method: "POST", headers: { [REM_SIDECAR_TOKEN_HEADER]: tokenOf(), "x-sno-station-mem-skin": "model-ready-probe" },
			body: JSON.stringify({ ...recall, scope: { ...probe, principal: userInfo().username } }), signal: AbortSignal.timeout(30_000),
		})).json());
		const scope = { principal: userInfo().username, project: "global", session: "codex-session-1", host: { sessionId: "codex-session-1" } };
		const prompt = "What colour did we pick for the launch page?";
		expect(await post("/v1/host-event", { scope, event: { kind: "prompt", prompt } }, "codex")).toEqual({ degraded: false, accepted: true });
		await post("/v1/get-recall", { scope, query: prompt, options: { source: "manual", limit: 3 } }, "codex");
		expect(await post("/v1/host-event", { scope, event: {
			kind: "llm", model: "openai:gpt-5.6-codex", promptTokens: 6402, completionTokens: 241, latencyMs: 8420.6,
		} }, "codex")).toEqual({ degraded: false, accepted: true });
		expect(await post("/v1/host-event", { scope, event: {
			kind: "tool", toolName: "Bash", decision: "allow", input: '{"command":"git status"}', output: "On branch dev, mail owner@example.test", latencyMs: 312.4,
		} }, "codex")).toEqual({ degraded: false, accepted: true });
		expect(await post("/v1/host-event", { scope, event: {
			kind: "permission", permissionKind: "Bash", decision: "deny", target: '{"command":"rm -rf /"}',
		} }, "codex")).toEqual({ degraded: false, accepted: true });
		await post("/v1/on-session-end", { scope, messages: [] }, "codex");

		// The model-ready probe runs its own session first; the session under test is the skin's.
		const started = ingest.events.find(event => event.event_type === "session.start" && event.scope.agent_id === "codex");
		expect(started, "session.start reached ingest").toBeDefined();
		const sessionUuid = started?.scope.session_uuid ?? "";
		expect(sessionUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		const types = await shippedTypes(sessionUuid, "cost.summary");
		expect(types).toEqual(["session.start", "prompt.submit", "memory.read", "llm.call", "tool.call", "permission.request", "memory.snapshot", "session.end", "cost.summary"]);

		const session = ingest.events.filter(event => event.scope.session_uuid === sessionUuid);
		expect(new Set(session.map(event => event.scope.agent_id))).toEqual(new Set(["codex"]));
		expect(ingest.events.filter(event => event.event_type === "agent.identify").map(event => event.scope.agent_id)).toContain("codex");
		const byType = Object.fromEntries(session.map(event => [event.event_type, event]));
		expect(byType["prompt.submit"]?.payload).toMatchObject({ byte_len: Buffer.byteLength(prompt, "utf8") });
		expect(byType["prompt.submit"]?.payload.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(byType["llm.call"]?.payload).toEqual({
			model: "openai:gpt-5.6-codex", prompt_tokens: 6402, completion_tokens: 241, latency_ms: 8421,
			cache_read_tokens: 0, cache_write_tokens: 0, token_source: "host_agent_paid",
		});
		expect(byType["llm.call"]?.lane).toBe("llm");
		expect(byType["tool.call"]?.lane).toBe("skill");
		expect(byType["tool.call"]?.payload).toMatchObject({ tool_name: "Bash", decision: "allow", latency_ms: 312 });
		expect(byType["tool.call"]?.payload.input_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(byType["tool.call"]?.payload.output_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(byType["tool.call"]?.payload.output_hash).not.toBe(sha256("On branch dev, mail owner@example.test"));
		expect(byType["tool.call"]?.payload.output_hash).toBe(sha256("On branch dev, mail <email>"));
		expect(byType["permission.request"]?.lane).toBe("security");
		expect(byType["permission.request"]?.payload).toEqual({ kind: "Bash", decision: "deny", target_hash: sha256('{"command":"rm -rf /"}') });
		expect(byType["session.end"]?.payload).toMatchObject({ session_uuid: sessionUuid });
		expect(byType["session.end"]?.payload.duration_ms).toBeGreaterThanOrEqual(0);
		expect(byType["memory.snapshot"]?.payload).toMatchObject({ session_uuid: sessionUuid, snapshot_reason: "session_end" });
		expect(byType["cost.summary"]?.payload).toMatchObject({
			session_uuid: sessionUuid, llm_calls: 1, memory_reads: 1, tool_calls: 1, host_agent_prompt_tokens: 6402, host_agent_completion_tokens: 241,
		});
	});
});
