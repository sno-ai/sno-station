/** @file recall-validity-gate.test.ts
 * @purpose Current-row retrieval excludes invalidated rows by default, while canonical
 *   manual recall retains a superseded row with its visible retirement marker.
 *   Explicit low-level history reads still reach the stored predecessor.
 * @boundary store.correct and explicit invalidation -> memory_recall tool AND the two
 *   MemoryRetriever entrypoints (retrieve, retrieveWithTrace) -> store search SQL.
 *   Real ONNX embedder, real encrypted SQLite, real plugin runtime. No LLM call:
 *   The actual store transaction and a deterministic invalidation prepare the historical row.
 * @see supersede-tombstone-recall.test.ts (the W1.3 explicit-parameter gate this
 *   PRD hardens into a default).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { memClawPlugin } from "../../../../apps/mem-claw/src/install/openclaw-plugin-runtime.ts";
import {
	createRetriever,
	DEFAULT_RETRIEVAL_CONFIG,
	type MemoryRetriever,
} from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import type { CandidateMemory } from "../../../../packages/memory/src/engine/shared/types.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { OpenClawPluginApiHarness } from "../helpers/openclaw-harness.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";
import { asClawResult } from "../helpers/tool-result.ts";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture.ts";
import { dirname } from "node:path";

const TEST_TIMEOUT_MS = 180_000;

let testEmbedder: Embedder;

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
}, TEST_TIMEOUT_MS);

const noopLogger = { warn: (_message: string) => {} };

/** The current fact. Its text never mentions the stale language, so a served
 * result containing "python" can only have come from the invalidated row. */
const SUPERSEDING_CANDIDATE: CandidateMemory = {
	category: "episodic",
	abstract: "The user's favorite programming language is Rust.",
	overview: "The user states their favorite programming language is Rust.",
	content: "The user said their favorite programming language is now Rust for all new work.",
};

const STALE_FACT_TEXT = "My favorite programming language is Python.";
const RECALL_QUERY = "What is the user's favorite programming language?";

interface Fixture {
	harness: OpenClawPluginApiHarness;
	store: MemoryStore;
	retriever: MemoryRetriever;
	staleId: string;
	replacementId: string;
	cleanup: () => void;
}

/**
 * One valid and one invalidated row in the same scope, on a real encrypted
 * store, plus the real plugin runtime and a retriever over the same store.
 *
 * Retrieval thresholds are pinned permissive on purpose: this gate proves the
 * validity filter does the excluding, never a score floor.
 */
async function buildFixture(): Promise<Fixture> {
	const stateDir = mkdtempSync(join(tmpdir(), "mem-claw-validity-gate-"));
	const prevStateDir = process.env.SNO_PROFILE_DIR;
	process.env.SNO_PROFILE_DIR = stateDir;

	const testDb = createTestDb();
	writeSettingsFixture(dirname(testDb.dbPath), {
		mode: "local-first", store: { path: testDb.dbPath, encryptionKey: testDb.encryptionKey },
		embedding: { cacheDir: "" }, recall: { auto: false }, capture: { ambient: false },
	});
	const harness = new OpenClawPluginApiHarness(
		{
			embedding: { dimensions: 1024 },
			dbPath: testDb.dbPath,
			ambientLearning: false,
			autoRecall: false,
			sessionStrategy: "none",
			retrieval: { minScore: 0.05, hardMinScore: 0.01, rerank: "none" },
			mode: "local-first",
		},
		{ runtimeAgentId: "recall-validity-gate-agent" },
	);
	await memClawPlugin.register(harness);

	const store = new MemoryStore({ dbPath: testDb.dbPath, embedder: testEmbedder });
	const retriever = createRetriever(store, testEmbedder, noopLogger, {
		...DEFAULT_RETRIEVAL_CONFIG,
		mode: "vector",
		rerank: "none",
		minScore: 0.05,
		hardMinScore: 0.01,
	});

	const staleVector = await testEmbedder.embed(STALE_FACT_TEXT);
	const stale = await store.store({
		text: STALE_FACT_TEXT,
		vector: staleVector,
		category: "episodic",
		projectId: "global",
		importance: 0.6,
	});
	const corrected = await store.correct({
		id: stale.id, content: SUPERSEDING_CANDIDATE.content,
		projectIdFilter: ["global"], session: "recall-validity-gate",
	});
	expect(corrected.corrected).toBe(true);
	await store.updateMetadata(stale.id, { invalidated_at: Date.now() });

	const staleMetadata = await store.getMemoryMetadata(stale.id);
	const replacementId = staleMetadata?.superseded_by;
	if (typeof replacementId !== "string") {
		throw new Error("fixture precondition failed: supersede did not link a replacement row");
	}
	if (typeof staleMetadata?.invalidated_at !== "number") {
		throw new Error("fixture precondition failed: stale row carries no invalidated_at");
	}

	function cleanup(): void {
		store.close();
		testDb.cleanup();
		try {
			rmSync(stateDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
		if (prevStateDir === undefined) delete process.env.SNO_PROFILE_DIR;
		else process.env.SNO_PROFILE_DIR = prevStateDir;
	}

	return { harness, store, retriever, staleId: stale.id, replacementId, cleanup };
}

describe("recall validity gate (PRD 205)", () => {
	let fixture: Fixture | undefined;

	beforeEach(() => {
		fixture = undefined;
	});

	afterEach(() => {
		fixture?.cleanup();
	});

	it(
		"manual memory_recall serves the valid row and visibly retired predecessor",
		async () => {
			fixture = await buildFixture();
			const { harness, staleId } = fixture;

			const recallTool = harness.getRegisteredTool("memory_recall");
			if (!recallTool) throw new Error("memory_recall tool not registered");
			const result = asClawResult(await recallTool.execute("validity-gate-call", {
				query: RECALL_QUERY,
			}));
			expect(result.isError, JSON.stringify(result)).not.toBe(true);
			const text = result.content[0]?.text ?? "";
			expect(text).toContain(staleId);
			expect(text.toLowerCase()).toContain("rust");
			expect(text.toLowerCase()).toContain("python");
			expect(text).toContain(`retired; superseded by ${fixture.replacementId}`);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"retrieve() omitting the validity parameter still excludes the invalidated row",
		async () => {
			fixture = await buildFixture();
			const { retriever, staleId, replacementId } = fixture;

			// This is the exact context shape built by the two serving callers that
			// pass no validity parameter today: memory-forget-tool.ts:110 and
			// memory-command-registration.ts:127 (`memory delete --query`). Both are
			// outside this PRD's change boundary, so the default at the retriever
			// entrypoint is what covers them, and this assertion is what pins it.
			const served = await retriever.retrieve({
				query: RECALL_QUERY,
				limit: 5,
				scopeFilter: ["global"],
				source: "manual",
			});

			expect(served.some((result) => result.entry.id === staleId)).toBe(false);
			expect(served.some((result) => result.entry.id === replacementId)).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"retrieveWithTrace() omitting the validity parameter still excludes the invalidated row",
		async () => {
			fixture = await buildFixture();
			const { retriever, staleId, replacementId } = fixture;

			const { results } = await retriever.retrieveWithTrace({
				query: RECALL_QUERY,
				limit: 5,
				scopeFilter: ["global"],
				source: "auto-recall",
			});

			expect(results.some((result) => result.entry.id === staleId)).toBe(false);
			expect(results.some((result) => result.entry.id === replacementId)).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"omission and an explicit current-time parameter serve the identical id sequence",
		async () => {
			fixture = await buildFixture();
			const { retriever } = fixture;

			const omitted = await retriever.retrieve({
				query: RECALL_QUERY,
				limit: 5,
				scopeFilter: ["global"],
				source: "manual",
			});
			const explicit = await retriever.retrieve({
				query: RECALL_QUERY,
				limit: 5,
				scopeFilter: ["global"],
				source: "manual",
				excludeInvalidatedBefore: Date.now(),
			});

			expect(omitted.map((result) => result.entry.id)).toEqual(
				explicit.map((result) => result.entry.id),
			);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"the explicit history opt-in still reaches the invalidated row, and it is still on disk",
		async () => {
			fixture = await buildFixture();
			const { retriever, store, staleId } = fixture;

			// `excludeInvalidatedBefore: 0` is the deliberate history read: the store
			// predicate becomes `invalidated_at > 0`, which drops nothing. REQ-2 —
			// nothing stored becomes unreachable.
			const served = await retriever.retrieve({
				query: RECALL_QUERY,
				limit: 5,
				scopeFilter: ["global"],
				source: "manual",
				facetPolicy: "include-history",
				excludeInvalidatedBefore: 0,
			});

			expect(served.some((result) => result.entry.id === staleId)).toBe(true);
			expect(store.getById(staleId)).toBeDefined();
		},
		TEST_TIMEOUT_MS,
	);
});
