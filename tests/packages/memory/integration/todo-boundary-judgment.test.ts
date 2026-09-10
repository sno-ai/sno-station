/** @file todo-boundary-judgment.test.ts
 * @purpose Proves the shared model-readable boundary for to-do lifecycle decisions.
 * @boundary Real lifecycle judgment, real encrypted SQLite, and the configured extraction model.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "@/extraction/embedding-provider-client";
import { routeTaskLifecycleCandidate } from "@/extraction/task-lifecycle-route";
import { createLlmClient } from "@/shared/llm-client";
import { MemoryStore } from "@/storage/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db";
import { routeTestTask } from "./task-lifecycle-test-route";

const llm = createLlmClient({ preset: "mem_claw/sno_ai_extract", timeoutMs: 120_000 });

let embedder: Embedder;
let store: MemoryStore | undefined;
let testDb: TestDb | undefined;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

afterEach(() => {
	store?.closeSync();
	testDb?.cleanup();
	store = undefined;
	testDb = undefined;
});

describe("shared to-do boundary judgment", () => {
	it(
		"separates finishable actions from projects, goals, deliverables, and routines",
		{ timeout: 300_000 },
		async () => {
			testDb = createTestDb();
			store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
			const cases = [
				{
					text: "The project timeline is 30 months, structured into three 10-month phases for foundational research, model development, and validation/deployment preparation.",
					isTodo: false,
				},
				{
					text: "The user aims to publish at least two high-impact research papers as part of their current objectives.",
					isTodo: false,
				},
				{
					text: "A key deliverable is interactive visualization tools for model outputs.",
					isTodo: false,
				},
				{
					text: "I also need to plan my attendance for a literary event soon.",
					isTodo: true,
				},
				{
					text: "I need to plan the budget for my upcoming vacation.",
					isTodo: true,
				},
				{
					text: "I exercise at the gym every weekday.",
					isTodo: false,
				},
			] as const;

			for (const [index, testCase] of cases.entries()) {
				const result = await routeTaskLifecycleCandidate({
					projectId: `todo-boundary-${index}`,
					candidateText: testCase.text,
					confirmedTaskCandidate: true,
					source: {
						kind: "authorized_untraced",
						sessionKey: `todo-boundary-session-${index}`,
						replayIdentity: `todo-boundary-candidate-${index}`,
						assertionOrdinal: 0,
					},
					firstResolutionNowMs: 2_000 + index,
					store,
					llm,
					timeoutMs: 120_000,
				});
				expect(result.status === "routed", testCase.text).toBe(testCase.isTodo);
			}
		},
	);

	it(
		"keeps open tasks open after a later-today plan and a related purchase",
		{ timeout: 300_000 },
		async () => {
			testDb = createTestDb();
			store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
			await routeTestTask({
				store,
				projectId: "todo-boundary-later",
				action: "open_or_refine",
				description: "Review audit findings",
				replayIdentity: "open-audit-review",
				at: 3_000,
			});
			await routeTaskLifecycleCandidate({
				projectId: "todo-boundary-later",
				candidateText: "I'll review the audit findings later today.",
				confirmedTaskCandidate: true,
				source: {
					kind: "authorized_untraced",
					sessionKey: "todo-boundary-later-session",
					replayIdentity: "later-audit-review",
					assertionOrdinal: 0,
				},
				firstResolutionNowMs: 3_001,
				store,
				llm,
				timeoutMs: 120_000,
			});

			await routeTestTask({
				store,
				projectId: "todo-boundary-purchase",
				action: "open_or_refine",
				description: "Buy groceries",
				replayIdentity: "open-buy-groceries",
				at: 4_000,
			});
			const purchase = await routeTaskLifecycleCandidate({
				projectId: "todo-boundary-purchase",
				candidateText:
					"I just spent $34.27 on groceries, so I'm hoping to make some efficient meals this week.",
				confirmedTaskCandidate: false,
				source: {
					kind: "authorized_untraced",
					sessionKey: "todo-boundary-purchase-session",
					replayIdentity: "grocery-purchase",
					assertionOrdinal: 0,
				},
				firstResolutionNowMs: 4_001,
				store,
				llm,
				timeoutMs: 120_000,
			});

			expect(purchase).toEqual({ status: "none" });
			expect(store.readTaskLifecycleInstances("todo-boundary-later")[0]?.terminalAtMs).toBeUndefined();
			expect(
				store.readTaskLifecycleInstances("todo-boundary-purchase")[0]?.terminalAtMs,
			).toBeUndefined();
		},
	);
});
