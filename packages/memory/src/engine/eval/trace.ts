/** @file trace.ts
 * @purpose Emits per-QA retrieval traces and the active config snapshot for eval runs.
 * @boundary Filesystem (JSONL/JSON write) and config constants surface.
 * @see ../retrieval/retriever.ts, ../../config/index.ts.
 *
 * Minimum-viable trace emission per PRD §11.2.2. Off by default; enabled by the
 * eval harness via `EVAL_TRACE_ENABLED=true` (env or build constant) and a
 * run-dir provided via `EVAL_TRACE_DIR` (env). Phase 0 instrumentation
 * (MRR/Recall, gold-rank, miss classification) remains explicitly waived.
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createLogger, currentLogContext, privateLogReference, withLogContext, type LogContext } from "@snoai/utils/logger";
import {
	ADJACENCY_BONUS_CAP,
	ADJACENCY_BONUS_PER_PAIR,
	BONUS_TOTAL_INVARIANT,
	CHUNK_MAX_TOKENS,
	CHUNK_MIN_TOKENS,
	CHUNK_OVERLAP_TOKENS,
	CHUNK_TARGET_TOKENS,
	CHUNK_TOKENIZER_MODE,
	CHUNKING_VERSION,
	DEFAULT_BM25_WEIGHT,
	DEFAULT_HARD_MIN_SCORE,
	DEFAULT_MIN_SCORE,
	DEFAULT_TOP_K,
	DEFAULT_VECTOR_WEIGHT,
	EMBEDDER_DIM,
	EMBEDDER_MODEL_DEFAULT,
	EMBEDDER_PROVIDER_DEFAULT,
	EVAL_CONFIG_SNAPSHOT_FILENAME,
	EVAL_QA_TRACES_FILENAME,
	EVAL_TRACE_ENABLED,
	HEAD_EXTRACT_MIN_CONTENT_TOKENS,
	HEAD_EXTRACT_OVERLAP_DROP_RATIO,
	HEAD_EXTRACT_TOKEN_BUDGET,
	INTRA_MEMORY_COSINE_THRESHOLD,
	LIGHTWEIGHT_COSINE_WEIGHT,
	LIGHTWEIGHT_FUSION_WEIGHT,
	LIGHTWEIGHT_RERANK_PENALTY,
	MAX_CHUNKS_PER_PARENT,
	MMR_LAMBDA,
	MULTI_HIT_BONUS_CAP,
	MULTI_HIT_BONUS_PER_HIT,
	SNIPPET_NEIGHBOR_AFTER,
	SNIPPET_NEIGHBOR_BEFORE,
} from "../../../config/index";

const log = createLogger("sno-station-mem:eval-trace");

export interface QaTrace {
	context?: Readonly<LogContext>;
	qaId?: string | undefined;
	query: string;
	retrievedChunkIds: string[];
	retrievedParentMemoryIds: string[];
	denseScores?: number[] | undefined;
	bm25Scores?: number[] | undefined;
	fusedScores?: number[] | undefined;
	rerankScores?: number[] | undefined;
	mmrScores?: number[] | undefined;
	finalMemoryScores: number[];
	embedderProvider: string;
	embedderModel: string;
	embedderDim: number;
	chunkingVersion: string;
	configHash: string;
	timestampMs: number;
	latencyMs?: number | undefined;
	/**
	 * Diagnostic side-channel for partial-population stages (PRD §4 trace
	 * population rule + F4 host finding). When a per-stage score array is
	 * incomplete (some results have the value, others don't), the array is
	 * omitted from the top-level fields and the missing-result chunk ids are
	 * recorded here so post-deploy debugging can see which chunk failed which
	 * stage rather than losing all of N scores silently.
	 */
	traceMetadata?: {
		omittedScoreArrays?: Record<string, string[]>;
	};
	/**
	 * What each retrieval stage received and what survived it, in pipeline order.
	 *
	 * The score arrays above describe only the SURVIVORS, so a memory removed part-way
	 * through leaves no record at all — which is why a wrong answer could never be attributed
	 * to the stage that dropped its evidence. `droppedIds` is the field that closes that.
	 * `skipped` names the config key that turned a stage off, because a disabled stage and a
	 * stage that ran and changed nothing are otherwise identical from outside.
	 */
	stages?: {
		name: string;
		inputCount: number;
		outputCount: number;
		droppedIds: string[];
		outputIds: string[];
		scoreRange: [number, number] | null;
		durationMs: number;
		skipped?: string;
	}[];
}

/**
 * Returns true when the eval-trace surface should write. Reads the env var at
 * call time so harness-flipped values take effect without a re-import.
 */
export function isTraceEnabled(): boolean {
	return process.env.EVAL_TRACE_ENABLED === "true" || EVAL_TRACE_ENABLED;
}

/**
 * Resolves the active trace directory. Prefers `EVAL_TRACE_DIR` env var; falls
 * back to the explicit override argument. Returns undefined when neither is
 * set; callers treat that as "no trace this run".
 */
export function resolveTraceDir(override?: string): string | undefined {
	const envDir = process.env.EVAL_TRACE_DIR;
	if (envDir && envDir.length > 0) return envDir;
	if (override && override.length > 0) return override;
	return undefined;
}

/**
 * Append one trace row to `qa_traces.jsonl`. No-op when tracing is disabled
 * or no `traceDir` is resolvable. Failures are logged but do not throw;
 * eval traces are diagnostic, not load-bearing.
 */
export function appendQaTrace(trace: QaTrace, traceDirOverride?: string): void {
	if (!isTraceEnabled()) return;
	const traceDir = resolveTraceDir(traceDirOverride);
	if (!traceDir) return;
	try {
		if (!existsSync(traceDir)) {
			mkdirSync(traceDir, { recursive: true });
		}
		const filePath = path.join(traceDir, EVAL_QA_TRACES_FILENAME);
		appendFileSync(filePath, `${JSON.stringify({ ...trace, context: currentLogContext() })}\n`, "utf8");
	} catch (err) {
		log.warn("failed to append qa trace", {
			error: err,
		}, {
			event_name: "sno_station_mem.trace.failed.to.append.qa.trace",
			file: "packages/sno-station-mem/src/engine/eval/trace.ts",
			function: "appendQaTrace",
			site_id: "trace.appendQaTrace.164bcaddd4",
		});
	}
}

/**
 * Composes the active retrieval-pipeline tunables snapshot. Returned object
 * has alphabetically-sorted keys so the resulting JSON is stable across
 * repeat calls, which is required for the SHA-256 fingerprint.
 */
export function buildConfigSnapshot(): Record<string, unknown> {
	const raw: Record<string, unknown> = {
		ADJACENCY_BONUS_CAP,
		ADJACENCY_BONUS_PER_PAIR,
		BONUS_TOTAL_INVARIANT,
		CHUNK_MAX_TOKENS,
		CHUNK_MIN_TOKENS,
		CHUNK_OVERLAP_TOKENS,
		CHUNK_TARGET_TOKENS,
		CHUNK_TOKENIZER_MODE,
		CHUNKING_VERSION,
		DEFAULT_BM25_WEIGHT,
		DEFAULT_HARD_MIN_SCORE,
		DEFAULT_MIN_SCORE,
		DEFAULT_TOP_K,
		DEFAULT_VECTOR_WEIGHT,
		EMBEDDER_DIM,
		EMBEDDER_MODEL_DEFAULT,
		EMBEDDER_PROVIDER_DEFAULT,
		HEAD_EXTRACT_MIN_CONTENT_TOKENS,
		HEAD_EXTRACT_OVERLAP_DROP_RATIO,
		HEAD_EXTRACT_TOKEN_BUDGET,
		INTRA_MEMORY_COSINE_THRESHOLD,
		LIGHTWEIGHT_COSINE_WEIGHT,
		LIGHTWEIGHT_FUSION_WEIGHT,
		LIGHTWEIGHT_RERANK_PENALTY,
		MAX_CHUNKS_PER_PARENT,
		MMR_LAMBDA,
		MULTI_HIT_BONUS_CAP,
		MULTI_HIT_BONUS_PER_HIT,
		SNIPPET_NEIGHBOR_AFTER,
		SNIPPET_NEIGHBOR_BEFORE,
	};
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(raw).sort()) {
		sorted[key] = raw[key];
	}
	return sorted;
}

/**
 * Writes `config-snapshot.json` to `traceDir` and returns the SHA-256 hex
 * digest of its content for join with `config_hash` in `qa_traces.jsonl`.
 * Idempotent; overwrites on each call. Throws on filesystem failure because
 * a missing snapshot invalidates the eval run per PRD §11.2.1.
 */
export function writeConfigSnapshot(traceDir: string): string {
	return withLogContext({ operation_id: currentLogContext().operation_id ?? randomUUID() }, () => {
		const started = performance.now();
		let hash: string | undefined;
		let filePath: string | undefined;
		let outcome = "failed";
		let failure: unknown;
		try {
			const snapshot = buildConfigSnapshot();
			const json = JSON.stringify(snapshot, null, 2);
			hash = sha256Hex(json);
			if (!existsSync(traceDir)) {
				mkdirSync(traceDir, { recursive: true });
			}
			filePath = path.join(traceDir, EVAL_CONFIG_SNAPSHOT_FILENAME);
			writeFileSync(filePath, json, "utf8");
			outcome = "success";
			return hash;
		} catch (error) {
			failure = error;
			throw error;
		} finally {
			log[outcome === "failed" ? "error" : "info"]("Configuration snapshot write completed", {
				outcome, error: failure, config_hash: hash ?? "unavailable",
				artifact_reference: privateLogReference(filePath ?? traceDir),
				duration_ms: performance.now() - started,
			}, {
				event_name: "memory.config.snapshot.completed",
				file: "packages/sno-station-mem/src/engine/eval/trace.ts",
				function: "writeConfigSnapshot",
				site_id: "trace.writeConfigSnapshot.completed",
			});
		}
	});
}

/** Computes the SHA-256 hex digest of the current config snapshot in-memory. */
export function computeConfigHash(): string {
	const json = JSON.stringify(buildConfigSnapshot(), null, 2);
	return sha256Hex(json);
}

function sha256Hex(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}
