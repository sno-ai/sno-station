/** @file group-crud-arrival-retirement-scoring.test.ts
 * @purpose The arrival retirement candidate set is scored over each candidate's OWN chunk vectors,
 *          so rows of OTHER subjects — however similar to the nominated text — never crowd the real
 *          candidates out of their scores and off the wrong side of the cap.
 * @boundary `readAtomicArrivalRetirementCandidateSet` over a real encrypted SQLite store filled by
 *           the real atomic write (real chunks, real embeddings). The model is not involved; this
 *           reads what the engine would HAND the judge.
 *
 * The defect: the ranking scored the candidates with a whole-project semantic search
 * (`limit = candidates.length`). A project holding same-category rows under other subjects that are
 * closer to the nominated text fills every KNN slot, the real candidates score nothing, and the
 * cap then keeps a set decided by nothing but row id. Here the crowding rows are IDENTICAL to the
 * nominated text — the strongest possible distractor — and the candidate ranking must be unmoved.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { AtomicKeyedRecord } from "@/extraction/atomic-profile-keying";
import { buildAtomicWriteCards } from "@/extraction/atomic-write-projection";
import type { Embedder } from "@/extraction/embedding-provider-client";
import { readAtomicArrivalRetirementCandidateSet } from "@/storage/memory-store-atomic-extraction-write-api";
import { applyStateCategoryMigration } from "@/storage/state-category-migration";
import {
	type AtomicExtractionLedgerKey,
	type AtomicExtractionRunParameters,
	MemoryStore,
} from "@/storage/store";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

const EXTRACTOR_VERSION = "arrival-retirement-scoring";
const USER = "user";
const ATTR = "preference.beverage";
const SESSION_MS = Date.UTC(2026, 5, 1, 9, 0);
const WRITE_MS = Date.UTC(2026, 8, 5, 5, 0);
const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 2_000,
	subchunkCount: 1,
};

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

let embedder: Embedder;
beforeAll(async () => {
	embedder = await createTestEmbedder();
});

interface Seed {
	label: string;
	text: string;
	subject: string;
	turn: number;
}

function keyedRecord(seed: Seed): AtomicKeyedRecord {
	return {
		category: "profile",
		kind: "standing",
		claimText: seed.text,
		subject: seed.subject,
		subjectKind: seed.subject === USER ? "user" : "named_entity",
		attribute: ATTR,
		value: seed.text,
		temporalPhrase: null,
		resolvedTime: null,
		endsCurrent: false,
		endedAt: null,
		importance: "medium",
		changesCurrentState: false,
		todo: "none",
		closeReason: null,
		sourceSpan: {
			turnIndex: seed.turn,
			quote: seed.text,
			startOffset: 0,
			endOffset: seed.text.length,
		},
		relations: [],
		singleClaim: true,
		lane: "active",
		dispositionReason: null,
		resplit: false,
	};
}

async function write(
	store: MemoryStore,
	projectId: string,
	seed: Seed,
	index: number,
): Promise<string> {
	const key: AtomicExtractionLedgerKey = {
		conversationId: "conversation-retirement-scoring",
		chunkHash: `chunk-${seed.label}`,
		pipelineVersion: EXTRACTOR_VERSION,
	};
	expect(
		store.beginAtomicExtractionChunk({
			...key,
			rawChunk: `user: ${seed.text}`,
			routingSnapshotId: "routing-retirement-scoring",
			runParameters: RUN_PARAMETERS,
			nowMs: WRITE_MS + index * 10,
		}),
	).toMatchObject({ action: "run" });
	store.recordAtomicExtractionCalls(key, WRITE_MS + index * 10 + 1);
	const result = await store.storeAtomicExtractionChunk({
		ledgerKey: key,
		projectId,
		extractorVersion: EXTRACTOR_VERSION,
		nowMs: WRITE_MS + index * 10 + 2,
		cards: buildAtomicWriteCards({
			records: [keyedRecord(seed)],
			idempotencyKeys: [`retirement-scoring-${seed.label}`],
			sessionTimestampMs: SESSION_MS,
			sourceTurnOffset: 0,
			timezone: "UTC",
		}),
	});
	const [cardId] = result.cardIds;
	if (cardId === undefined) throw new Error(`no row written for ${seed.label}`);
	return cardId;
}

describe("PRD 150 review — arrival retirement scores candidates on their own vectors", () => {
	// The nominated statement and five same-subject candidates. The order they come back in is not
	// asserted against a re-computed geometry (which never matches the engine's chunk vectors byte
	// for byte); it is asserted to be INVARIANT to rows of other subjects. That invariance is
	// exactly the fix: a candidate is scored on its own vectors, so a project full of near-identical
	// other-subject rows cannot move it.
	const NOMINATED = "I no longer drink tea in the mornings";
	const CANDIDATES: Seed[] = [
		{ label: "tea", text: "I drink tea every morning", subject: USER, turn: 1 },
		{ label: "coffee", text: "I drink coffee every morning", subject: USER, turn: 2 },
		{ label: "walks", text: "I take a walk every morning", subject: USER, turn: 3 },
		{ label: "violin", text: "I practise the violin after work", subject: USER, turn: 4 },
		{ label: "stamps", text: "I collect vintage postage stamps", subject: USER, turn: 5 },
	];
	const NOMINATED_TURN = 9;

	/**
	 * The order the candidates SHOULD take, computed from the SAME inputs the engine scores on: the
	 * nominated text embedded once, against each candidate's OWN stored chunk vectors (best chunk),
	 * `1 / (1 + L2)`. Reading the stored vectors rather than re-embedding the candidate texts is
	 * what keeps this identical to the engine's geometry.
	 */
	async function expectedOrder(
		store: MemoryStore,
		scope: string,
		idByLabel: ReadonlyMap<string, string>,
	): Promise<string[]> {
		void scope;
		const nominatedVector = await store.embedder.embed(NOMINATED);
		const scored = CANDIDATES.map((candidate) => {
			const memoryId = idByLabel.get(candidate.label);
			if (memoryId === undefined) throw new Error(`no id for ${candidate.label}`);
			const chunkIds = (
				store.sqlite
					.prepare("SELECT chunk_id AS chunkId FROM nodix_memory_chunks WHERE memory_id = ?")
					.all(memoryId) as Array<{ chunkId: string }>
			).map((row) => row.chunkId);
			const vectors = store.getVectorsByIds(chunkIds);
			let best = Number.NEGATIVE_INFINITY;
			for (const vector of vectors.values()) {
				let sum = 0;
				for (let i = 0; i < nominatedVector.length; i += 1) {
					const d = (nominatedVector[i] ?? 0) - (vector[i] ?? 0);
					sum += d * d;
				}
				best = Math.max(best, 1 / (1 + Math.sqrt(sum)));
			}
			return { label: candidate.label, score: best };
		});
		return scored
			.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
			.map((entry) => entry.label);
	}

	async function candidateOrder(
		scope: string,
		withDistractors: boolean,
	): Promise<{ served: string[]; expected: string[] }> {
		const fixture = createTestDb();
		const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		cleanups.push(async () => {
			await store.close();
			fixture.cleanup();
		});
		applyStateCategoryMigration(fixture.runtime.db);

		const idByLabel = new Map<string, string>();
		let index = 0;
		for (const seed of CANDIDATES) {
			idByLabel.set(seed.label, await write(store, scope, seed, index));
			index += 1;
		}
		if (withDistractors) {
			// Identical to the nominated text, under OTHER subjects: a whole-project vector search
			// ranks them above every real candidate and fills the KNN slots the candidates need.
			for (let d = 0; d < 6; d += 1) {
				await write(
					store,
					scope,
					{ label: `distractor-${d}`, text: NOMINATED, subject: `entity:cafe_${d}`, turn: 1 },
					index,
				);
				index += 1;
			}
		}
		const nominatedId = await write(
			store,
			scope,
			{ label: "nominated", text: NOMINATED, subject: USER, turn: NOMINATED_TURN },
			index,
		);

		const set = await readAtomicArrivalRetirementCandidateSet(store as never, {
			projectId: scope,
			nominatedRowId: nominatedId,
			jobId: "job-retirement-scoring",
		});
		if (!set) throw new Error("the candidate set was not built");
		const labelById = new Map([...idByLabel].map(([label, id]) => [id, label]));
		const served = set.candidateRows.map((row) => labelById.get(row.id) ?? `other:${row.id}`);
		return { served, expected: await expectedOrder(store, scope, idByLabel) };
	}

	it(
		"ranks the candidates the same way whether or not other subjects crowd the project",
		{ timeout: 300_000 },
		async () => {
			const clean = await candidateOrder("persona:retirement-scoring-clean", false);
			const crowded = await candidateOrder("persona:retirement-scoring-crowded", true);

			// A candidate row is never a distractor: the subject filter already guarantees that, so a
			// break here means the set was built wrong, not that scoring changed.
			expect(
				crowded.served.filter((label) => label.startsWith("other:")),
				"a row of another subject was offered as a retirement candidate",
			).toEqual([]);
			expect(
				[...clean.served].sort(),
				"the clean store did not offer the five same-subject candidates",
			).toEqual(["coffee", "stamps", "tea", "violin", "walks"]);
			// Positive check: the served order IS the candidates' own stored-vector similarity order.
			// This fails if the ranking ignores the vectors and falls back to some fixed order.
			expect(
				clean.served,
				"the candidates were not ranked by their own stored-vector similarity",
			).toEqual(clean.expected);
			// Invariance check: scored on their own vectors, the five come back in that same order
			// whether or not the project is full of near-identical other-subject rows.
			expect(
				crowded.served,
				"other-subject rows changed the candidate ranking — they crowded out the real scores",
			).toEqual(clean.served);
		},
	);
});
