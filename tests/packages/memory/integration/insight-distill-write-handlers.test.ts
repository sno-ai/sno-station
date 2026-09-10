/** @file insight-distill-write-handlers.test.ts
 * @purpose Proves the insight-distill write path stores the subject date without moving the
 *   assertion chronology away from the session.
 * @boundary insight-distill write actions -> MemoryStore.store -> encrypted SQLite. Real ONNX
 *   embedder, real encrypted SQLite, zero mocks.
 *
 * The `handleContextualize` and `handleContradict` cases that used to live here were removed on
 * 2026-08-28 by owner ruling: the `lesson` category is not enabled yet, only the offline REM path
 * will ever write it, and the write-authority rule refuses a lesson from this path by design. There
 * is nothing to test until that feature is built, and the handlers themselves have no caller in
 * `apps/` — they are scaffolding for that future work and were left in place.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts";
import {
	handleContextualize,
	handleContradict,
	storeCandidate,
} from "../../../../packages/sno-station-mem/src/engine/extraction/insight-distill-write-actions.ts";
import {
	buildInsightMetadata,
	stringifyInsightMetadata,
} from "../../../../packages/sno-station-mem/src/engine/extraction/memory-metadata-codec.ts";
import type { CandidateMemory } from "../../../../packages/sno-station-mem/src/engine/shared/types.ts";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

let testEmbedder: Embedder;

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

interface Fixture {
	store: MemoryStore;
	sqlite: ReturnType<typeof createTestDb>["sqlite"];
	cleanup: () => void;
}

function buildFixture(): Fixture {
	const testDb = createTestDb();
	const store = new MemoryStore({ dbPath: testDb.dbPath, embedder: testEmbedder });
	function cleanup(): void {
		store.close();
		testDb.cleanup();
	}
	return { store, sqlite: testDb.sqlite, cleanup };
}

/** Every memory id on disk except the supplied match row. */
function otherMemoryIds(
	sqlite: ReturnType<typeof createTestDb>["sqlite"],
	matchId: string,
): string[] {
	const rows = sqlite
		.prepare("SELECT id FROM nodix_memories WHERE id != ?")
		.all(matchId) as Array<{ id: string }>;
	return rows.map((r) => r.id);
}

const EXISTING_FACT = "The deploy pipeline runs the unit suite before publishing.";

const CONTEXTUALIZE_CANDIDATE: CandidateMemory = {
	category: "lesson",
	abstract: "The unit suite is skipped for docs-only changes to keep deploys fast.",
	overview: "- Docs-only changes skip the unit suite during deploy.",
	content:
		"For docs-only changes the deploy pipeline skips the unit suite, because no executable code changed.",
	antiPatternSignature: "docs-only-deploy-skip-unit-suite",
};

const CONTRADICT_CANDIDATE: CandidateMemory = {
	category: "lesson",
	abstract: "The deploy pipeline no longer runs the unit suite before publishing.",
	overview: "- The pre-publish unit suite gate was removed from the deploy pipeline.",
	content:
		"The deploy pipeline stopped running the unit suite before publishing after the gate moved to CI.",
	antiPatternSignature: "deploy-pipeline-unit-suite-gate-removed",
};

const CONTEXT_LABEL = "deploy-pipeline";
const SESSION_DATE_TIME = "2026-08-28T10:15:00-07:00";
const SESSION_TIMESTAMP = Date.parse(SESSION_DATE_TIME);

describe("insight-distill non-merge write handlers (§3.5 Item 4)", () => {
	let fixture: Fixture | undefined;

	beforeEach(() => {
		fixture = undefined;
	});

	afterEach(() => {
		fixture?.cleanup();
	});

	async function storeMatchRow(store: MemoryStore): Promise<string> {
		const vector = await testEmbedder.embed(EXISTING_FACT);
		const metadata = stringifyInsightMetadata(
			buildInsightMetadata(
				{ text: EXISTING_FACT, category: "lesson" },
				{ anti_pattern_signature: "deploy-pipeline-unit-suite-before-publish" },
			),
		);
		const stored = await store.store({
			text: EXISTING_FACT,
			vector,
			category: "lesson",
			projectId: "global",
			importance: 0.6,
			metadata,
		});
		return stored.id;
	}

	it("stores the subject date without moving assertion chronology away from the session", async () => {
		fixture = buildFixture();
		const { store } = fixture;
		const candidate: CandidateMemory = {
			category: "episodic",
			abstract: "The deployment failed on 2025-03-01.",
			overview: "- The deployment failed on 2025-03-01.",
			content: "The deployment failed on 2025-03-01 after the health check timed out.",
			temporalPhrase: "2025-03-01",
		};
		const vector = await testEmbedder.embed(`${candidate.abstract} ${candidate.content}`);

		const { entry } = await storeCandidate({
			store,
			candidate,
			vector,
			sessionKey: "subject-date-assertion-time",
			targetScope: "global",
			sessionDateTime: SESSION_DATE_TIME,
			sessionTimezone: "America/Los_Angeles",
		});

		const metadata = await store.getMemoryMetadata(entry.id);
		expect(entry).toMatchObject({
			timestamp: Date.parse("2025-03-01T00:00:00.000Z"),
			timezone: "user",
		});
		expect(metadata).toMatchObject({
			asserted_at: SESSION_TIMESTAMP,
			last_accessed_at: SESSION_TIMESTAMP,
			valid_from: Date.parse("2025-03-01T00:00:00.000Z"),
		});
	});
});
