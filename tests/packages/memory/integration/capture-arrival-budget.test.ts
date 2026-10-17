import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { REM_SIDECAR_TOKEN_HEADER } from "../../../../packages/memory/src/contract/routes";
import { MemoryClient } from "../../../../packages/memory/src/contract/client";
import { startRemSidecar } from "../../../../packages/memory/src/sidecar/server";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db";
import { writeSettingsFixture } from "../fixtures/settings-file-fixture";
import { untilModelReady } from "./fixtures/model-ready";
import { LOCAL_EMBEDDING_CACHE_DIR_DEFAULT } from "../../../../packages/embedder/src/constants.ts";

let root: string;
let database: ReturnType<typeof createTestDb>;
let sidecar: Awaited<ReturnType<typeof startRemSidecar>> | undefined;
let host: Server | undefined;
let token: string;
let principal: string;
let holdJudgments = false;
let judgmentReply = "keep";
let judgmentStatus = 200;
let releaseJudgments = Promise.withResolvers<void>();
let holdExtraction = false;
let extractionEntered = Promise.withResolvers<void>();
let extractionClosed = false;
let releaseExtraction = Promise.withResolvers<void>();
const calls: string[] = [];

function data<T>(prompt: string): T {
	return JSON.parse(prompt.split("<take>\n").at(-1)?.split("\n</take>")[0] ?? "null") as T;
}

function modelAnswer(prompt: string): { kind: string; text: string } {
	if (prompt.includes("Adjudicate whether the newer memory replaces the older memory.")
		|| prompt.includes("Judge the relationship of the newer memory to the older memory.")) {
		return { kind: "arrival", text: judgmentReply };
	}
	if (prompt.includes("Task: user-subject guard.")) {
		const records = data<Array<{ record_index: number }>>(prompt);
		return { kind: "guard", text: JSON.stringify({ decisions: records.map(({ record_index }) =>
			({ record_index, durable_self_statement: true })) }) };
	}
	if (prompt.includes("facts:\n")) {
		const facts = data<Array<{ id: number; fact: string }>>(prompt);
		return { kind: "enrichment", text: JSON.stringify({ enrichments: facts.map(({ id, fact }) => ({
			id, kind: "standing", attribute: "preference.food", value: fact,
			ends_current: false, importance: "medium", changes_current_state: false,
			todo: "none", close_reason: null, single_claim: true, relations: [],
			time: { kind: "none" }, ended_time: { kind: "none" },
		})) }) };
	}
	if (prompt.includes('"claims_found"') && prompt.includes("transcript:\n")) {
		const turns = data<Array<{ role: string; content: string; turn_index: number }>>(prompt)
			.filter(turn => turn.role === "user");
		return { kind: "extraction", text: JSON.stringify({
			claims_found: turns.map(turn => turn.content),
			decisions: turns.map(turn => ({ turn_index: turn.turn_index, progress_only: false })),
			facts: turns.map((turn, id) => ({ id, fact: turn.content, subject: "user", subject_kind: "user",
				temporal_phrase: null, ended_at_phrase: null,
				source_span: { turn_index: turn.turn_index, quote: turn.content } })),
		}) };
	}
	return { kind: "keying", text: '{"records":[]}' };
}

async function post(path: string, body: unknown, signal = AbortSignal.timeout(15_000)): Promise<Response> {
	if (!sidecar) throw new Error("missing sidecar");
	return fetch(`http://127.0.0.1:${sidecar.port}${path}`, {
		method: "POST", headers: { [REM_SIDECAR_TOKEN_HEADER]: token, "x-sno-station-mem-skin": "capture-budget" },
		body: JSON.stringify(body), signal,
	});
}

function capture(messages: string[], session = "agent:capture-budget:turn") {
	return { scope: { principal, project: "global", session },
		turn: { turnId: "turn", rewindEpoch: 0,
			messages: messages.map(content => ({ role: "user" as const, content, at: 1791820800000 })) } };
}

beforeEach(async ({ task }) => {
	database = createTestDb();
	root = mkdtempSync(join(tmpdir(), "capture-arrival-budget-"));
	vi.stubEnv("SNO_PROFILE_DIR", root);
	calls.length = 0;
	holdJudgments = false;
	judgmentReply = "keep";
	judgmentStatus = 200;
	releaseJudgments = Promise.withResolvers<void>();
	holdExtraction = false;
	extractionEntered = Promise.withResolvers<void>();
	extractionClosed = false;
	releaseExtraction = Promise.withResolvers<void>();
	host = createServer(async (request, response) => {
		let raw = "";
		for await (const chunk of request) raw += chunk;
		const body = JSON.parse(raw) as { prompt?: string; messages?: Array<{ content: string }> };
		const answer = modelAnswer(body.prompt ?? body.messages?.at(-1)?.content ?? "");
		calls.push(answer.kind);
		if (answer.kind === "extraction" && holdExtraction) {
			response.once("close", () => { extractionClosed = true; });
			extractionEntered.resolve();
			await releaseExtraction.promise;
			if (response.destroyed) return;
		}
		if (answer.kind === "arrival" && holdJudgments) await releaseJudgments.promise;
		const status = answer.kind === "arrival" ? judgmentStatus : 200;
		response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(status !== 200
			? { error: "model unavailable" } : {
			model: "loopback-model", choices: [body.prompt === undefined
				? { message: { content: answer.text }, finish_reason: "stop" }
				: { text: answer.text, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1 },
		}));
	});
	await new Promise<void>(done => host?.listen(0, "127.0.0.1", done));
	const address = host.address();
	if (!address || typeof address === "string") throw new Error("missing model endpoint");
	writeSettingsFixture(root, { mode: task.name.includes("Sno GPU") ? "rem-enhanced" : "agent-native",
		store: { path: database.dbPath, encryptionKey: database.encryptionKey },
		snoGpu: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "loopback" },
		embedding: { cacheDir: LOCAL_EMBEDDING_CACHE_DIR_DEFAULT },
		rerank: { mode: "none" }, rem: { tick: false },
		telemetry: { observe: { enabled: false }, memoryUsage: { enabled: false } },
	});
	sidecar = await startRemSidecar();
	token = JSON.parse(readFileSync(join(root, "station", "sidecar.json"), "utf8")).token;
	const init = await post("/v1/init", { scope: { principal: "caller", project: "global", session: "setup" },
		registration: { skinId: "capture-budget", model: {
			baseUrl: `http://127.0.0.1:${address.port}/v1`, credential: "loopback", model: "loopback-model",
		} } });
	principal = (await init.json() as { principal: string }).principal;
	await untilModelReady(async ({ scope, query, options }) =>
		(await post("/v1/get-recall", { scope: { principal, ...scope }, query, options })).json(), 30_000);
	for (const food of ["tea", "coffee", "rice", "noodles", "curry", "soup", "apples", "pears", "beans", "bread", "oats", "corn"]) {
		const response = await post("/v1/mutate", { scope: { principal, project: "global", session: "seed" },
			op: { op: "store", content: `I like ${food}.`, category: "episodic" } });
		expect(response.status).toBe(200);
	}
	database.sqlite.prepare("UPDATE nodix_memories SET category = 'profile', subject = 'user', attribute = 'preference.food'").run();
	expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM nodix_memories").get()).toEqual({ count: 12 });
	calls.length = 0;
}, 60_000);

afterEach(async () => {
	releaseJudgments.resolve();
	releaseExtraction.resolve();
	await sidecar?.stop();
	sidecar = undefined;
	if (host) {
		host.closeAllConnections();
		await new Promise<void>(done => host?.close(() => done()));
	}
	host = undefined;
	vi.unstubAllEnvs();
	database?.cleanup();
	if (root) rmSync(root, { recursive: true, force: true });
});

it("cancels an explicit Sno GPU capture at the provider connection without persisting or replaying it", async () => {
	if (!sidecar) throw new Error("missing sidecar");
	holdExtraction = true;
	const client = new MemoryClient("capture-budget", database.dbPath, { pid: process.pid, port: sidecar.port, token });
	const input = capture(["I like lentils."], "explicit-cancel");
	const controller = new AbortController();
	const result = client.capture(input.turn, input.scope, controller.signal).catch(error => error);
	await Promise.race([extractionEntered.promise, result.then(() => { throw new Error("capture ended before extraction"); })]);
	controller.abort();
	expect(await result).toMatchObject({ reason: "timeout" });
	await vi.waitFor(() => expect(extractionClosed).toBe(true), { timeout: 1000 });
	releaseExtraction.resolve();
	await sidecar.stop();
	sidecar = undefined;
	expect(calls).toEqual(["extraction"]);
	expect(database.sqlite.prepare("SELECT text FROM nodix_memories WHERE text = 'I like lentils.'").all()).toEqual([]);
	expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM pending_captures").get()).toEqual({ count: 0 });
});

it("finishes a Sno GPU capture after an ordinary hook disconnects without explicit cancellation", async () => {
	holdExtraction = true;
	const controller = new AbortController();
	const result = post("/v1/capture", capture(["I like lentils."], "hook-disconnect"), controller.signal).catch(error => error);
	await Promise.race([extractionEntered.promise, result.then(() => { throw new Error("capture ended before extraction"); })]);
	controller.abort();
	await result;
	expect(extractionClosed).toBe(false);
	releaseExtraction.resolve();
	await vi.waitFor(() => expect(database.sqlite.prepare("SELECT state FROM nodix_atomic_extraction_ledger").all())
		.toEqual([{ state: "complete" }]), { timeout: 5000 });
	expect(database.sqlite.prepare("SELECT text FROM nodix_memories WHERE text = 'I like lentils.'").all()).toEqual([{ text: "I like lentils." }]);
});

it("passes the existing capture deadline to Sno GPU secondary extraction", async () => {
	const lines: string[] = [];
	const output = vi.spyOn(process.stderr, "write").mockImplementation(chunk => { lines.push(String(chunk)); return true; });
	try {
		const response = await post("/v1/capture", capture(["I like lentils."], "shared-deadline"));
		expect(await response.json()).toMatchObject({ committed: true });
		expect(calls).toContain("guard");
		const guardCall = createHash("sha256").update("E6").digest("hex");
		const completed = lines.flatMap(line => line.trim().split("\n")).filter(Boolean).map(line => JSON.parse(line))
			.find(record => record.event_name === "llm.request.completed" && record.attributes.destination === "sno-gpu"
				&& record.attributes.call_id?.sha256 === guardCall);
		expect(completed?.attributes.timeout_ms).toBeGreaterThan(800_000);
		expect(completed?.attributes.timeout_ms).toBeLessThanOrEqual(900_000);
	} finally { output.mockRestore(); }
});

it("returns the committed turn while arrival judgments are blocked and skips its resend", async () => {
	holdJudgments = true;
	judgmentReply = "replacement";
	const request = capture(["I like lentils."]);
	try {
		const response = await post("/v1/capture", request, AbortSignal.timeout(2000));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ degraded: false, turnId: "turn", committed: true });
		expect(database.sqlite.prepare("SELECT state FROM nodix_atomic_extraction_ledger").all()).toEqual([{ state: "complete" }]);
		expect(database.sqlite.prepare("SELECT text FROM nodix_memories WHERE text = 'I like lentils.'").all()).toEqual([{ text: "I like lentils." }]);
		const retry = await post("/v1/capture", request, AbortSignal.timeout(2000));
		expect(await retry.json()).toEqual({ degraded: false, turnId: "turn", committed: true });
		expect(calls.filter(kind => kind === "extraction")).toEqual(["extraction"]);
		expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM nodix_memories").get()).toEqual({ count: 13 });
		expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM nodix_memories WHERE json_extract(metadata, '$.superseded_by') IS NOT NULL").get()).toEqual({ count: 0 });
	} finally { releaseJudgments.resolve(); }
	await sidecar?.stop();
	sidecar = undefined;
	expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM nodix_memories WHERE json_extract(metadata, '$.superseded_by') IS NOT NULL").get()).toEqual({ count: 3 });
});

it("does not extract again after the caller times out on a committed turn", async () => {
	holdJudgments = true;
	const request = capture(["I like lentils."]);
	const controller = new AbortController();
	const first = post("/v1/capture", request, controller.signal).then(
		async response => response.json(), () => "caller-disconnected",
	);
	try {
		await vi.waitFor(() => expect(database.sqlite.prepare("SELECT state FROM nodix_atomic_extraction_ledger").all())
			.toEqual([{ state: "complete" }]), { timeout: 5000 });
		controller.abort();
		await first;
		const retry = await post("/v1/capture", request, AbortSignal.timeout(2000));
		expect(await retry.json()).toEqual({ degraded: false, turnId: "turn", committed: true });
		expect(calls.filter(kind => kind === "extraction")).toEqual(["extraction"]);
		expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM nodix_memories").get()).toEqual({ count: 13 });
	} finally { releaseJudgments.resolve(); }
});

it("shares three arrival calls across all cards of one capture", async () => {
	const response = await post("/v1/capture", capture(["I like lentils.", "I like barley.", "I like chickpeas."]));
	expect(await response.json()).toEqual({ degraded: false, turnId: "turn", committed: true });
	await sidecar?.stop();
	sidecar = undefined;
	expect(calls.filter(kind => kind === "arrival")).toHaveLength(3);
	expect(calls.filter(kind => kind === "extraction")).toEqual(["extraction"]);
	expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM nodix_memories").get()).toEqual({ count: 15 });
	expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM nodix_memories WHERE json_extract(metadata, '$.superseded_by') IS NOT NULL").get()).toEqual({ count: 0 });
	expect(database.sqlite.prepare("SELECT state FROM nodix_atomic_extraction_ledger ORDER BY chunk_hash").all()).toEqual([
		{ state: "complete" },
	]);
});

it.each(["empty", "unavailable"])("counts Sno GPU %s retries and host fallback in the same ten-call capture budget", async failure => {
	judgmentReply = failure === "empty" ? "" : "keep";
	judgmentStatus = failure === "unavailable" ? 503 : 200;
	const response = await post("/v1/capture", capture(["I like lentils."]));
	expect(await response.json()).toEqual({ degraded: false, turnId: "turn", committed: true });
	await sidecar?.stop();
	sidecar = undefined;
	expect(calls.filter(kind => kind === "arrival")).toHaveLength(3);
	expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM nodix_memories").get()).toEqual({ count: 13 });
	expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM nodix_memories WHERE json_extract(metadata, '$.superseded_by') IS NOT NULL").get()).toEqual({ count: 0 });
});
