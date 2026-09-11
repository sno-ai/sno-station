/** @file atomic-two-fates-count.test.ts
 * @purpose Proves local two-fates row counting without a corpus or evaluation gate.
 * @boundary Atomic write projection, real encrypted SQLite, and the default retriever path.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AtomicKeyedRecord } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-profile-keying";
import { buildAtomicWriteCards } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-write-projection";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client";
import {
	createRetriever,
	DEFAULT_RETRIEVAL_CONFIG,
} from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever";
import {
	type AtomicExtractionLedgerKey,
	type AtomicExtractionRunParameters,
	MemoryStore,
} from "../../../../packages/sno-station-mem/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db";

const PROJECT_ID = "atomic-two-fates-local";
const EXTRACTOR_VERSION = "atomic-v3-two-fates-test";
const SEARCH_TERM = "twofatesanchor";
const NOW_MS = Date.UTC(2026, 8, 3, 8, 30);
const INCUMBENT_NON_APPEND_EXTRACTION_CAP = 10;
const DUPLICATE_ARRIVAL_COUNT = INCUMBENT_NON_APPEND_EXTRACTION_CAP + 1;
const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 2_000,
	subchunkCount: 1,
};

interface FateObservation {
	candidateKey: string;
	category: string;
	lane: string;
}

interface TwoFatesCount {
	servedTwoFateCount: number;
	thirdFateCount: number;
	discardedKeys: string[];
	hiddenLaneKeys: string[];
	unservedActiveKeys: string[];
}

function countTwoFates(
	expectedCandidateKeys: readonly string[],
	storedRows: readonly FateObservation[],
	defaultServedRows: readonly FateObservation[],
): TwoFatesCount {
	const expected = new Set(expectedCandidateKeys);
	const storedByKey = new Map(storedRows.map((row) => [row.candidateKey, row]));
	const servedTwoFateKeys = new Set(
		defaultServedRows.flatMap((row) =>
			expected.has(row.candidateKey) && (row.category === "episodic" || row.category === "profile")
				? [row.candidateKey]
				: [],
		),
	);
	const absentFromDefault = expectedCandidateKeys.filter((key) => !servedTwoFateKeys.has(key));
	return {
		servedTwoFateCount: servedTwoFateKeys.size,
		thirdFateCount: expectedCandidateKeys.length - servedTwoFateKeys.size,
		discardedKeys: absentFromDefault.filter((key) => !storedByKey.has(key)),
		hiddenLaneKeys: absentFromDefault.filter((key) => {
			const row = storedByKey.get(key);
			return row !== undefined && row.lane !== "active";
		}),
		unservedActiveKeys: absentFromDefault.filter((key) => storedByKey.get(key)?.lane === "active"),
	};
}

function record(
	name: string,
	overrides: Partial<AtomicKeyedRecord> = {},
): AtomicKeyedRecord {
	const text = `${SEARCH_TERM} ${name}`;
	return {
		kind: "standing",
		category: "profile",
		claimText: text,
		subject: "user",
		subjectKind: "user",
		attribute: "preference.food",
		value: name,
		temporalPhrase: null,
		resolvedTime: null,
		importance: "medium",
		changesCurrentState: false,
		todo: "none",
		closeReason: null,
		sourceSpan: { turnIndex: 0, quote: text, startOffset: 0, endOffset: text.length },
		relations: [],
		singleClaim: true,
		lane: "active",
		dispositionReason: null,
		resplit: false,
		...overrides,
	};
}

function readCandidateKey(metadata: string): string {
	const parsed = JSON.parse(metadata) as { idempotency_key?: unknown };
	if (typeof parsed.idempotency_key !== "string") {
		throw new Error("stored two-fates row has no idempotency key");
	}
	return parsed.idempotency_key;
}

function ledgerKey(): AtomicExtractionLedgerKey {
	return {
		conversationId: "two-fates-conversation",
		chunkHash: "two-fates-chunk",
		pipelineVersion: EXTRACTOR_VERSION,
	};
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("atomic two-fates count", () => {
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

	it("stores and serves eleven duplicate arrivals plus the distinct fact without truncation", async () => {
		const duplicate = record("the user prefers tea");
		const records = [
			...Array.from({ length: DUPLICATE_ARRIVAL_COUNT }, () => ({ ...duplicate })),
			record("the user moved to Kyoto", {
				category: "episodic",
				attribute: null,
				value: "moved to Kyoto",
			}),
		];
		const duplicateCandidateKeys = Array.from(
			{ length: DUPLICATE_ARRIVAL_COUNT },
			(_, index) => `duplicate-arrival-${index + 1}`,
		);
		const expectedCandidateKeys = [...duplicateCandidateKeys, "distinct-fact"];
		const cards = buildAtomicWriteCards({
			records,
			idempotencyKeys: expectedCandidateKeys,
			sourceTurnOffset: 0,
			sessionTimestampMs: NOW_MS,
			timezone: "UTC",
		});
		const key = ledgerKey();
		expect(
			store.beginAtomicExtractionChunk({
				...key,
				rawChunk: "Eleven duplicate claims and one distinct claim.",
				routingSnapshotId: "two-fates-routing",
				runParameters: RUN_PARAMETERS,
				nowMs: NOW_MS,
			}),
		).toMatchObject({ action: "run", entry: { state: "open" } });
		store.recordAtomicExtractionCalls(key, NOW_MS + 1);

		const written = await store.storeAtomicExtractionChunk({
			ledgerKey: key,
			projectId: PROJECT_ID,
			extractorVersion: EXTRACTOR_VERSION,
			nowMs: NOW_MS + 2,
			cards,
		});

		expect(written).toMatchObject({
			createdCount: expectedCandidateKeys.length,
			suppressed: [],
			ledger: { state: "complete" },
		});
		expect(new Set(written.cardIds).size).toBe(expectedCandidateKeys.length);
		const storedRows = fixture.runtime.db
			.prepare(
				`SELECT category, lane, metadata
				FROM nodix_memories
				WHERE project_id = ?
				ORDER BY id`,
			)
			.all(PROJECT_ID) as Array<{ category: string; lane: string; metadata: string }>;
		expect(storedRows).toHaveLength(expectedCandidateKeys.length);
		expect(storedRows.every(({ category }) => category === "episodic" || category === "profile")).toBe(
			true,
		);
		expect(storedRows.every(({ lane }) => lane === "active")).toBe(true);
		expect(storedRows.filter(({ category }) => category === "profile")).toHaveLength(
			DUPLICATE_ARRIVAL_COUNT,
		);
		expect(storedRows.filter(({ category }) => category === "episodic")).toHaveLength(1);
		expect(
			storedRows.filter(({ metadata }) => readCandidateKey(metadata).startsWith("duplicate-arrival")),
		).toHaveLength(DUPLICATE_ARRIVAL_COUNT);
		expect(
			fixture.runtime.db
				.prepare(
					"SELECT COUNT(*) AS count FROM nodix_memories WHERE project_id = ? AND text LIKE ?",
				)
				.get(PROJECT_ID, "%moved to Kyoto%"),
		).toEqual({ count: 1 });

		const defaultList = await store.list({ projectId: PROJECT_ID, limit: 20 });
		expect(new Set(defaultList.map(({ id }) => id))).toEqual(new Set(written.cardIds));
		for (const id of written.cardIds) expect(store.isMemoryOnFactSurface(id)).toBe(true);

		const retriever = createRetriever(store, embedder, undefined, {
			...DEFAULT_RETRIEVAL_CONFIG,
			rerank: "none",
			minScore: -1,
			hardMinScore: -1,
			candidatePoolSize: 20,
		});
		const recalled = await retriever.retrieve({
			query: SEARCH_TERM,
			limit: 20,
			scopeFilter: [PROJECT_ID],
			source: "manual",
		});
		expect(new Set(recalled.map(({ entry }) => entry.id))).toEqual(new Set(written.cardIds));

		const storedObservations: FateObservation[] = storedRows.map((row) => ({
			candidateKey: readCandidateKey(row.metadata),
			category: row.category,
			lane: row.lane,
		}));
		const servedObservations: FateObservation[] = recalled.map(({ entry }) => ({
			candidateKey: readCandidateKey(entry.metadata),
			category: entry.category,
			lane: entry.lane,
		}));
		expect(countTwoFates(expectedCandidateKeys, storedObservations, servedObservations)).toEqual({
			servedTwoFateCount: expectedCandidateKeys.length,
			thirdFateCount: 0,
			discardedKeys: [],
			hiddenLaneKeys: [],
			unservedActiveKeys: [],
		});
	});

	it("turns hidden, discarded, and count-truncated candidates into a nonzero third-fate count", () => {
		const expected = ["first", "second", "third"];
		const stored: FateObservation[] = expected.map((candidateKey) => ({
			candidateKey,
			category: "profile",
			lane: "active",
		}));

		const hiddenStored = stored.map((row) =>
			row.candidateKey === "second" ? { ...row, lane: "parked" } : row,
		);
		const hiddenServed = hiddenStored.filter(({ lane }) => lane === "active");
		expect(countTwoFates(expected, hiddenStored, hiddenServed)).toMatchObject({
			thirdFateCount: 1,
			hiddenLaneKeys: ["second"],
		});

		const discardedStored = stored.filter(({ candidateKey }) => candidateKey !== "second");
		expect(countTwoFates(expected, discardedStored, discardedStored)).toMatchObject({
			thirdFateCount: 1,
			discardedKeys: ["second"],
		});

		const truncatedServed = stored.slice(0, 2);
		expect(countTwoFates(expected, stored, truncatedServed)).toMatchObject({
			thirdFateCount: 1,
			unservedActiveKeys: ["third"],
		});
	});
});
