/** @file task-lifecycle-mutation-discipline-real-route.test.ts
 * @purpose Proves model-addressed task completion, stale-set refusal, and three-writer convergence.
 * @boundary Real Sno model calls and fresh encrypted SQLite; wrappers only synchronize real replies.
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
	routeTaskLifecycleAssertion,
	routeTaskLifecycleCandidate,
	TaskLifecycleJudgmentUnavailableError,
} from "../../../../packages/sno-station-mem/src/engine/extraction/task-lifecycle-route";
import {
	createLlmClient,
	type LlmClient,
	type MemoryLlmRequest,
} from "../../../../packages/sno-station-mem/src/model/llm-client";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store";
import { requireEnv } from "../helpers/env";
import { createTestDb, createTestEmbedder } from "../helpers/test-db";

const repeatLabel = process.env.TASK_LIFECYCLE_REPEAT ?? "manual";
const firstAt = Date.parse("2026-08-04T11:00:00.000Z");

function realClient(): LlmClient {
	return createLlmClient({
		apiKey: requireEnv("SNO_MEM_CLAW_LLM_INTERNAL_KEY"),
		preset: "mem_claw/sno_ai_extract",
		timeoutMs: 90_000,
	});
}

function forwardingClient(
	base: LlmClient,
	completeJson: <T>(request: MemoryLlmRequest, forward: () => Promise<T>) => Promise<T>,
): LlmClient {
	return {
		completeJson: <T>(request: MemoryLlmRequest) =>
			completeJson(request, () => base.completeJson<T>(request)),
		completeText: (request) => base.completeText(request),
		getResolvedConfig: () => base.getResolvedConfig(),
		getLastError: () => base.getLastError(),
		getLastUsage: () => base.getLastUsage(),
	};
}

function trackedClient(base: LlmClient, label: string, expectedCalls: number): LlmClient {
	const startedAt = Date.now();
	let completedCalls = 0;
	return forwardingClient(base, async (_request, forward) => {
		const response = await forward();
		completedCalls += 1;
		const elapsedSeconds = Math.max((Date.now() - startedAt) / 1_000, 0.001);
		const callsPerSecond = completedCalls / elapsedSeconds;
		const remaining = Math.max(expectedCalls - completedCalls, 0);
		process.stdout.write(
			`TASK_LIFECYCLE_MODEL ${label} ${completedCalls}/${expectedCalls} ${callsPerSecond.toFixed(2)} calls/sec ETA ${Math.ceil(remaining / callsPerSecond)}s\n`,
		);
		return response;
	});
}

async function openTask(
	store: MemoryStore,
	projectId: string,
	description: string,
	ordinal: number,
): Promise<string> {
	const result = await routeTaskLifecycleAssertion({
		assertion: {
			kind: "task_lifecycle",
			action: "open_or_refine",
			projectId,
			subject: "user",
			description,
			occurrenceAnchors: { explicitOccurrenceId: `task-${ordinal}` },
			revisionDetails: {},
		},
		source: {
			kind: "authorized_untraced",
			sessionKey: `${projectId}-open`,
			replayIdentity: `open-${ordinal}`,
			assertionOrdinal: ordinal,
		},
		firstResolutionNowMs: firstAt + ordinal,
		store,
	});
	if (!result.write.activeTaskId) throw new Error("expected an active task identifier");
	return result.write.activeTaskId;
}

function activeIds(store: MemoryStore, projectId: string): string[] {
	return store
		.readTaskLifecycleInstances(projectId)
		.filter((instance) => instance.terminalAtMs === undefined)
		.map((instance) => instance.activeTaskId)
		.toSorted();
}

function terminalTaskAudit(store: MemoryStore): Array<Record<string, unknown>> {
	const auditPath = `${dirname(store.dbPath)}/audit.jsonl`;
	return readFileSync(auditPath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((record) => {
			const details = record.details as Record<string, unknown> | undefined;
			return (
				details?.mutation_writer === "task-lifecycle" &&
				details.audit_phase === "completed"
			);
		});
}

describe(`task lifecycle mutation discipline real route ${repeatLabel}`, () => {
	it("uses ordinary none, names the completed task, and refuses stale task sets", async () => {
		const fixture = createTestDb();
		const store = new MemoryStore({
			dbPath: fixture.dbPath,
			embedder: await createTestEmbedder(),
		});
		const llm = trackedClient(realClient(), `acc5-${repeatLabel}`, 5);
		try {
			const noCloseScope = `task-none-${repeatLabel}`;
			const noCloseId = await openTask(store, noCloseScope, "Write the completion report", 1);
			const noClose = await routeTaskLifecycleCandidate({
				projectId: noCloseScope,
				candidateText: "Write the completion report",
				confirmedTaskCandidate: false,
				source: {
					kind: "authorized_untraced",
					sessionKey: noCloseScope,
					replayIdentity: "completion-word-inside-task",
					assertionOrdinal: 0,
				},
				firstResolutionNowMs: firstAt + 10,
				store,
				llm,
			});
			expect(noClose.status).toBe("none");
			expect(activeIds(store, noCloseScope)).toEqual([noCloseId]);

			const completeScope = `task-complete-${repeatLabel}`;
			const completeId = await openTask(store, completeScope, "Write the quarterly report", 2);
			const completed = await routeTaskLifecycleCandidate({
				projectId: completeScope,
				candidateText: "The quarterly report is done.",
				confirmedTaskCandidate: false,
				source: {
					kind: "authorized_untraced",
					sessionKey: completeScope,
					replayIdentity: "report-done",
					assertionOrdinal: 0,
				},
				firstResolutionNowMs: firstAt + 20,
				store,
				llm,
			});
			expect(completed).toMatchObject({
				status: "routed",
				result: { write: { result: "completed", activeTaskId: completeId } },
			});
			expect(activeIds(store, completeScope)).toEqual([]);

			const staleScope = `task-stale-${repeatLabel}`;
			const staleId = await openTask(store, staleScope, "Write the audit report", 3);
			let driftOrdinal = 0;
			const changingClient = forwardingClient(llm, async (_request, forward) => {
				const response = await forward();
				driftOrdinal += 1;
				await openTask(
					store,
					staleScope,
					`Review drift item ${driftOrdinal}`,
					10 + driftOrdinal,
				);
				return response;
			});
			await expect(
				routeTaskLifecycleCandidate({
					projectId: staleScope,
					candidateText: "The audit report is done.",
					confirmedTaskCandidate: false,
					source: {
						kind: "authorized_untraced",
						sessionKey: staleScope,
						replayIdentity: "stale-report-done",
						assertionOrdinal: 0,
					},
					firstResolutionNowMs: firstAt + 30,
					store,
					llm: changingClient,
				}),
			).rejects.toBeInstanceOf(TaskLifecycleJudgmentUnavailableError);
			expect(activeIds(store, staleScope)).toContain(staleId);
			expect(driftOrdinal).toBe(3);
			const audits = terminalTaskAudit(store);
			expect(audits.map((record) => record.decision)).toEqual(
				expect.arrayContaining([
					"no-mutation",
					"committed",
					"preserved-without-adjudication",
				]),
			);
		} finally {
			store.closeSync();
			fixture.cleanup();
		}
	});

	it("rejudges after collisions until three distinct completions land", async () => {
		const fixture = createTestDb();
		const store = new MemoryStore({
			dbPath: fixture.dbPath,
			embedder: await createTestEmbedder(),
		});
		try {
			const projectId = `task-concurrent-${repeatLabel}`;
			const taskDescriptions = [
				"Submit the solar permit",
				"Publish the lunar schedule",
				"Approve the harbor budget",
			] as const;
			const taskIds = await Promise.all(
				taskDescriptions.map((description, index) =>
					openTask(store, projectId, description, index + 1),
				),
			);
			const remainderId = await openTask(store, projectId, "Review the annual roadmap", 9);
			const base = trackedClient(realClient(), `acc6-${repeatLabel}`, 6);
			let initialReplies = 0;
			let releaseInitial: (() => void) | undefined;
			const initialBarrier = new Promise<void>((resolve) => {
				releaseInitial = resolve;
			});
			const synchronized = forwardingClient(base, async (_request, forward) => {
				const response = await forward();
				const position = initialReplies;
				initialReplies += 1;
				if (initialReplies === 3) releaseInitial?.();
				if (position < 3) await initialBarrier;
				return response;
			});
			const results = await Promise.all(
				taskDescriptions.map((description, index) =>
					routeTaskLifecycleCandidate({
						projectId,
						candidateText: `${description} is done.`,
						confirmedTaskCandidate: false,
						source: {
							kind: "authorized_untraced",
							sessionKey: projectId,
							replayIdentity: `concurrent-complete-${index}`,
							assertionOrdinal: index,
						},
						firstResolutionNowMs: firstAt + 100 + index,
						store,
						llm: synchronized,
					}),
				),
			);
			for (const [index, result] of results.entries()) {
				expect(result).toMatchObject({
					status: "routed",
					result: {
						write: { result: "completed", activeTaskId: taskIds[index] },
					},
				});
			}
			expect(
				results.reduce(
					(sum, result) =>
						sum + (result.status === "routed" ? result.result.conflictRetries : 0),
					0,
				),
			).toBeGreaterThanOrEqual(2);
			expect(activeIds(store, projectId)).toEqual([remainderId]);
		} finally {
			store.closeSync();
			fixture.cleanup();
		}
	});
});
