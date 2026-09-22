/** @file insight-distill-commit-count.test.ts
 * @purpose Proves a committed profile row is counted before later task routing can fail.
 * @boundary Real encrypted SQLite with one PRD-declared transport failure at the model adapter.
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { processExtractedCandidate } from "@/extraction/insight-distill-candidate-processor";
import { routeTaskLifecycleAssertion } from "../../../../packages/memory/src/engine/extraction/task-lifecycle-route";
import type { LlmClient } from "../../../../packages/memory/src/model/llm-client";
import type { CandidateMemory, ExtractionStats } from "../../../../packages/memory/src/engine/shared/types";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db";

const unavailableRoute: LlmClient = {
	completeJson: async () => {
		throw new Error("injected task lifecycle transport failure");
	},
	completeText: async () => {
		throw new Error("unexpected text call");
	},
	getResolvedConfig: async () => {
		throw new Error("unexpected config read");
	},
	getLastError: () => "injected task lifecycle transport failure",
	getLastUsage: () => null,
};

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("insight distill committed-row accounting", () => {
	it("counts the profile commit before a later task route fails and records the refusal", async () => {
		const fixture = createTestDb();
		const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		const projectId = "profile-commit-before-task-route-failure";
		try {
			await routeTaskLifecycleAssertion({
				assertion: {
					kind: "task_lifecycle",
					action: "open_or_refine",
					projectId,
					subject: "user",
					description: "Prepare the travel budget",
					occurrenceAnchors: {},
					revisionDetails: {},
				},
				source: {
					kind: "authorized_untraced",
					sessionKey: projectId,
					replayIdentity: "open-budget-task",
					assertionOrdinal: 0,
				},
				firstResolutionNowMs: Date.parse("2026-08-04T11:00:00.000Z"),
				store,
			});

			const candidate: CandidateMemory = {
				category: "profile",
				sectionName: "preferences.travel",
				abstract: "The user prefers rail travel.",
				overview: "- The user prefers rail travel.",
				content: "The user prefers rail travel for regional trips.",
			};
			const stats: ExtractionStats = { created: 0, merged: 0, skipped: 0 };
			await expect(
				processExtractedCandidate({
					candidate,
					sessionKey: projectId,
					replayIdentity: "profile-travel-candidate",
					stats,
					targetScope: projectId,
					scopeFilter: [projectId],
					store,
					embedder,
					llm: unavailableRoute,
				}),
			).rejects.toThrow("injected task lifecycle transport failure");

			expect(stats).toMatchObject({ created: 1, merged: 0, skipped: 0 });
			expect(store.getByFactKey(projectId, "profile:preferences.travel")?.text).toBe(
				candidate.content,
			);
			const records = readFileSync(`${dirname(store.dbPath)}/audit.jsonl`, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(records).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						decision: "preserved-without-adjudication",
						details: expect.objectContaining({
							audit_phase: "completed",
							mutation_writer: "task-lifecycle",
							mutation_outcome: "preserved-without-adjudication",
						}),
					}),
				]),
			);
		} finally {
			store.closeSync();
			fixture.cleanup();
		}
	});
});
