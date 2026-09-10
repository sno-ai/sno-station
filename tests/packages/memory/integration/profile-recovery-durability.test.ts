/** Real encrypted SQLite + real ONNX embedder. No model judgment is involved. */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../apps/mem-claw/src/extraction/embedding-provider-client.ts";
import {
	buildInsightMetadata,
	deriveFactKey,
	parseInsightMetadata,
	stringifyInsightMetadata,
} from "../../../../apps/mem-claw/src/extraction/memory-metadata-codec.ts";
import { runProfileSectionUpdate } from "../../../../apps/mem-claw/src/extraction/profile-section-writer.ts";
import { runWithMutationAttempt } from "../../../../apps/mem-claw/src/operations/runtime-audit-log.ts";
import type { MemoryEntry } from "../../../../apps/mem-claw/src/shared/types.ts";
import {
	MemoryStore,
	type StoreInput,
} from "../../../../apps/mem-claw/src/storage/store.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db.ts";

const PROJECT_ID = "profile-recovery-durability";
const SECTION_NAME = "identity";
const FACT_KEY = deriveFactKey({ kind: "profile", section_name: SECTION_NAME });
const START_AT = Date.parse("2026-08-03T12:00:00.000Z");

interface ProfileRecoveryEntry {
	mutationAttemptId: string;
	removedRowId: string;
	removedValue: string;
	sectionName: string;
	removedAtMs: number;
}

interface RecoveryStore {
	supersede(args: {
		create: StoreInput;
		closes: Array<{ id: string; buildMetadata: (createdId: string) => string }>;
		activeFactGuard: { factKey: string; expectedId: string };
		profileRecovery: {
			mutationAttemptId: string;
			sectionName: string;
			removedAtMs: number;
		};
	}): Promise<MemoryEntry>;
	readProfileRecoveryEntries(rowId: string): ProfileRecoveryEntry[];
}

interface Fixture {
	store: MemoryStore;
	testDb: TestDb;
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

afterAll(async () => {
	await embedder.dispose();
});

describe("profile removed-value durability", () => {
	let fixture: Fixture | undefined;

	afterEach(() => {
		fixture?.store.close();
		fixture?.testDb.cleanup();
		fixture = undefined;
	});

	function buildFixture(): Fixture {
		const testDb = createTestDb();
		return {
			store: new MemoryStore({ dbPath: testDb.dbPath, embedder }),
			testDb,
		};
	}

	function profileInput(value: string, at: number, supersedes?: string): StoreInput {
		return {
			text: `Search heading\n\n${value}`,
			category: "profile",
			projectId: PROJECT_ID,
			importance: 0.85,
			timestamp: at,
			metadata: stringifyInsightMetadata(
				buildInsightMetadata(
					{ text: value, category: "profile", timestamp: at },
					{
						l0_abstract: value,
						l1_overview: `- ${value}`,
						l2_content: value,
						section_name: SECTION_NAME,
						asserted_at: at,
						valid_from: at,
						source: "ambient-learning",
						...(supersedes === undefined ? {} : { supersedes }),
					},
				),
			),
			trusted: true,
		};
	}

	function closeMetadata(row: MemoryEntry, replacementId: string, at: number): string {
		return stringifyInsightMetadata(
			buildInsightMetadata(row, {
				...parseInsightMetadata(row.metadata, row),
				invalidated_at: at,
				superseded_by: replacementId,
			}),
		);
	}

	async function replaceProfile(
		store: MemoryStore,
		current: MemoryEntry,
		value: string,
		at: number,
		mutationAttemptId: string,
	): Promise<MemoryEntry> {
		return (store as unknown as RecoveryStore).supersede({
			create: profileInput(value, at, current.id),
			closes: [
				{
					id: current.id,
					buildMetadata: (createdId) => closeMetadata(current, createdId, at),
				},
			],
			activeFactGuard: { factKey: FACT_KEY ?? "", expectedId: current.id },
			profileRecovery: { mutationAttemptId, sectionName: SECTION_NAME, removedAtMs: at },
		});
	}

	it("retains every removed value when the independent history write fails", async () => {
		fixture = buildFixture();
		const first = await fixture.store.store(profileInput("A", START_AT));

		fixture.testDb.sqlite.exec(`
			CREATE TRIGGER fail_history_partner
			BEFORE INSERT ON nodix_memories
			WHEN NEW.category = 'episodic'
			BEGIN SELECT RAISE(ABORT, 'injected history partner failure'); END;
		`);
		await expect(
			fixture.store.store({
				text: "A became historical",
				category: "episodic",
				projectId: PROJECT_ID,
				timestamp: START_AT + 1,
				metadata: stringifyInsightMetadata(
					buildInsightMetadata(
						{ text: "A became historical", category: "episodic", timestamp: START_AT + 1 },
						{ asserted_at: START_AT + 1, source: "ambient-learning" },
					),
				),
			}),
		).rejects.toThrow("injected history partner failure");
		fixture.testDb.sqlite.exec("DROP TRIGGER fail_history_partner");

		const second = await replaceProfile(
			fixture.store,
			first,
			"B",
			START_AT + 1_000,
			"attempt-a-to-b",
		);
		const third = await replaceProfile(
			fixture.store,
			second,
			"C",
			START_AT + 2_000,
			"attempt-b-to-c",
		);

		const entries = (fixture.store as unknown as RecoveryStore).readProfileRecoveryEntries(
			third.id,
		);
		expect(entries).toEqual([
			{
				mutationAttemptId: "attempt-b-to-c",
				removedRowId: second.id,
				removedValue: "B",
				sectionName: SECTION_NAME,
				removedAtMs: START_AT + 2_000,
			},
			{
				mutationAttemptId: "attempt-a-to-b",
				removedRowId: first.id,
				removedValue: "A",
				sectionName: SECTION_NAME,
				removedAtMs: START_AT + 1_000,
			},
		]);
	});

	it("keeps the old row current when the recovery append cannot commit", async () => {
		fixture = buildFixture();
		const first = await fixture.store.store(profileInput("A", START_AT));
		fixture.testDb.sqlite.exec(`
			CREATE TRIGGER fail_profile_recovery_append
			BEFORE INSERT ON nodix_profile_recovery_entries
			BEGIN SELECT RAISE(ABORT, 'injected recovery append failure'); END;
		`);

		await expect(
			runWithMutationAttempt({
				stateDir: dirname(fixture.store.dbPath),
				event: "memory_superseded",
				operation: "profile-recovery-atomicity-test",
				writer: "profile-section",
				subject: SECTION_NAME,
				run: () =>
					replaceProfile(
						fixture?.store as MemoryStore,
						first,
						"B",
						START_AT + 1_000,
						"attempt-atomic-failure",
					),
				completedOutcome: () => ({ outcome: "committed" }),
			}),
		).rejects.toThrow("injected recovery append failure");

		const current = fixture.store.getByFactKey(PROJECT_ID, FACT_KEY ?? "");
		expect(current?.id).toBe(first.id);
		expect(current?.text).toBe("Search heading\n\nA");
		expect(
			(fixture.store as unknown as RecoveryStore).readProfileRecoveryEntries(first.id),
		).toEqual([]);
	});

	it("uses the profile writer's durable mutation attempt identifier", async () => {
		fixture = buildFixture();
		await runProfileSectionUpdate({
			scope: PROJECT_ID,
			sectionName: SECTION_NAME,
			newAssertion: "A",
			source: { sessionKey: "profile-recovery", messageId: "profile-a" },
			store: fixture.store,
			at: START_AT,
		});
		const replacement = await runProfileSectionUpdate({
			scope: PROJECT_ID,
			sectionName: SECTION_NAME,
			newAssertion: "B",
			source: { sessionKey: "profile-recovery", messageId: "profile-b" },
			store: fixture.store,
			at: START_AT + 1_000,
		});

		const entries = fixture.store.readProfileRecoveryEntries(replacement.rowId);
		const auditRecords = readFileSync(dirname(fixture.store.dbPath) + "/audit.jsonl", "utf8")
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as {
						decision?: string;
						details?: {
							audit_operation_id?: string;
							audit_phase?: string;
							mutation_subject?: string;
						};
					},
			);
		const completedAttempts = auditRecords.filter(
			(record) =>
				record.details?.audit_phase === "completed" &&
				record.details?.mutation_subject === SECTION_NAME,
		);

		expect(entries).toHaveLength(1);
		expect(entries[0]?.mutationAttemptId).toBe(
			completedAttempts.at(-1)?.details?.audit_operation_id,
		);
		expect(entries[0]?.removedValue).toBe("A");
	});

	it("records the removed value on the tombstone event path", async () => {
		fixture = buildFixture();
		const first = await fixture.store.store(profileInput("A", START_AT));
		const removedAtMs = START_AT + 1_000;
		const eventText = "Forget the saved identity.";
		const created = await fixture.store.createEventAndSupersede({
			event: {
				text: eventText,
				category: "episodic",
				projectId: PROJECT_ID,
				timestamp: removedAtMs,
				metadata: stringifyInsightMetadata(
					buildInsightMetadata(
						{ text: eventText, category: "episodic", timestamp: removedAtMs },
						{ asserted_at: removedAtMs, source: "ambient-learning" },
					),
				),
			},
			replacement: profileInput("identity: none", removedAtMs, first.id),
			closeExisting: [
				{
					id: first.id,
					buildMetadata: ({ replacementId }) =>
						closeMetadata(first, replacementId, removedAtMs),
				},
			],
			profileRecovery: {
				mutationAttemptId: "attempt-a-to-tombstone",
				sectionName: SECTION_NAME,
				removedAtMs,
			},
		});

		expect(fixture.store.readProfileRecoveryEntries(created.replacement.id)).toEqual([
			{
				mutationAttemptId: "attempt-a-to-tombstone",
				removedRowId: first.id,
				removedValue: "A",
				sectionName: SECTION_NAME,
				removedAtMs,
			},
		]);
	});
});
