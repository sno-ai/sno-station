/** Four unsupplied real-route observations plus conditional real-SQLite invariants. */

import {
	getDekSync,
	openEncryptedDbReadonly,
} from "@snoai/sno-station-core-crypto";
import { closeLogger } from "@snoai/utils/logger";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Embedder } from "../../../../apps/mem-claw/src/extraction/embedding-provider-client.ts";
import {
	buildInsightMetadata,
	stringifyInsightMetadata,
} from "../../../../apps/mem-claw/src/extraction/memory-metadata-codec.ts";
import { runProfileSectionUpdate } from "../../../../apps/mem-claw/src/extraction/profile-section-writer.ts";
import { createLlmClient } from "../../../../apps/mem-claw/src/shared/llm-client.ts";
import { pluginConfigSchema } from "../../../../apps/mem-claw/src/shared/types.ts";
import { MemoryStore } from "../../../../apps/mem-claw/src/storage/store.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

const SCOPE = "profile-conflict-quarantine";
const SECTION = "identity";
const STARTED_AT = Date.parse("2025-06-01T12:00:00Z");
const OBSERVATION_COUNT = 4;
let diagnosticWrites: ReturnType<typeof vi.spyOn>;
const ROUTING = pluginConfigSchema.parse({ mode: "rem-enhanced" });
const LLM = createLlmClient({
	preset: "mem_claw/sno_ai_extract",
	routing: ROUTING,
	timeoutMs: 60_000,
});

let embedder: Embedder;

interface OfflineDispositionRow {
	id: string;
	lane: string;
	disposition_reason: string | null;
	dispositioned_at_ms: number | null;
}

beforeAll(async () => {
	diagnosticWrites = vi.spyOn(process.stderr, "write");
	embedder = await createTestEmbedder();
});

afterAll(async () => {
	await closeLogger();
	diagnosticWrites.mockRestore();
});

describe("profile conflict quarantine", () => {
	it("observes four real verdicts and proves SQLite invariants on actual blockedBy landings", async () => {
		let blockedByLandings = 0;

		for (let observation = 1; observation <= OBSERVATION_COUNT; observation++) {
			const logStart = diagnosticWrites.mock.calls.length;
			const testDb = createTestDb();
			const store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
			try {
				const blockingText =
					"The user no longer works as an independent consultant and now leads research.";
				const blockingMetadata = buildInsightMetadata(
					{ text: blockingText, category: "profile", timestamp: STARTED_AT + 86_400_000 },
					{
						section_name: SECTION,
						valid_from: STARTED_AT + 86_400_000,
						asserted_at: STARTED_AT + 86_400_000,
						source: "ambient-learning",
					},
				);
				const blockingRow = await store.store({
					text: blockingText,
					category: "profile",
					projectId: SCOPE,
					timestamp: STARTED_AT + 86_400_000,
					metadata: stringifyInsightMetadata(blockingMetadata),
					trusted: true,
				});
				testDb.sqlite
					.prepare(
						"UPDATE nodix_memories SET metadata = json_set(metadata, '$.fact_key', ?) WHERE id = ?",
					)
					.run("profile:legacy-identity-slot", blockingRow.id);

				const result = await runProfileSectionUpdate({
					scope: SCOPE,
					sectionName: SECTION,
					newAssertion: "The user works as an independent consultant.",
					evidence: "The user described their consulting work.",
					source: {
						sessionKey: "profile-conflict-quarantine-session",
						messageId: "profile-conflict-quarantine-message",
					},
					store,
					llm: LLM,
					routing: ROUTING,
					at: STARTED_AT,
					timeoutMs: 60_000,
				});
				const quarantinedRows = await store.list({
					projectId: SCOPE,
					category: "profile",
					lane: "quarantined",
					limit: 10,
				});
				const quarantinedRow = quarantinedRows.find(
					(row) => row.dispositionReason === "superseded-by-existing",
				);
				await closeLogger();
				const logOutput = diagnosticWrites.mock.calls.slice(logStart).map(([bytes]) => String(bytes)).join("");
				const terminal = logOutput.split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.event_name === "memory.profile.completed");
				expect(terminal).toHaveLength(1);
				expect(terminal[0].attributes.outcome).toBeDefined();
				const warningRecord = quarantinedRow
					? logOutput
							.split("\n")
							.find(
								(line) =>
									line.includes("WARN") &&
									line.includes("profile conflict blocked candidate quarantined") &&
									line.includes(`"candidateRowId":"${quarantinedRow.id}"`) &&
									line.includes(`"blockingRowId":"${blockingRow.id}"`),
							)
					: undefined;
				const landedBlockedBy = quarantinedRow !== undefined && warningRecord !== undefined;
				process.stdout.write(
					`[jasper] real-route observation ${observation}/${OBSERVATION_COUNT}: outcome=${result.outcome}, quarantineDisposition=${quarantinedRow !== undefined}, matchingWarn=${warningRecord !== undefined}, blockedBy=${landedBlockedBy}\n`,
				);
				if (!landedBlockedBy) continue;
				blockedByLandings++;

				const activeRows = await store.list({
					projectId: SCOPE,
					category: "profile",
					lane: "active",
					limit: 10,
				});
				expect(result).toEqual({ outcome: "no-op", rowId: blockingRow.id });
				expect(activeRows).toHaveLength(1);
				expect(activeRows[0]?.id).toBe(blockingRow.id);
				expect(quarantinedRows).toHaveLength(1);
				expect(quarantinedRow).toMatchObject({
					lane: "quarantined",
					dispositionReason: "superseded-by-existing",
				});
				expect(quarantinedRow.dispositionedAt).toBe(STARTED_AT);

				const offlineDb = openEncryptedDbReadonly(testDb.dbPath, getDekSync());
				try {
					const offlineRows = offlineDb
						.prepare<[string], OfflineDispositionRow>(
							"SELECT id, lane, disposition_reason, dispositioned_at_ms FROM nodix_memories WHERE project_id = ? ORDER BY id",
						)
						.all(SCOPE);
					expect(offlineRows).toHaveLength(2);
					expect(offlineRows.find((row) => row.id === blockingRow.id)).toMatchObject({
						lane: "active",
						disposition_reason: null,
						dispositioned_at_ms: null,
					});
					expect(offlineRows.find((row) => row.id === quarantinedRow.id)).toMatchObject({
						lane: "quarantined",
						disposition_reason: "superseded-by-existing",
						dispositioned_at_ms: STARTED_AT,
					});
					process.stdout.write(
						`[jasper] real-SQLite invariant ${observation}: rows=${offlineRows.length}, blocking=retained, incoming=quarantined, reason=${quarantinedRow.dispositionReason}, dispositionedAt=${quarantinedRow.dispositionedAt}\n`,
					);
				} finally {
					offlineDb.close();
				}
				expect(warningRecord).toContain(`"incomingSection":"${SECTION}"`);
				expect(warningRecord).toContain(`"blockingSection":"${SECTION}"`);
				expect(warningRecord).toContain('"verdict":"replacement"');
			} finally {
				await store.close();
				testDb.cleanup();
			}
		}

		process.stdout.write(
			`[jasper] real-route landing count: blockedBy=${blockedByLandings}/${OBSERVATION_COUNT}\n`,
		);
		process.stdout.write(
			`[jasper] statistical limit: N observations establish only "no failure observed in N runs"; they do not prove a universal landing rate.\n`,
		);
	});
});
