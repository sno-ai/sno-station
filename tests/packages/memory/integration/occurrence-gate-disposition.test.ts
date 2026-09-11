/** @file occurrence-gate-disposition.test.ts
 * @purpose Proves occurrence-withheld candidates remain durable and reconstructable.
 * @boundary Production candidate persistence, real encrypted SQLite, and a fresh reader.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client";
import { processExtractedCandidate } from "@/extraction/insight-distill-candidate-processor";
import type { CandidateMemory, ExtractionStats } from "../../../../packages/sno-station-mem/src/engine/shared/types";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store";
import { createTestLlmClient } from "../../../apps/mem-claw/helpers/llm-client.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";
import { routeTestTask } from "../../../apps/mem-claw/integration/task-lifecycle-test-route.ts";

const SCOPE = "occurrence-gate-disposition";
const SESSION_KEY = "occurrence-gate-disposition-session";
const SESSION_DATE_TIME = "2026-08-03T12:00:00.000Z";
const extractionTrace = {
	source: "llm-conversation-chunk",
	chunkIndex: 0,
	chunkCount: 1,
	startOffset: 0,
	endOffset: 64,
	tokenCount: 12,
	contentType: "conversation",
	chunkingVersion: "test-v1",
	candidateIndex: 0,
} as const;

type DurableCandidate = CandidateMemory & {
	durableQuarantine: true;
};

describe("occurrence gate durable disposition", () => {
	let embedder: Embedder;
	let fixture: TestDb | undefined;
	let store: MemoryStore | undefined;

	beforeAll(async () => {
		embedder = await createTestEmbedder();
	});

	afterEach(async () => {
		await store?.close();
		fixture?.cleanup();
		store = undefined;
		fixture = undefined;
	});

	it("persists one profile candidate and its withheld sibling as an active episodic row", async () => {
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		const kept: CandidateMemory = {
			category: "profile",
			sectionName: "preferences.music",
			abstract: "The user likes indie folk.",
			overview: "The user likes indie folk.",
			content: "The user likes indie folk.",
			extractionTrace: { ...extractionTrace, candidateIndex: 1 },
		};
		const withheld: DurableCandidate = {
			category: "episodic",
			abstract: "The user stated a music preference.",
			overview: "The user stated a music preference.",
			content: "The user stated a music preference.",
			extractionTrace,
			lane: "quarantined",
			dispositionReason: "absorbed_occurrence",
			rawCandidateJson: JSON.stringify({ producer: "episodic-lane" }),
			durableQuarantine: true,
		};

		const stats: ExtractionStats = { created: 0, merged: 0, skipped: 0 };
		for (const candidate of [kept, withheld]) {
			await processExtractedCandidate({
				candidate,
				sessionKey: SESSION_KEY,
				stats,
				targetScope: SCOPE,
				scopeFilter: [SCOPE],
				store,
				embedder,
				llm: createTestLlmClient(),
				sessionDateTime: SESSION_DATE_TIME,
			});
		}

		await store.close();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		const active = await store.list({ projectId: SCOPE, limit: 10 });
		const quarantined = await store.list({ projectId: SCOPE, lane: "quarantined", limit: 10 });
		const deleteCount = fixture.sqlite
			.prepare("SELECT COUNT(*) AS count FROM nodix_memory_events WHERE event_type = 'delete'")
			.get() as { count: number };

		// Owner law 2026-08-26: an extracted candidate ends as `profile` or as `episodic`, and
		// there is no quarantine lane left — `durableQuarantine` is gone from `src/` entirely.
		// The withheld sibling stays readable, so it lands active with its refusal reason kept.
		expect(active).toHaveLength(2);
		expect(active[0]).toMatchObject({ category: "profile", lane: "active" });
		expect(quarantined).toHaveLength(0);
		const withheldRow = active[1];
		expect(withheldRow).toMatchObject({
			category: "episodic",
			lane: "active",
			text: "The user stated a music preference.",
		});
		expect(stats.created).toBe(2);
		expect(deleteCount.count).toBe(0);
	});

	it("asks the task classifier about a clean candidate and never about a refused one", async () => {
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		// The classifier only runs when an open task exists, so without this the case would
		// pass for both candidates and prove nothing.
		await routeTestTask({
			store,
			projectId: SCOPE,
			action: "open_or_refine",
			description: "Draft the quarterly report",
			replayIdentity: "disposition-classifier-open",
			at: Date.parse(SESSION_DATE_TIME),
		});

		const sentence = "The user finished drafting the quarterly report.";
		async function classifyCallsFor(
			dispositionReason: string | undefined,
			index: number,
		): Promise<string[]> {
			const labels: string[] = [];
			const candidate: CandidateMemory = {
				category: "episodic",
				abstract: sentence,
				overview: sentence,
				content: sentence,
				extractionTrace: { ...extractionTrace, candidateIndex: index },
				...(dispositionReason === undefined ? {} : { dispositionReason }),
			};
			const stats: ExtractionStats = { created: 0, merged: 0, skipped: 0 };
			await processExtractedCandidate({
				candidate,
				sessionKey: `${SESSION_KEY}-${index}`,
				replayIdentity: `${SESSION_KEY}-${index}`,
				stats,
				targetScope: SCOPE,
				scopeFilter: [SCOPE],
				store: store as MemoryStore,
				embedder,
				llm: createTestLlmClient({
					async completeJson<T>(request): Promise<T | null> {
						labels.push(request.callLabel);
						// The classifier refuses an unusable answer, so it has to be given a real
						// one; "none" changes nothing and keeps the case about the call itself.
						if (request.callLabel === "profile-active-task-classify") {
							return { action: "none", taskId: null } as T;
						}
						return null;
					},
				}),
				sessionDateTime: SESSION_DATE_TIME,
			});
			return labels.filter((label) => label === "profile-active-task-classify");
		}

		expect(await classifyCallsFor(undefined, 2)).not.toHaveLength(0);
		expect(await classifyCallsFor("candidate_not_grounded", 3)).toHaveLength(0);
	});

	it("persists a newly widened profile mismatch as an active row with its reason kept", async () => {
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		const mismatch: DurableCandidate = {
			category: "profile",
			sectionName: "preferences.music",
			abstract: "The user likes opera.",
			overview: "The user likes opera.",
			content: "The user likes opera.",
			gateEvidenceText: "user: I listened to a podcast.",
			extractionTrace,
			lane: "quarantined",
			dispositionReason: "candidate_not_grounded",
			durableQuarantine: true,
		};
		const stats: ExtractionStats = { created: 0, merged: 0, skipped: 0 };

		await processExtractedCandidate({
			candidate: mismatch,
			sessionKey: SESSION_KEY,
			stats,
			targetScope: SCOPE,
			scopeFilter: [SCOPE],
			store,
			embedder,
			llm: createTestLlmClient(),
			sessionDateTime: SESSION_DATE_TIME,
		});

		expect(await store.list({ projectId: SCOPE, lane: "quarantined" })).toEqual([]);
		const active = await store.list({ projectId: SCOPE });
		expect(active).toHaveLength(1);
		// The refused profile candidate is demoted to episodic and kept live with its reason.
		// It carries no reconstruction payload: the sentence itself is the record now.
		expect(active[0]).toMatchObject({
			category: "episodic",
			lane: "active",
			dispositionReason: "candidate_not_grounded",
		});
		expect(active[0]?.text).toContain(mismatch.content);
		expect(stats.created).toBe(1);
	});
});
