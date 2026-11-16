/** Restatement judgments through real HTTP capture and encrypted-store read-back. */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db";
import { createMemUpdateFixture } from "../fixtures/mem-update-fixture";
import { modelReply, startRecorder } from "./fixtures/model-recorders";

type Fact = { text: string; kind: "rule" | "fact"; subject: "user" | "agent"; role: "user" | "assistant" };
type JudgmentFact = { index: number; text: string; by: "owner" | "assistant";
	rows: Array<{ id: string; text: string; by: "owner" | "assistant" }> };
type StoredRow = { id: string; text: string; project: string; lane: string; metadata: string };
const ownerText = "The owner requires every reply to be written in Chinese.";
const restatedOwnerText = "The user asked the assistant to speak Chinese.";
const storageText = "The assistant uses encrypted SQLite storage.";
const restatedStorageText = "The assistant stores its data in encrypted SQLite.";
const unrelatedText = "Jupiter has a powerful magnetic field.";
const skin = "hermes";
let embedder: Embedder;
let similarities: { owner: number; storage: number; unrelated: number };
let fixture: Awaited<ReturnType<typeof createMemUpdateFixture>>;
let closers: Array<() => Promise<void>>;
let fact: Fact;
let mode: "work" | "chat";
let answer: "same" | "new" | "failure";
let plantedId: string;
let judgments: Array<{ facts: JudgmentFact[] }>;
let modelEndpoint: string;

beforeAll(async () => {
	embedder = await createTestEmbedder();
	const texts = [ownerText, restatedOwnerText, storageText, restatedStorageText, unrelatedText];
	const vectors = await embedder.embedMany(texts);
	function cosine(left: number, right: number) {
		const a = vectors[left]!;
		const b = vectors[right]!;
		return a.reduce((sum, value, index) => sum + value * b[index]!, 0)
			/ Math.sqrt(a.reduce((sum, value) => sum + value * value, 0) * b.reduce((sum, value) => sum + value * value, 0));
	}
	similarities = { owner: cosine(0, 1), storage: cosine(2, 3), unrelated: cosine(2, 4) };
	console.info("Restatement embedding measurements", { provider: embedder.providerKind, model: embedder.model,
		dimensions: embedder.dimensions, texts, similarities });
});

beforeEach(async () => {
	closers = []; judgments = []; mode = "work"; answer = "same"; plantedId = "";
	fact = { text: restatedStorageText, kind: "fact", subject: "agent", role: "user" };
	const recorder = await startRecorder(closers, ({ content, raw }) => {
		// Like the capture harness, identify calls by their prompt; call ids are not sent on the wire.
		// E21's final-line facts/rows payload is specified independently of its prompt wording.
		const lastLine = content.trimEnd().split("\n").at(-1) ?? "";
		if (lastLine.startsWith("{") && lastLine.includes('"facts"') && lastLine.includes('"rows"')) {
			const request = JSON.parse(lastLine) as { facts: JudgmentFact[] };
			judgments.push(request);
			return answer === "failure" ? { status: 503, body: { error: "restatement unavailable" } }
				: modelReply(JSON.stringify({ facts: request.facts.map(item => ({ index: item.index,
					rows: item.rows.map(row => ({ id: row.id, relation: answer === "same" && row.id === plantedId ? "same" : "unrelated" })) })) }), raw);
		}
		if (content.startsWith("Judge whether this conversation's place")) return modelReply(JSON.stringify({ mode }), raw);
		if (content.startsWith("For each owner's rule")) {
			const data = JSON.parse(lastLine) as { rows: Array<{ id: string }> };
			return modelReply(JSON.stringify({ rows: data.rows.map(row => ({ id: row.id, scope: "project" })) }), raw);
		}
		if (content.includes("facts:\n")) {
			const batch = JSON.parse(content.split("<take>\n").at(-1)?.split("\n</take>")[0] ?? "[]") as Array<{ id: number }>;
			return modelReply(JSON.stringify({ enrichments: batch.map(({ id }) => ({ id, kind: "standing",
				attribute: "preference.communication_style", value: fact.text, ends_current: false, importance: "high",
				changes_current_state: false, todo: "none", close_reason: null, single_claim: true,
				relations: [], time: { kind: "none" }, ended_time: { kind: "none" } })) }), raw);
		}
		if (content.includes("response_schema:") && !content.includes("Task:") && content.includes("<take>")) {
			const turns = JSON.parse(content.split("<take>\n").at(-1)?.split("\n</take>")[0] ?? "[]") as Array<{ turn_index: number; role: string; content: string }>;
			const turn = turns.find(item => item.content.includes(fact.text));
			return modelReply(JSON.stringify({ claims_found: turn ? [turn.turn_index] : [],
				decisions: turns.filter(item => item.role === "user").map(item => ({ turn_index: item.turn_index, progress_only: false })),
				facts: turn ? [{ id: 0, fact: fact.text, ...(mode === "work" ? { kind: fact.kind } : {}),
					subject: fact.subject, subject_kind: fact.subject, temporal_phrase: null, ended_at_phrase: null,
					source_span: { turn_index: turn.turn_index, quote: fact.text } }] : [] }), raw);
		}
		if (content.includes("durable_self_statement")) return modelReply('{"decisions":[{"record_index":0,"durable_self_statement":true}]}', raw);
		if (content.includes("Task: resolve each unresolved standing subject")) return modelReply('{"resolutions":[]}', raw);
		if (content.includes('"new_display_name":')) return modelReply('{"entity_id":"new"}', raw);
		if (raw || content.includes("Verdict:") || content.includes("Adjudicate")) return modelReply("keep", raw);
		return modelReply('{"profile_candidates":[],"records":[]}', raw);
	});
	modelEndpoint = `${recorder.url}/v1`;
	fixture = await createMemUpdateFixture(embedder, { mode: "agent-native", capture: { assistant: true } });
	const initialized = await register();
	expect(initialized.body.degraded).toBe(false);
});
afterEach(async () => { await fixture?.close(); for (const close of closers) await close(); });

function register() {
	return fixture.post("/v1/init", { scope: fixture.scope, registration: { skinId: skin,
		model: { baseUrl: modelEndpoint, credential: "fixture", model: "loopback-model" } } }, skin);
}
async function capture() {
	await register();
	const result = await fixture.post("/v1/capture", { scope: { ...fixture.scope, session: randomUUID(), host: { surface: "terminal" } },
		turn: { turnId: randomUUID(), rewindEpoch: 0, messages: [
			...(fact.role === "assistant" ? [{ role: "user", content: "Explain the project constraints.", at: 1794351600000 }] : []),
			{ role: fact.role, content: fact.text, at: 1794351600000 },
		] } }, skin);
	expect(result.status).toBe(200);
	expect(result.body).toMatchObject({ degraded: false, committed: true });
	// Drain the same post-capture arrival-retirement work as the capture harness.
	await register();
}
function rows(): StoredRow[] {
	return fixture.database.sqlite.prepare("SELECT id, text, project_id AS project, lane, metadata FROM nodix_memories ORDER BY text").all() as StoredRow[];
}
async function plant(text = storageText, projectId = fixture.scope.project, assertedBy?: "assistant") {
	const entry = await fixture.store.store({ text, projectId, category: "episodic", importance: 0.7,
		metadata: JSON.stringify({ precision_kind: fact.kind, ...(assertedBy ? { asserted_by: assertedBy } : {}) }) });
	plantedId = entry.id;
	expect(rows()).toMatchObject([{ id: plantedId, text, project: projectId, lane: "active" }]);
	return rows()[0]!;
}
function expectNotWritten() {
	expect.soft(rows()).toHaveLength(1);
	expect.soft(rows().some(row => row.text === fact.text)).toBe(false);
}

describe("memory precision restatement", () => {
	it("does not write an owner's paraphrase of a shared owner row and advances its source order", async () => {
		expect(similarities.owner).toBeGreaterThanOrEqual(0.5);
		fact = { text: restatedOwnerText, kind: "rule", subject: "user", role: "user" };
		const row = await plant(ownerText, "global");
		await capture();
		expectNotWritten();
		expect.soft(rows().find(item => item.id === row.id)?.text).toBe(ownerText);
		expect.soft(JSON.parse(rows().find(item => item.id === row.id)?.metadata ?? "{}").source_order)
			.toMatchObject({ valid_from: 1794351600000, session_moment: 1794351600000, session_ordinal: 0, global_turn_index: 0 });
	});
	it("does not write an owner's paraphrase and clears the existing assistant mark", async () => {
		expect(similarities.storage).toBeGreaterThanOrEqual(0.75);
		const row = await plant(storageText, fixture.scope.project, "assistant");
		expect(JSON.parse(row.metadata).asserted_by).toBe("assistant");
		await capture();
		expectNotWritten();
		const stored = rows().find(item => item.id === row.id)!;
		expect.soft(JSON.parse(stored.metadata)).not.toHaveProperty("asserted_by");
		expect.soft(JSON.parse(stored.metadata).source_order)
			.toMatchObject({ valid_from: 1794351600000, session_moment: 1794351600000, session_ordinal: 0, global_turn_index: 0 });
	});
	it("adopts a shared assistant row when the owner restates it without writing a project fact", async () => {
		const row = await plant(storageText, "global", "assistant");
		expect(JSON.parse(row.metadata).asserted_by).toBe("assistant");
		await capture();
		expectNotWritten();
		const stored = rows().find(item => item.id === row.id)!;
		expect.soft(JSON.parse(stored.metadata)).not.toHaveProperty("asserted_by");
	});
	it("does not write an assistant's paraphrase and leaves the owner row unchanged", async () => {
		expect(similarities.storage).toBeGreaterThanOrEqual(0.75);
		fact.role = "assistant";
		const row = await plant();
		expect(JSON.parse(row.metadata)).not.toHaveProperty("asserted_by");
		await capture();
		expectNotWritten();
		expect.soft(rows().find(item => item.id === row.id)).toEqual(row);
	});
	it("writes the fact when E21 answers unrelated", async () => {
		expect(similarities.storage).toBeGreaterThanOrEqual(0.75);
		answer = "new";
		await plant();
		await capture();
		expect(rows()).toHaveLength(2);
		expect(rows()).toContainEqual(expect.objectContaining({ text: fact.text, lane: "active" }));
	});
	it("writes the fact pending and succeeds when E21 returns HTTP 503", async () => {
		expect(similarities.storage).toBeGreaterThanOrEqual(0.75);
		answer = "failure";
		await plant();
		await capture();
		expect(rows()).toHaveLength(2);
		expect(rows()).toContainEqual(expect.objectContaining({ text: fact.text, lane: "active" }));
		expect(JSON.parse(rows().find(row => row.text === fact.text)?.metadata ?? "{}").precision_check).toBe("pending");
	});
	it("writes an unrelated fact after one E21 judgement and leaves the existing row unchanged", async () => {
		fact.text = unrelatedText;
		answer = "new";
		const row = await plant();
		await capture();
		expect(judgments).toEqual([{ facts: [{ index: 0, text: fact.text, by: "owner", scope: fixture.scope.project,
			rows: [{ id: row.id, text: row.text, by: "owner", scope: row.project }] }] }]);
		expect(rows()).toHaveLength(2);
		expect(rows()).toContainEqual(expect.objectContaining({ text: fact.text, lane: "active" }));
		expect(rows().find(item => item.id === row.id)).toEqual(row);
	});
	it("writes a fact into an empty store without an E21 request", async () => {
		expect(rows()).toEqual([]);
		fact.text = unrelatedText;
		await capture();
		expect(rows()).toEqual([expect.objectContaining({ text: fact.text, lane: "active" })]);
		expect(judgments).toEqual([]);
	});
	it("does not request E21 in a chat place with a near-identical existing row", async () => {
		expect(similarities.storage).toBeGreaterThanOrEqual(0.75);
		mode = "chat";
		await plant();
		await capture();
		expect(rows()).toContainEqual(expect.objectContaining({ text: fact.text }));
		expect(judgments).toEqual([]);
	});
});
