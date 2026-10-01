/**
 * The installed hook commands of the Claude Code and Codex skins, run as the host would run
 * them (the built CLI, JSON on stdin), against a real sidecar; the only stand-in is the
 * www.sno.ai ingest endpoint. Every event must arrive under the skin's own agent id.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSettingsFixture } from "../../packages/memory/fixtures/settings-file-fixture";

const repoRoot = resolve(import.meta.dirname, "../../..");
// The machine's own model cache (read from the account, not HOME): no per-test model download.
const MODEL_CACHE = join(userInfo().homedir, ".cache", "sno-station", "models");

type Envelope = { event_id: string; event_type: string; lane: string; scope: { agent_id: string; session_uuid?: string }; payload: Record<string, unknown> };

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
				const envelope = JSON.parse(body) as Envelope;
				// Production accepts a re-sent event id as a duplicate; an at-least-once client may re-post.
				if (events.some(seen => seen.event_id === envelope.event_id)) return reply(409, { error: "duplicate_event" });
				events.push(envelope);
				return reply(202, { receipt_id: envelope.event_id });
			}
			reply(404, { error: "not_found" });
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("ingest stand-in did not listen");
	return { events, server, baseUrl: `http://127.0.0.1:${address.port}` };
});

let root: string;
let previousEnv: Record<string, string | undefined>;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "mem-skin-observe-hooks-"));
	previousEnv = { SNO_PROFILE_DIR: process.env.SNO_PROFILE_DIR, HOME: process.env.HOME,
		SNO_STATION_MEM_NODE_ENV: process.env.SNO_STATION_MEM_NODE_ENV };
	process.env.SNO_PROFILE_DIR = root;
	// The store list lives under HOME; the hooks and the service they start inherit this environment.
	process.env.HOME = join(root, "home");
	process.env.SNO_STATION_MEM_NODE_ENV = "test";
	ingest.events.length = 0;
	writeSettingsFixture(root, { mode: "local-first", rerank: { mode: "none" }, embedding: { cacheDir: MODEL_CACHE },
		telemetry: { observe: { enabled: true, baseUrl: ingest.baseUrl } } });
});

afterEach(async () => {
	const discovery = join(root, "station", "sidecar.json");
	if (existsSync(discovery)) {
		const { pid } = JSON.parse(readFileSync(discovery, "utf8")) as { pid: number };
		try { process.kill(pid, "SIGTERM"); }
		catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
	}
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
});

afterAll(() => new Promise<void>(resolve => ingest.server.close(() => resolve())));

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function hook(cli: string, subcommand: string, input: Record<string, unknown>): void {
	const run = spawnSync(process.execPath, [cli, subcommand], {
		encoding: "utf8", timeout: 30_000, env: process.env, input: JSON.stringify(input),
	});
	expect(run.status, `${subcommand}: ${run.stderr}`).toBe(0);
}

async function eventsFor(agentId: string, last: string): Promise<Envelope[]> {
	for (let waited = 0; waited < 30_000; waited += 250) {
		const mine = ingest.events.filter(event => event.scope.agent_id === agentId);
		if (mine.some(event => event.event_type === last)) return mine;
		await delay(250);
	}
	throw new Error(`ingest never received ${last} for ${agentId}`);
}

describe.each([
	{ app: "mem-claude", agentId: "claude-code", turnKey: "prompt_id" },
	{ app: "mem-codex", agentId: "codex", turnKey: "turn_id" },
])("$app hook commands report the host's tool activity", ({ app, agentId, turnKey }) => {
	it("delivers prompt, tool and session end under its own agent id", async () => {
		const cli = join(repoRoot, "apps", app, "dist/cli.js");
		const sessionId = `${app}-observe-1`;
		const base = { session_id: sessionId, cwd: repoRoot };
		const prompt = "Which branch is the release cut from?";
		hook(cli, "user-prompt-submit", { ...base, [turnKey]: "turn-1", prompt });
		hook(cli, "pre-tool-use", { ...base, tool_use_id: "tool-1", tool_name: "Bash", tool_input: { command: "git status" } });
		await delay(40);
		hook(cli, "post-tool-use", { ...base, tool_use_id: "tool-1", tool_name: "Bash", tool_input: { command: "git status" }, tool_response: { stdout: "On branch dev" } });
		hook(cli, "post-tool-use", { ...base, tool_use_id: "tool-orphan", tool_name: "Read", tool_input: { file_path: "/etc/hosts" }, tool_response: { content: "127.0.0.1 localhost" } });
		hook(cli, "session-end", base);

		const mine = await eventsFor(agentId, "cost.summary");
		const started = mine.find(event => event.event_type === "session.start");
		expect(started?.scope.session_uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		const sessionUuid = started?.scope.session_uuid;
		const session = mine.filter(event => event.scope.session_uuid === sessionUuid);
		expect(session.map(event => event.event_type)).toEqual([
			"session.start", "prompt.submit", "memory.read", "tool.call", "tool.call", "memory.snapshot", "session.end", "cost.summary",
		]);
		const [first, orphan] = session.filter(event => event.event_type === "tool.call");
		expect(first?.lane).toBe("skill");
		expect(first?.payload).toMatchObject({ tool_name: "Bash", decision: "allow", input_hash: sha256('{"command":"git status"}'), output_hash: sha256('{"stdout":"On branch dev"}') });
		expect(first?.payload.latency_ms).toBeGreaterThanOrEqual(40);
		expect(orphan?.payload).toMatchObject({ tool_name: "Read", latency_ms: 0 });
		expect(session.find(event => event.event_type === "prompt.submit")?.payload).toMatchObject({ byte_len: Buffer.byteLength(prompt, "utf8") });
		expect(session.find(event => event.event_type === "cost.summary")?.payload).toMatchObject({ tool_calls: 2, memory_reads: 1 });
	}, 120_000);
});
