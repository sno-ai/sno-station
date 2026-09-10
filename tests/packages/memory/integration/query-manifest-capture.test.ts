/** @file query-manifest-capture.test.ts
 * @purpose Proves deterministic, read-only query capture against real encrypted SQLite.
 * @boundary Production MemoryStore, retriever, rendering, token counting, and task projection reads.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client";
import {
	buildInsightMetadata,
	stringifyInsightMetadata,
} from "../../../../packages/sno-station-mem/src/engine/extraction/memory-metadata-codec";
import {
	captureQueryManifest,
	hashQueryManifestStore,
	serializeQueryManifestCapture,
	type ReviewedQueryInput,
} from "../../../../packages/sno-station-mem/src/engine/retrieval/query-manifest-capture";
import { DEFAULT_RETRIEVAL_CONFIG } from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever";
import type { MemoryEntry } from "../../../../packages/sno-station-mem/src/engine/shared/types";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db";
import { routeTestTask } from "../../../apps/mem-claw/integration/task-lifecycle-test-route";

const REFERENCE_TIME_MS = Date.parse("2026-07-29T17:00:00.000Z");
const PROJECT_ID = "query-manifest-capture-integration";

let embedder: Embedder;
let fixture: TestDb | undefined;
let store: MemoryStore | undefined;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

afterEach(async () => {
	await store?.close();
	store = undefined;
	fixture?.cleanup();
	fixture = undefined;
});

afterAll(() => {
	// The shared real embedder is intentionally retained by the test helper.
});

function openStore(): MemoryStore {
	fixture = createTestDb();
	store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	return store;
}

function profileMetadata(
	text: string,
	sectionName: string,
	extra: Record<string, unknown> = {},
): string {
	return stringifyInsightMetadata(
		buildInsightMetadata(
			{
				text,
				category: "profile",
				timestamp: REFERENCE_TIME_MS - 10_000,
				metadata: JSON.stringify({
					kind: "profile",
					memory_category: "profile",
					section_name: sectionName,
					...extra,
				}),
			},
			{ section_name: sectionName },
		),
	);
}

async function storeProfile(
	target: MemoryStore,
	text: string,
	metadata: string,
	timestamp: number,
): Promise<MemoryEntry> {
	return target.store({
		text,
		category: "profile",
		projectId: PROJECT_ID,
		timestamp,
		metadata,
		trusted: true,
	});
}

async function seedCaptureRows(
	target: MemoryStore,
): Promise<{
	supportingCarrierId: string;
	projectionMemoryId: string;
	activeTaskIds: string[];
	terminalTaskId: string;
}> {
	const alphaText = "Prepare the deterministic launch checklist.";
	const betaText = "Review the encrypted snapshot opening procedure.";
	const terminalText = "Retire the obsolete capture fixture.";
	const terminal = await routeTestTask({
		store: target,
		projectId: PROJECT_ID,
		action: "open_or_refine",
		description: terminalText,
		replayIdentity: "query-manifest-terminal-open",
		occurrenceId: terminalText,
		at: REFERENCE_TIME_MS - 9_000,
	});
	const alpha = await routeTestTask({
		store: target,
		projectId: PROJECT_ID,
		action: "open_or_refine",
		description: alphaText,
		replayIdentity: "query-manifest-alpha-open",
		occurrenceId: alphaText,
		at: REFERENCE_TIME_MS - 8_000,
	});
	const beta = await routeTestTask({
		store: target,
		projectId: PROJECT_ID,
		action: "open_or_refine",
		description: betaText,
		replayIdentity: "query-manifest-beta-open",
		occurrenceId: betaText,
		at: REFERENCE_TIME_MS - 7_000,
	});
	await routeTestTask({
		store: target,
		projectId: PROJECT_ID,
		action: "complete",
		description: terminalText,
		replayIdentity: "query-manifest-terminal-complete",
		occurrenceId: terminalText,
		at: REFERENCE_TIME_MS - 6_000,
	});
	const activeTaskIds = [alpha.write.activeTaskId, beta.write.activeTaskId];
	const terminalTaskId = terminal.write.activeTaskId;
	if (activeTaskIds.some((id) => id === null) || terminalTaskId === null) {
		throw new Error("expected task lifecycle identifiers");
	}
	const projection = target.getByFactKey(PROJECT_ID, "profile:active_tasks");
	if (!projection) throw new Error("expected active-task projection");
	await storeProfile(
		target,
		"The user prefers concise Chinese status updates.",
		profileMetadata(
			"The user prefers concise Chinese status updates.",
			"preferences.language",
		),
		REFERENCE_TIME_MS - 4_000,
	);
	const supportingCarrier = await target.store({
		text: "The launch checklist must preserve the read-only SQLite boundary.",
		category: "episodic",
		projectId: PROJECT_ID,
		timestamp: REFERENCE_TIME_MS - 3_000,
	});
	return {
		supportingCarrierId: supportingCarrier.id,
		projectionMemoryId: projection.id,
		activeTaskIds: activeTaskIds as string[],
		terminalTaskId,
	};
}

function reviewedQueries(
	supportingCarrierId: string,
	activeTaskIds: string[],
	terminalTaskId: string,
): ReviewedQueryInput[] {
	return [
		{
			queryId: "current-task-list-reviewed-20260729",
			text: "What tasks remain on my current list?",
			projectId: PROJECT_ID,
			intent: "list-all",
			taskMode: "current",
			expectedAddresses: [{ sectionName: "active_tasks", expectedLiveMatchCount: 1 }],
			requiredSupportingCarrierIds: [supportingCarrierId],
			expectedActiveTaskIds: activeTaskIds,
			expectedTerminalTaskIds: [terminalTaskId],
		},
		{
			queryId: "language-preference-reviewed-20260729",
			text: "Which language should status updates use?",
			projectId: PROJECT_ID,
			intent: "lookup",
			taskMode: "non-task",
			expectedAddresses: [
				{ sectionName: "preferences.language", expectedLiveMatchCount: 1 },
			],
			requiredSupportingCarrierIds: [],
			expectedActiveTaskIds: [],
			expectedTerminalTaskIds: [],
		},
	];
}

describe("query manifest capture integration", () => {
	it("emits byte-identical complete captures without mutating the real store", async () => {
		const target = openStore();
		const {
			projectionMemoryId,
			supportingCarrierId,
			activeTaskIds,
			terminalTaskId,
		} = await seedCaptureRows(target);
		const beforeHash = hashQueryManifestStore(target);

		const request = {
			store: target,
			embedder,
			referenceTimeMs: REFERENCE_TIME_MS,
			productionTopK: 10,
			retrievalConfig: {
				...DEFAULT_RETRIEVAL_CONFIG,
				rerank: "none" as const,
				recencyWeight: 0,
				timeDecayHalfLifeDays: 0,
				hardMinScore: 0,
				minScore: 0,
			},
			queries: reviewedQueries(supportingCarrierId, activeTaskIds, terminalTaskId),
		};
		const firstPromise = captureQueryManifest(request);
		await Promise.resolve();
		const concurrentWallClock = Date.now();
		const first = await firstPromise;
		const second = await captureQueryManifest(request);
		const firstSerialized = serializeQueryManifestCapture(first);
		const secondSerialized = serializeQueryManifestCapture(second);

		expect(firstSerialized.bytes).toBe(secondSerialized.bytes);
		expect(firstSerialized.sha256).toBe(secondSerialized.sha256);
		expect(concurrentWallClock).not.toBe(REFERENCE_TIME_MS);
		expect(first.inputStore.sha256).toBe(beforeHash);
		expect(hashQueryManifestStore(target)).toBe(beforeHash);

		const currentList = first.queries[0];
		expect(currentList?.addressResolution.status).toBe("missing");
		expect(currentList?.addressResolution.reason).toMatch(/production Query address resolver/i);
		expect(currentList?.reviewedExpectations.expectedAddresses).toEqual([
			{ sectionName: "active_tasks", expectedLiveMatchCount: 1 },
		]);
		expect(currentList?.retrieval.method).toBe("MemoryRetriever.retrieveWithTrace");
		expect(currentList?.retrieval.storeMethods).toContain("MemoryStore.searchSemantic");
		expect(currentList?.retrieval.storeMethods).toContain("MemoryStore.searchKeyword");
		expect(currentList?.candidates.length).toBeGreaterThan(0);
		for (const candidate of currentList?.candidates ?? []) {
			expect(candidate.memoryId.length).toBeGreaterThan(0);
			expect(Number.isFinite(candidate.finalPreAdmissionScore)).toBe(true);
			expect(["available", "missing"]).toContain(candidate.rawScores.dense.status);
			expect(["available", "missing"]).toContain(candidate.rawScores.bm25.status);
			expect(["available", "missing"]).toContain(candidate.rawScores.fused.status);
			expect(["available", "missing"]).toContain(candidate.rawScores.rerank.status);
			expect(["available", "missing"]).toContain(candidate.rawScores.mmr.status);
			expect(candidate.renderedText.status).toBe("available");
			expect(candidate.renderedTokenCount.status).toBe("available");
			expect(candidate.provenance.retrievalMethod).toBe(
				"MemoryRetriever.retrieveWithTrace",
			);
		}
		const projectionCandidate = currentList?.candidates.find(
			(candidate) => candidate.memoryId === projectionMemoryId,
		);
		expect(projectionCandidate?.renderedText.status).toBe("available");
		if (projectionCandidate?.renderedText.status !== "available") {
			throw new Error("expected rendered projection candidate");
		}
		expect(projectionCandidate.renderedText.value).toContain(
			"Prepare the deterministic launch checklist.",
		);
		expect(projectionCandidate.renderedText.value).toContain(
			"Review the encrypted snapshot opening procedure.",
		);
		expect(projectionCandidate.renderedText.value.split("\n")).toHaveLength(1);

		expect(currentList?.currentListCapture.status).toBe("available");
		if (currentList?.currentListCapture.status !== "available") {
			throw new Error("expected current-list capture");
		}
		expect(currentList.currentListCapture.value.productionQueryFallbackPath.status).toBe(
			"missing",
		);
		expect(currentList.currentListCapture.value.captureEnumerationPath).toBe(
			"MemoryStore.readTaskLifecycleInstances",
		);
		expect(
			currentList.currentListCapture.value.directFallbackRowsBeforeOrdering.map(
				(row) => row.activeTaskId,
			),
		).toEqual(activeTaskIds);
		expect(
			currentList.currentListCapture.value.directFallbackRowsAfterOrdering.map(
				(row) => row.activeTaskId,
			),
		).toEqual(activeTaskIds);
		expect(currentList.currentListCapture.value.directTaskRead.rows).toHaveLength(3);
		expect(
			currentList.currentListCapture.value.directFallbackRowsBeforeOrdering.some(
				(row) => row.activeTaskId === terminalTaskId,
			),
		).toBe(false);
		expect(currentList.currentListCapture.value.projection.validity).toBe("valid");

		const lookup = first.queries[1];
		expect(lookup?.currentListCapture.status).toBe("not-applicable");
		expect(lookup?.addressResolution.status).toBe("missing");
		expect(lookup?.reviewedExpectations.expectedAddresses[0]?.sectionName).toBe(
			"preferences.language",
		);
	});

	it("preserves production top-k while retaining internal candidate-stage counts", async () => {
		const target = openStore();
		const { supportingCarrierId, activeTaskIds, terminalTaskId } = await seedCaptureRows(target);
		const capture = await captureQueryManifest({
			store: target,
			embedder,
			referenceTimeMs: REFERENCE_TIME_MS,
			productionTopK: 1,
			retrievalConfig: {
				...DEFAULT_RETRIEVAL_CONFIG,
				rerank: "none",
				recencyWeight: 0,
				timeDecayHalfLifeDays: 0,
				hardMinScore: 0,
				minScore: 0,
			},
			queries: reviewedQueries(supportingCarrierId, activeTaskIds, terminalTaskId).slice(0, 1),
		});

		const query = capture.queries[0];
		expect(query?.retrieval.topK).toBe(1);
		expect(query?.retrieval.candidatePoolLimit).toBeGreaterThan(1);
		expect(query?.candidates).toHaveLength(1);
		expect(
			query?.retrieval.stages.find((stage) => stage.name === "parallel_search")?.outputCount,
		).toBeGreaterThan(1);
	});
});
