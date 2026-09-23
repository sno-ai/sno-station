/** @file observable-store-atomic-write.test.ts
 * @purpose Proves an atomic extraction write reports one memory.write per created row, the event
 *          OpenClaw phase 11 waits for; the atomic path once bypassed the observable store.
 * @boundary Real encrypted SQLite write door; only the Observe sender is replaced by a recorder.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AtomicKeyedRecord } from "../../../../packages/memory/src/engine/extraction/atomic-profile-keying";
import { buildAtomicWriteCards } from "../../../../packages/memory/src/engine/extraction/atomic-write-projection";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import type { PluginObservability } from "../../../../packages/memory/src/engine/observability/adapter";
import { ObservableMemoryStore } from "../../../../packages/memory/src/engine/observability/observable-memory-store";
import type {
	AtomicExtractionLedgerKey,
	AtomicExtractionRunParameters,
} from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db";

const PROJECT_ID = "atomic-observe-write";
const EXTRACTOR_VERSION = "atomic-v3-observe-write-test";
const SESSION_TIMESTAMP_MS = Date.UTC(2026, 8, 22, 23, 0);
const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 2_000,
	subchunkCount: 1,
};

function standingRecord(claimText: string): AtomicKeyedRecord {
	return {
		kind: "standing",
		category: "profile",
		claimText,
		subject: "user",
		subjectKind: "user",
		attribute: null,
		refusedAttribute: null,
		value: claimText,
		temporalPhrase: null,
		resolvedTime: null,
		time: { kind: "none" },
		endsCurrent: false,
		endedAt: null,
		importance: "medium",
		changesCurrentState: false,
		todo: "none",
		closeReason: null,
		sourceSpan: { turnIndex: 0, quote: claimText, startOffset: 0, endOffset: claimText.length },
		relations: [],
		singleClaim: true,
		lane: "active",
		dispositionReason: null,
		resplit: false,
	};
}

interface Emitted {
	eventType: string;
	sessionUuid?: string;
	scope?: { project_id?: string };
	payload: { key_hash: string; byte_len: number };
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("observable atomic extraction write", () => {
	let fixture: TestDb;
	let store: ObservableMemoryStore;
	let emitted: Emitted[];
	let tracked: Promise<unknown>[];

	beforeEach(() => {
		fixture = createTestDb();
		emitted = [];
		tracked = [];
		const recorder = {
			enabled: true,
			hashText: (text: string) => `hash:${text}`,
			emit: async (event: Emitted) => {
				emitted.push(event);
			},
			emitError: async () => undefined,
			trackBestEffort: (_label: string, task: () => unknown) => {
				tracked.push(Promise.resolve().then(task));
			},
		} as unknown as PluginObservability;
		store = new ObservableMemoryStore(
			{ dbPath: fixture.dbPath, embedder },
			recorder,
			() => "session-atomic",
			{ provider: "openai-compatible" } as never,
		);
	});

	afterEach(async () => {
		await store.close();
		fixture.cleanup();
	});

	it("reports every created row as memory.write", async () => {
		const key: AtomicExtractionLedgerKey = {
			conversationId: "conversation-observe-write",
			chunkHash: "chunk-observe-write",
			pipelineVersion: EXTRACTOR_VERSION,
		};
		store.beginAtomicExtractionChunk({
			...key,
			rawChunk: "raw transcript for observe write",
			routingSnapshotId: "routing-snapshot-observe-write",
			runParameters: RUN_PARAMETERS,
			nowMs: SESSION_TIMESTAMP_MS,
		});
		store.recordAtomicExtractionCalls(key, SESSION_TIMESTAMP_MS + 1);
		const cards = buildAtomicWriteCards({
			records: [
				standingRecord("The user's package manager is pnpm-7f3a."),
				standingRecord("The user prefers richer memory context."),
			],
			idempotencyKeys: ["observe-write-package-manager", "observe-write-memory-mode"],
			sourceTurnOffset: 0,
			sessionTimestampMs: SESSION_TIMESTAMP_MS,
			timezone: "UTC",
		});

		const result = await store.storeAtomicExtractionChunk({
			ledgerKey: key,
			projectId: PROJECT_ID,
			extractorVersion: EXTRACTOR_VERSION,
			nowMs: SESSION_TIMESTAMP_MS + 2,
			cards,
		});
		await Promise.all(tracked);

		expect(result.createdCount).toBe(2);
		const rows = fixture.sqlite
			.prepare("SELECT id, content_hash, text FROM nodix_memories WHERE project_id = ?")
			.all(PROJECT_ID) as Array<{ id: string; content_hash: string | null; text: string }>;
		expect(rows.map((row) => row.id).sort()).toEqual([...result.cardIds].sort());
		const writes = emitted.filter((event) => event.eventType === "memory.write");
		expect(
			writes
				.map((event) => ({
					session: event.sessionUuid,
					scope: event.scope?.project_id,
					key: event.payload.key_hash,
					bytes: event.payload.byte_len,
				}))
				.sort((a, b) => a.key.localeCompare(b.key)),
		).toEqual(
			rows
				.map((row) => ({
					session: "session-atomic",
					scope: PROJECT_ID,
					key: `hash:${row.content_hash || row.id}`,
					bytes: Buffer.byteLength(row.text, "utf8"),
				}))
				.sort((a, b) => a.key.localeCompare(b.key)),
		);
	});
});
