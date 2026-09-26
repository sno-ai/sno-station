/** @file task-lifecycle-hard-cut.test.ts
 * @purpose Proves that production task mutations use the typed lifecycle route after the hard cut.
 * @boundary Real SQLite and public routes; the replay-retention case injects a named target.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import {
	buildInsightMetadata,
	stringifyInsightMetadata,
} from "../../../../packages/memory/src/engine/extraction/memory-metadata-codec";
import { InsightDistiller } from "@/extraction/memory-extraction-pipeline";
import {
	routeTaskLifecycleCandidate,
	routeTaskLifecycleAssertion,
	TaskLifecycleJudgmentUnavailableError,
	type TaskLifecycleRouteInput,
} from "../../../../packages/memory/src/engine/extraction/task-lifecycle-route";
import type { TaskLifecycleAssertionDraft } from "../../../../packages/memory/src/engine/extraction/task-lifecycle-assertion";
import {
	buildTaskLifecycleCandidateSet,
	taskLifecycleCandidateSetVersion,
} from "../../../../packages/memory/src/engine/extraction/task-lifecycle-resolver";
import type { LlmClient } from "../../../../packages/memory/src/model/llm-client";
import { MemoryStore, TaskLifecycleStaleResolutionError } from "../../../../packages/memory/src/store/store";
import { _provisionKey } from "../../../../packages/sqlite-crypto/src/dek.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db";
import { createTestLlmClient } from "../../../apps/mem-claw/helpers/llm-client";

const projectId = "lifecycle-hard-cut";
const productionSourceRoot = new URL("../../../../apps/mem-claw/src/", import.meta.url);
const extractionSourceRoot = new URL("extraction/", productionSourceRoot);
const firstAt = Date.parse("2039-01-01T00:00:00.000Z");

let embedder: Embedder;
let fixture: TestDb | undefined;
let store: MemoryStore | undefined;
let cryptoDirectory: string | undefined;
let priorKeyFile: string | undefined;
let priorXdgConfigHome: string | undefined;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

afterEach(() => {
	store?.closeSync();
	fixture?.cleanup();
	store = undefined;
	fixture = undefined;
	if (priorKeyFile === undefined) delete process.env.SNO_STATION_CORE_KEY_FILE;
	else process.env.SNO_STATION_CORE_KEY_FILE = priorKeyFile;
	if (priorXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = priorXdgConfigHome;
	if (cryptoDirectory) rmSync(cryptoDirectory, { recursive: true, force: true });
	cryptoDirectory = undefined;
});

function setup(): { store: MemoryStore; sqlite: TestDb["sqlite"] } {
	cryptoDirectory = mkdtempSync(
		join(homedir(), ".local", "state", "mem-claw-lifecycle-test-"),
	);
	priorKeyFile = process.env.SNO_STATION_CORE_KEY_FILE;
	priorXdgConfigHome = process.env.XDG_CONFIG_HOME;
	process.env.SNO_STATION_CORE_KEY_FILE = join(cryptoDirectory, "key");
	process.env.XDG_CONFIG_HOME = join(cryptoDirectory, "xdg");
	_provisionKey();
	fixture = createTestDb();
	store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	return { store, sqlite: fixture.sqlite };
}

function draft(
	action: TaskLifecycleAssertionDraft["action"],
	description: string,
	occurrenceId?: string,
): TaskLifecycleAssertionDraft {
	return {
		kind: "task_lifecycle",
		action,
		projectId,
		subject: "user",
		description,
		occurrenceAnchors: occurrenceId ? { explicitOccurrenceId: occurrenceId } : {},
		revisionDetails: {},
	};
}

function input(
	target: MemoryStore,
	assertion: TaskLifecycleAssertionDraft,
	replayIdentity: string,
	at: number,
	injectTerminalTarget = false,
): TaskLifecycleRouteInput {
	const candidates = buildTaskLifecycleCandidateSet(
		{
			...assertion,
			commandId: "0".repeat(64),
			effectiveAtMs: at,
			timeSource: "first_resolution",
		},
		target.readTaskLifecycleInstances(assertion.projectId),
	);
	const terminalTarget = injectTerminalTarget ? candidates[0] : undefined;
	return {
		assertion,
		source: {
			kind: "authorized_untraced",
			sessionKey: "hard-cut-session",
			replayIdentity,
			assertionOrdinal: 0,
		},
		firstResolutionNowMs: at,
		store: target,
		...(terminalTarget === undefined
			? {}
			: {
					precomputedJudgment: {
						status: "completed" as const,
						value: {
							result: "same_instance",
							activeTaskId: terminalTarget.activeTaskId,
						},
						candidateSetVersion: taskLifecycleCandidateSetVersion(candidates),
					},
				}),
	};
}

function terminalTransitionCount(sqlite: TestDb["sqlite"]): number {
	const row = sqlite
		.prepare(
			`SELECT COUNT(*) AS count
			FROM nodix_active_task_transitions
			WHERE project_id = ? AND transition_kind IN ('complete', 'remove')`,
		)
		.get(projectId) as { count: number };
	return row.count;
}

function readProductionTypeScriptSources(
	directory: URL,
): Array<{ sourceUrl: URL; source: string }> {
	const sources: Array<{ sourceUrl: URL; source: string }> = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			sources.push(
				...readProductionTypeScriptSources(new URL(`${entry.name}/`, directory)),
			);
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			const sourceUrl = new URL(entry.name, directory);
			sources.push({ sourceUrl, source: readFileSync(sourceUrl, "utf8") });
		}
	}
	return sources;
}

describe("task lifecycle hard cut", () => {
	it("removes every legacy task mutation edge from the production route graph", () => {
		const candidateProcessor = readFileSync(
			new URL("insight-distill-candidate-processor.ts", extractionSourceRoot),
			"utf8",
		);
		const taskLifecycleRoute = readFileSync(
			new URL("task-lifecycle-route.ts", extractionSourceRoot),
			"utf8",
		);
		const taskLifecycleSkill = readFileSync(
			new URL(
				"../../../../packages/memory/skills/judge-task-lifecycle/SKILL.md",
				import.meta.url,
			),
			"utf8",
		);
		const profileWriter = readFileSync(
			new URL("profile-section-writer.ts", extractionSourceRoot),
			"utf8",
		);
		expect(candidateProcessor).not.toContain("routeExtractedTaskCompletion");
		expect(candidateProcessor).toContain("routeTaskLifecycleCandidate");
		expect(candidateProcessor).not.toContain("parseTaskLifecycleAssertionDraft");
		const publicRoute = profileWriter.slice(
			profileWriter.indexOf("export async function runProfileSectionUpdate"),
			profileWriter.indexOf("async function runProfileSectionUpdateOnce"),
		);
		expect(publicRoute).toContain("runTypedActiveTaskUpdate");
		expect(publicRoute).not.toContain("runActiveTasksUpdate");
		expect(profileWriter).not.toContain(
			"export async function routeExtractedTaskCompletion",
		);
		expect(taskLifecycleRoute).toContain('callId: "T1"');
		expect(taskLifecycleRoute.match(/\.completeJson</gu)).toHaveLength(1);
		expect(taskLifecycleRoute).not.toContain("parseTaskLifecycleAssertionDraft");
		expect(taskLifecycleRoute.match(/callId: "/gu)).toHaveLength(1);
		expect(taskLifecycleRoute).toContain("TASK_LIFECYCLE_JUDGMENT_SKILL");
		expect(taskLifecycleRoute).not.toContain(
			"A candidate that reports a task as finished, cancelled, or already handled never opens one.",
		);
		expect(taskLifecycleRoute).not.toContain(
			"read Active tasks for the same task worded differently",
		);
		expect(taskLifecycleSkill).toContain(
			"A candidate that reports a task as finished, cancelled, or already handled never opens one.",
		);
		expect(taskLifecycleSkill).toContain("Match tasks by meaning, not exact wording.");
		const registry = readFileSync(
			new URL("../../../../packages/memory/config/b-profile-section-registry.json", import.meta.url),
			"utf8",
		);
		expect(registry).not.toContain('"task_lifecycle"');
		const removedLegacyPatterns = [
			...[
				"routeExtractedTaskCompletion",
				"runActiveTasksUpdate",
				"openTask",
				"completeTask",
				"matchTask",
				"bestTokenOverlap",
				"findCompletionByAssertion",
				"findCompletionByIdempotencyKey",
				"findCompletedTaskHistory",
				"migrateLegacyActiveTaskLedgers",
				"activeTaskStoreInput",
				"recomputeActiveTaskProjection",
				"activeTaskProjectionInput",
				"taskSourceId",
				"completionIdempotencyKey",
				"findCompletionBySourceMessageId",
			].map((symbol) => ({
				symbol,
				pattern: new RegExp(`\\b${symbol}\\b`, "u"),
			})),
			{ symbol: "taskId", pattern: /\btaskId\s*\(/u },
		];
		const productionSources = readProductionTypeScriptSources(productionSourceRoot);
		expect(productionSources.length).toBeGreaterThan(0);
		const reappearances = productionSources.flatMap(({ sourceUrl, source }) =>
			removedLegacyPatterns
				.filter(({ pattern }) => pattern.test(source))
				.map(({ symbol }) => `${symbol} in ${sourceUrl.pathname}`),
		);
		expect(
			reappearances,
			`Removed legacy task mutation symbols reappeared:\n${reappearances.join("\n")}`,
		).toEqual([]);
	});

	it("rejects every generic metadata mutation of a legacy task row", async () => {
		const { store: target, sqlite } = setup();
		const rowId = "legacy-task-row";
		const metadata = stringifyInsightMetadata(
			buildInsightMetadata(
				{ text: "legacy task", category: "profile", timestamp: firstAt },
				{
					section_name: "active_tasks",
					source: "legacy",
					active_task_kind: "task",
					active_task_id: rowId,
					active_task_origin: {
						kind: "legacy",
						omnibus_row_id: "legacy-ledger",
						item_index: 0,
						legacy_item_id: rowId,
					},
					active_task_status: "active",
					active_task_created_at: firstAt,
					active_task_transitioned_at: firstAt,
					active_task_lifecycle: [
						{ from: null, to: "active", at: firstAt, source_id: "legacy-source" },
					],
				},
			),
		);
		sqlite
			.prepare(
				`INSERT INTO nodix_memories(
					id, fact_id, text, category, project_id, importance, timestamp,
					timezone, metadata, content_hash, lane
				) VALUES (?, ?, 'legacy task', 'profile', ?, 0.7, ?, 'UTC', ?, ?, 'active')`,
			)
			.run(rowId, rowId, projectId, firstAt, metadata, "legacy-task-content-hash");

		await expect(
			target.update(rowId, { metadata, writerAuthority: "profile-writer" }),
		).rejects.toThrow("read-only after the lifecycle hard cut");
		await expect(target.updateMetadata(rowId, { tier: "core" })).rejects.toThrow(
			"read-only after the lifecycle hard cut",
		);
		await expect(target.updateTier(rowId, "core")).rejects.toThrow(
			"storage axis mutations require offline-family authority",
		);
		await expect(target.applyMetadataDelta(rowId, () => ({ tier: "core" }))).rejects.toThrow(
			"read-only after the lifecycle hard cut",
		);
		await expect(
			target.applyMetadataDeltas([
				{ memoryId: rowId, deltaFn: () => ({ tier: "core" }) },
			]),
		).rejects.toThrow("read-only after the lifecycle hard cut");
		await expect(
			target.resolveReflectionItem(rowId, {
				writerAuthority: "offline-family",
				resolvedAt: firstAt + 1,
			}),
		).rejects.toThrow("read-only after the lifecycle hard cut");
		expect(
			(
				sqlite
					.prepare("SELECT metadata FROM nodix_memories WHERE id = ?")
					.get(rowId) as { metadata: string }
			).metadata,
		).toBe(metadata);
	});

	it("keeps an unavailable ambiguous terminal judgment mutation-free", async () => {
		const target = setup().store;
		await routeTaskLifecycleAssertion(
			input(target, draft("open_or_refine", "file the permit renewal"), "open-a", firstAt),
		);
		await routeTaskLifecycleAssertion(
			input(
				target,
				draft("open_or_refine", "file the permit renewal"),
				"open-b",
				firstAt + 1,
			),
		);
		const result = await routeTaskLifecycleAssertion(
			input(
				target,
				draft("complete", "file the permit renewal"),
				"ambiguous-terminal",
				firstAt + 2,
			),
		);
		expect(result.write).toMatchObject({
			result: "uncertain",
			activeTaskId: null,
			activeTaskRevisionId: null,
		});
		expect(terminalTransitionCount(setupResult(fixture).sqlite)).toBe(0);
	});

	it("fails loudly without a lifecycle judgment and leaves active state unchanged", async () => {
		const { store: target, sqlite } = setup();
		await routeTaskLifecycleAssertion(
			input(
				target,
				draft("open_or_refine", "prepare the permit renewal"),
				"open-before-unavailable",
				firstAt,
			),
		);
		await expect(
			routeTaskLifecycleCandidate({
				projectId,
				candidateText: "The permit renewal was successfully arranged.",
				confirmedTaskCandidate: false,
				source: {
					kind: "authorized_untraced",
					sessionKey: "hard-cut-session",
					replayIdentity: "unavailable-semantic-judgment",
					assertionOrdinal: 0,
				},
				firstResolutionNowMs: firstAt + 1,
				store: target,
			}),
		).rejects.toBeInstanceOf(TaskLifecycleJudgmentUnavailableError);
		expect(terminalTransitionCount(sqlite)).toBe(0);
		const instances = target.readTaskLifecycleInstances(projectId);
		expect(instances).toEqual([
			expect.objectContaining({
				currentDescription: "prepare the permit renewal",
			}),
		]);
		expect(instances[0]).not.toHaveProperty("terminalAtMs");
	});

	it("completes the model-selected task when final assertion ranking changes", async () => {
		const target = setup().store;
		const first = await routeTaskLifecycleAssertion(
			input(
				target,
				draft("open_or_refine", "Book dentist appointment", "dentist-appointment"),
				"open-dentist-appointment",
				firstAt,
			),
		);
		await routeTaskLifecycleAssertion(
			input(
				target,
				draft("open_or_refine", "Call dentist office about billing", "dentist-billing"),
				"open-dentist-billing",
				firstAt + 1,
			),
		);
		if (!first.write.activeTaskId) throw new Error("expected first active task identifier");
		const llm = createTestLlmClient({
			completeJson: async <T>() =>
				({ action: "complete", taskId: first.write.activeTaskId }) as T,
		});

		const completed = await routeTaskLifecycleCandidate({
			projectId,
			candidateText: "I am done with the dentist",
			confirmedTaskCandidate: false,
			source: {
				kind: "authorized_untraced",
				sessionKey: "hard-cut-session",
				replayIdentity: "complete-selected-dentist-task",
				assertionOrdinal: 0,
			},
			firstResolutionNowMs: firstAt + 2,
			store: target,
			llm,
		});

		expect(completed).toMatchObject({
			status: "routed",
			result: {
				write: { result: "completed", activeTaskId: first.write.activeTaskId },
			},
		});
	});

	it("rejudges a none verdict when the active task set changes", async () => {
		const target = setup().store;
		await routeTaskLifecycleAssertion(
			input(
				target,
				draft("open_or_refine", "Review the unrelated budget", "unrelated-budget"),
				"open-unrelated-budget",
				firstAt,
			),
		);
		let judgments = 0;
		let lateTaskId: string | undefined;
		const llm = createTestLlmClient({
			completeJson: async <T>() => {
				judgments += 1;
				if (judgments === 1) {
					const late = await routeTaskLifecycleAssertion(
						input(
							target,
							draft("open_or_refine", "Publish the quarterly plan", "quarterly-plan"),
							"open-quarterly-plan",
							firstAt + 1,
						),
					);
					lateTaskId = late.write.activeTaskId ?? undefined;
					return { action: "none", taskId: null } as T;
				}
				return { action: "complete", taskId: lateTaskId ?? null } as T;
			},
		});

		const completed = await routeTaskLifecycleCandidate({
			projectId,
			candidateText: "The quarterly plan was published",
			confirmedTaskCandidate: false,
			source: {
				kind: "authorized_untraced",
				sessionKey: "hard-cut-session",
				replayIdentity: "complete-late-quarterly-plan",
				assertionOrdinal: 0,
			},
			firstResolutionNowMs: firstAt + 2,
			store: target,
			llm,
		});

		expect(judgments).toBe(2);
		expect(completed).toMatchObject({
			status: "routed",
			result: { write: { result: "completed", activeTaskId: lateTaskId } },
		});
	});

	it("keeps model-selected anchored refinements versioned", async () => {
		const target = setup().store;
		const opened = await routeTaskLifecycleAssertion(
			input(
				target,
				draft("open_or_refine", "Prepare the anchored release", "anchored-release"),
				"open-anchored-release",
				firstAt,
			),
		);
		if (!opened.write.activeTaskId) throw new Error("expected anchored task identifier");
		const llm = createTestLlmClient({
			completeJson: async <T>() =>
				({ action: "open_or_refine", taskId: opened.write.activeTaskId }) as T,
		});

		const refined = await routeTaskLifecycleCandidate({
			projectId,
			candidateText: "The anchored release now has updated details",
			confirmedTaskCandidate: true,
			occurrenceAnchors: { explicitOccurrenceId: "anchored-release" },
			source: {
				kind: "authorized_untraced",
				sessionKey: "hard-cut-session",
				replayIdentity: "refine-anchored-release",
				assertionOrdinal: 0,
			},
			firstResolutionNowMs: firstAt + 1,
			store: target,
			llm,
		});

		expect(refined).toMatchObject({
			status: "routed",
			result: {
				resolution: {
					result: "same_instance",
					candidateSetVersion: expect.any(String),
				},
			},
		});
		expect(target.readTaskLifecycleInstances(projectId)).toEqual([
			expect.objectContaining({
				activeTaskId: opened.write.activeTaskId,
				currentDescription: "The anchored release now has updated details",
			}),
		]);
	});

	it("continues the extraction batch after one malformed task judgment", async () => {
		const target = setup().store;
		await routeTaskLifecycleAssertion(
			input(
				target,
				draft("open_or_refine", "Review the deployment plan", "deployment-plan"),
				"open-deployment-plan",
				firstAt,
			),
		);
		let taskJudgments = 0;
		const llm = createTestLlmClient({
			completeJson: async <T>(request: Parameters<LlmClient["completeJson"]>[0]) => {
				if (request.callId === "T1") {
					taskJudgments += 1;
					return (taskJudgments === 1
						? { malformed: true }
						: { action: "none", taskId: null }) as T;
				}
				return null as T;
			},
		});
		const extractor = new InsightDistiller(target, embedder, llm, {
			defaultScope: projectId,
		});

		const stats = await extractor.extractAndPersist(
			"The deployment review started and the notes were shared.",
			"hard-cut-batch",
			{ scope: projectId, sessionDateTime: "2039-01-01T00:00:01.000Z" },
		);

		expect(taskJudgments).toBe(2);
		expect(stats).toMatchObject({ created: 2, processingFailures: 1 });
	});

	it("rejects distinct and same-task writes when the judged snapshot is stale", async () => {
		const target = setup().store;
		await routeTaskLifecycleAssertion(
			input(
				target,
				draft("open_or_refine", "Review the existing roadmap", "existing-roadmap"),
				"open-existing-roadmap",
				firstAt,
			),
		);
		const judgedInstances = target.readTaskLifecycleInstances(projectId);
		await routeTaskLifecycleAssertion(
			input(
				target,
				draft("open_or_refine", "Review the concurrent roadmap", "concurrent-roadmap"),
				"open-concurrent-roadmap",
				firstAt + 1,
			),
		);
		const assertion = draft("open_or_refine", "Prepare a separate launch checklist");
		const candidates = buildTaskLifecycleCandidateSet(
			{
				...assertion,
				commandId: "0".repeat(64),
				effectiveAtMs: firstAt + 2,
				timeSource: "first_resolution",
			},
			judgedInstances,
		);

		await expect(
			routeTaskLifecycleAssertion({
				assertion,
				source: {
					kind: "authorized_untraced",
					sessionKey: "hard-cut-session",
					replayIdentity: "stale-distinct-task",
					assertionOrdinal: 0,
				},
				firstResolutionNowMs: firstAt + 2,
				store: target,
				precomputedInstances: judgedInstances,
				precomputedJudgment: {
					status: "completed",
					value: { result: "distinct_instance" },
					candidateSetVersion: taskLifecycleCandidateSetVersion(candidates),
				},
			}),
		).rejects.toBeInstanceOf(TaskLifecycleStaleResolutionError);

		const selected = candidates[0];
		if (!selected) throw new Error("expected a judged task candidate");
		const sameAssertion = {
			...assertion,
			description: "Revise the existing roadmap details",
		};
		const sameCandidates = buildTaskLifecycleCandidateSet(
			{
				...sameAssertion,
				commandId: "0".repeat(64),
				effectiveAtMs: firstAt + 2,
				timeSource: "first_resolution",
			},
			judgedInstances,
		);
		await expect(
			routeTaskLifecycleAssertion({
				assertion: sameAssertion,
				source: {
					kind: "authorized_untraced",
					sessionKey: "hard-cut-session",
					replayIdentity: "stale-same-task",
					assertionOrdinal: 0,
				},
				firstResolutionNowMs: firstAt + 2,
				store: target,
				precomputedInstances: judgedInstances,
				precomputedJudgment: {
					status: "completed",
					value: {
						result: "same_instance",
						activeTaskId: selected.activeTaskId,
					},
					candidateSetVersion: taskLifecycleCandidateSetVersion(sameCandidates),
				},
			}),
		).rejects.toBeInstanceOf(TaskLifecycleStaleResolutionError);
	});

	it("replays through durable command binding after more than 50 terminal events", async () => {
		const { store: target, sqlite } = setup();
		let replayInput: TaskLifecycleRouteInput | undefined;
		let firstResult: Awaited<ReturnType<typeof routeTaskLifecycleAssertion>> | undefined;
		for (let index = 0; index < 51; index++) {
			process.stdout.write(`HARD_CUT_TERMINAL ${index + 1}/51\n`);
			const occurrenceId = `occurrence-${index}`;
			await routeTaskLifecycleAssertion(
				input(
					target,
					draft("open_or_refine", "archive the monthly report", occurrenceId),
					`open-${index}`,
					firstAt + index * 2,
				),
			);
			const terminal = input(
				target,
				draft("complete", "archive the monthly report", occurrenceId),
				`complete-${index}`,
				firstAt + index * 2 + 1,
				true,
			);
			const result = await routeTaskLifecycleAssertion(terminal);
			if (index === 0) {
				replayInput = terminal;
				firstResult = result;
			}
		}
		if (!replayInput || !firstResult) throw new Error("missing replay fixture");
		expect(terminalTransitionCount(sqlite)).toBe(51);
		const before = sqlite
			.prepare(
				"SELECT COUNT(*) AS count FROM nodix_task_lifecycle_commands WHERE project_id = ?",
			)
			.get(projectId);
		const replay = await routeTaskLifecycleAssertion(replayInput);
		expect(replay.write).toEqual({ ...firstResult.write, replayed: true });
		expect(
			sqlite
				.prepare(
					"SELECT COUNT(*) AS count FROM nodix_task_lifecycle_commands WHERE project_id = ?",
				)
				.get(projectId),
		).toEqual(before);
		expect(terminalTransitionCount(sqlite)).toBe(51);
	});
});

function setupResult(current: TestDb | undefined): TestDb {
	if (!current) throw new Error("hard-cut fixture is not initialized");
	return current;
}
