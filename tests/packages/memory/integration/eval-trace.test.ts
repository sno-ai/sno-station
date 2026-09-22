/** Integration tests for eval-trace JSONL emission + config-snapshot.json
 *  per PRD §11.2.2 (Task #10). Pure I/O over a tmp dir — no LLM, no embedder,
 *  no DB needed. Verifies the gating contract (default OFF), append-mode
 *  writes, snapshot file shape, and hash stability.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendQaTrace,
	buildConfigSnapshot,
	computeConfigHash,
	isTraceEnabled,
	writeConfigSnapshot,
} from "../../../../packages/memory/src/engine/eval/trace";
import { collectParallelStage } from "../../../../packages/memory/src/engine/retrieval/retriever";
import type { MemoryEntry, RetrievalResult } from "../../../../packages/memory/src/engine/shared/types";

interface QaTraceLine {
	query: string;
	retrievedParentMemoryIds: string[];
	finalMemoryScores: number[];
	embedderProvider: string;
	embedderModel: string;
	embedderDim: number;
	chunkingVersion: string;
	configHash: string;
	timestampMs: number;
}

describe("eval-trace (PRD §11.2.2)", () => {
	let tmp: string;
	const originalEnv = {
		EVAL_TRACE_ENABLED: process.env.EVAL_TRACE_ENABLED,
		EVAL_TRACE_DIR: process.env.EVAL_TRACE_DIR,
	};

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "claw-eval-trace-"));
		// biome-ignore lint/performance/noDelete: env reset must remove the key, not just nullify.
		delete process.env.EVAL_TRACE_ENABLED;
		// biome-ignore lint/performance/noDelete: env reset must remove the key, not just nullify.
		delete process.env.EVAL_TRACE_DIR;
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		if (originalEnv.EVAL_TRACE_ENABLED === undefined) {
			// biome-ignore lint/performance/noDelete: restoring undefined removes the key.
			delete process.env.EVAL_TRACE_ENABLED;
		} else {
			process.env.EVAL_TRACE_ENABLED = originalEnv.EVAL_TRACE_ENABLED;
		}
		if (originalEnv.EVAL_TRACE_DIR === undefined) {
			// biome-ignore lint/performance/noDelete: restoring undefined removes the key.
			delete process.env.EVAL_TRACE_DIR;
		} else {
			process.env.EVAL_TRACE_DIR = originalEnv.EVAL_TRACE_DIR;
		}
	});

	it("trace is disabled by default — no file written", () => {
		expect(isTraceEnabled()).toBe(false);
		appendQaTrace(
			{
				query: "ignored",
				retrievedChunkIds: [],
				retrievedParentMemoryIds: ["m1"],
				finalMemoryScores: [0.5],
				embedderProvider: "local-onnx",
				embedderModel: "qwen3-embedding-4b@1024",
				embedderDim: 1024,
				chunkingVersion: "test",
				configHash: "deadbeef",
				timestampMs: 1,
			},
			tmp,
		);
		expect(existsSync(join(tmp, "qa_traces.jsonl"))).toBe(false);
	});

	it("trace enabled writes JSONL and appends across calls", () => {
		process.env.EVAL_TRACE_ENABLED = "true";
		process.env.EVAL_TRACE_DIR = tmp;
		expect(isTraceEnabled()).toBe(true);

		const retrievedChunkIds: string[] = [];
		const baseTrace = {
			retrievedChunkIds,
			embedderProvider: "local-onnx",
			embedderModel: "qwen3-embedding-4b@1024",
			embedderDim: 1024,
			chunkingVersion: "test",
			configHash: "abcd",
			timestampMs: 1234,
		} as const;

		appendQaTrace({
			...baseTrace,
			query: "first",
			retrievedParentMemoryIds: ["m1"],
			finalMemoryScores: [0.9],
		});
		appendQaTrace({
			...baseTrace,
			query: "second",
			retrievedParentMemoryIds: ["m2", "m3"],
			finalMemoryScores: [0.7, 0.6],
		});

		const path = join(tmp, "qa_traces.jsonl");
		expect(existsSync(path)).toBe(true);
		const lines = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.filter((line) => line.length > 0);
		expect(lines.length).toBe(2);
		const parsed = lines.map((line) => JSON.parse(line) as QaTraceLine);
		expect(parsed[0]?.query).toBe("first");
		expect(parsed[1]?.query).toBe("second");
		expect(parsed[1]?.retrievedParentMemoryIds).toEqual(["m2", "m3"]);
		expect(parsed[1]?.finalMemoryScores).toEqual([0.7, 0.6]);
	});

	it("writeConfigSnapshot writes file and returns stable hash", () => {
		const hash1 = writeConfigSnapshot(tmp);
		const path = join(tmp, "config-snapshot.json");
		expect(existsSync(path)).toBe(true);

		// File contents parse and contain expected sentinel keys.
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
			string,
			unknown
		>;
		expect(typeof parsed.CHUNK_MAX_TOKENS).toBe("number");
		expect(typeof parsed.CHUNKING_VERSION).toBe("string");
		expect(parsed.EMBEDDER_DIM).toBe(1024);
		expect(parsed.EMBEDDER_PROVIDER_DEFAULT).toBe("local-onnx");

		// Keys are sorted alphabetically — required for hash stability.
		const keys = Object.keys(parsed);
		const sorted = [...keys].sort();
		expect(keys).toEqual(sorted);

		// Hash matches an in-memory recompute and is stable across calls.
		const hash2 = writeConfigSnapshot(tmp);
		expect(hash2).toBe(hash1);
		expect(computeConfigHash()).toBe(hash1);
		expect(hash1).toMatch(/^[0-9a-f]{64}$/);
	});

	it("traceMetadata.omittedScoreArrays serializes round-trip through JSONL (callers populate it; this test only asserts JSONL preserves it)", () => {
		// Codex 2026-04-29 (tests-trace.md F1): this test is intentionally
		// scoped to JSONL serialization round-trip. The omission *derivation*
		// lives in `retriever.collectParallelStage` and is covered by the
		// "collectParallelStage derives omittedScoreArrays" test below; here
		// we only prove the JSON shape survives append+read.
		process.env.EVAL_TRACE_ENABLED = "true";
		process.env.EVAL_TRACE_DIR = tmp;

		appendQaTrace({
			query: "partial-stage probe",
			retrievedChunkIds: ["chunk-a", "chunk-b", "chunk-c"],
			retrievedParentMemoryIds: ["m1", "m2", "m3"],
			fusedScores: [0.9, 0.8, 0.7],
			// rerankScores omitted; caller (retriever) supplied
			// traceMetadata.omittedScoreArrays — this test only asserts the
			// JSONL emitter does not strip or rewrite it.
			finalMemoryScores: [0.9, 0.8, 0.7],
			embedderProvider: "local-onnx",
			embedderModel: "qwen3",
			embedderDim: 1024,
			chunkingVersion: "test",
			configHash: "abcd",
			timestampMs: 100,
			traceMetadata: {
				omittedScoreArrays: {
					rerankScores: ["chunk-a", "chunk-c"],
				},
			},
		});

		const lines = readFileSync(join(tmp, "qa_traces.jsonl"), "utf8")
			.trim()
			.split("\n")
			.filter((line) => line.length > 0);
		expect(lines.length).toBe(1);
		const parsed = JSON.parse(lines[0]!) as Record<string, unknown> & {
			traceMetadata?: { omittedScoreArrays?: Record<string, string[]> };
		};
		// rerankScores must be ABSENT, not present-as-null
		expect(Object.hasOwn(parsed, "rerankScores")).toBe(false);
		// omitted ids must be available for post-deploy debugging
		expect(parsed.traceMetadata?.omittedScoreArrays?.rerankScores).toEqual([
			"chunk-a",
			"chunk-c",
		]);
		// fusedScores still present and parallel to retrievedChunkIds
		expect(parsed.fusedScores).toEqual([0.9, 0.8, 0.7]);
		expect(parsed.retrievedChunkIds).toEqual([
			"chunk-a",
			"chunk-b",
			"chunk-c",
		]);
	});

	it("fully-populated parallel arrays stay aligned to retrievedChunkIds", () => {
		process.env.EVAL_TRACE_ENABLED = "true";
		process.env.EVAL_TRACE_DIR = tmp;

		appendQaTrace({
			query: "full-stage probe",
			retrievedChunkIds: ["c1", "c2"],
			retrievedParentMemoryIds: ["m1", "m2"],
			denseScores: [0.5, 0.4],
			bm25Scores: [0.3, 0.2],
			fusedScores: [0.7, 0.5],
			rerankScores: [0.8, 0.6],
			mmrScores: [0.78, 0.55],
			finalMemoryScores: [0.78, 0.55],
			embedderProvider: "local-onnx",
			embedderModel: "qwen3",
			embedderDim: 1024,
			chunkingVersion: "test",
			configHash: "abcd",
			timestampMs: 200,
		});

		const lines = readFileSync(join(tmp, "qa_traces.jsonl"), "utf8")
			.trim()
			.split("\n")
			.filter((line) => line.length > 0);
		const parsed = lines
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.find((p) => p.query === "full-stage probe")!;
		expect(parsed).toBeDefined();

		const expectedLen = (parsed.retrievedChunkIds as string[]).length;
		for (const stage of [
			"denseScores",
			"bm25Scores",
			"fusedScores",
			"rerankScores",
			"mmrScores",
			"finalMemoryScores",
		]) {
			const arr = parsed[stage] as number[] | undefined;
			expect(Array.isArray(arr)).toBe(true);
			expect(arr!.length).toBe(expectedLen);
			// No null fill (PRD §4): JSON.stringify([undefined]) would emit
			// [null]; ensure the helper's omit path is what triggers, not a
			// mid-array null.
			for (const v of arr!) expect(v).not.toBeNull();
		}
		// Side-channel must be absent when no stage is partial.
		expect(parsed.traceMetadata).toBeUndefined();
	});

	it("collectParallelStage derives omittedScoreArrays from partial RetrievalResult inputs (PRD §M1)", () => {
		// Codex 2026-04-29 (tests-trace.md F1): the round-trip test above
		// supplies omittedScoreArrays directly. This test asserts the
		// upstream *derivation* contract — given a list of RetrievalResult
		// where some entries lack a stage score, the helper must drop the
		// values array and return the chunk ids whose score was missing.
		// `collectParallelStage` is the single derivation site invoked at
		// retriever.ts:539-547; covering it here closes the gap codex flagged.
			const baseEntry: MemoryEntry = {
				id: "m-x",
				text: "ignored",
				category: "episodic",
				lane: "active",
				projectId: "default",
				importance: 0.5,
			timestamp: 0,
			metadata: "{}",
			contentHash: "h",
		};
		const mkResult = (
			chunkId: string,
			rerankScore: number | undefined,
		): RetrievalResult => ({
			entry: baseEntry,
			score: 0,
			sources: {},
			chunkId,
			rerankScore,
		});
		const fallbackIds = ["chunk-a", "chunk-b", "chunk-c"];
		const partial = collectParallelStage(
			[
				mkResult("chunk-a", undefined),
				mkResult("chunk-b", 0.42),
				mkResult("chunk-c", undefined),
			],
			"rerankScore",
			fallbackIds,
		);
		// Partial: helper drops the values array and surfaces the missing ids.
		expect(partial.values).toBeNull();
		expect(partial.omitted).toEqual(["chunk-a", "chunk-c"]);

		const full = collectParallelStage(
			[
				mkResult("chunk-a", 0.9),
				mkResult("chunk-b", 0.8),
				mkResult("chunk-c", 0.7),
			],
			"rerankScore",
			fallbackIds,
		);
		// Fully populated: values array preserved, omitted is empty.
		expect(full.values).toEqual([0.9, 0.8, 0.7]);
		expect(full.omitted).toEqual([]);

		// NaN counts as missing — guards against a downstream stage emitting
		// a NaN score and then claiming the array is "present" in JSONL.
		const nan = collectParallelStage(
			[mkResult("chunk-a", Number.NaN), mkResult("chunk-b", 0.5)],
			"rerankScore",
			["chunk-a", "chunk-b"],
		);
		expect(nan.values).toBeNull();
		expect(nan.omitted).toEqual(["chunk-a"]);
	});

	it("snapshot covers the Task #9 tunables surface", () => {
		const snap = buildConfigSnapshot();
		// Spot-check: at least 30 keys (28 added in Task #9 + a few retrieval
		// tunables wired into the snapshot). Strict equality would lock the
		// list; a min-count guard catches accidental deletions without
		// blocking additive tunable additions.
		expect(Object.keys(snap).length).toBeGreaterThanOrEqual(30);
		// Required fields per PRD §11.2.2.
		expect(snap).toHaveProperty("CHUNK_MAX_TOKENS");
		expect(snap).toHaveProperty("CHUNK_MIN_TOKENS");
		expect(snap).toHaveProperty("MMR_LAMBDA");
		expect(snap).toHaveProperty("LIGHTWEIGHT_FUSION_WEIGHT");
		expect(snap).toHaveProperty("EMBEDDER_DIM");
		expect(snap).toHaveProperty("CHUNKING_VERSION");
	});
});
