/** Real ONNX embedder + real encrypted SQLite. No mocking. Missing deps = FAIL. */

/**
 * Mapped reflection loop — in-batch near-duplicate guard.
 *
 * `runMappedMemoryLoop` already dedupes each candidate against the DB via
 * `searchSemantic` before pushing into the bulkStore batch. That check does
 * NOT catch the case where two candidates in the same batch are
 * paraphrases of one another but neither exists in the DB yet: both pass
 * the DB pre-check, and `bulkStore`'s own in-batch dedup is content-hash
 * only (different text → different hash → both rows persist). These tests
 * exercise the cosine-similarity guard that runs after the DB pre-check
 * and before pushing into the pending batch.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { runMappedMemoryLoop } from "../../../../packages/memory/src/engine/reflection/reflection-mapped-memory-loop.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestLlmClient } from "../../../apps/mem-claw/helpers/llm-client.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

let testEmbedder: Embedder;
let diagnosticWrites: ReturnType<typeof vi.spyOn>;
function duplicateDiagnostics(): string[] {
	return diagnosticWrites.mock.calls.map(([bytes]) => String(bytes)).filter(bytes => {
		try { return JSON.parse(bytes).event_name === "memory.reflection_mapped_memory_loop.reflection.duplicate.candidate.skipped"; }
		catch { return false; }
	});
}

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

function buildReflectionMarkdown(bullets: string[]): string {
	return ["## Lessons & pitfalls (symptom / cause / fix / prevention)", ...bullets.map((b) => `- ${b}`)].join(
		"\n",
	);
}

/**
 * Builds reflection markdown with two distinct mapped sections so we can
 * exercise the cross-kind in-batch dedup boundary. The first section emits
 * `mappedKind: "lesson"`, the second emits `mappedKind: "decision"`.
 */
function buildCrossKindReflectionMarkdown(lessonBullet: string, decisionBullet: string): string {
	return [
		"## Lessons & pitfalls (symptom / cause / fix / prevention)",
		`- ${lessonBullet}`,
		"",
		"## Decisions (durable)",
		`- ${decisionBullet}`,
	].join("\n");
}

interface LogSink {
	info: (msg: string) => void;
	warn: (msg: string) => void;
	debug: (msg: string) => void;
	infoMessages: string[];
	warnMessages: string[];
	debugMessages: string[];
}

function makeLogSink(): LogSink {
	const infoMessages: string[] = [];
	const warnMessages: string[] = [];
	const debugMessages: string[] = [];
	return {
		info: (msg) => infoMessages.push(msg),
		warn: (msg) => warnMessages.push(msg),
		debug: (msg) => debugMessages.push(msg),
		infoMessages,
		warnMessages,
		debugMessages,
	};
}

function cosineCheck(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i += 1) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		dot += x * y;
		normA += x * x;
		normB += y * y;
	}
	if (normA === 0 || normB === 0) return dot;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

describe("runMappedMemoryLoop — in-batch cosine dedup", () => {
	let dbPath: string;
	let cleanup: () => void;
	let store: MemoryStore;

	beforeEach(() => {
		vi.stubEnv("LOG_LEVEL", "debug");
		diagnosticWrites = vi.spyOn(process.stderr, "write");
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		cleanup = testDb.cleanup;
		store = new MemoryStore({ dbPath, embedder: testEmbedder });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		store.close();
		cleanup();
	});

	it("skips a paraphrased near-duplicate when both candidates pass DB pre-check", async () => {
		// Two bullets that say the same thing with surface variation. The local
		// ONNX embedder packs them near each other in semantic space. We verify
		// the cosine surpasses the loop's threshold first so a model regression
		// surfaces as a fixture-level failure, not a confusing "0 vs 1" mismatch.
		const a = "Always check the log after restarting the dev server.";
		const b = "Always check the logs after restarting the dev server.";
		const va = await testEmbedder.embed(a);
		const vb = await testEmbedder.embed(b);
		expect(cosineCheck(va, vb)).toBeGreaterThanOrEqual(0.95);

		const log = makeLogSink();
		await runMappedMemoryLoop({
			reflectionText: buildReflectionMarkdown([a, b]),
			store,
			embedder: testEmbedder,
			llm: createTestLlmClient(),
			targetScope: "test-batch-dedup-1",
			sourceAgentId: "agent-1",
			sessionKey: "sess-1",
			sessionId: "sid-1",
			runAt: 1_700_000_000_000,
			usedFallback: false,
			toolErrorSignals: [],
			eventId: "evt-1",
			logger: log,
		});

		const stats = await store.stats();
		expect(stats.total).toBe(1);
		expect(duplicateDiagnostics()).toHaveLength(1);
		// Privacy: reflection bullets are user content. The skip log must not
		// embed any prefix of the candidate text (no truncated leak either —
		// secrets/PII frequently appear at the start of a line).
		expect(duplicateDiagnostics().every((m) => !m.includes(b))).toBe(true);
		expect(duplicateDiagnostics().every((m) => !m.includes(b.slice(0, 20)))).toBe(true);
	});

	it("keeps genuinely distinct candidates", async () => {
		const a = "Always check the log after restarting the dev server.";
		const b = "Drizzle migrations must run before the first sqlite-vec load call.";
		const va = await testEmbedder.embed(a);
		const vb = await testEmbedder.embed(b);
		// Sanity: these two must be below the dedup threshold, otherwise the
		// regression assertion below is meaningless.
		expect(cosineCheck(va, vb)).toBeLessThan(0.95);

		const log = makeLogSink();
		await runMappedMemoryLoop({
			reflectionText: buildReflectionMarkdown([a, b]),
			store,
			embedder: testEmbedder,
			llm: createTestLlmClient(),
			targetScope: "test-batch-dedup-2",
			sourceAgentId: "agent-1",
			sessionKey: "sess-1",
			sessionId: "sid-1",
			runAt: 1_700_000_000_000,
			usedFallback: false,
			toolErrorSignals: [],
			eventId: "evt-2",
			logger: log,
		});

		const stats = await store.stats();
		expect(stats.total).toBe(2);
		expect(log.debugMessages.some((m) => m.includes("mapped batch dedup skip"))).toBe(false);
	});

	it("scans every prior pending entry, not just the most recent", async () => {
		// Order: [first, distinct, paraphrase-of-first]. If the loop only
		// compared against the most recent pending entry, the third bullet
		// would slip through. The guard must walk the whole pending array.
		const first = "Always check the log after restarting the dev server.";
		const distinct = "Drizzle migrations must run before the first sqlite-vec load call.";
		const paraphraseOfFirst = "Always check the logs after restarting the dev server.";

		const vFirst = await testEmbedder.embed(first);
		const vDistinct = await testEmbedder.embed(distinct);
		const vPara = await testEmbedder.embed(paraphraseOfFirst);
		expect(cosineCheck(vFirst, vPara)).toBeGreaterThanOrEqual(0.95);
		expect(cosineCheck(vDistinct, vPara)).toBeLessThan(0.95);

		const log = makeLogSink();
		await runMappedMemoryLoop({
			reflectionText: buildReflectionMarkdown([first, distinct, paraphraseOfFirst]),
			store,
			embedder: testEmbedder,
			llm: createTestLlmClient(),
			targetScope: "test-batch-dedup-3",
			sourceAgentId: "agent-1",
			sessionKey: "sess-1",
			sessionId: "sid-1",
			runAt: 1_700_000_000_000,
			usedFallback: false,
			toolErrorSignals: [],
			eventId: "evt-3",
			logger: log,
		});

		const stats = await store.stats();
		expect(stats.total).toBe(2);
		const stored = await store.list({ projectId: "test-batch-dedup-3" });
		const texts = stored.map((row) => row.text);
		expect(texts).toContain(first);
		expect(texts).toContain(distinct);
		expect(texts).not.toContain(paraphraseOfFirst);
		expect(duplicateDiagnostics()).toHaveLength(1);
	});

	it("does NOT dedup across distinct mappedKinds even at high cosine", async () => {
		// Two surface-identical sentences under different mapped sections
		// produce mappedKind="lesson" and mappedKind="decision". They are
		// semantically the same string → cosine ≈ 1.0, but they live in
		// different mapped domains. The DB pre-check scopes by mappedKind;
		// the in-batch guard must too, otherwise a "decision" entry would
		// silently suppress an "lesson" entry (or vice versa).
		const same = "Always check the log after restarting the dev server.";
		const v = await testEmbedder.embed(same);
		expect(cosineCheck(v, v)).toBeGreaterThanOrEqual(0.95);

		const log = makeLogSink();
		await runMappedMemoryLoop({
			reflectionText: buildCrossKindReflectionMarkdown(same, same),
			store,
			embedder: testEmbedder,
			llm: createTestLlmClient(),
			targetScope: "test-batch-dedup-4",
			sourceAgentId: "agent-1",
			sessionKey: "sess-1",
			sessionId: "sid-1",
			runAt: 1_700_000_000_000,
			usedFallback: false,
			toolErrorSignals: [],
			eventId: "evt-4",
			logger: log,
		});

		const stats = await store.stats();
		// Both rows must persist because the in-batch guard treats different
		// mappedKinds as independent dedup domains.
		expect(stats.total).toBe(2);
		expect(log.debugMessages.some((m) => m.includes("mapped batch dedup skip"))).toBe(false);
	});
});
