import { beforeAll, describe, expect, test } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import {
	createTestDb,
	createTestEmbedder,
	type TestSqliteDatabase,
} from "../helpers/test-db.ts";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";

const SCOPE = "phase94-startup-old-category-guard";
const TIMESTAMP = Date.parse("2026-06-13T09:00:00.000Z");

let testEmbedder: Embedder;

assertLiveAgentE2EEnabled();

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("Agent 1:1 phase 94 startup old-category guard", () => {
	test(
		"rejects a pre-cutover store before reads or writes can start",
		() => {
			const testDb = createTestDb();
			let opened: MemoryStore | undefined;
			try {
				insertLegacyRow(testDb.sqlite, {
					category: "identity",
					id: "phase94-identity",
					metadata: { memory_category: "identity" },
					text: "The user works from Vancouver.",
				});
				testDb.sqlite.close();

				expect(() => {
					opened = new MemoryStore({
						dbPath: testDb.dbPath,
						embedder: testEmbedder,
					});
				}).toThrow(/offline migrator/);
			} finally {
				opened?.close();
				testDb.cleanup();
			}
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 120_000),
	);
});

function insertLegacyRow(
	sqlite: TestSqliteDatabase,
	input: {
		category: string;
		id: string;
		metadata: Record<string, unknown>;
		text: string;
	},
): void {
	sqlite
		.prepare(
			"INSERT INTO nodix_memories (id, text, category, project_id, importance, timestamp, metadata, content_hash, fact_id, timezone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'UTC')",
		)
		.run(
			input.id,
			input.text,
			input.category,
			SCOPE,
			0.7,
			TIMESTAMP,
			JSON.stringify(input.metadata),
			`legacy-hash-${input.id}`,
			`legacy-fact-${input.id}`,
		);
}
