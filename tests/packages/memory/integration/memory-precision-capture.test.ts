/** Real capture contract, encrypted store, and scripted external model replies. */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db";
import { createMemUpdateFixture } from "../fixtures/mem-update-fixture";
import { modelReply, startRecorder } from "./fixtures/model-recorders";

interface Fact {
	text: string; kind: string; subject?: string; subjectKind?: string; attribute?: string;
	role?: "user" | "assistant"; standing?: boolean; scope?: string;
	quote?: string;
}
let embedder: Embedder;
let fixture: Awaited<ReturnType<typeof createMemUpdateFixture>>;
let closers: Array<() => Promise<void>>;
let facts: Fact[];
let mode: string;
let failedMode: boolean;
let modePrompts: string[];
let capturePrompts: string[];
let scopeTexts: string[];
let scopeReplyAsArray: boolean;
let modelEndpoint: string;
let exactRepeat: boolean;
const skin = "hermes";

beforeAll(async () => { embedder = await createTestEmbedder(); });
beforeEach(async () => {
	closers = []; facts = []; mode = "work"; failedMode = false;
	modePrompts = []; capturePrompts = []; scopeTexts = [];
	scopeReplyAsArray = false; exactRepeat = false;
	const recorder = await startRecorder(closers, ({ content, raw }) => {
		if (exactRepeat && content.startsWith("Each fact is about to be stored as a memory.")) {
			const data = JSON.parse(content.trimEnd().split("\n").at(-1) ?? "null") as {
				facts: Array<{ index: number; rows: Array<{ id: string }> }>;
			};
			return modelReply(JSON.stringify({ facts: data.facts.map(fact => ({ index: fact.index,
				rows: fact.rows.map(row => ({ id: row.id, relation: "same" })) })) }), raw);
		}
		if (content.startsWith("Judge whether this conversation's place")) {
			modePrompts.push(content);
			return failedMode ? { status: 400, body: { error: "mode unavailable" } } : modelReply(JSON.stringify({ mode }), raw);
		}
		if (content.startsWith("For each owner's rule")) {
			const data = JSON.parse(content.slice(content.lastIndexOf("\n") + 1)) as { rows: Array<{ id: string; text: string }> };
			scopeTexts.push(...data.rows.map(row => row.text));
			const rows = data.rows.map(row => ({ id: row.id, scope: facts.find(fact => fact.text === row.text)?.scope ?? "project" }));
			return modelReply(scopeReplyAsArray ? "```json\n" + JSON.stringify(rows) + "\n```" : JSON.stringify({ rows }), raw);
		}
		if (content.includes("facts:\n")) {
			const batch = JSON.parse(content.split("<take>\n").at(-1)?.split("\n</take>")[0] ?? "[]") as Array<{ id: number }>;
			return modelReply(JSON.stringify({ enrichments: batch.map(({ id }) => {
				const fact = facts[id];
				return { id, kind: fact?.standing === false ? "occurrence" : "standing", attribute: fact?.attribute ?? "preference.communication_style",
					value: fact?.text, ends_current: false, importance: "high", changes_current_state: false,
					todo: "none", close_reason: null, single_claim: true, relations: [], time: { kind: "none" }, ended_time: { kind: "none" } };
			}) }), raw);
		}
		if (content.includes("response_schema:") && !content.includes("Task:") && content.includes("<take>")) {
			capturePrompts.push(content);
			const turns = JSON.parse(content.split("<take>\n").at(-1)?.split("\n</take>")[0] ?? "[]") as Array<{ turn_index: number; role: string; content: string }>;
			const work = content.startsWith("Read this work conversation");
			const kept = facts.flatMap((fact, id) => {
				if (work && fact.kind === "activity") return [];
				const turn = turns.find(turn => turn.content.includes(fact.text.trim()));
				if (!turn) return [];
				return [{ id, fact: fact.text, ...(work ? { kind: fact.kind } : {}), subject: fact.subject ?? "user",
					subject_kind: fact.subjectKind ?? "user", temporal_phrase: null, ended_at_phrase: null,
					source_span: { turn_index: turn.turn_index, quote: fact.quote ?? fact.text.trim() } }];
			});
			return modelReply(JSON.stringify({ claims_found: kept.map(fact => fact.source_span.turn_index),
				decisions: turns.filter(turn => turn.role === "user").map(turn => ({ turn_index: turn.turn_index, progress_only: false })), facts: kept }), raw);
		}
		if (content.includes("durable_self_statement")) return modelReply(JSON.stringify({ decisions: facts.map((_, record_index) => ({ record_index, durable_self_statement: true })) }), raw);
		if (content.includes("Task: resolve each unresolved standing subject")) return modelReply('{"resolutions":[]}', raw);
		if (content.includes('"new_display_name":')) return modelReply('{"entity_id":"new"}', raw);
		if (raw || content.includes("Verdict:") || content.includes("Adjudicate")) return modelReply("keep", raw);
		return modelReply('{"profile_candidates":[],"records":[]}', raw);
	});
	modelEndpoint = `${recorder.url}/v1`;
	fixture = await createMemUpdateFixture(embedder, { mode: "agent-native", capture: { assistant: true } });
	const initialized = await fixture.post("/v1/init", { scope: fixture.scope,
		registration: { skinId: skin, model: { baseUrl: modelEndpoint, credential: "fixture", model: "loopback-model" } } }, skin);
	expect(initialized.body.degraded).toBe(false);
});
afterEach(async () => { await fixture?.close(); for (const close of closers) await close(); });

async function capture(surface = "terminal", project = fixture.scope.project) {
	await fixture.post("/v1/init", { scope: fixture.scope, registration: { skinId: skin, model: { baseUrl: modelEndpoint, credential: "fixture", model: "loopback-model" } } }, skin);
	const session = randomUUID();
	const result = await fixture.post("/v1/capture", { scope: { ...fixture.scope, project, session, host: { surface } },
		turn: { turnId: randomUUID(), rewindEpoch: 0, messages: [...(facts.every(fact => fact.role === "assistant") ? [{ role: "user", content: "Explain the project constraints.", at: 1794351600000 }] : []), ...facts.map(fact => ({ role: fact.role ?? "user", content: fact.text, at: 1794351600000 }))] } }, skin);
	expect(result.status).toBe(200);
	expect(result.body).toMatchObject({ degraded: false, committed: true });
	// Scope moves run after the capture's arrival-retirement work.
	await fixture.post("/v1/init", { scope: fixture.scope, registration: { skinId: skin, model: { baseUrl: modelEndpoint, credential: "fixture", model: "loopback-model" } } }, skin);
	return result;
}
interface StoredRow { text: string; project: string; lane: string; kind: string | null; asserted: string | null; source: string | null }
function rows(): StoredRow[] {
	return fixture.database.sqlite.prepare("SELECT text, project_id AS project, lane, json_extract(metadata, '$.precision_kind') AS kind, json_extract(metadata, '$.asserted_by') AS asserted, json_extract(metadata, '$.source_project_id') AS source FROM nodix_memories ORDER BY text").all() as StoredRow[];
}
function modes() {
	return fixture.database.sqlite.prepare("SELECT skin_id, project_id, surface, mode FROM nodix_place_modes ORDER BY surface").all();
}

describe("memory precision capture", () => {
	it.each([false, true])("stores the same profile scopes with fenced bare array = %s", async asArray => {
		scopeReplyAsArray = asArray;
		facts = [
			{ text: "The user requires concise reports.", kind: "rule", scope: "general" },
			{ text: "The user requires English comments in this project.", kind: "rule", scope: "project", attribute: "preference.comments" },
		];
		await capture();
		expect(rows()).toEqual([
			{ text: "The user requires English comments in this project.", project: "agent:mem-update", lane: "active", kind: "rule", asserted: null, source: null },
			{ text: "The user requires concise reports.", project: "global", lane: "active", kind: "rule", asserted: null, source: "agent:mem-update" },
		]);
	});
	it("judges once, persists across restart, and separates Hermes entry surfaces", async () => {
		facts = [{ text: "The user requires concise reports.", kind: "rule" }];
		await capture();
		mode = "chat";
		await fixture.restart();
		await capture();
		expect(modePrompts).toHaveLength(1);
		await capture("telegram");
		expect(modes()).toEqual([
			{ skin_id: "hermes", project_id: "agent:mem-update", surface: "telegram", mode: "chat" },
			{ skin_id: "hermes", project_id: "agent:mem-update", surface: "terminal", mode: "work" },
		]);
		expect(modePrompts).toHaveLength(2);
	});
	it.each(["unsure", "invalid", "failure"])("uses work rules without storing a %s judgment and judges the next capture", async answer => {
		mode = answer; failedMode = answer === "failure";
		facts = [{ text: "The user requires concise reports.", kind: "rule" }, { text: "The tests finished successfully.", kind: "activity", standing: false }];
		await capture();
		expect(modes()).toEqual([]);
		expect(rows()).toEqual([{ text: "The user requires concise reports.", project: "agent:mem-update", lane: "active", kind: "rule", asserted: null, source: null }]);
		mode = "work"; failedMode = false;
		await capture();
		expect(modePrompts.length).toBe(2);
		expect(modes()).toEqual([{ skin_id: "hermes", project_id: "agent:mem-update", surface: "terminal", mode: "work" }]);
	});
	it("selects work versus chat prompts and persists their scripted replies with the five work kind labels", async () => {
		facts = [
			{ text: "The user requires concise reports.", kind: "rule" },
			{ text: "The user chose SQLite because the service runs locally.", kind: "decision", standing: false },
			{ text: "The assistant uses encrypted SQLite storage.", kind: "fact", subject: "agent", subjectKind: "agent" },
			{ text: "The assistant cannot index a store without its tokenizer.", kind: "pitfall", subject: "agent", subjectKind: "agent" },
			{ text: "The user works in Pacific time.", kind: "person" },
			{ text: "The tests finished successfully.", kind: "activity", standing: false },
		];
		await capture();
		expect(rows().map(row => [row.text, row.kind])).toEqual([
			["The assistant cannot index a store without its tokenizer.", "pitfall"], ["The assistant uses encrypted SQLite storage.", "fact"],
			["The user chose SQLite because the service runs locally.", "decision"],
			["The user requires concise reports.", "rule"], ["The user works in Pacific time.", "person"],
		]);
		mode = "chat";
		await capture("telegram", "chat-project");
		const chat = fixture.database.sqlite.prepare("SELECT text, json_extract(metadata, '$.precision_kind') AS kind FROM nodix_memories WHERE project_id = 'chat-project' ORDER BY text").all() as StoredRow[];
		expect(chat).toHaveLength(6);
		expect(chat).toContainEqual({ text: "The tests finished successfully.", kind: null });
		expect(capturePrompts[0]?.startsWith("Read this work conversation")).toBe(true);
		expect(capturePrompts[0]).not.toContain("commitment");
		expect(capturePrompts.at(-1)?.startsWith("Read this work conversation")).toBe(false);
	});
	it("rejects a scripted commitment kind instead of writing it as a work memory", async () => {
		facts = [
			{ text: "The user must finish the release documentation.", kind: "commitment" },
			{ text: "The user requires concise reports.", kind: "rule" },
		];
		const result = await fixture.post("/v1/capture", {
			scope: { ...fixture.scope, session: randomUUID(), host: { surface: "terminal" } },
			turn: { turnId: randomUUID(), rewindEpoch: 0, messages: [
				{ role: "user", content: "The user must finish the release documentation.", at: 1794351600000 },
				{ role: "user", content: "The user requires concise reports.", at: 1794351600001 },
			] },
		}, skin);
		expect(result.status).toBe(200);
		expect(capturePrompts.length).toBeGreaterThan(0);
		expect(rows()).toEqual([
			{ text: "The user requires concise reports.", project: "agent:mem-update", lane: "active", kind: "rule", asserted: null, source: null },
		]);
	});
	it("sends the lasting-information purpose and three clarifications in the real work capture prompt", async () => {
		facts = [{ text: "The user requires concise reports.", kind: "rule" }];
		await capture();
		expect(capturePrompts.length).toBeGreaterThan(0);
		for (const phrase of [
			"store only what will still be needed later and cannot be looked up again",
			"`rule`", "`decision`", "`fact`", "`pitfall`", "`person`",
			"how to work", "unless the sentence limits it to that task",
			"outside fact", "took research", "project's own files",
			"visible in the work once it is carried out", "not lasting",
		]) expect.soft(capturePrompts[0]).toContain(phrase);
		expect.soft(capturePrompts[0]).not.toContain("commitment");
	});
	it("keeps assistant project facts active and marked while assistant user claims stay parked", async () => {
		facts = [
			{ text: "The assistant uses encrypted SQLite storage.", kind: "fact", subject: "agent", subjectKind: "agent", role: "assistant" },
			{ text: "The user requires verbose reports.", kind: "rule", role: "assistant" },
		];
		await capture();
		expect(rows()).toEqual([
			{ text: "The assistant uses encrypted SQLite storage.", project: "agent:mem-update", lane: "active", kind: "fact", asserted: "assistant", source: null },
			{ text: "The user requires verbose reports.", project: "agent:mem-update", lane: "parked", kind: "rule", asserted: null, source: null },
		]);
	});
	it("keeps assistant project decisions active and marked while assistant owner rules stay parked", async () => {
		facts = [
			{ text: "The sno-station event buffer limit is 256MB.", kind: "decision", subject: "sno-station", subjectKind: "named_entity", role: "assistant" },
			{ text: "The user requires verbose reports.", kind: "rule", role: "assistant" },
		];
		await capture();
		expect(rows()).toEqual([
			{ text: "The sno-station event buffer limit is 256MB.", project: "agent:mem-update", lane: "active", kind: "decision", asserted: "assistant", source: null },
			{ text: "The user requires verbose reports.", project: "agent:mem-update", lane: "parked", kind: "rule", asserted: null, source: null },
		]);
		expect(fixture.database.sqlite.prepare("SELECT disposition_reason FROM nodix_memories WHERE text = 'The user requires verbose reports.'").get()).toEqual({ disposition_reason: "subject-unverified" });
		expect(scopeTexts).toEqual([]);
	});
	it("restores Markdown quote spans for work assistant facts while chat still parks them", async () => {
		facts = [
			{ text: "In SQLite, a column declared `INTEGER` turns the text `'00120'` into the number `120` when it is stored, so the leading zeros are lost before any export runs.",
				quote: "column declared INTEGER turns the text '00120' into the number 120 when it is stored, so the leading zeros are lost before any export runs.",
				kind: "fact", subject: "agent", subjectKind: "agent", role: "assistant" },
			{ text: "**The assistant** preserves __text__ identifiers.", quote: "The **assistant** preserves text identifiers.",
				kind: "fact", subject: "agent", subjectKind: "agent", role: "assistant" },
		];
		await capture();
		expect(rows().map(row => [row.text, row.lane, row.kind, row.asserted])).toEqual([
			["**The assistant** preserves __text__ identifiers.", "active", "fact", "assistant"],
			["In SQLite, a column declared `INTEGER` turns the text `'00120'` into the number `120` when it is stored, so the leading zeros are lost before any export runs.", "active", "fact", "assistant"],
		]);
		const spans = fixture.database.sqlite.prepare("SELECT json_extract(metadata, '$.source_span') AS span FROM nodix_memories ORDER BY text").all() as Array<{ span: string }>;
		expect(spans.map(row => JSON.parse(row.span))).toEqual([
			{ turnIndex: 2, quote: "The assistant** preserves __text__ identifiers.", startOffset: 2, endOffset: 49 },
			{ turnIndex: 1, quote: "column declared `INTEGER` turns the text `'00120'` into the number `120` when it is stored, so the leading zeros are lost before any export runs.", startOffset: 13, endOffset: 158 },
		]);
		mode = "chat";
		await capture("telegram", "chat-project");
		expect(rows().filter(row => row.project === "chat-project").map(row => [row.text, row.lane, row.kind, row.asserted])).toEqual([
			["**The assistant** preserves __text__ identifiers.", "parked", null, null],
			["In SQLite, a column declared `INTEGER` turns the text `'00120'` into the number `120` when it is stored, so the leading zeros are lost before any export runs.", "parked", null, null],
		]);
		expect(fixture.database.sqlite.prepare("SELECT json_extract(metadata, '$.source_span') AS span FROM nodix_memories WHERE project_id = 'chat-project' ORDER BY text").all()).toEqual([{ span: null }, { span: null }]);
	});
	it("clears an assistant fact mark when the owner repeats it without writing another row", async () => {
		exactRepeat = true;
		facts = [{ text: "The assistant uses encrypted SQLite storage.", kind: "fact", subject: "agent", subjectKind: "agent", role: "assistant" }];
		await capture();
		const original = fixture.database.sqlite.prepare("SELECT id FROM nodix_memories WHERE lane = 'active'").get();
		facts = [{ text: "  The assistant uses encrypted   SQLite storage.  ", kind: "fact", subject: "agent", subjectKind: "agent" }];
		await capture();
		expect(fixture.database.sqlite.prepare("SELECT id FROM nodix_memories WHERE lane = 'active'").get()).toEqual(original);
		expect(rows()).toContainEqual({ text: "The assistant uses encrypted SQLite storage.", project: "agent:mem-update", lane: "active", kind: "fact", asserted: null, source: null });
		await capture();
		expect(rows()).toHaveLength(1);
	});
	it("does not write a whitespace normalized repeat from a second conversation", async () => {
		exactRepeat = true;
		facts = [{ text: "The assistant uses encrypted SQLite storage.", kind: "fact", subject: "agent", subjectKind: "agent" }];
		await capture();
		const original = fixture.database.sqlite.prepare("SELECT id, text FROM nodix_memories").all();
		facts = [{ text: "  The assistant uses encrypted\t  SQLite storage.  ", kind: "fact", subject: "agent", subjectKind: "agent" }];
		await capture();
		expect(fixture.database.sqlite.prepare("SELECT id, text FROM nodix_memories").all()).toEqual(original);
		expect(rows().map(row => row.text)).toEqual(["The assistant uses encrypted SQLite storage."]);
	});
	it.each(["project", "general"])("stores and delivers case-only changes with %s scope", async scope => {
		facts = [{ text: "The user requires API_TOKEN for authentication.", kind: "rule", scope }];
		await capture();
		facts = [{ text: "The user requires api_token for authentication.", kind: "rule", scope }];
		await capture();
		expect(rows().map(row => row.text)).toEqual([
			"The user requires API_TOKEN for authentication.",
			"The user requires api_token for authentication.",
		]);
		const recalled = await fixture.post("/v1/get-recall", {
			scope: { ...fixture.scope, session: "case-only-recall", host: { surface: "terminal" } }, query: "hi",
			options: { source: "auto", injectionPhase: "session-start" },
		}, skin);
		expect(recalled.body.degraded).toBe(false);
		expect(recalled.body.memoryIds).toHaveLength(2);
		expect(recalled.body.contextText).toContain("The user requires API_TOKEN for authentication.");
		expect(recalled.body.contextText).toContain("The user requires api_token for authentication.");
	});
	it("moves general preferences, leaves project and agent rules, and deletes a moved global duplicate", async () => {
		facts = [
			{ text: "The user requires concise reports.", kind: "rule", scope: "general" },
			{ text: "The user requires English comments in this project.", kind: "rule", scope: "project", attribute: "preference.comments" },
			{ text: "The assistant uses concise messages.", kind: "rule", subject: "agent", subjectKind: "agent" },
		];
		await capture();
		expect(rows()).toEqual([
			{ text: "The assistant uses concise messages.", project: "agent:mem-update", lane: "active", kind: "rule", asserted: null, source: null },
			{ text: "The user requires English comments in this project.", project: "agent:mem-update", lane: "active", kind: "rule", asserted: null, source: null },
			{ text: "The user requires concise reports.", project: "global", lane: "active", kind: "rule", asserted: null, source: "agent:mem-update" },
		]);
		expect(scopeTexts.sort()).toEqual(["The user requires English comments in this project.", "The user requires concise reports."]);
		const other = (await fixture.post("/v1/get-recall", { scope: { ...fixture.scope, project: "second-project", session: "cross-project" }, query: "hi", options: { source: "auto", injectionPhase: "session-start" } }, skin)).body;
		expect(other.contextText).toContain("The user requires concise reports.");
		expect(other.contextText).not.toContain("English comments");
		const original = fixture.database.sqlite.prepare("SELECT id FROM nodix_memories WHERE project_id = 'global'").get();
		facts = [{ text: "The user requires concise reports.", kind: "rule", scope: "general" }];
		await capture("terminal", "second-project");
		expect(rows()).toHaveLength(3);
		expect(fixture.database.sqlite.prepare("SELECT id FROM nodix_memories WHERE project_id = 'global'").get()).toEqual(original);
	});
});
