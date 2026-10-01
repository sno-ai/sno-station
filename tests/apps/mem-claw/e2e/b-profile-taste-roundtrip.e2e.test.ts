/** @file b-profile-taste-roundtrip.e2e.test.ts
 * @purpose Proves deterministic to-do writes and records one ungated real-model journey.
 * @boundary Registered agent_end, production atomic distiller, and real encrypted SQLite.
 */

import { writeFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AtomicGenericExtractionCompletion } from "../../../../packages/memory/src/engine/extraction/atomic-generic-extractor.ts";
import { parseAtomicExtractionReply } from "../../../../packages/memory/src/engine/extraction/atomic-extraction-reply.ts";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { memClawPlugin } from "../../../../apps/mem-claw/src/install/openclaw-plugin-runtime.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { OpenClawPluginApiHarness } from "../helpers/openclaw-harness.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

const transportState = vi.hoisted(() => ({
	realEvidencePath: process.env.QCG3_REAL_MODEL_EVIDENCE,
	scriptedReplies: [] as string[],
	realReplies: [] as Array<string | null>,
}));

vi.mock("../../../../packages/memory/src/engine/extraction/atomic-memory-extraction", async (importOriginal) => {
	const original = await importOriginal<
		typeof import("../../../../packages/memory/src/engine/extraction/atomic-memory-extraction.ts")
	>();
	return {
		...original,
		createSignedAtomicMemoryExtractionTransports: (...args: Parameters<
			typeof original.createSignedAtomicMemoryExtractionTransports
		>) => {
			if (transportState.realEvidencePath) {
				const transports = original.createSignedAtomicMemoryExtractionTransports(...args);
				return {
					...transports,
					generic: {
						async complete(
							request: Parameters<typeof transports.generic.complete>[0],
						): Promise<AtomicGenericExtractionCompletion | null> {
							const reply = await transports.generic.complete(request);
							transportState.realReplies.push(reply?.text ?? null);
							return reply;
						},
					},
				};
			}
			return {
				generic: {
					async complete(): Promise<AtomicGenericExtractionCompletion> {
						const text = transportState.scriptedReplies.shift();
						if (text === undefined) throw new Error("QCG-3 scripted reply queue is empty");
						return { text, truncated: false };
					},
				},
				profileKeying: { keyTurn: async () => [] },
				resplit: { resplit: async () => null },
				subjectGuard: {
					repairMissingHalf: async () => [],
					guardUserSubjects: async ({ records }: { records: readonly unknown[] }) =>
						records.map(() => true),
				},
			};
		},
	};
});

const OPEN_TEXT = "I plan to submit the quarterly report.";
const DONE_TEXT = 'The to-do "submit the quarterly report" is done.';
const LATER_TEXT = 'The to-do "submit the quarterly report" is still open. I\'ll do it later today.';
const TODO_DESCRIPTION = "submit the quarterly report";
const OPENED_AT = "2026-09-03T08:00:00.000Z";
const DONE_AT = "2026-09-03T16:00:00.000Z";
const LATER_AT = "2026-09-03T12:00:00.000Z";
const _CLOSE_REASON = "The to-do is done.";

function atomicRecord(input: {
	content: string;
	claimText: string;
	todo: "open" | "done" | "none";
	closeReason?: string;
}): Record<string, unknown> {
	return {
		category: input.todo === "done" ? "episodic" : "profile",
		claim_text: input.claimText,
		subject: "user",
		subject_kind: "user",
		attribute: "goal.project",
		value: TODO_DESCRIPTION,
		temporal_phrase: null,
		resolved_time: null,
		importance: "medium",
		changes_current_state: input.todo === "done",
		todo: input.todo,
		close_reason: input.closeReason ?? null,
		source_span: { turn_index: 0, quote: input.content },
		relations: [],
		single_claim: true,
	};
}

function scriptReplies(...recordsByTurn: Array<readonly Record<string, unknown>[]>): void {
	transportState.scriptedReplies = recordsByTurn.map((records) => JSON.stringify({ records }));
}

interface TodoRow {
	activeTaskId: string;
	description: string;
	status: "open" | "done" | "removed";
	closedAt: number | null;
	closeReason: string | null;
}

interface Journey {
	harness: OpenClawPluginApiHarness;
	store: MemoryStore;
	cleanup: () => void;
	agentId: string;
	sessionKey: string;
}

let testEmbedder: Embedder;
const journeys: Journey[] = [];

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

afterEach(async () => {
	for (const journey of journeys.splice(0).reverse()) {
		await journey.harness.stopServices();
		await journey.store.close();
		journey.cleanup();
	}
});

async function createJourney(label: string): Promise<Journey> {
	const fixture = createTestDb();
	const agentId = `todo-roundtrip-${label}`;
	const harness = new OpenClawPluginApiHarness(
		{
			embedding: { dimensions: 1024 },
			dbPath: fixture.dbPath,
			ambientLearning: true,
			autoRecall: false,
			selfImprovement: { enabled: false },
			sessionStrategy: "none",
			mode: "rem-enhanced",
			extraction: { llm: { preset: "mem_claw/sno_ai_extract" } },
		},
		{ runtimeAgentId: agentId },
	);
	await memClawPlugin.register(harness);
	const journey = {
		harness,
		store: new MemoryStore({ dbPath: fixture.dbPath, embedder: testEmbedder }),
		cleanup: fixture.cleanup,
		agentId,
		sessionKey: `agent:${agentId}:test`,
	};
	journeys.push(journey);
	return journey;
}

async function runTurn(journey: Journey, content: string, timestamp: string): Promise<void> {
	const handler = journey.harness.getOnHookHandler("agent_end");
	if (!handler) throw new Error("agent_end was not registered");
	await (
		handler as (
			event: unknown,
			ctx: { agentId: string; sessionKey: string; sessionTimezone: string },
		) => Promise<void>
	)(
		{
			messages: [{ role: "user", content, timestamp: Date.parse(timestamp) }],
			success: true,
		},
		{
			agentId: journey.agentId,
			sessionKey: journey.sessionKey,
			sessionTimezone: "UTC",
		},
	);
}

function readTodos(store: MemoryStore): TodoRow[] {
	return store.sqlite
		.prepare(
			`SELECT active_task_id AS activeTaskId, description, status,
				closed_at AS closedAt, close_reason AS closeReason
			FROM nodix_todos ORDER BY opened_at, active_task_id`,
		)
		.all() as TodoRow[];
}

describe.skipIf(Boolean(transportState.realEvidencePath))("to-do lifecycle round trip", () => {
	it(
		"keeps the to-do open when the user says later today",
		{ timeout: 180_000 },
		async () => {
			scriptReplies(
				[
					atomicRecord({
						content: OPEN_TEXT,
						claimText: "The user plans to submit the quarterly report.",
						todo: "open",
					}),
				],
				[
					atomicRecord({
						content: LATER_TEXT,
						claimText: "The user will submit the quarterly report later today.",
						todo: "none",
					}),
				],
			);
			const journey = await createJourney("later-today");
			await runTurn(journey, OPEN_TEXT, OPENED_AT);
			await runTurn(journey, LATER_TEXT, LATER_AT);

			expect(readTodos(journey.store)).toMatchObject([
				{
					description: "submit the quarterly report",
					status: "open",
					closedAt: null,
					closeReason: null,
				},
			]);
		},
	);
});

function recordedDecisions(raw: string | null): {
	raw: string | null;
	decisions: Array<{ todo: string; value: string; closeReason: string | null }>;
	parseError?: string;
} {
	if (raw === null) return { raw: null, decisions: [] };
	const parsed = parseAtomicExtractionReply(raw, 1);
	if (!parsed.ok) return { raw, decisions: [], parseError: parsed.reason };
	return {
		raw,
		decisions: parsed.records.map((record) => ({
			todo: record.todo,
			value: record.value,
			closeReason: record.closeReason,
		})),
	};
}

describe.runIf(Boolean(transportState.realEvidencePath))("to-do real-model record", () => {
	it("records one real extraction journey as-is", { timeout: 180_000 }, async () => {
		const journey = await createJourney("real-model-record");
		const turns = [
			{ content: OPEN_TEXT, timestamp: OPENED_AT },
			{ content: DONE_TEXT, timestamp: DONE_AT },
		] as const;
		const outcomes: Array<{ turn: string; error: string | null; todos: TodoRow[] }> = [];
		const repliesByTurn: Array<Array<string | null>> = [];
		for (const turn of turns) {
			const start = transportState.realReplies.length;
			let error: string | null = null;
			try {
				await runTurn(journey, turn.content, turn.timestamp);
			} catch (caught) {
				error = caught instanceof Error ? caught.message : String(caught);
			}
			repliesByTurn.push(transportState.realReplies.slice(start));
			outcomes.push({ turn: turn.content, error, todos: readTodos(journey.store) });
		}
		const artifact = {
			commit: process.env.QCG3_REAL_MODEL_COMMIT ?? "unknown",
			recordedAt: new Date().toISOString(),
			outcome: outcomes.at(-1)?.todos.some((todo) => todo.status === "done")
				? "pass"
				: "fail",
			turns: outcomes.map((outcome, index) => ({
				...outcome,
				modelReplies: (repliesByTurn[index] ?? []).map(recordedDecisions),
			})),
		};
		if (!transportState.realEvidencePath) throw new Error("QCG-3 evidence path is missing");
		writeFileSync(transportState.realEvidencePath, `${JSON.stringify(artifact, null, 2)}\n`, {
			flag: "wx",
		});
	});
});
