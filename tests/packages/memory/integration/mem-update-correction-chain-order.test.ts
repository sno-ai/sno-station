/** Persisted correction -> ordinary replacement -> delayed assertion, using real atomic writes. */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { compareMemorySourceOrder, readMemorySourceOrder } from "../../../../packages/memory/src/store/memory-source-order";
import type { AtomicExtractionWriteCard } from "../../../../packages/memory/src/store/store";
import { createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db";
import { createMemUpdateFixture } from "../fixtures/mem-update-fixture";

const DAY = 86_400_000;
let embedder: Embedder;
let fixture: Awaited<ReturnType<typeof createMemUpdateFixture>>;
beforeAll(async () => { embedder = await createTestEmbedder(); });
beforeEach(async () => { fixture = await createMemUpdateFixture(embedder); });
afterEach(async () => { await fixture?.close(); });

async function assertion(text: string, subject: string, sessionMoment: number, eventMoment: number,
	overrides: Partial<AtomicExtractionWriteCard> = {}) {
	const ledgerKey = { conversationId: randomUUID(), chunkHash: randomUUID(), pipelineVersion: "mem-update-chain-order" };
	fixture.store.beginAtomicExtractionChunk({ ...ledgerKey, rawChunk: text,
		routingSnapshotId: "mem-update-chain-order", nowMs: sessionMoment,
		runParameters: { maxInputTokens: 4096, outputTokenBudget: 2000, subchunkCount: 1 } });
	fixture.store.recordAtomicExtractionCalls(ledgerKey, sessionMoment);
	const card: AtomicExtractionWriteCard = { idempotencyKey: randomUUID(), globalTurnIndex: 0,
		text, category: "state", subject, attribute: "project.lead", timestamp: sessionMoment,
		validFrom: eventMoment, validUntil: null, endsCurrent: false, endedAt: null, importance: 0.9,
		timezone: "America/Los_Angeles", lane: "active", dispositionReason: null,
		rawCandidateJson: null, relations: [], metadata: { topic: "project.lead", fact_key: "state:project.lead" }, ...overrides };
	const stored = await fixture.store.storeAtomicExtractionChunk({ ledgerKey, projectId: fixture.scope.project,
		extractorVersion: "mem-update-chain-order", nowMs: sessionMoment, cards: [card] });
	const id = stored.cardIds[0];
	if (!id) throw new Error(`atomic assertion was not written: ${JSON.stringify(stored)}`);
	return id;
}

function row(id: string) {
	const entry = fixture.store.getById(id);
	if (!entry) throw new Error(`chain-order row not found: ${id}`);
	return entry;
}
function metadata(id: string): Record<string, unknown> { return JSON.parse(row(id).metadata); }
async function currentIds(subject: string) {
	const entries = await fixture.store.list({ projectId: fixture.scope.project, category: "state", limit: 20 });
	return entries.filter(entry => {
		const address = fixture.database.sqlite.prepare("SELECT subject FROM nodix_memories WHERE id = ?")
			.get(entry.id) as { subject: string };
		return address.subject === subject && !metadata(entry.id).superseded_by;
	}).map(entry => entry.id).sort();
}

describe("correction order survives ordinary descendants", () => {
	it("keeps a newer ordinary descendant current when an older assertion replays with a later event", async () => {
		const subject = "entity:orion-chain-project";
		// The target is independent of the delayed assertion and dated well before correction.
		const early = Date.UTC(2000, 0, 1);
		const target = await assertion("Dana is the Orion Research Project lead.", subject, early, early);
		const response = await fixture.post("/v1/mutate", { scope: fixture.scope,
			op: { op: "correct", id: target, content: "Jordan is the Orion Research Project lead." } });
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({ degraded: false, result: { isError: false } });
		const corrected = response.body.result.details.id;
		const correctionOrder = readMemorySourceOrder(row(corrected).metadata);
		const correctionMoment = row(corrected).timestamp;
		expect(correctionOrder.correction).toBe(true);
		expect(correctionOrder.session_moment).toBe(correctionMoment);
		expect(metadata(target).superseded_by).toBe(corrected);
		expect(await currentIds(subject)).toEqual([corrected]);

		const later = await assertion("Morgan is the Orion Research Project lead.", subject,
			correctionMoment + 1000, correctionMoment + DAY);
		// A no-op atomic writer cannot pass: the later assertion must actually close correction.
		expect(metadata(corrected).superseded_by).toBe(later);
		expect(metadata(later).superseded_by).toBeUndefined();
		expect(await currentIds(subject)).toEqual([later]);

		const delayed = await assertion("Dana will lead the Orion Research Project at the upcoming event.", subject,
			correctionMoment - 1000, correctionMoment + 2 * DAY);
		const laterOrder = readMemorySourceOrder(row(later).metadata);
		const delayedOrder = readMemorySourceOrder(row(delayed).metadata);
		process.stderr.write(`${JSON.stringify({ correctionChainOrder: {
			target, corrected, later, delayed, correctionMoment,
			comparisons: { delayedToCorrection: compareMemorySourceOrder(delayedOrder, correctionOrder),
				correctionToLater: compareMemorySourceOrder(correctionOrder, laterOrder),
				laterToDelayed: compareMemorySourceOrder(laterOrder, delayedOrder) },
			rows: [target, corrected, later, delayed].map(id => ({ id, text: row(id).text,
				order: readMemorySourceOrder(row(id).metadata), supersededBy: metadata(id).superseded_by ?? null })),
			current: await currentIds(subject),
		} })}\n`);
		expect(metadata(target).superseded_by).toBe(corrected);
		expect(metadata(corrected).superseded_by).toBe(later);
		expect(metadata(later).superseded_by).toBeUndefined();
		expect(metadata(delayed).superseded_by).toBe(later);
		expect(await currentIds(subject)).toEqual([later]);
	});

	it("accepts a post-correction assertion whose event began before correction", async () => {
		const subject = "entity:harbor-current-state-project";
		const early = Date.UTC(2000, 0, 1);
		const target = await assertion("Dana is the Harbor Research Project lead.", subject, early, early);
		const response = await fixture.post("/v1/mutate", { scope: fixture.scope,
			op: { op: "correct", id: target, content: "Jordan is the Harbor Research Project lead." } });
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({ degraded: false, result: { isError: false } });
		const corrected = response.body.result.details.id;
		const correctionMoment = row(corrected).timestamp;
		expect(await currentIds(subject)).toEqual([corrected]);
		const ordinary = await assertion("Morgan is now the Harbor Research Project lead.", subject,
			correctionMoment + 1000, correctionMoment - DAY);
		process.stderr.write(`${JSON.stringify({ postCorrectionEarlierEvent: {
			target, corrected, ordinary, correctionMoment,
			rows: [target, corrected, ordinary].map(id => ({ id, text: row(id).text,
				order: readMemorySourceOrder(row(id).metadata), supersededBy: metadata(id).superseded_by ?? null })),
			current: await currentIds(subject),
		} })}\n`);
		expect(metadata(target).superseded_by).toBe(corrected);
		expect(metadata(corrected).superseded_by).toBe(ordinary);
		expect(metadata(ordinary).superseded_by).toBeUndefined();
		expect(await currentIds(subject)).toEqual([ordinary]);
	});

	it("still orders ordinary assertions by event date before their session time", async () => {
		const subject = "entity:cedar-ordinary-project";
		const first = await assertion("Alex is the Cedar Research Project lead.", subject,
			Date.UTC(2000, 0, 30), Date.UTC(2000, 0, 20));
		const laterEvent = await assertion("Taylor is the Cedar Research Project lead.", subject,
			Date.UTC(2000, 0, 10), Date.UTC(2000, 0, 21));
		expect(metadata(first).superseded_by).toBe(laterEvent);
		expect(await currentIds(subject)).toEqual([laterEvent]);
		const olderEvent = await assertion("Alex formerly led the Cedar Research Project.", subject,
			Date.UTC(2000, 1, 1), Date.UTC(2000, 0, 19));
		expect(metadata(olderEvent).superseded_by).toBe(laterEvent);
		expect(metadata(laterEvent).superseded_by).toBeUndefined();
		expect(await currentIds(subject)).toEqual([laterEvent]);
	});

	it("keeps an independent pre-correction fact open under a many-valued attribute", async () => {
		const subject = "entity:harbor-deliverables-project";
		const early = Date.UTC(2000, 0, 1);
		// project.deliverable is explicitly cardinality many in the shipped state vocabulary.
		const target = await assertion("The Harbor project will deliver a quarterly operations report.", subject,
			early, early, { attribute: "project.deliverable",
				metadata: { topic: "project.deliverable", fact_key: "state:project.deliverable:report" } });
		const response = await fixture.post("/v1/mutate", { scope: fixture.scope,
			op: { op: "correct", id: target, content: "The Harbor project will deliver an annual operations report." } });
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({ degraded: false, result: { isError: false } });
		const corrected = response.body.result.details.id;
		const correctionMoment = row(corrected).timestamp;
		expect(metadata(target).superseded_by).toBe(corrected);
		expect(metadata(corrected).fact_key).toBe("state:project.deliverable:report");
		expect(await currentIds(subject)).toEqual([corrected]);

		const independent = await assertion("The Harbor project will also deliver a public documentation website.", subject,
			correctionMoment - 1000, correctionMoment - DAY, { attribute: "project.deliverable",
				metadata: { topic: "project.deliverable", fact_key: "state:project.deliverable:website" } });
		process.stderr.write(`${JSON.stringify({ independentManyValuedFact: {
			target, corrected, independent, correctionMoment,
			rows: [target, corrected, independent].map(id => ({ id, text: row(id).text,
				factKey: metadata(id).fact_key, order: readMemorySourceOrder(row(id).metadata),
				supersededBy: metadata(id).superseded_by ?? null })), current: await currentIds(subject),
		} })}\n`);
		expect(metadata(target).superseded_by).toBe(corrected);
		expect(metadata(corrected).superseded_by).toBeUndefined();
		expect(metadata(independent).superseded_by).toBeUndefined();
		expect(await currentIds(subject)).toEqual([corrected, independent].sort());
	});
});
