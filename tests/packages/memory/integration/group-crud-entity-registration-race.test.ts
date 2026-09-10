import { expect, it } from "vitest";

import { normalizeEntityName } from "@/storage/memory-store-atomic-entity-api";
import { applyEntityNameKeyMigration } from "@/storage/entity-name-key-migration";
import { applyStateCategoryMigration } from "@/storage/state-category-migration";
import { MemoryStore } from "@/storage/store";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

it(
	"writes the second first mention under the entity that won name registration",
	{ timeout: 180_000 },
	async () => {
		const embedder = await createTestEmbedder();
		const fixture = createTestDb();
		const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		try {
			applyStateCategoryMigration(fixture.runtime.db);
			applyEntityNameKeyMigration(fixture.runtime.db);
			const projectId = "persona:group-crud-entity-registration-race";
			const normalizedName = normalizeEntityName("Acme Corp Rebrand");
			for (const [index, entityId] of [
				"entity:11111111-1111-4111-8111-111111111111",
				"entity:22222222-2222-4222-8222-222222222222",
			].entries()) {
				const ledgerKey = {
					conversationId: `conversation-registration-${index}`,
					chunkHash: `chunk-registration-${index}`,
					pipelineVersion: "group-crud-entity-registration-race",
				};
				const text = `Acme Corp Rebrand has a budget of $${index + 1},000,000.`;
				const nowMs = Date.UTC(2026, 8, 5, 5, 0) + index * 10;
				expect(store.beginAtomicExtractionChunk({
					...ledgerKey,
					rawChunk: `user: ${text}`,
					routingSnapshotId: "routing-group-crud-review",
					runParameters: { maxInputTokens: 4_096, outputTokenBudget: 4_096, subchunkCount: 1 },
					nowMs,
				})).toMatchObject({ action: "run" });
				store.recordAtomicExtractionCalls(ledgerKey, nowMs + 1);
				const result = await store.storeAtomicExtractionChunk({
					ledgerKey,
					projectId,
					extractorVersion: "group-crud-entity-registration-race",
					nowMs: nowMs + 2,
					entities: [{ entityId, displayName: "Acme Corp Rebrand", normalizedName }],
					cards: [{
						idempotencyKey: `registration-card-${index}`,
						globalTurnIndex: 0,
						endsCurrent: false,
						endedAt: null,
						text,
						category: "state",
						subject: entityId,
						attribute: "project.budget",
						timestamp: Date.UTC(2026, 5, 1, 9, 0),
						validFrom: Date.UTC(2026, 5, 1, 9, 0),
						validUntil: null,
						importance: 0.9,
						timezone: "UTC",
						lane: "active",
						dispositionReason: null,
						rawCandidateJson: null,
						metadata: { kind: "state", memory_category: "state", entity_identity_new: true },
						relations: [],
					}],
				});
				expect(result.createdCount).toBe(1);
			}
			expect(fixture.sqlite.prepare(
				"SELECT entity_id FROM nodix_memory_entities WHERE project_id = ? AND normalized_name = ?",
			).all(projectId, normalizedName)).toEqual([
				{ entity_id: "entity:11111111-1111-4111-8111-111111111111" },
			]);
			expect(fixture.sqlite.prepare(
				"SELECT subject FROM nodix_memories WHERE json_extract(metadata, '$.idempotency_key') = ?",
			).get("registration-card-1")).toEqual({
				subject: "entity:11111111-1111-4111-8111-111111111111",
			});
			expect(fixture.sqlite.prepare(
				"SELECT id FROM nodix_memories WHERE subject = ?",
			).all("entity:22222222-2222-4222-8222-222222222222")).toEqual([]);
			// Joining the winning entity makes the second card an ordinary later value of a
			// one-value attribute: it closes the first, instead of both staying current.
			const rows = fixture.sqlite.prepare(
				`SELECT json_extract(metadata, '$.idempotency_key') AS key, id,
					json_extract(metadata, '$.superseded_by') AS supersededBy,
					json_extract(metadata, '$.entity_identity_new') AS fresh
				FROM nodix_memories ORDER BY key`,
			).all() as Array<{ key: string; id: string; supersededBy: string | null; fresh: unknown }>;
			expect(rows.map(({ key }) => key)).toEqual(["registration-card-0", "registration-card-1"]);
			expect(rows[0]?.supersededBy, "the first budget stayed open beside the second").toBe(
				rows[1]?.id,
			);
			expect(rows[1]?.fresh, "the joined card still claims a fresh entity").toBeNull();
		} finally {
			try {
				await store.close();
			} finally {
				fixture.cleanup();
			}
		}
	},
);
