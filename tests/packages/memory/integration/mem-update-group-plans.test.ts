/** Real group-maintenance plans interleaved with correction commits; only model replies wait. */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { runGroupCrudMaintenancePass } from "../../../../packages/memory/src/engine/maintenance/group-crud-maintenance";
import type { AtomicExtractionWriteCard } from "../../../../packages/memory/src/store/store";
import { createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db";
import { createMemUpdateFixture } from "../fixtures/mem-update-fixture";

const MODEL_ENDPOINT = "http://localhost:8070/codex/v1/responses";
let embedder: Embedder;
let fixture: Awaited<ReturnType<typeof createMemUpdateFixture>>;
beforeAll(async () => { embedder = await createTestEmbedder(); });
beforeEach(async () => { fixture = await createMemUpdateFixture(embedder); });
afterEach(async () => { await fixture?.close(); });

async function judgement(instructions: string, input: unknown): Promise<unknown> {
	const response = await fetch(MODEL_ENDPOINT, {
		method: "POST", headers: { "content-type": "application/json", authorization: "Bearer ccproxy-test" },
		body: JSON.stringify({ model: "gpt-6-sol", instructions, input: [{ role: "user", content: JSON.stringify(input) }],
			reasoning: { effort: "low" }, max_output_tokens: 1024 }),
	});
	const body = await response.json() as { model: string; error?: unknown;
		output: Array<{ content?: Array<{ type: string; text?: string }> }> };
	if (!response.ok) throw new Error(`ccproxy HTTP ${response.status}: ${JSON.stringify(body.error)}`);
	const text = body.output.flatMap(item => item.content ?? []).filter(item => item.type === "output_text")
		.map(item => item.text ?? "").join("\n").replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim();
	process.stderr.write(`${JSON.stringify({ maintenanceJudgement: { endpoint: MODEL_ENDPOINT, requestedModel: "gpt-6-sol", actualModel: body.model } })}\n`);
	return JSON.parse(text);
}

async function state(text: string, subject: string, projectId = fixture.scope.project,
	identitySettled = false) {
	const now = Date.now() - 60_000;
	const ledgerKey = { conversationId: randomUUID(), chunkHash: randomUUID(), pipelineVersion: "mem-update-group-test" };
	fixture.store.beginAtomicExtractionChunk({ ...ledgerKey, rawChunk: text,
		routingSnapshotId: "mem-update-group-test",
		runParameters: { maxInputTokens: 4096, outputTokenBudget: 2000, subchunkCount: 1 }, nowMs: now });
	fixture.store.recordAtomicExtractionCalls(ledgerKey, now);
	const card: AtomicExtractionWriteCard = { idempotencyKey: randomUUID(), globalTurnIndex: 0,
		text, category: "state", subject, attribute: "project.lead", timestamp: now,
		validFrom: now, validUntil: null, endsCurrent: false, endedAt: null, importance: 0.9,
		timezone: "America/Los_Angeles", lane: "active", dispositionReason: null,
		rawCandidateJson: null, relations: [], metadata: { topic: "project.lead",
			fact_key: "state:project.lead", ...(identitySettled ? { group_crud_maintenance_identity: "new" } : {}) } };
	const result = await fixture.store.storeAtomicExtractionChunk({ ledgerKey, projectId,
		extractorVersion: "mem-update-group-test", nowMs: now, cards: [card] });
	const id = result.cardIds[0];
	if (!id) throw new Error("group test fixture did not persist its state card");
	return id;
}

function row(id: string) {
	const entry = fixture.store.getById(id);
	if (!entry) throw new Error(`group test row missing: ${id}`);
	return entry;
}
function metadata(id: string): Record<string, unknown> { return JSON.parse(row(id).metadata); }
function address(id: string) {
	return fixture.database.sqlite.prepare("SELECT subject, attribute, lane FROM nodix_memories WHERE id = ?")
		.get(id) as { subject: string; attribute: string | null; lane: string };
}

function ageMissingKey(id: string) {
	const value = metadata(id);
	delete value.topic;
	delete value.attribute;
	delete value.section_name;
	fixture.database.sqlite.prepare("UPDATE nodix_memories SET attribute = NULL, metadata = ? WHERE id = ?")
		.run(JSON.stringify(value), id);
}

async function correct(id: string, content: string) {
	const result = await fixture.store.correct({ id, content, projectIdFilter: [fixture.scope.project],
		session: fixture.scope.session });
	expect(result.corrected).toBe(true);
	if (!result.corrected) throw new Error(`group test correction failed: ${JSON.stringify(result)}`);
	return result.id;
}

describe("correction wins against stale group maintenance plans", () => {
	it("preserves correction lineage when a previously planned keying reply returns", async () => {
		const oldText = "Dana is the lead organizer of the Orion Research Project.";
		const nextText = "Jordan is the lead organizer of the Orion Research Project.";
		const oldId = await state(oldText, "entity:orion-project");
		const controlId = await state("Alex is the lead organizer of the Cedar Research Project.", "entity:cedar-project");
		ageMissingKey(oldId);
		ageMissingKey(controlId);
		const planned = Promise.withResolvers<string>();
		const release = Promise.withResolvers<void>();
		let held = false;
		const maintenance = runGroupCrudMaintenancePass({ database: fixture.database.sqlite,
			stateKeying: { async respond(input) {
				const answer = z.object({ attribute: z.string().nullable() }).parse(await judgement(
					"Choose the canonical state attribute for this claim from offeredSlugs. Return only JSON {\"attribute\": \"offered slug\"}, or null as the value if none fits.", input));
				if (!held && input.text === oldText) {
					held = true;
					planned.resolve(answer.attribute ?? "none");
					await release.promise;
				}
				return answer.attribute;
			} } });
		try {
			expect(await Promise.race([planned.promise, maintenance.then(() => "no keying plan")]),
				"Real model classification must select project.lead before the correction interleave starts").toBe("project.lead");
			const successor = await correct(oldId, nextText);
			const closedMetadata = row(oldId).metadata;
			release.resolve();
			await maintenance;
			expect(row(oldId).metadata).toBe(closedMetadata);
			expect(address(oldId).attribute).toBeNull();
			expect(metadata(oldId).superseded_by).toBe(successor);
			expect(row(successor)).toMatchObject({ text: nextText, projectId: fixture.scope.project });
			expect(address(successor)).toMatchObject({ subject: "entity:orion-project", lane: "active" });
			expect(metadata(successor)).toMatchObject({ fact_key: "state:project.lead", l0_abstract: nextText });
			expect(metadata(successor).superseded_by).toBeUndefined();
			// A normal keying decision must still change its independently prepared current row.
			expect(address(controlId).attribute).toBe("project.lead");
			expect(metadata(controlId).topic).toBe("project.lead");
		} finally { release.resolve(); await maintenance; }
	}, 180_000);

	it("refuses a stale entity merge snapshot and still applies an unchanged control merge", async () => {
		const source = "entity:orion-shorthand", target = "entity:orion-canonical";
		const controlProject = "agent:mem-update-control";
		const controlSource = "entity:cedar-shorthand", controlTarget = "entity:cedar-canonical";
		const oldId = await state("Dana is the lead organizer of the Orion Research Project.", source);
		await state("The Orion Research Project lead office is in Seattle.", target, fixture.scope.project, true);
		const controlId = await state("Alex leads the Cedar Research Project.", controlSource, controlProject);
		await state("The Cedar Research Project lead office is in Portland.", controlTarget, controlProject, true);
		const insertEntity = fixture.database.sqlite.prepare(`INSERT INTO nodix_memory_entities
			(project_id, entity_id, display_name, normalized_name, created_at) VALUES (?, ?, ?, ?, ?)`);
		for (const [project, id, name, created] of [
			[fixture.scope.project, source, "the Orion Research Project", 1],
			[fixture.scope.project, target, "Orion Research Project", 2],
			[controlProject, controlSource, "the Cedar Research Project", 1],
			[controlProject, controlTarget, "Cedar Research Project", 2],
		] as const) insertEntity.run(project, id, name, name.toLowerCase(), created);
		const planned = Promise.withResolvers<string>();
		const release = Promise.withResolvers<void>();
		let held = false;
		const maintenance = runGroupCrudMaintenancePass({ database: fixture.database.sqlite,
			identityJudgement: { async respond(input) {
				const answer = z.discriminatedUnion("decision", [
					z.object({ decision: z.literal("existing"), entityId: z.string() }),
					z.object({ decision: z.literal("new") }), z.object({ decision: z.literal("undecided") }),
				]).parse(await judgement("Decide whether displayName is a name for one of existingDisplayNames. Return only JSON {\"decision\":\"existing\",\"entityId\":\"offered id\"} for the same entity, {\"decision\":\"new\"} for a distinct entity, or {\"decision\":\"undecided\"} when uncertain.", input));
				if (!held && input.displayName === "the Orion Research Project") {
					held = true;
					planned.resolve(answer.decision === "existing" ? answer.entityId : answer.decision);
					await release.promise;
				}
				return answer;
			} } });
		try {
			expect(await Promise.race([planned.promise, maintenance.then(() => "no entity merge plan")]),
				"Real model classification must select the target entity before the correction interleave starts").toBe(target);
			const nextText = "Jordan is the lead organizer of the Orion Research Project.";
			const successor = await correct(oldId, nextText);
			const closedMetadata = row(oldId).metadata;
			const successorMetadata = row(successor).metadata;
			release.resolve();
			await maintenance;
			expect(row(oldId).metadata).toBe(closedMetadata);
			expect(row(successor).metadata).toBe(successorMetadata);
			expect(metadata(oldId).superseded_by).toBe(successor);
			expect(address(oldId).subject).toBe(source);
			expect(address(successor)).toMatchObject({ subject: source, attribute: "project.lead", lane: "active" });
			expect(row(successor).text).toBe(nextText);
			expect(metadata(successor).superseded_by).toBeUndefined();
			expect(metadata(successor).merge_id).toBeUndefined();
			expect(address(controlId).subject).toBe(controlTarget);
			expect(metadata(controlId).merge_id).toEqual(expect.any(String));
			expect(fixture.database.sqlite.prepare("SELECT entity_id AS entityId FROM nodix_memory_entities WHERE project_id = ? AND normalized_name = ?")
				.get(fixture.scope.project, "the orion research project")).toEqual({ entityId: source });
			expect(fixture.database.sqlite.prepare("SELECT entity_id AS entityId FROM nodix_memory_entities WHERE project_id = ? AND normalized_name = ?")
				.get(controlProject, "the cedar research project")).toEqual({ entityId: controlTarget });
		} finally { release.resolve(); await maintenance; }
	}, 180_000);
});
