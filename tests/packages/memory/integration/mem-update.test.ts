/** Real HTTP memory service, local ONNX embeddings, and encrypted SQLite read-back. */

import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { readMemorySourceOrder } from "../../../../packages/memory/src/store/memory-source-order";
import { createSnoStationMemRemPorts } from "../../../../packages/memory/src/store/rem-sqlite-adapter";
import type { AtomicExtractionWriteCard } from "../../../../packages/memory/src/store/store";
import { createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db";
import { createMemUpdateFixture } from "../fixtures/mem-update-fixture";

const PROJECT = "agent:mem-update";
let embedder: Embedder;
let fixture: Awaited<ReturnType<typeof createMemUpdateFixture>>;

beforeAll(async () => { embedder = await createTestEmbedder(); });
beforeEach(async () => { fixture = await createMemUpdateFixture(embedder); });
afterEach(async () => { await fixture?.close(); });

async function correct(id: string, content: string, scope = fixture.scope) {
	return fixture.post("/v1/mutate", { scope, op: { op: "correct", id, content } });
}

async function seed(text = "The release owner is Dana.", projectId = PROJECT) {
	return fixture.store.store({ text, category: "episodic", projectId });
}

function metadata(id: string): Record<string, any> {
	return JSON.parse(fixture.store.getById(id)?.metadata ?? "{}");
}

function countRows() {
	return (fixture.database.sqlite.prepare("SELECT COUNT(*) AS count FROM nodix_memories").get() as { count: number }).count;
}

async function atomic(text: string, overrides: Partial<AtomicExtractionWriteCard> = {}) {
	const now = Date.now();
	const ledgerKey = { conversationId: randomUUID(), chunkHash: randomUUID(), pipelineVersion: "mem-update-test" };
	fixture.store.beginAtomicExtractionChunk({ ...ledgerKey, rawChunk: text, routingSnapshotId: "mem-update-test",
		runParameters: { maxInputTokens: 4096, outputTokenBudget: 2000, subchunkCount: 1 }, nowMs: now });
	fixture.store.recordAtomicExtractionCalls(ledgerKey, now);
	const result = await fixture.store.storeAtomicExtractionChunk({ ledgerKey, projectId: PROJECT,
		extractorVersion: "mem-update-test", nowMs: now,
		cards: [{ idempotencyKey: randomUUID(), globalTurnIndex: 4, endsCurrent: false, endedAt: null,
			text, category: "profile", subject: "user", attribute: "preference.drink", timestamp: now - 60_000,
			validFrom: now - 60_000, validUntil: null, importance: 0.9, timezone: "America/Los_Angeles",
			lane: "active", dispositionReason: null, rawCandidateJson: null, relations: [], ...overrides }],
	});
	const row = fixture.store.getById(result.cardIds[0] ?? "");
	if (!row) throw new Error(`atomic fixture was not persisted: ${JSON.stringify(result)}`);
	return row;
}

describe("service-owned memory correction", () => {
	it("creates a fresh successor and closes the old row in the service transaction", async () => {
		const old = await seed();
		const corrected = await correct(old.id, "The release owner is Jordan.");
		expect(corrected.status).toBe(200);
		expect(corrected.body).toMatchObject({ degraded: false, result: { isError: false } });
		const successorId = corrected.body.result.details.id;
		expect(successorId).toEqual(expect.any(String));
		expect(successorId).not.toBe(old.id);
		expect(corrected.body.result.content).toEqual([{ type: "text", text: successorId }]);
		expect(fixture.store.getById(successorId)).toMatchObject({ text: "The release owner is Jordan.", projectId: PROJECT, category: "episodic" });
		const retained = fixture.store.getById(old.id);
		expect(retained?.text).toBe(old.text);
		expect(JSON.parse(retained?.metadata ?? "{}")).toMatchObject({ superseded_by: successorId, superseded_at: expect.any(String) });
		expect(metadata(successorId).superseded_by).toBeUndefined();
		expect((await fixture.post("/v1/inspect", { scope: fixture.scope, op: { op: "get", id: old.id } })).body.result.entry.text)
			.toBe(`${old.text}\nretired; superseded by ${successorId}`);
		expect(countRows()).toBe(2);
		const chunks = fixture.database.sqlite.prepare("SELECT chunk_id FROM nodix_memory_chunks WHERE memory_id = ?").all(successorId) as { chunk_id: string }[];
		expect(chunks.length).toBeGreaterThan(0);
		for (const chunk of chunks) expect(fixture.database.sqlite.prepare("SELECT id FROM nodix_memory_chunk_vectors WHERE id = ?").get(chunk.chunk_id)).toEqual({ id: chunk.chunk_id });
		expect(fixture.database.sqlite.prepare("SELECT COUNT(*) AS count FROM nodix_memory_chunks_fts WHERE nodix_memory_chunks_fts MATCH 'Jordan'").get()).toEqual({ count: 1 });
	});

	it("returns the immediate successor on same or different-word retries and preserves a correction chain", async () => {
		const old = await seed();
		const first = await correct(old.id, "The release owner is Jordan.");
		const next = first.body.result.details.id;
		for (const content of [old.text, "The release owner is Jordan.", "The release owner is Avery."]) {
			const retry = await correct(old.id, content);
			expect(retry.body).toMatchObject({ degraded: false, result: { isError: true,
				details: { errorCode: "already-superseded", successorId: next } } });
		}
		const third = (await correct(next, "The release owner is Avery.")).body.result.details.id;
		expect((await correct(old.id, "The release owner is Morgan.")).body.result.details.successorId).toBe(next);
		expect(metadata(next).superseded_by).toBe(third);
		expect(countRows()).toBe(3);
		await fixture.store.delete(third);
		const retired = await fixture.post("/v1/inspect", { scope: fixture.scope, op: { op: "get", id: next } });
		expect(retired.body.result.entry.text).toContain(`retired; superseded by ${third}`);
		expect((await fixture.post("/v1/inspect", { scope: fixture.scope, op: { op: "get", id: third } })).body.result.entry).toBeNull();
	});

	it("commits one successor when two different corrections compete", async () => {
		const old = await seed();
		const results = await Promise.all([correct(old.id, "The release owner is Jordan."), correct(old.id, "The release owner is Avery.")]);
		const committed = results.find(result => result.body.result.isError === false);
		const refused = results.find(result => result.body.result.isError === true);
		expect(committed).toBeDefined();
		expect(refused?.body.result.details).toMatchObject({ errorCode: "already-superseded", successorId: committed?.body.result.details.id });
		expect(metadata(old.id).superseded_by).toBe(committed?.body.result.details.id);
		expect(countRows()).toBe(2);
	});

	it("rejects same normalized text and collisions with closed or invalidated rows without inserting", async () => {
		const old = await seed();
		const collision = await seed("The release owner is Jordan.");
		for (const content of [old.text, `  ${old.text}  `, collision.text]) {
			expect((await correct(old.id, content)).body.result).toMatchObject({ isError: true, details: { errorCode: "invalid-input" } });
		}
		fixture.database.sqlite.prepare("UPDATE nodix_memories SET metadata = json_set(metadata, '$.invalidated_at', ?, '$.superseded_by', ?) WHERE id = ?")
			.run(new Date().toISOString(), "missing-successor", collision.id);
		expect((await correct(old.id, collision.text)).body.result).toMatchObject({ isError: true, details: { errorCode: "invalid-input" } });
		expect(countRows()).toBe(2);
		expect(metadata(old.id).superseded_by).toBeUndefined();
	});

	it("keeps a readable global correction global and rejects an inaccessible id", async () => {
		const old = await seed("The shared release owner is Dana.", "global");
		const other = await seed("The private deployment uses cluster north.", "agent:other-project");
		expect((await correct(other.id, "The private deployment uses cluster south.")).body.result).toMatchObject({ isError: true, details: { errorCode: "not-found" } });
		const successor = (await correct(old.id, "The shared release owner is Jordan.")).body.result.details.id;
		expect(fixture.store.getById(successor)?.projectId).toBe("global");
		expect((await fixture.post("/v1/inspect", { scope: { ...fixture.scope, project: "agent:third-project" }, op: { op: "get", id: successor } })).body.result.entry.id).toBe(successor);
	});

	it.each(["insert", "close"])("rolls back all rows and indexes when the %s write fails", async phase => {
		const old = await seed();
		const before = fixture.database.sqlite.prepare("SELECT id, text, metadata, content_hash FROM nodix_memories").all();
		const countsBefore = fixture.database.sqlite.prepare("SELECT (SELECT COUNT(*) FROM nodix_memory_chunks) AS chunks, (SELECT COUNT(*) FROM nodix_memory_chunk_vectors) AS vectors").get();
		fixture.database.sqlite.exec(phase === "insert"
			? "CREATE TRIGGER mem_update_failure BEFORE INSERT ON nodix_memory_chunks BEGIN SELECT RAISE(ABORT, 'injected correction chunk failure'); END"
			: "CREATE TRIGGER mem_update_failure BEFORE UPDATE OF metadata ON nodix_memories WHEN json_extract(NEW.metadata, '$.superseded_by') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected correction close failure'); END");
		const failed = await correct(old.id, "The release owner is Jordan.");
		expect(failed.body.degraded || failed.body.result?.isError).toBe(true);
		expect(JSON.stringify(failed.body)).toContain("injected correction");
		expect(fixture.database.sqlite.prepare("SELECT id, text, metadata, content_hash FROM nodix_memories").all()).toEqual(before);
		expect(fixture.database.sqlite.prepare("SELECT (SELECT COUNT(*) FROM nodix_memory_chunks) AS chunks, (SELECT COUNT(*) FROM nodix_memory_chunk_vectors) AS vectors").get()).toEqual(countsBefore);
		fixture.database.sqlite.exec("DROP TRIGGER mem_update_failure");
		expect((await correct(old.id, "The release owner is Jordan.")).body.result.isError).toBe(false);
	});

	it("refuses parked, quarantined, invalidated, reflection, and active-task targets", async () => {
		const shapes = [
			{ lane: "parked" }, { lane: "quarantined" },
			{ metadata: { invalidated_at: new Date().toISOString() } },
			{ metadata: { type: "memory-reflection-item" } },
			{ metadata: { active_task_kind: "task" } },
			{ metadata: { active_task_kind: "projection" } },
			{ dispositionReason: "candidate_not_grounded" },
		];
		for (const [index, shape] of shapes.entries()) {
			const old = await seed(`The release rule ${index} is recorded.`);
			if (shape.lane) fixture.database.sqlite.prepare("UPDATE nodix_memories SET lane = ?, raw_candidate_json = '{}' WHERE id = ?").run(shape.lane, old.id);
			if (shape.dispositionReason) fixture.database.sqlite.prepare("UPDATE nodix_memories SET disposition_reason = ? WHERE id = ?").run(shape.dispositionReason, old.id);
			if (shape.metadata) fixture.database.sqlite.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?").run(JSON.stringify({ ...metadata(old.id), ...shape.metadata }), old.id);
			const before = countRows();
			expect((await correct(old.id, `The release rule ${index} was corrected.`)).body.result).toMatchObject({ isError: true, details: { errorCode: "invalid-input" } });
			expect(countRows()).toBe(before);
			expect(metadata(old.id).superseded_by).toBeUndefined();
		}
	});

	it("preserves fact filing and entity relations while replacing summaries, access data, and assertion order", async () => {
		const old = await atomic("The user prefers jasmine tea.", { metadata: {
			section_name: "preferences", fact_key: "profile:preference.drink", entity_id: "entity:user",
			l2_content: "The user prefers jasmine tea.", summary: "jasmine tea", access_count: 9,
		}, relations: [{ subject: "user", predicate: "PREFERS", object: "tea" }] });
		const start = Date.now();
		const result = await correct(old.id, "The user prefers oolong tea.");
		const next = fixture.store.getById(result.body.result.details.id);
		expect(next).toMatchObject({ category: old.category, projectId: old.projectId, importance: old.importance, timezone: old.timezone, factId: old.factId });
		const identity = fixture.database.sqlite.prepare("SELECT subject, attribute, fact_id, lane, maturity, source, valid_from, valid_until FROM nodix_memories WHERE id = ?").get(next?.id) as any;
		expect(identity).toMatchObject({ subject: "user", attribute: "preference.drink", lane: "active", maturity: "extracted", source: "manual", valid_until: null });
		const nextMeta = metadata(next?.id ?? "");
		expect(nextMeta).toMatchObject({ section_name: "preferences", fact_key: "profile:preference.drink", entity_id: "entity:user", source: "manual" });
		expect(JSON.stringify(nextMeta)).not.toContain("jasmine tea");
		expect(nextMeta.idempotency_key).toBeUndefined();
		expect(nextMeta.access_count ?? 0).toBe(0);
		const order = readMemorySourceOrder(next?.metadata ?? "{}");
		expect(order.valid_from).toBeNull();
		expect(order.session_moment).toBeGreaterThanOrEqual(start);
		expect(next?.timestamp).toBeGreaterThanOrEqual(start);
		expect(fixture.database.sqlite.prepare("SELECT subject, predicate, object FROM nodix_memory_relations WHERE source_card_id = ?").all(next?.id))
			.toEqual([{ subject: "user", predicate: "PREFERS", object: "tea" }]);
		expect(metadata(old.id).invalidated_at).toBeDefined();
	});

	it("keeps correction assertion order ahead of a delayed capture with a later event date", async () => {
		const old = await atomic("The user prefers jasmine tea.");
		const nextId = (await correct(old.id, "The user prefers oolong tea.")).body.result.details.id;
		const next = fixture.store.getById(nextId);
		await atomic("The user prefers jasmine tea for next month's meeting.", { timestamp: (next?.timestamp ?? 0) - 5000,
			validFrom: (next?.timestamp ?? 0) + 86_400_000, endsCurrent: true });
		expect(metadata(nextId).superseded_by).toBeUndefined();
		expect(fixture.store.listAtomicValidAt(PROJECT, Date.now()).map(row => row.id)).toContain(nextId);
	});

	it("refuses stale REM close, lane, and rewrite plans without replacing correction lineage", async () => {
		const old = await seed();
		const alternative = await seed("The release owner is Avery.");
		const nextId = (await correct(old.id, "The release owner is Jordan.")).body.result.details.id;
		const ports = createSnoStationMemRemPorts({ database: fixture.database.runtime.db });
		const retained = fixture.store.getById(old.id);
		expect(retained).toBeDefined();
		expect((await ports.conflict.softClose({ rowId: old.id, successorId: alternative.id, plannedContentHash: retained?.contentHash ?? "",
			plannedSuccessorContentHash: alternative.contentHash, reason: "A stale plan predates the correction.", timestamp: new Date().toISOString() })).applied).toBe(false);
		expect((await ports.forget.moveLane({ rowId: old.id, plannedContentHash: retained?.contentHash ?? "", targetLane: "parked",
			reason: "A stale plan predates the correction.", timestamp: new Date().toISOString() })).applied).toBe(false);
		expect(metadata(old.id).superseded_by).toBe(nextId);
		expect(fixture.store.getById(nextId)?.lane).toBe("active");
	});

	it("reports a REM winner as already superseded and never inserts another row", async () => {
		const old = await seed();
		const winner = await seed("The release owner is Jordan.");
		const ports = createSnoStationMemRemPorts({ database: fixture.database.runtime.db });
		expect((await ports.conflict.softClose({ rowId: old.id, successorId: winner.id, plannedContentHash: old.contentHash,
			plannedSuccessorContentHash: winner.contentHash, reason: "A real REM close committed before correction.", timestamp: new Date().toISOString() })).applied).toBe(true);
		expect((await correct(old.id, "The release owner is Avery.")).body.result).toMatchObject({ isError: true, details: { errorCode: "already-superseded", successorId: winner.id } });
		expect(countRows()).toBe(2);
	});

	it("includes invalidated retirement history manually and removes it before automatic ranking and limit", async () => {
		const old = await atomic("The user prefers jasmine tea.");
		const nextId = (await correct(old.id, "The user prefers oolong tea.")).body.result.details.id;
		const manual = await fixture.post("/v1/get-recall", { scope: fixture.scope, query: "What tea does the user prefer?", options: { source: "manual", limit: 2, minScore: 0 } });
		expect(manual.body.contextText).toContain(`retired; superseded by ${nextId}`);
		expect(manual.body.contextText).toContain(old.id);
		expect(manual.body.contextText).toContain(nextId);
		const auto = await fixture.post("/v1/get-recall", { scope: fixture.scope, query: "What jasmine tea does the user prefer?", options: { source: "auto", injectionPhase: "prompt", limit: 1, minScore: 0, maxChars: 2000 } });
		expect(auto.body.contextText).toContain(` [id:${nextId}]`);
		expect(auto.body.contextText).not.toContain(old.id);
		expect(auto.body.contextText).not.toContain("jasmine tea");
		expect(auto.body.memoryIds).toEqual([nextId]);
	});

	it("marks only rendered ids served, preserves repeats on re-registration, and clears them on reset", async () => {
		const row = await seed("The release objective is ship the corrected memory flow.");
		const input = { scope: fixture.scope, query: "What is the release objective?", options: { source: "auto", injectionPhase: "prompt", limit: 1, minScore: 0, maxChars: 10 } };
		const tiny = await fixture.post("/v1/get-recall", input);
		expect(tiny.body.contextText).toBe("");
		expect(tiny.body.memoryIds).toEqual([]);
		input.options.maxChars = 2000;
		const full = await fixture.post("/v1/get-recall", input);
		expect(full.body.contextText).toContain(row.id);
		expect(full.body.memoryIds).toEqual([row.id]);
		await fixture.post("/v1/init", { scope: fixture.scope, registration: { skinId: "mem-update-test" } });
		expect((await fixture.post("/v1/get-recall", input)).body.contextText).toBe("");
		await fixture.post("/v1/on-session-end", { scope: { ...fixture.scope, host: { boundary: "reset" } }, messages: [] });
		expect((await fixture.post("/v1/get-recall", input)).body.contextText).toContain(row.id);
	});
});
