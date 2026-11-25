/** Work capture -> encrypted store -> automatic recall, with only the external model scripted. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import * as modelClient from "../../../../packages/memory/src/model/llm-client";
import type { MemoryLlmRequest } from "../../../../packages/memory/src/model/llm-client-types";
import type { CalendarInstruction } from "../../../../packages/memory/src/engine/extraction/calendar-instruction";
import { createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db";
import { createMemUpdateFixture } from "../fixtures/mem-update-fixture";
import { modelReply, startRecorder } from "./fixtures/model-recorders";

type Relation = "unrelated" | "same" | "replaces" | "overlaps" | "maybe-same" | "maybe-replaces";
type Fact = { text: string; kind: "rule" | "fact" | "person"; subject?: "user"; role?: "user" | "assistant"; occurrence?: boolean; compound?: true; time?: CalendarInstruction };
type JudgedFact = { index: number; text: string; by: string; rows: Array<{ id: string; text: string; by: string }> };
type Row = { id: string; text: string; project: string; lane: string; metadata: Record<string, unknown> };
const oldPort = "The owner requires the service to use port 8070.";
const newPort = "The owner requires the service to use port 8090.";
const repeatedPort = "The service must listen on port 8090, as required by the owner.";
const skin = "hermes";
const originalClient = modelClient.createLlmClient;
const activeCall = new AsyncLocalStorage<string>();
let embedder: Awaited<ReturnType<typeof createTestEmbedder>>;
let fixture: Awaited<ReturnType<typeof createMemUpdateFixture>>;
let closers: Array<() => Promise<void>>;
let facts: Fact[];
let calls: Array<{ id: string; prompt: string }>;
let judgments: JudgedFact[][];
let answer: (fact: JudgedFact) => { index: number; rows: Array<{ id: string; relation: Relation }> } | undefined;
let confirmation: boolean | "unreachable";
let scope: "general" | "project" | "unsure";
let splitReply: string;
let guarded: number | undefined;
let refused: number[];
let endpoint: string;

beforeAll(async () => { embedder = await createTestEmbedder(); });
beforeEach(async () => {
	closers = []; calls = []; judgments = []; confirmation = true; scope = "project"; splitReply = ""; guarded = undefined; refused = [];
	facts = [{ text: newPort, kind: "rule" }];
	answer = fact => ({ index: fact.index, rows: fact.rows.map(row => ({ id: row.id, relation: "replaces" })) });
	// Keep the real model client and its reply parsing. Carry the call id to its external host port,
	// since RegisteredAgentPort intentionally omits call ids from HTTP requests.
	vi.spyOn(modelClient, "createLlmClient").mockImplementation(config => {
		const host = config.agentPort;
		const client = originalClient({ ...config, ...(host ? { agentPort: {
			async complete(request) {
				const id = activeCall.getStore() ?? "";
				calls.push({ id, prompt: request.prompt });
				if (id === "E18" || id === "E10") throw new Error(`Work capture called retired ${id}`);
				if (id === "E21") {
					const data = JSON.parse(request.prompt.trimEnd().split("\n").at(-1) ?? "null") as { facts: JudgedFact[] };
					judgments.push(data.facts);
					return { kind: "ok", text: JSON.stringify({ facts: data.facts.flatMap(fact => {
						const result = answer(fact); return result ? [result] : [];
					}) }) };
				}
				if (id === "E22") {
					if (confirmation === "unreachable") throw new Error("Checking side unreachable");
					return { kind: "ok", text: JSON.stringify({ replaces: confirmation }) };
				}
				return host.complete(request);
			},
			...(host.reachable ? { reachable: () => host.reachable?.() ?? Promise.resolve(false) } : {}),
		} } : {}) });
		return { ...client,
			completeText: request => activeCall.run(String(request.callId), () => client.completeText(request)),
			completeJson: <T>(request: MemoryLlmRequest) => activeCall.run(String(request.callId), () => client.completeJson<T>(request)),
		};
	});
	const recorder = await startRecorder(closers, ({ content, raw }) => {
		const lastLine = content.trimEnd().split("\n").at(-1) ?? "";
		if (content.startsWith("Judge whether this conversation's place")) return modelReply('{"mode":"work"}', raw);
		if (content.startsWith("For each owner's rule")) {
			const data = JSON.parse(lastLine) as { rows: Array<{ id: string }> };
			return modelReply(JSON.stringify({ rows: data.rows.map(row => ({ id: row.id, scope })) }), raw);
		}
		if (content.includes("Task: split each compound record")) return modelReply(splitReply, raw);
		if (content.includes("facts:\n")) {
			const batch = JSON.parse(content.split("<take>\n").at(-1)?.split("\n</take>")[0] ?? "[]") as Array<{ id: number }>;
			return modelReply(JSON.stringify({ enrichments: batch.map(({ id }) => {
				const fact = facts[id];
				return { id, kind: fact?.occurrence ? "occurrence" : "standing", attribute: "preference.communication_style",
					value: fact?.text, ends_current: false, importance: "high", changes_current_state: false,
					todo: "none", close_reason: null, single_claim: fact?.compound !== true, relations: [],
					time: fact?.time ?? { kind: "none" }, ended_time: { kind: "none" } };
			}) }), raw);
		}
		if (content.includes("response_schema:") && !content.includes("Task:") && content.includes("<take>")) {
			const turns = JSON.parse(content.split("<take>\n").at(-1)?.split("\n</take>")[0] ?? "[]") as Array<{ turn_index: number; role: string; content: string }>;
			const kept = facts.flatMap((fact, id) => {
				const turn = turns.find(item => item.content.includes(fact.text));
				return turn ? [{ id, fact: fact.text, kind: fact.kind, subject: fact.subject ?? "agent", subject_kind: fact.subject ?? "agent",
					temporal_phrase: null, ended_at_phrase: null, source_span: { turn_index: turn.turn_index, quote: fact.text } }] : [];
			});
			return modelReply(JSON.stringify({ claims_found: kept.map(fact => fact.source_span.turn_index),
				decisions: turns.filter(turn => turn.role === "user").map(turn => ({ turn_index: turn.turn_index, progress_only: false })), facts: kept }), raw);
		}
		if (content.includes("durable_self_statement")) return modelReply(JSON.stringify({ decisions: Array.from({ length: guarded ?? facts.length }, (_, record_index) => ({ record_index, durable_self_statement: !refused.includes(record_index) })) }), raw);
		if (content.includes("Task: resolve each unresolved standing subject")) return modelReply('{"resolutions":[]}', raw);
		if (content.includes('"new_display_name":')) return modelReply('{"entity_id":"new"}', raw);
		return modelReply('{"profile_candidates":[],"records":[]}', raw);
	});
	endpoint = `${recorder.url}/v1`;
	fixture = await createMemUpdateFixture(embedder, { mode: "agent-native", capture: { assistant: true } });
	expect((await register()).body.degraded).toBe(false);
});
afterEach(async () => {
	try { await fixture?.close(); for (const close of closers) await close(); }
	finally { vi.restoreAllMocks(); }
});

function register() {
	return fixture.post("/v1/init", { scope: fixture.scope, registration: { skinId: skin,
		model: { baseUrl: endpoint, credential: "fixture", model: "loopback-model" } } }, skin);
}
async function capture(at = 1794351600000) {
	const session = randomUUID();
	await register();
	const result = await fixture.post("/v1/capture", { scope: { ...fixture.scope, session, host: { surface: "terminal" } },
		turn: { turnId: "write-judgement-turn", rewindEpoch: 0, messages: [
			...(facts.every(fact => fact.role === "assistant") ? [{ role: "user", content: "Explain the service constraints.", at }] : []),
			...facts.map(fact => ({ role: fact.role ?? "user", content: fact.text, at })),
		] } }, skin);
	expect(result.status).toBe(200);
	expect(result.body).toMatchObject({ degraded: false, committed: true });
	await register(); // Drains post-capture work, as the existing capture fixture does.
	expect.soft(calls.map(call => call.id), "work capture must not call E18").not.toContain("E18");
	expect.soft(calls.map(call => call.id), "work capture must not call E10").not.toContain("E10");
	return session;
}
function rows(): Row[] {
	return (fixture.database.sqlite.prepare("SELECT id, text, project_id AS project, lane, metadata FROM nodix_memories ORDER BY rowid")
		.all() as Array<Omit<Row, "metadata"> & { metadata: string }>).map(row => ({ ...row, metadata: JSON.parse(row.metadata) }));
}
function row(id: string): Row {
	const found = rows().find(item => item.id === id);
	if (!found) throw new Error(`Missing stored row ${id}`);
	return found;
}
function written(text: string): Row {
	const found = rows().find(item => item.text === text && item.metadata.superseded_by === undefined);
	if (!found) throw new Error(`Missing open row: ${text}`);
	return found;
}
async function plant(text = oldPort, extra: Record<string, unknown> = {}, project = fixture.scope.project) {
	const entry = await fixture.store.store({ text, projectId: project, category: "episodic", importance: 0.9,
		metadata: JSON.stringify({ precision_kind: "rule", source_order: { valid_from: null,
			session_moment: 1794265200000, session_ordinal: 0, global_turn_index: 0, rowid: 0,
			conversation_id: "seed-session" }, ...extra }) });
	return row(entry.id);
}
function relation(value: Relation) {
	answer = fact => ({ index: fact.index, rows: fact.rows.map(item => ({ id: item.id, relation: value })) });
}
function expectOpen(id: string) {
	expect.soft(row(id).metadata).not.toHaveProperty("superseded_by");
	expect.soft(row(id).metadata).not.toHaveProperty("supersede_reason");
}
function expectClosed(id: string, successor: string) {
	expect.soft(row(id).metadata).toMatchObject({ superseded_by: successor, supersede_reason: "write-judgement" });
}
async function recall(expected: string[], excluded: string[] = [], phase: "session-start" | "prompt" = "session-start", query = "What service port must the assistant use?") {
	const result = await fixture.post("/v1/get-recall", { scope: { ...fixture.scope, session: randomUUID(), host: { surface: "terminal" } },
		query, options: { source: "auto", injectionPhase: phase } }, skin);
	expect.soft(result.status).toBe(200);
	expect.soft(result.body.degraded).toBe(false);
	expect.soft([...result.body.memoryIds].sort()).toEqual([...expected].sort());
	for (const id of expected) expect.soft(result.body.contextText).toContain(row(id).text);
	for (const id of excluded) {
		expect.soft(result.body.memoryIds).not.toContain(id);
		// A historical row may have exactly the same text as its new successor.
		if (!expected.some(kept => row(kept).text === row(id).text)) expect.soft(result.body.contextText).not.toContain(row(id).text);
	}
}

it("repeat: keeps the stored rule and advances its source order", async () => {
	const old = await plant(newPort);
	facts = [{ text: repeatedPort, kind: "rule" }]; relation("same");
	const session = await capture();
	expect.soft(rows().map(item => item.id)).toEqual([old.id]);
	expect.soft(row(old.id).text).toBe(newPort);
	expect.soft(row(old.id).metadata.source_order).toEqual({ valid_from: 1794351600000, session_moment: 1794351600000,
		session_ordinal: 0, global_turn_index: 0, rowid: 1, conversation_id: session });
	expectOpen(old.id);
	await recall([old.id]);
});

it("three stale copies: confirms and closes every 8070 row", async () => {
	const old = await plant();
	const second = await plant("The service must listen on port 8070.");
	const third = await plant("The required service port is 8070.");
	await capture();
	const current = written(newPort);
	expect.soft(rows()).toHaveLength(4);
	for (const prior of [old, second, third]) expectClosed(prior.id, current.id);
	expect.soft(calls.filter(call => call.id === "E22").map(call => JSON.parse(call.prompt.trimEnd().split("\n").at(-1) ?? "null")))
		.toEqual(expect.arrayContaining([
			{ older: { id: old.id, text: "The owner requires the service to use port 8070.", by: "owner" },
				newer: { text: "The owner requires the service to use port 8090.", by: "owner" } },
			{ older: { id: second.id, text: "The service must listen on port 8070.", by: "owner" },
				newer: { text: "The owner requires the service to use port 8090.", by: "owner" } },
			{ older: { id: third.id, text: "The required service port is 8070.", by: "owner" },
				newer: { text: "The owner requires the service to use port 8090.", by: "owner" } },
		]));
	expect.soft(calls.filter(call => call.id === "E22")).toHaveLength(3);
	expectOpen(current.id);
	await recall([current.id], [old.id, second.id, third.id]);
});

it("low-similarity replacement: shows an open row near 0.4 to judgement and closes it after confirmation", async () => {
	const old = await plant("The user insists that every possible bug be confirmed fixed before 1.2.4 is released.");
	const newText = "The user does not care much about edge cases.";
	facts = [{ text: newText, kind: "rule" }];
	relation("replaces"); confirmation = true;
	const hits = await fixture.store.searchSemantic(await embedder.embed(newText), {
		projectIdFilter: [fixture.scope.project, "global"], limit: 8, minScore: 0,
		excludeSuperseded: true, excludeInvalidatedBefore: 1794351600000,
	});
	const hit = hits.find(item => item.entry.id === old.id);
	expect(hit?.distance, "the real nearest-row search finds the open row").toBeDefined();
	expect(1 - (hit?.distance ?? 2) ** 2 / 2).toBeCloseTo(0.4, 1);
	expectOpen(old.id);
	await capture();
	const current = written(newText);
	expect.soft(judgments.flat().flatMap(fact => fact.rows)).toContainEqual({ id: old.id, text: old.text, by: "owner", scope: fixture.scope.project });
	expect.soft(calls.filter(call => call.id === "E22").map(call => call.prompt).join("\n")).toContain(old.text);
	expectClosed(old.id, current.id);
	expectOpen(current.id);
});

it("back to an earlier value: excludes the replaced row from judgement and writes a fresh row", async () => {
	const current = await plant(newPort);
	const old = await plant(oldPort, { superseded_by: current.id, superseded_at: 1794265200000, supersede_reason: "write-judgement" });
	facts = [{ text: oldPort, kind: "rule" }];
	await capture();
	expect.soft(judgments.flat().flatMap(fact => fact.rows).map(item => item.id)).toContain(current.id);
	for (const call of calls.filter(call => call.id === "E21")) expect.soft(call.prompt).not.toContain(old.id);
	const fresh = written(oldPort);
	expect.soft(fresh.id).not.toBe(old.id);
	expect.soft(rows()).toHaveLength(3);
	expectClosed(current.id, fresh.id);
	expect.soft(row(old.id).metadata).toEqual(old.metadata);
	await recall([fresh.id], [current.id, old.id]);
});

it("same new value with a stale open value: closes against the existing row without another write", async () => {
	const current = await plant(newPort);
	const old = await plant();
	facts = [{ text: repeatedPort, kind: "rule" }];
	answer = fact => ({ index: fact.index, rows: fact.rows.map(item => ({ id: item.id,
		relation: item.id === current.id ? "same" : "replaces" })) });
	await capture();
	expect.soft(rows().map(item => item.id)).toEqual([current.id, old.id]);
	expectClosed(old.id, current.id);
	expectOpen(current.id);
	await recall([current.id], [old.id]);
});

it("maybe-same: stores nothing and leaves the old row open", async () => {
	const old = await plant(); relation("maybe-same");
	await capture();
	expect.soft(rows()).toEqual([old]);
	await recall([old.id]);
});

it("maybe-replaces: stores the new rule and records the open pair", async () => {
	const old = await plant(); relation("maybe-replaces");
	await capture();
	const current = written(newPort);
	expect.soft(rows()).toHaveLength(2);
	expect.soft(current.metadata.precision_recheck_with).toEqual([old.id]);
	expectOpen(old.id); expectOpen(current.id);
	await recall([old.id, current.id]);
});

it("overlaps: stores both open rows and records their pair", async () => {
	const old = await plant(); relation("overlaps");
	await capture();
	const current = written(newPort);
	expect.soft(rows()).toHaveLength(2);
	expect.soft(current.metadata.precision_recheck_with).toEqual([old.id]);
	expectOpen(old.id); expectOpen(current.id);
	await recall([old.id, current.id]);
});

it("checking side says no: keeps the old row and stores the new row", async () => {
	const old = await plant(); confirmation = false;
	await capture();
	const current = written(newPort);
	expect.soft(rows()).toHaveLength(2);
	expectOpen(old.id); expectOpen(current.id);
	expect.soft(current.metadata).not.toHaveProperty("precision_check");
	expect.soft(calls.filter(call => call.id === "E22").map(call => call.prompt).join("\n")).toContain(oldPort);
	expect.soft(calls.filter(call => call.id === "E22").map(call => call.prompt).join("\n")).toContain(newPort);
	await recall([old.id, current.id]);
});

it("assistant against owner: refuses replacement before calling the checking side", async () => {
	const old = await plant();
	facts = [{ text: newPort, kind: "rule", role: "assistant" }];
	await capture();
	const current = written(newPort);
	expect.soft(rows()).toHaveLength(2);
	expectOpen(old.id); expectOpen(current.id);
	expect.soft(current.metadata.asserted_by).toBe("assistant");
	expect.soft(calls.map(call => call.id)).not.toContain("E22");
	expect.soft(judgments.flat().map(fact => fact.by)).toContain("assistant");
	await recall([old.id], [current.id]);
});

it("checking side unreachable: stores pending, preserves old rows, and logs the affected pair", async () => {
	const old = await plant(); confirmation = "unreachable";
	const lines: string[] = [];
	const output = vi.spyOn(process.stderr, "write").mockImplementation(chunk => { lines.push(String(chunk)); return true; });
	try {
		await capture();
		const current = written(newPort);
		expect.soft(rows()).toHaveLength(2);
		expect.soft(current.metadata.precision_check).toBe("pending");
		expectOpen(old.id); expectOpen(current.id);
		const errors = lines.flatMap(line => line.split("\n")).filter(line => line.startsWith("{"))
			.map(line => JSON.parse(line) as { severity_text: string; attributes: unknown })
			.filter(record => record.severity_text === "ERROR");
		expect.soft(errors.some(record => {
			const attributes = JSON.stringify(record.attributes);
			return attributes.includes(old.id) && attributes.includes(current.id);
		}), "an error log names both affected rows").toBe(true);
		await recall([old.id, current.id]);
	} finally { output.mockRestore(); }
});

it("per-fact failure: handles two valid answers and stores only the omitted fact pending", async () => {
	const old = await plant();
	const reports = await plant("The owner requires concise service reports.");
	facts = [{ text: newPort, kind: "rule" }, { text: "The owner wants brief service reports.", kind: "rule" },
		{ text: "The owner requires the service port to be documented as 8090.", kind: "rule" }];
	answer = fact => fact.index === 2 ? undefined : { index: fact.index, rows: fact.rows.map(item => ({ id: item.id,
		relation: fact.index === 0 && item.id === old.id ? "replaces"
			: fact.index === 1 && item.id === reports.id ? "same" : "unrelated" })) };
	await capture();
	const current = written(newPort);
	const pending = written("The owner requires the service port to be documented as 8090.");
	expect.soft(rows()).toHaveLength(4);
	expectClosed(old.id, current.id);
	expect.soft(rows().some(item => item.text === "The owner wants brief service reports.")).toBe(false);
	expect.soft(pending.metadata.precision_check).toBe("pending");
	expect.soft(current.metadata).not.toHaveProperty("precision_check");
	expectOpen(reports.id); expectOpen(pending.id);
	await recall([current.id, reports.id, pending.id], [old.id]);
});

it("an unshown answer id fails only that fact and stores it pending", async () => {
	const old = await plant();
	const reports = await plant("The owner requires concise service reports.");
	facts = [{ text: newPort, kind: "rule" }, { text: "The owner requires detailed service reports.", kind: "rule" }];
	answer = fact => ({ index: fact.index, rows: fact.index === 0
		? [{ id: "row-that-was-never-shown", relation: "replaces" }]
		: fact.rows.map(item => ({ id: item.id, relation: item.id === reports.id ? "replaces" : "unrelated" })) });
	await capture();
	const current = written(newPort);
	const currentReports = written("The owner requires detailed service reports.");
	expect.soft(rows()).toHaveLength(4);
	expect.soft(current.metadata.precision_check).toBe("pending");
	expect.soft(currentReports.metadata).not.toHaveProperty("precision_check");
	expectClosed(reports.id, currentReports.id);
	expectOpen(currentReports.id);
	expectOpen(old.id); expectOpen(current.id);
	for (const call of calls.filter(call => call.id === "E21")) expect.soft(call.prompt).not.toContain("row-that-was-never-shown");
	await recall([old.id, current.id, currentReports.id], [reports.id]);
});

it("project exception: links the project rule without marking the shared owner rule", async () => {
	const shared = await plant(oldPort, {}, "global");
	await capture();
	const current = written(newPort);
	expect.soft(rows()).toHaveLength(2);
	expect.soft(row(shared.id)).toEqual(shared);
	expect.soft(current.project).toBe("agent:mem-update");
	expect.soft(current.metadata.overrides_shared).toBe(shared.id);
	expectOpen(shared.id); expectOpen(current.id);
	await recall([current.id], [shared.id]);
	const other = await fixture.post("/v1/get-recall", { scope: { ...fixture.scope, project: "another-project", session: randomUUID() },
		query: "hi", options: { source: "auto", injectionPhase: "session-start" } }, skin);
	expect.soft(other.body.memoryIds).toEqual([shared.id]);
	expect.soft(other.body.contextText).toContain(oldPort);
	expect.soft(other.body.contextText).not.toContain(newPort);
});

it("owner's person fact from a project, judged general: becomes shared and retires the shared person fact", async () => {
	const oldServer = "The owner runs local models on an Ollama server.";
	const newServer = "The owner runs local models on LM Studio and has uninstalled Ollama.";
	const shared = await plant(oldServer, { precision_kind: "person" }, "global");
	facts = [{ text: newServer, kind: "person", subject: "user" }];
	scope = "general";
	await capture();
	const current = written(newServer);
	expect.soft(rows()).toHaveLength(2);
	expect.soft(current.project).toBe("global");
	expect.soft(current.metadata).not.toHaveProperty("overrides_shared");
	expectClosed(shared.id, current.id);
	const other = await fixture.post("/v1/get-recall", { scope: { ...fixture.scope, project: "another-project", session: randomUUID() },
		query: "hi", options: { source: "auto", injectionPhase: "session-start" } }, skin);
	expect.soft(other.body.memoryIds).toEqual([current.id]);
	expect.soft(other.body.contextText).toContain("LM Studio");
	expect.soft(other.body.contextText).not.toContain("Ollama server");
});
const wholeSentence = "I switched my local model server to LM Studio today and uninstalled Ollama.";
// One piece bound to no sentence of this capture: the split said nothing about the sentence it was asked to split.
const unrelatedSplit = JSON.stringify({ records: [{ kind: "standing", claim_text: "The owner likes tea.", subject: "user", subject_kind: "user",
	attribute: null, value: "tea", temporal_phrase: null, time: { kind: "none" }, ended_time: { kind: "none" }, ends_current: false,
	ended_at_phrase: null, importance: "medium", changes_current_state: false, todo: "none", close_reason: null,
	source_span: { turn_index: 0, quote: "I like tea." }, relations: [], single_claim: true }] });
it.each([["cannot be read", "no JSON here"], ["is empty", '{"records":[]}'], ["is about something else", unrelatedSplit]])(
	"a sentence holding two facts whose split %s is kept whole, reaches other projects and retires the old shared fact", async (_name, reply) => {
		const shared = await plant("The owner runs local models on an Ollama server.", { precision_kind: "person" }, "global");
		facts = [{ text: wholeSentence, kind: "person", subject: "user", compound: true }];
		splitReply = reply; scope = "general";
		await capture();
		const current = written(wholeSentence);
		expect(current).toMatchObject({ lane: "active", project: "global" });
		// Two facts in one row must never share a key with a single fact: no row may be retired by key because of it.
		expect(fixture.database.sqlite.prepare("SELECT attribute FROM nodix_memories WHERE id = ?").get(current.id)).toEqual({ attribute: null });
		expectClosed(shared.id, current.id);
		const other = await fixture.post("/v1/get-recall", { scope: { ...fixture.scope, project: "another-project", session: randomUUID() },
			query: "hi", options: { source: "auto", injectionPhase: "session-start" } }, skin);
		expect(other.body.memoryIds).toEqual([current.id]);
	});
it("a sentence holding two facts that was split is still set aside, and only its pieces are used", async () => {
	const piece = (claim: string) => ({ ...JSON.parse(unrelatedSplit).records[0], claim_text: claim, value: claim,
		source_span: { turn_index: 0, quote: wholeSentence } });
	facts = [{ text: wholeSentence, kind: "person", subject: "user", compound: true }];
	guarded = 2;
	splitReply = JSON.stringify({ records: [piece("The owner's local model server is LM Studio."), piece("The owner has uninstalled Ollama.")] });
	await capture();
	expect(rows().filter(item => item.lane === "active").map(item => item.text).sort()).toEqual([
		"The owner has uninstalled Ollama.", "The owner's local model server is LM Studio."]);
	expect(rows().filter(item => item.lane === "parked").map(item => item.text)).toEqual([wholeSentence]);
});
// Real case (2026-11-24, 2 of 8 splits): the split was fine, but the check that follows refused one of its two pieces.
const pieceOf = (claim: string) => ({ ...JSON.parse(unrelatedSplit).records[0], claim_text: claim, value: claim,
	source_span: { turn_index: 0, quote: wholeSentence } });
it("a sentence holding two facts is kept whole when one of its pieces is refused afterwards, so no half is lost", async () => {
	facts = [{ text: wholeSentence, kind: "person", subject: "user", compound: true }];
	guarded = 2; refused = [1]; scope = "general";
	splitReply = JSON.stringify({ records: [pieceOf("The owner's local model server is LM Studio."), pieceOf("The owner has uninstalled Ollama.")] });
	answer = fact => ({ index: fact.index, rows: fact.rows.map(row => ({ id: row.id, relation: "unrelated" })) });
	await capture();
	expect(rows().filter(item => item.lane === "active").map(item => [item.text, item.project]).sort()).toEqual([
		[wholeSentence, "global"], ["The owner's local model server is LM Studio.", "global"]]);
	expect(rows().filter(item => item.lane === "parked").map(item => item.text)).toEqual(["The owner has uninstalled Ollama."]);
	expect(fixture.database.sqlite.prepare("SELECT attribute FROM nodix_memories WHERE id = ?").get(written(wholeSentence).id)).toEqual({ attribute: null });
});
it("a sentence holding two facts stays set aside when every one of its pieces is refused", async () => {
	facts = [{ text: wholeSentence, kind: "person", subject: "user", compound: true }];
	guarded = 2; refused = [0, 1];
	splitReply = JSON.stringify({ records: [pieceOf("The owner's local model server is LM Studio."), pieceOf("The owner has uninstalled Ollama.")] });
	await capture();
	expect(rows().filter(item => item.lane === "active")).toEqual([]);
	expect(rows().filter(item => item.lane === "parked").map(item => item.text)).toContain(wholeSentence);
});
it("two owner's person facts in one capture correcting the same shared fact, judged general: both become shared and the shared fact is retired", async () => {
	const usesLmStudio = "The owner's local model server is LM Studio.";
	const noOllama = "The owner has uninstalled Ollama.";
	const shared = await plant("The owner runs local models on an Ollama server.", { precision_kind: "person" }, "global");
	facts = [{ text: usesLmStudio, kind: "person", subject: "user" }, { text: noOllama, kind: "person", subject: "user" }];
	answer = fact => ({ index: fact.index, rows: fact.rows.map(item => ({ id: item.id, relation: item.id === shared.id ? "replaces" : "unrelated" })) });
	scope = "general";
	await capture();
	const first = written(usesLmStudio), second = written(noOllama);
	expect.soft([first.project, second.project]).toEqual(["global", "global"]);
	expect.soft(first.metadata).not.toHaveProperty("overrides_shared");
	expect.soft(second.metadata).not.toHaveProperty("overrides_shared");
	expect.soft(row(shared.id).metadata).toMatchObject({ supersede_reason: "write-judgement" });
	expect.soft([first.id, second.id]).toContain(row(shared.id).metadata.superseded_by);
	const other = await fixture.post("/v1/get-recall", { scope: { ...fixture.scope, project: "another-project", session: randomUUID() },
		query: "hi", options: { source: "auto", injectionPhase: "session-start" } }, skin);
	expect.soft(other.body.contextText).toContain("LM Studio");
	expect.soft(other.body.contextText).not.toContain("Ollama server");
});
it.each(["project", "unsure"] as const)("owner's person fact from a project, judged %s: stays that project's exception and the shared fact stays open", async judged => {
	const newServer = "The owner runs local models on LM Studio and has uninstalled Ollama.";
	const shared = await plant("The owner runs local models on an Ollama server.", { precision_kind: "person" }, "global");
	facts = [{ text: newServer, kind: "person", subject: "user" }];
	scope = judged;
	await capture();
	const current = written(newServer);
	expect.soft(current.project).toBe("agent:mem-update");
	expect.soft(current.metadata.overrides_shared).toBe(shared.id);
	expectOpen(shared.id);
});
it("owner's rule from a project, judged general: stays that project's exception and the shared rule stays open", async () => {
	const shared = await plant(oldPort, {}, "global");
	scope = "general";
	facts = [{ text: newPort, kind: "rule", subject: "user" }];
	await capture();
	const current = written(newPort);
	expect.soft(current.project).toBe("agent:mem-update");
	expect.soft(current.metadata.overrides_shared).toBe(shared.id);
	expectOpen(shared.id);
});
it("two real occurrences: keeps both facts and tells the judgement they are never the same", async () => {
	const firstText = "The service owner restarted the service on Monday after a port 8070 outage.";
	const secondText = "The service owner restarted the service on Tuesday after a port 8070 outage.";
	const first = await plant(firstText, { precision_kind: "fact" });
	facts = [{ text: secondText, kind: "fact", occurrence: true }]; relation("unrelated");
	await capture();
	const second = written(secondText);
	expect.soft(rows().map(item => [item.text, item.metadata.precision_kind])).toEqual([[firstText, "fact"], [secondText, "fact"]]);
	expectOpen(first.id); expectOpen(second.id);
	expect.soft(calls.filter(call => call.id === "E21").map(call => call.prompt).join("\n").toLowerCase())
		.toContain("two occurrences of something that happened are never the same");
	await recall([first.id, second.id], [], "prompt", "When did the service owner restart the service after port 8070 outages?");
});

it("exact shared repeat: shows the shared row to judgement and stores nothing when it answers same", async () => {
	const shared = await plant(newPort, {}, "global");
	relation("same");
	await capture();
	expect.soft(judgments.flat().flatMap(fact => fact.rows).map(item => item.text))
		.toEqual(["The owner requires the service to use port 8090."]);
	expect.soft(rows().map(item => [item.id, item.text, item.project])).toEqual([[shared.id, newPort, "global"]]);
	expectOpen(shared.id);
	await recall([shared.id]);
});

it("identical text on different days: stores both occurrences when judgement answers unrelated", async () => {
	facts = [{ text: "The customer payment arrived.", kind: "fact", occurrence: true,
		time: { kind: "absolute", year: 2026, month: 11, day: 9, precision: "day", timezone: "UTC" } }];
	relation("unrelated");
	await capture(1794222000000);
	expect(fixture.database.sqlite.prepare("SELECT text, valid_from FROM nodix_memories ORDER BY rowid").all())
		.toEqual([{ text: "The customer payment arrived.", valid_from: 1794182400000 }]);
	facts = [{ text: "The customer payment arrived.", kind: "fact", occurrence: true,
		time: { kind: "absolute", year: 2026, month: 11, day: 10, precision: "day", timezone: "UTC" } }];
	await capture(1794308400000);
	expect.soft(judgments.flat().flatMap(fact => fact.rows).map(item => item.text))
		.toEqual(["The customer payment arrived."]);
	expect.soft(fixture.database.sqlite.prepare("SELECT text, valid_from FROM nodix_memories ORDER BY rowid").all())
		.toEqual([
			{ text: "The customer payment arrived.", valid_from: 1794182400000 },
			{ text: "The customer payment arrived.", valid_from: 1794268800000 },
		]);
	for (const item of rows()) expectOpen(item.id);
});
