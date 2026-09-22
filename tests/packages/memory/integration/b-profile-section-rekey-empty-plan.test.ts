import { beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { applyRekeyPlan } from "../../../../packages/memory/src/engine/extraction/b-profile-section-rekey";
import {
	buildInsightMetadata,
	stringifyInsightMetadata,
} from "../../../../packages/memory/src/engine/extraction/memory-metadata-codec";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

const NOW = Date.parse("2026-08-07T04:00:00.000Z");

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("B-profile section re-key empty plan", () => {
	it("returns the frozen empty report when a canonical row appears after planning", async () => {
		const testDb = createTestDb();
		const store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
		const projectId = "rekey-empty-plan-concurrency";
		const report = {
			sourceRows: 0,
			targetKeys: 0,
			collisions: 0,
			migrated: 0,
			merged: 0,
			rejected: 0,
			missingRawPhrase: 0,
			unchanged: 0,
			finalCount: 0,
			separatorSplitGroups: 0,
			domainPrefixSplitGroups: 0,
			crossPathSplitGroups: 0,
		};
		const plan = { report, actions: [], projectIdFilter: [projectId] };
		const metadata = stringifyInsightMetadata(
			buildInsightMetadata(
				{
					text: "The user prefers written release updates.",
					category: "profile",
					timestamp: NOW,
				},
				{
					section_name: "preferences.release_updates",
					rawTopicPhrase: "release updates",
				},
			),
		);

		try {
			testDb.sqlite
				.prepare(
					"INSERT INTO nodix_memories(id, fact_id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash) VALUES (?, ?, ?, 'profile', ?, 0.7, ?, 'UTC', ?, ?)",
				)
				.run(
					"rekey-empty-plan-live-row",
					"profile:preferences.release_updates",
					"The user prefers written release updates.",
					projectId,
					NOW,
					metadata,
					"rekey-empty-plan-live-row-hash",
				);

			expect(await applyRekeyPlan(store, plan)).toEqual(report);
		} finally {
			store.closeSync();
			testDb.cleanup();
		}
	});
});
