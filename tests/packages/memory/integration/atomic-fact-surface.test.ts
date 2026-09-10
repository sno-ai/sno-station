/** @file atomic-fact-surface.test.ts
 * @purpose Proves atomic write projection and the single active-lane fact surface.
 * @boundary Deterministic projection plus real encrypted SQLite readers and retrieval.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AtomicKeyedRecord } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-profile-keying";
import {
	type AtomicGauntletRecord,
	runAtomicExtractionGauntlet,
} from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-extraction-gauntlet";
import type { AtomicExtractionRecord } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-extraction-reply";
import {
	ATOMIC_MEMORY_WRITE_CONFIG,
	buildAtomicWriteCards,
} from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-write-projection";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client";
import {
	createRetriever,
	DEFAULT_RETRIEVAL_CONFIG,
} from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever";
import {
	ATOMIC_FACT_SURFACE_LANE,
	type AtomicExtractionLedgerKey,
	type AtomicExtractionRunParameters,
	MemoryStore,
} from "../../../../packages/sno-station-mem/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db";

const PROJECT_ID = "atomic-fact-surface";
const EXTRACTOR_VERSION = "atomic-v3-fact-surface-test";
const SESSION_TIMESTAMP_MS = Date.UTC(2026, 8, 3, 10, 15);
const SHARED_SEARCH_TERM = "surfaceanchor";
const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 2_000,
	subchunkCount: 1,
};

function enhancedRecord(
	name: string,
	overrides: Partial<AtomicKeyedRecord> = {},
): AtomicKeyedRecord {
	const quote = `${name} source evidence`;
	return {
		kind: overrides.category === "episodic" ? "occurrence" : "standing",
		category: "profile",
		claimText: `${SHARED_SEARCH_TERM} ${name} durable claim`,
		subject: "user",
		subjectKind: "user",
		attribute: `attribute.${name}`,
		value: `${name}-value`,
		temporalPhrase: null,
		resolvedTime: null,
		importance: "medium",
		changesCurrentState: false,
		todo: "none",
		closeReason: null,
		sourceSpan: { turnIndex: 0, quote, startOffset: 0, endOffset: quote.length },
		relations: [
			{ subject: "surface-node", predicate: "PREFERS", object: `object:${name}` },
		],
		singleClaim: true,
		lane: "active",
		dispositionReason: null,
		resplit: false,
		...overrides,
	};
}

function ledgerKey(suffix: string): AtomicExtractionLedgerKey {
	return {
		conversationId: `conversation-${suffix}`,
		chunkHash: `chunk-${suffix}`,
		pipelineVersion: EXTRACTOR_VERSION,
	};
}

async function writeRecords(
	store: MemoryStore,
	records: readonly AtomicKeyedRecord[],
	suffix: string,
) {
	const key = ledgerKey(suffix);
	expect(
		store.beginAtomicExtractionChunk({
			...key,
			rawChunk: `raw transcript for ${suffix}`,
			routingSnapshotId: "routing-snapshot-fact-surface",
			runParameters: RUN_PARAMETERS,
			nowMs: SESSION_TIMESTAMP_MS,
		}),
	).toMatchObject({ action: "run", entry: { state: "open" } });
	store.recordAtomicExtractionCalls(key, SESSION_TIMESTAMP_MS + 1);
	const cards = buildAtomicWriteCards({
		records,
		idempotencyKeys: records.map((_, index) => `${suffix}-${index}`),
		sourceTurnOffset: 0,
		sessionTimestampMs: SESSION_TIMESTAMP_MS,
		timezone: "UTC",
	});
	const result = await store.storeAtomicExtractionChunk({
		ledgerKey: key,
		projectId: PROJECT_ID,
		extractorVersion: EXTRACTOR_VERSION,
		nowMs: SESSION_TIMESTAMP_MS + 2,
		cards,
	});
	expect(result).toMatchObject({
		createdCount: records.length,
		suppressed: [],
		ledger: { state: "complete" },
	});
	return result.cardIds;
}

describe("atomic write projection", () => {
	it("maps committed importance, time pairs, and every stored diagnostic", async () => {
		const baseProvenance = [
			{
				claimText: "Base claim",
				sourceSpan: {
					turnIndex: 0,
					quote: "Base evidence",
					startOffset: 0,
					endOffset: 13,
				},
				relations: [{ subject: "user", predicate: "MENTIONS" as const, object: "base" }],
			},
		];
		const invalidProfileInput: AtomicExtractionRecord = {
			kind: "standing",
			category: "profile",
			claimText: "The user has an invalid model date.",
			subject: "user",
			subjectKind: "user",
			attribute: "identity.location",
			value: "Kyoto",
			temporalPhrase: null,
			resolvedTime: { year: 2023, month: 13, day: 1 },
			importance: "medium",
			changesCurrentState: false,
			todo: "none",
			closeReason: null,
			sourceSpan: { turnIndex: 0, quote: "The user has an invalid model date." },
			relations: [],
			singleClaim: true,
		};
		const [invalidProfile] = await runAtomicExtractionGauntlet({
			records: [invalidProfileInput],
			turns: [{ role: "user", content: invalidProfileInput.claimText }],
		});
		expect(invalidProfile).toMatchObject({
			kind: "standing",
			category: "profile",
			resolvedTime: null,
			resolvedTimeInvalid: true,
		});
		if (!invalidProfile) throw new Error("gauntlet returned no invalid profile record");

		const records = [
				enhancedRecord("instant", {
					category: "episodic",
					importance: "high",
					resolvedTime: { year: 2026, month: 9, day: 1, hour: 12, minute: 30 },
					keyingNote: "keying-failed",
				baseProvenance,
			}),
			enhancedRecord("day", {
				category: "episodic",
				importance: "medium",
				resolvedTime: { year: 2026, month: 9, day: 1 },
			}),
			enhancedRecord("profile-open", {
				importance: "low",
				resolvedTime: { year: 2026, month: 8, day: 15 },
			}),
			enhancedRecord("profile-session", { importance: "high" }),
			enhancedRecord("unresolved", {
				category: "episodic",
				importance: "low",
				temporalPhrase: "around harvest",
			}),
			invalidProfile,
		];

		const cards = buildAtomicWriteCards({
			records,
			idempotencyKeys: records.map((_, index) => `projection-${index}`),
			sourceTurnOffset: 0,
			sessionTimestampMs: SESSION_TIMESTAMP_MS,
			timezone: "UTC",
		});

		expect(ATOMIC_MEMORY_WRITE_CONFIG).toEqual({
			importance: { high: 0.9, medium: 0.7, low: 0.3 },
		});
		expect(cards.map(({ importance }) => importance)).toEqual([0.9, 0.7, 0.3, 0.9, 0.3, 0.7]);
		expect(cards[0]).toMatchObject({
			validFrom: Date.UTC(2026, 8, 1, 12, 30),
			validUntil: Date.UTC(2026, 8, 1, 12, 30) + 1,
		});
		expect(cards[1]).toMatchObject({
			validFrom: Date.UTC(2026, 8, 1),
			validUntil: Date.UTC(2026, 8, 2),
		});
		expect(cards[2]).toMatchObject({
			validFrom: Date.UTC(2026, 7, 15),
			validUntil: null,
		});
		expect(cards[3]).toMatchObject({
			validFrom: SESSION_TIMESTAMP_MS,
			validUntil: null,
		});
		expect(cards[4]).toMatchObject({ validFrom: null, validUntil: null });
		expect(cards[5]).toMatchObject({ validFrom: null, validUntil: null });

			expect(cards[0]?.metadata).toEqual({
				value: "instant-value",
				importance_label: "high",
				source_span: records[0]?.sourceSpan,
				keying_note: "keying-failed",
				base_provenance: baseProvenance,
				kind: "episodic",
				memory_category: "episodic",
				event_at: "2026-09-01T12:30:00.000Z",
				valid_from: Date.UTC(2026, 8, 1, 12, 30),
				valid_until: Date.UTC(2026, 8, 1, 12, 30) + 1,
			});
			expect(cards[0]?.metadata).not.toHaveProperty("temporal_override");
		expect(cards[2]?.metadata).toMatchObject({
			importance_label: "low",
			section_name: "attribute.profile-open",
		});
		// An unresolved phrase leaves the occurrence undated: no event_at, no valid window.
		expect(cards[4]?.metadata).toEqual({
			value: "unresolved-value",
			importance_label: "low",
			source_span: records[4]?.sourceSpan,
			temporal_phrase: "around harvest",
			kind: "episodic",
			memory_category: "episodic",
		});
		expect(cards[5]?.metadata).toMatchObject({ section_name: "identity.location" });
	});
});

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("atomic fact surface", () => {
	let fixture: TestDb;
	let store: MemoryStore;

	beforeEach(() => {
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	});

	afterEach(async () => {
		await store.close();
		fixture.cleanup();
	});

	it("stores every disposition and exposes only active unsuppressed facts", async () => {
		const assistantTurn = { role: "assistant" as const, content: "The user likes tea." };
		const assistantInput: AtomicExtractionRecord = {
			kind: "standing",
			category: "profile",
			claimText: `${SHARED_SEARCH_TERM} assistant evidence claim`,
			subject: "user",
			subjectKind: "user",
			attribute: "parked.subject-unverified",
			value: "tea",
			temporalPhrase: null,
			resolvedTime: null,
			importance: "medium",
			changesCurrentState: false,
			todo: "none",
			closeReason: null,
			sourceSpan: { turnIndex: 0, quote: assistantTurn.content },
			relations: [{ subject: "surface-node", predicate: "PREFERS", object: "object:unverified" }],
			singleClaim: true,
		};
		const [assistantDisposition] = await runAtomicExtractionGauntlet({
			records: [assistantInput],
			turns: [assistantTurn],
		});
		expect(assistantDisposition).toMatchObject({
			lane: "parked",
			dispositionReason: "subject-unverified",
			subject: null,
			attribute: null,
		});
		if (!assistantDisposition) throw new Error("gauntlet returned no assistant disposition");

		const records = [
			enhancedRecord("active-user", { attribute: "active.user" }),
			enhancedRecord("active-third-party", {
				subject: "entity:ada-lovelace",
				subjectKind: "named_entity",
				attribute: "active.third-party",
			}),
			enhancedRecord("compound", {
				attribute: "parked.compound",
				lane: "parked",
				dispositionReason: "compound",
				resplit: true,
			}),
			{
				...assistantDisposition,
				subject: "user",
				attribute: "parked.subject-unverified",
			} satisfies AtomicGauntletRecord,
			enhancedRecord("subject-rejected", {
				attribute: "parked.subject-rejected",
				lane: "parked",
				dispositionReason: "subject-rejected",
			}),
			enhancedRecord("key-suppression-target", { attribute: "suppressed.key" }),
			enhancedRecord("content-suppression-target", { attribute: "suppressed.content" }),
		] satisfies AtomicKeyedRecord[];
		const ids = await writeRecords(store, records, "fact-surface");
		expect(ids).toHaveLength(records.length);
		const idByName = new Map(records.map((record, index) => [record.attribute, ids[index]]));

		const storedRows = fixture.runtime.db
			.prepare(
				"SELECT id, lane, disposition_reason FROM nodix_memories WHERE project_id = ? ORDER BY id",
			)
			.all(PROJECT_ID) as Array<{ id: string; lane: string; disposition_reason: string | null }>;
		expect(storedRows).toHaveLength(records.length);
		expect(storedRows.filter(({ lane }) => lane === "parked").map(({ disposition_reason }) => disposition_reason).sort()).toEqual([
			"compound",
			"subject-rejected",
			"subject-unverified",
		]);
		expect(
			fixture.runtime.db
				.prepare(
					"SELECT COUNT(*) AS count FROM nodix_memory_relations WHERE source_card_id IN (SELECT id FROM nodix_memories WHERE project_id = ?)",
				)
				.get(PROJECT_ID),
		).toEqual({ count: records.length });

		const activeUserId = idByName.get("active.user");
		const thirdPartyId = idByName.get("active.third-party");
		const keyTargetId = idByName.get("suppressed.key");
		const contentTargetId = idByName.get("suppressed.content");
		if (!activeUserId || !thirdPartyId || !keyTargetId || !contentTargetId) {
			throw new Error("missing active fact-surface fixture id");
		}
		expect(store.getAtomicBySubjectAttribute(PROJECT_ID, "user", "active.user")?.id).toBe(
			activeUserId,
		);
		expect(
			store.getAtomicBySubjectAttribute(
				PROJECT_ID,
				"entity:ada-lovelace",
				"active.third-party",
			)?.id,
		).toBe(thirdPartyId);
		for (const reason of ["compound", "subject-unverified", "subject-rejected"] as const) {
			expect(
				store.getAtomicBySubjectAttribute(PROJECT_ID, "user", `parked.${reason}`),
			).toBeUndefined();
		}
		expect(ATOMIC_FACT_SURFACE_LANE).toBe("active");

		const retriever = createRetriever(store, embedder, undefined, {
			...DEFAULT_RETRIEVAL_CONFIG,
			rerank: "none",
			minScore: -1,
			hardMinScore: -1,
			candidatePoolSize: 20,
		});
		const beforeSuppression = await retriever.retrieve({
			query: SHARED_SEARCH_TERM,
			limit: 20,
			scopeFilter: [PROJECT_ID],
			source: "manual",
		});
		const beforeIds = new Set(beforeSuppression.map(({ entry }) => entry.id));
		for (const id of [activeUserId, thirdPartyId, keyTargetId, contentTargetId]) {
			expect(beforeIds.has(id)).toBe(true);
			expect(store.isMemoryOnFactSurface(id)).toBe(true);
		}
		for (const reason of ["compound", "subject-unverified", "subject-rejected"] as const) {
			const parkedId = idByName.get(`parked.${reason}`);
			if (!parkedId) throw new Error(`missing ${reason} fixture id`);
			expect(beforeIds.has(parkedId)).toBe(false);
			expect(store.isMemoryOnFactSurface(parkedId)).toBe(false);
		}

		await store.createMemorySuppression({
			projectId: PROJECT_ID,
			subject: "user",
			attribute: "suppressed.key",
			nowMs: SESSION_TIMESTAMP_MS + 10,
		});
		await store.createMemorySuppression({
			projectId: PROJECT_ID,
			content: records[6]?.claimText ?? "missing content target",
			nowMs: SESSION_TIMESTAMP_MS + 11,
		});
		expect(store.isMemoryOnFactSurface(keyTargetId)).toBe(false);
		expect(store.isMemoryOnFactSurface(contentTargetId)).toBe(false);
		expect(
			store.getAtomicBySubjectAttribute(PROJECT_ID, "user", "suppressed.key"),
		).toBeUndefined();
		expect(
			store.getAtomicBySubjectAttribute(PROJECT_ID, "user", "suppressed.content"),
		).toBeUndefined();

		const visibleRelations = store.walkMemoryRelations({
			projectId: PROJECT_ID,
			node: "surface-node",
			direction: "outgoing",
		});
		expect(new Set(visibleRelations.map(({ sourceCardId }) => sourceCardId))).toEqual(
			new Set([activeUserId, thirdPartyId]),
		);
		const afterSuppression = await retriever.retrieve({
			query: SHARED_SEARCH_TERM,
			limit: 20,
			scopeFilter: [PROJECT_ID],
			source: "manual",
		});
		expect(new Set(afterSuppression.map(({ entry }) => entry.id))).toEqual(
			new Set([activeUserId, thirdPartyId]),
		);

		const parkedAuditRows = await store.list({ projectId: PROJECT_ID, lane: "parked", limit: 20 });
		expect(new Set(parkedAuditRows.map(({ id }) => id))).toEqual(
			new Set(
				["parked.compound", "parked.subject-unverified", "parked.subject-rejected"].map(
					(attribute) => idByName.get(attribute),
				),
			),
		);
	});
});
