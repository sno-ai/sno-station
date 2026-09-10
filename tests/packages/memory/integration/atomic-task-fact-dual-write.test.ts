/** @file Proves task lifecycle and atomic fact output commit through one production write call. */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AtomicKeyedRecord } from "@/extraction/atomic-profile-keying";
import { buildAtomicWriteCards } from "@/extraction/atomic-write-projection";
import type { Embedder } from "@/extraction/embedding-provider-client";
import {
	admitTaskLifecycleAssertion,
	buildTaskLifecycleCommandClaim,
	type TaskLifecycleAssertionDraft,
} from "@/extraction/task-lifecycle-assertion";
import { resolveTaskLifecycle } from "@/extraction/task-lifecycle-resolver";
import {
	type AtomicExtractionLedgerKey,
	type AtomicExtractionRunParameters,
	type AtomicExtractionWriteInput,
	MemoryStore,
	type TaskLifecycleWriteInput,
} from "@/storage/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db";

const EXTRACTOR_VERSION = "atomic-v3-task-fact-test";
const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 2_000,
	subchunkCount: 1,
};

interface SemanticOutputCounts {
	taskLifecycle: number;
	atomicFact: number;
}

function count(
	database: TestDb["sqlite"],
	sql: string,
	...parameters: unknown[]
): number {
	return (database.prepare(sql).get(...parameters) as { count: number }).count;
}

function ledgerState(database: TestDb["sqlite"], key: AtomicExtractionLedgerKey): string {
	const row = database
		.prepare(
			"SELECT state FROM nodix_atomic_extraction_ledger WHERE conversation_id = ? AND chunk_hash = ? AND pipeline_version = ?",
		)
		.get(key.conversationId, key.chunkHash, key.pipelineVersion) as
		| { state: string }
		| undefined;
	if (!row) throw new Error("expected an atomic extraction ledger row");
	return row.state;
}

function beginRecordedChunk(
	store: MemoryStore,
	database: TestDb["sqlite"],
	key: AtomicExtractionLedgerKey,
	claim: string,
	nowMs: number,
): void {
	expect(
		store.beginAtomicExtractionChunk({
			...key,
			rawChunk: claim,
			routingSnapshotId: "atomic-task-fact-routing",
			runParameters: RUN_PARAMETERS,
			nowMs,
		}),
	).toMatchObject({ action: "run", entry: { state: "open" } });
	store.recordAtomicExtractionCalls(key, nowMs + 1);
	expect(ledgerState(database, key)).toBe("calls_recorded");
}

function prepareCombinedWrite(input: {
	store: MemoryStore;
	database: TestDb["sqlite"];
	projectId: string;
	claim: string;
	suffix: string;
	nowMs: number;
	duplicateRelation?: boolean;
}): TaskLifecycleWriteInput {
	const assertion: TaskLifecycleAssertionDraft = {
		kind: "task_lifecycle",
		action: "open_or_refine",
		projectId: input.projectId,
		subject: "user",
		description: input.claim,
		occurrenceAnchors: {},
		revisionDetails: {},
	};
	const source = {
		kind: "authorized_untraced" as const,
		sessionKey: `task-fact-session-${input.suffix}`,
		replayIdentity: `task-fact-assertion-${input.suffix}`,
		assertionOrdinal: 0,
	};
	const commandClaim = buildTaskLifecycleCommandClaim({ assertion, source });
	const admission = admitTaskLifecycleAssertion(input.store, {
		assertion,
		source,
		commandClaim,
		sessionTime: new Date(input.nowMs).toISOString(),
		firstResolutionNowMs: input.nowMs,
	});
	const ledgerKey: AtomicExtractionLedgerKey = {
		conversationId: `task-fact-conversation-${input.suffix}`,
		chunkHash: `task-fact-chunk-${input.suffix}`,
		pipelineVersion: EXTRACTOR_VERSION,
	};
	beginRecordedChunk(input.store, input.database, ledgerKey, input.claim, input.nowMs);
	const atomicRecord: AtomicKeyedRecord = {
		kind: "standing",
		category: "profile",
		claimText: input.claim,
		subject: "user",
		subjectKind: "user",
		attribute: "trait.constraint",
		value: input.claim,
		temporalPhrase: null,
		resolvedTime: null,
		importance: "medium",
		changesCurrentState: false,
		todo: "none",
		closeReason: null,
		sourceSpan: {
			turnIndex: 0,
			quote: input.claim,
			startOffset: 0,
			endOffset: input.claim.length,
		},
		relations: [{ subject: "user", predicate: "MENTIONS", object: "evening work" }],
		singleClaim: true,
		lane: "active",
		dispositionReason: null,
		resplit: false,
	};
	const [builtCard] = buildAtomicWriteCards({
		records: [atomicRecord],
		idempotencyKeys: [`task-fact-${input.suffix}`],
		sourceTurnOffset: 0,
		sessionTimestampMs: input.nowMs,
		timezone: "UTC",
	});
	if (!builtCard) throw new Error("expected one projected atomic fact card");
	const firstRelation = builtCard.relations[0];
	if (!firstRelation) throw new Error("expected the projected atomic fact relation");
	const atomicFactWrite: AtomicExtractionWriteInput = {
		ledgerKey,
		projectId: input.projectId,
		extractorVersion: EXTRACTOR_VERSION,
		nowMs: input.nowMs + 2,
		cards: [
			{
				...builtCard,
				relations: input.duplicateRelation
					? [firstRelation, firstRelation]
					: builtCard.relations,
			},
		],
	};
	return {
		admission,
		commandClaim,
		resolution: resolveTaskLifecycle({
			assertion: admission.assertion,
			instances: [],
			judgment: { status: "absent" },
		}),
		atomicFactWrite,
	};
}

function semanticOutputCounts(
	database: TestDb["sqlite"],
	projectId: string,
): SemanticOutputCounts {
	return {
		taskLifecycle: count(
			database,
			"SELECT COUNT(*) AS count FROM nodix_active_task_instances WHERE project_id = ?",
			projectId,
		),
		atomicFact: count(
			database,
			"SELECT COUNT(*) AS count FROM nodix_memories WHERE project_id = ? AND extractor_version = ?",
			projectId,
			EXTRACTOR_VERSION,
		),
	};
}

function assertBothSemanticOutputs(outputs: SemanticOutputCounts): void {
	if (outputs.taskLifecycle !== 1 || outputs.atomicFact !== 1) {
		throw new Error(
			`expected task and fact outputs, got task=${outputs.taskLifecycle} fact=${outputs.atomicFact}`,
		);
	}
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("atomic task and durable fact dual write", () => {
	let testDb: TestDb | undefined;
	let store: MemoryStore | undefined;

	afterEach(() => {
		store?.closeSync();
		testDb?.cleanup();
		store = undefined;
		testDb = undefined;
	});

	function setup(): { store: MemoryStore; database: TestDb["sqlite"] } {
		testDb = createTestDb();
		store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
		return { store, database: testDb.sqlite };
	}

	it.each([
		{
			name: "a forty-minute evening ceiling as the only content",
			claim: "I limit my evening work to forty minutes.",
		},
		{
			name: "one statement with both a live-task and durable-constraint reading",
			claim: "I can spend only forty minutes tonight finishing the release notes.",
		},
	])("commits both independent semantic outputs for $name", async ({ name, claim }) => {
		const target = setup();
		const projectId = `atomic-task-fact-${name.replace(/[^a-z]+/giu, "-")}`;
		const write = prepareCombinedWrite({
			...target,
			projectId,
			claim,
			suffix: projectId,
			nowMs: 2_000_000_000_000,
		});

		const result = await target.store.applyTaskLifecycleResolution(write);

		expect(result).toMatchObject({ result: "created_instance", replayed: false });
		expect(result.atomicFactWrite).toMatchObject({
			createdCount: 1,
			ledger: { state: "complete" },
		});
		const outputs = semanticOutputCounts(target.database, projectId);
		expect(outputs).toEqual({ taskLifecycle: 1, atomicFact: 1 });
		expect(outputs.taskLifecycle + outputs.atomicFact).toBe(2);
		expect(() => assertBothSemanticOutputs(outputs)).not.toThrow();
		const instances = target.store.readTaskLifecycleInstances(projectId);
		expect(instances).toHaveLength(1);
		expect(instances[0]?.currentDescription).toBe(claim);
		const fact = target.store.getAtomicBySubjectAttribute(
			projectId,
			"user",
			"trait.constraint",
		);
		expect(fact).toMatchObject({ text: claim, category: "profile", lane: "active" });

		const todoRows = count(
			target.database,
			"SELECT COUNT(*) AS count FROM nodix_todos WHERE project_id = ? AND status = 'open'",
			projectId,
		);
		const taskMemoryRows = count(
			target.database,
			"SELECT COUNT(*) AS count FROM nodix_memories WHERE project_id = ? AND json_valid(metadata) AND json_extract(metadata, '$.active_task_kind') IN ('task', 'projection')",
			projectId,
		);
		expect(todoRows).toBe(1);
		expect(taskMemoryRows).toBe(0);
		expect(() =>
			assertBothSemanticOutputs({ ...outputs, atomicFact: 0 }),
		).toThrow("expected task and fact outputs");
		expect(() =>
			assertBothSemanticOutputs({ ...outputs, taskLifecycle: 0 }),
		).toThrow("expected task and fact outputs");
	});

	it("rolls back task state and the atomic fact when a relation insert fails", async () => {
		const target = setup();
		const projectId = "atomic-task-fact-rollback";
		const claim = "I can spend only forty minutes tonight finishing the release notes.";
		const write = prepareCombinedWrite({
			...target,
			projectId,
			claim,
			suffix: "rollback",
			nowMs: 2_000_000_100_000,
			duplicateRelation: true,
		});
		const ledgerKey = write.atomicFactWrite?.ledgerKey;
		if (!ledgerKey) throw new Error("expected the combined write ledger key");

		await expect(target.store.applyTaskLifecycleResolution(write)).rejects.toThrow();

		expect(
			{
				commands: count(
					target.database,
					"SELECT COUNT(*) AS count FROM nodix_task_lifecycle_commands WHERE project_id = ?",
					projectId,
				),
				instances: count(
					target.database,
					"SELECT COUNT(*) AS count FROM nodix_active_task_instances WHERE project_id = ?",
					projectId,
				),
				evidence: count(
					target.database,
					"SELECT COUNT(*) AS count FROM nodix_active_task_evidence WHERE project_id = ?",
					projectId,
				),
				todos: count(
					target.database,
					"SELECT COUNT(*) AS count FROM nodix_todos WHERE project_id = ?",
					projectId,
				),
				memories: count(
					target.database,
					"SELECT COUNT(*) AS count FROM nodix_memories WHERE project_id = ?",
					projectId,
				),
			},
		).toEqual({ commands: 0, instances: 0, evidence: 0, todos: 0, memories: 0 });
		expect(ledgerState(target.database, ledgerKey)).toBe("calls_recorded");
		expect(
			target.store.getAtomicBySubjectAttribute(projectId, "user", "trait.constraint"),
		).toBeUndefined();
	});
});
