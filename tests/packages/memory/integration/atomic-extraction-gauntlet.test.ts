/** @file atomic-extraction-gauntlet.test.ts
 * @purpose Proves atomic extraction post-processing and parked-row exclusion.
 * @boundary Deterministic gauntlet, one stubbed re-split call, and real MemoryStore consumers.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "@/extraction/embedding-provider-client";
import {
	type AtomicGauntletRecord,
	type AtomicResplitTransport,
	runAtomicExtractionGauntlet,
} from "@/extraction/atomic-extraction-gauntlet";
import type {
	AtomicExtractionRecord,
	AtomicExtractionTurn,
} from "@/extraction/atomic-extraction-reply";
import { MemoryStore } from "@/storage/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db";

const TURNS: AtomicExtractionTurn[] = [
	{
		role: "user",
		content:
			"I moved to Kyoto. My favorite dish is curry and my favorite music is jazz. I like tea. Later I like tea.",
	},
	{ role: "assistant", content: "Assistant-only evidence." },
];

function record(overrides: Partial<AtomicExtractionRecord> = {}): AtomicExtractionRecord {
	return {
		kind: "standing",
		category: "profile",
		claimText: "The user chooses tea.",
		subject: "user",
		subjectKind: "user",
		attribute: "preference.food",
		value: "tea",
		temporalPhrase: null,
		resolvedTime: null,
		importance: "medium",
		changesCurrentState: false,
		todo: "none",
		closeReason: null,
		sourceSpan: { turnIndex: 0, quote: "I like tea." },
		relations: [],
		singleClaim: true,
		...overrides,
	};
}

type ResplitInput = Parameters<AtomicResplitTransport["resplit"]>[0];

class ScriptedResplitTransport implements AtomicResplitTransport {
	readonly calls: ResplitInput[] = [];

	constructor(private readonly outcome: AtomicExtractionRecord[] | null | Error) {}

	async resplit(input: ResplitInput): Promise<AtomicExtractionRecord[] | null> {
		this.calls.push(input);
		if (this.outcome instanceof Error) throw this.outcome;
		return this.outcome;
	}
}

function expectCompound(item: AtomicGauntletRecord, failure?: string): void {
	expect(item).toMatchObject({
		lane: "parked",
		dispositionReason: "compound",
		subject: null,
		attribute: null,
		resplit: true,
		...(failure === undefined ? {} : { resplitFailure: failure }),
	});
}

describe("atomic extraction gauntlet", () => {
	it("batches both compound signals into one re-split and re-runs its outputs", async () => {
		const singleClaimFalse = record({
			claimText: "The user moved twice and changed jobs.",
			value: "moved twice and changed jobs",
			sourceSpan: { turnIndex: 0, quote: "I moved to Kyoto." },
			singleClaim: false,
		});
		const twoDictionaryKeys = record({
			claimText: "The user's favorite dish and favorite music changed.",
			value: "curry and jazz",
			sourceSpan: {
				turnIndex: 0,
				quote: "My favorite dish is curry and my favorite music is jazz.",
			},
		});
		const atomicOutput = record({
			claimText: "The user moved to Kyoto.",
			value: "Kyoto",
			attribute: "identity.location",
			sourceSpan: { turnIndex: 0, quote: "I moved to Kyoto." },
			relations: [{ subject: "user", predicate: "UNAPPROVED_EDGE", object: "Kyoto" }],
		});
		const stillCompound = record({
			claimText: "The user still has two independently mutable claims.",
			value: "two claims",
			sourceSpan: { turnIndex: 0, quote: "I moved to Kyoto." },
			singleClaim: false,
		});
		const transport = new ScriptedResplitTransport([atomicOutput, stillCompound]);

		const output = await runAtomicExtractionGauntlet({
			records: [singleClaimFalse, twoDictionaryKeys],
			turns: TURNS,
			resplitTransport: transport,
		});

		expect(transport.calls).toHaveLength(1);
		expect(transport.calls[0]?.records).toEqual([singleClaimFalse, twoDictionaryKeys]);
		expect(output).toHaveLength(2);
		expect(output[0]).toMatchObject({
			claimText: atomicOutput.claimText,
			lane: "active",
			dispositionReason: null,
			resplit: true,
			relations: [{ predicate: "MENTIONS" }],
		});
		expectCompound(output[1] as AtomicGauntletRecord);
		expect(transport.calls).toHaveLength(1);
	});

	it("never calls re-split again for an already re-split compound", async () => {
		const transport = new ScriptedResplitTransport(new Error("must not be called"));
		const output = await runAtomicExtractionGauntlet({
			records: [record({ singleClaim: false })],
			turns: TURNS,
			resplit: true,
			resplitTransport: transport,
		});

		expect(transport.calls).toHaveLength(0);
		expect(output).toHaveLength(1);
		expectCompound(output[0] as AtomicGauntletRecord);
	});

	it("keeps every suspect compound when re-split is unavailable, throws, or is empty", async () => {
		const suspects = [
			record({ claimText: "Compound one.", singleClaim: false }),
			record({ claimText: "Compound two.", singleClaim: false }),
		];
		const cases: Array<{
			outcome: AtomicExtractionRecord[] | null | Error;
			failure: string;
		}> = [
			{ outcome: null, failure: "resplit-unavailable" },
			{ outcome: new Error("re-split transport failed"), failure: "re-split transport failed" },
			{ outcome: [], failure: "resplit-empty" },
		];

		for (const { outcome, failure } of cases) {
			const transport = new ScriptedResplitTransport(outcome);
			const output = await runAtomicExtractionGauntlet({
				records: suspects,
				turns: TURNS,
				resplitTransport: transport,
			});
			expect(transport.calls).toHaveLength(1);
			expect(output).toHaveLength(suspects.length);
			for (const kept of output) expectCompound(kept, failure);
		}
	});

	it("applies attribution, first exact quote offsets, episodic retention, and relation fallback", async () => {
		const exact = record({
			claimText: "The user chooses tea.",
			relations: [{ subject: "user", predicate: "UNKNOWN_RELATION", object: "tea" }],
		});
		const assistantProfile = record({
			claimText: "The assistant claims a preference.",
			sourceSpan: { turnIndex: 1, quote: "Assistant-only evidence." },
		});
		const missingProfile = record({
			claimText: "The profile quote is missing.",
			sourceSpan: { turnIndex: 0, quote: "This quote is absent." },
		});
		const missingEpisodic = record({
			kind: "occurrence",
			category: "episodic",
			claimText: "An event quote is missing.",
			attribute: null,
			sourceSpan: { turnIndex: 0, quote: "This event quote is absent." },
		});

		const output = await runAtomicExtractionGauntlet({
			records: [exact, assistantProfile, missingProfile, missingEpisodic],
			turns: TURNS,
		});
		const byText = new Map(output.map((item) => [item.claimText, item]));
		const firstOffset = TURNS[0]?.content.indexOf("I like tea.") ?? -1;
		expect(firstOffset).toBeGreaterThanOrEqual(0);
		expect(byText.get(exact.claimText)).toMatchObject({
			lane: "active",
			dispositionReason: null,
			subject: "user",
			attribute: "preference.food",
			sourceSpan: {
				turnIndex: 0,
				quote: "I like tea.",
				startOffset: firstOffset,
				endOffset: firstOffset + "I like tea.".length,
			},
			relations: [{ predicate: "MENTIONS" }],
		});
		expect(byText.get(assistantProfile.claimText)).toMatchObject({
			lane: "parked",
			dispositionReason: "subject-unverified",
			subject: null,
			attribute: null,
		});
		expect(byText.get(missingProfile.claimText)).toMatchObject({
			lane: "parked",
			dispositionReason: "subject-unverified",
			subject: null,
			attribute: null,
			sourceSpan: null,
		});
		expect(byText.get(missingEpisodic.claimText)).toMatchObject({
			lane: "active",
			dispositionReason: null,
			subject: null,
			attribute: null,
			sourceSpan: null,
		});
	});
});

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("parked fact-surface exclusion", () => {
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

	it("hides all three parked reasons from key, relation, and automatic retrieval consumers", async () => {
		const projectId = "gauntlet-fact-surface";
		const seeds = [
			{
				name: "active",
				section: "preferences.active",
				lane: "active",
				reason: null,
				marker: "gauntletactiveonly",
			},
			{
				name: "compound",
				section: "preferences.compound",
				lane: "parked",
				reason: "compound",
				marker: "gauntletcompoundonly",
			},
			{
				name: "subject-unverified",
				section: "preferences.subject_unverified",
				lane: "parked",
				reason: "subject-unverified",
				marker: "gauntletunverifiedonly",
			},
			{
				name: "subject-rejected",
				section: "preferences.subject_rejected",
				lane: "parked",
				reason: "subject-rejected",
				marker: "gauntletrejectedonly",
			},
		] as const;
		const ids = new Map<string, string>();
		for (const seed of seeds) {
			const stored = await store.store({
				text: `${seed.marker} durable memory`,
				category: "profile",
				projectId,
				metadata: JSON.stringify({ section_name: seed.section }),
				trusted: true,
			});
			ids.set(seed.name, stored.id);
			if (seed.lane === "parked") {
				fixture.runtime.db
					.prepare(
						"UPDATE nodix_memories SET lane = 'parked', disposition_reason = ? WHERE id = ?",
					)
					.run(seed.reason, stored.id);
			}
			fixture.runtime.db
				.prepare(`
					INSERT INTO nodix_memory_relations(
						source_card_id, subject, predicate, object, created_at
					) VALUES (?, 'agent', 'WORKS_ON', ?, 1)
				`)
				.run(stored.id, `object:${seed.name}`);
		}
		const activeId = ids.get("active");
		if (!activeId) throw new Error("active seed id missing");
		const expectOnlyActive = (visibleIds: string[]): void => {
			expect([...visibleIds].sort()).toEqual([activeId]);
		};

		const keyedIds = seeds.flatMap((seed) => {
			const found = store.getByFactKey(projectId, `profile:${seed.section}`);
			return found ? [found.id] : [];
		});
		expectOnlyActive(keyedIds);

		const relationIds = store
			.walkMemoryRelations({ projectId, node: "agent", direction: "outgoing" })
			.map(({ sourceCardId }) => sourceCardId);
		expectOnlyActive(relationIds);

		const automaticIds: string[] = [];
		for (const seed of seeds) {
			const results = await store.searchKeyword(seed.marker, {
				projectIdFilter: [projectId],
				limit: 10,
			});
			automaticIds.push(...results.map(({ entry }) => entry.id));
		}
		expectOnlyActive(automaticIds);

		const plantedKeyIds = fixture.runtime.db
			.prepare(`
				SELECT id FROM nodix_memories
				WHERE project_id = ? AND json_extract(metadata, '$.fact_key') LIKE 'profile:%'
				ORDER BY id
			`)
			.all(projectId)
			.map((row) => (row as { id: string }).id);
		const plantedRelationIds = fixture.runtime.db
			.prepare(`
				SELECT source.id
				FROM nodix_memory_relations relation
				JOIN nodix_memories source ON source.id = relation.source_card_id
				WHERE source.project_id = ? AND relation.subject = 'agent'
				ORDER BY source.id
			`)
			.all(projectId)
			.map((row) => (row as { id: string }).id);
		const plantedAutomaticIds = seeds.flatMap((seed) =>
			fixture.runtime.db
				.prepare(`
					SELECT memory.id
					FROM nodix_memory_chunks_fts fts
					JOIN nodix_memory_chunks chunk ON chunk.rowid = fts.rowid
					JOIN nodix_memories memory ON memory.id = chunk.memory_id
					WHERE nodix_memory_chunks_fts MATCH ? AND memory.project_id = ?
					ORDER BY memory.id
				`)
				.all(seed.marker, projectId)
				.map((row) => (row as { id: string }).id),
		);
		for (const plantedIds of [plantedKeyIds, plantedRelationIds, plantedAutomaticIds]) {
			expect(() => expectOnlyActive(plantedIds)).toThrow();
		}
	});
});
