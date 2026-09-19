/**
 * Sno Station Memory centralized configuration.
 * Shared tunable constants for every memory skin.
 * Organized by domain: Scoring → Retrieval → Storage → Backup → Cache → Session → Capture → Reflection
 */

import {
	CHUNKING_VERSION,
	DEFAULT_AGGREGATION_CONFIG,
	DEFAULT_CHUNK_CONFIG,
	DEFAULT_SNIPPET_NEIGHBOR_AFTER,
	DEFAULT_SNIPPET_NEIGHBOR_BEFORE,
	HEAD_EXTRACT_MIN_CONTENT_TOKENS,
	HEAD_EXTRACT_OVERLAP_DROP_RATIO,
	HEAD_EXTRACT_TOKEN_BUDGET,
} from "@snoai/chunking";
import { LOCAL_EMBEDDING_MODEL } from "@snoai/embedder";
import { z } from "zod";

/** Maximum wait for sidecar requests and resource cleanup during shutdown. */
export const MEMORY_SHUTDOWN_TIMEOUT_MS: number = 5_000;

// =============================================================================
// SCORING & THRESHOLDS
// =============================================================================

/**
 * Final result floor, applied to the POST-scoring-pipeline score (after the
 * multiplicative shrinker chain: importance, length-norm, time-decay,
 * retention). That chain routinely compresses a genuinely relevant match to
 * 0.03-0.06 once a memory ages past its decay half-life — a real, expected
 * production scenario, not an edge case. The old value (0.37) was calibrated
 * against the PRE-shrinker fused score scale and silently rejected almost
 * all real recall once shrinkers applied (confirmed 2026-07-05 scoring-
 * pipeline audit). 0 matches the only value ever proven end-to-end
 * (LoCoMo stratified-100, 86%, `evals/locomo/outputs/stratified-100-20260705-002827`);
 * shipped and tested must be the same config. Re-introducing a nonzero floor
 * needs fresh measured data post the A2/A3 fixes below, not a guess.
 */
export const DEFAULT_MIN_SCORE = 0;

/** Hard floor applied before any score amplification in the pipeline. See
 * `DEFAULT_MIN_SCORE` — same reasoning, same fix. */
export const DEFAULT_HARD_MIN_SCORE = 0;

/** Default importance score for new memories (0.0–1.0) */
export const DEFAULT_IMPORTANCE = 0.7;

/** Default scope for memories without explicit scope */
export const DEFAULT_SCOPE = "global";

/** Default embedding vector dimension (Voyage AI 1024-d) */
export const VECTOR_DIMENSION_DEFAULT = 1024;

/** Plugin version identifier */
export const PLUGIN_VERSION = "0.9.74";

/** Production sno.ai host origin used by @snoai/sno-observe. */
export const SNO_OBSERVE_DEFAULT_BASE_URL = "https://www.sno.ai";

/** Default observability agent id for OpenClaw plugin emits. */
export const SNO_OBSERVE_DEFAULT_AGENT_ID = "openclaw";

/** Bounded lifecycle observe flush — enough headroom for the SDK to complete one HTTP POST batch. */
export const SNO_OBSERVE_FLUSH_TIMEOUT_MS = 8_000;

// =============================================================================
// RETRIEVAL — PRECISION-RECALL SEARCH & RRF FUSION
// =============================================================================

/** Default top-K results returned from search */
export const DEFAULT_TOP_K = 10;

/** Default and minimum character-estimated token budgets for one recall result. */
export const DEFAULT_RECALL_TOKEN_BUDGET = 7_000;
export const MIN_RECALL_TOKEN_BUDGET = 5_000;

/** Weight for vector (semantic) branch in hybrid score fusion */
export const DEFAULT_VECTOR_WEIGHT = 0.7;

/** Weight for BM25 (keyword) branch in hybrid score fusion */
export const DEFAULT_BM25_WEIGHT = 0.3;

/** Initial candidate pool size for precision recall search */
export const CANDIDATE_POOL_SIZE = 64;

/**
 * Hard ceiling for candidate pool expansion. Also the retrieval limit `memory_recall` asks for,
 * so it bounds how much of a live store one answer can see. Raised 100 → 512 on 2026-09-06 (owner
 * order): atomic rows are small and many, and at 100 a 159-row live store served 76 rows per
 * question, cutting live to-dos the question asked for; at 512 the whole store came back for
 * 3,476 tokens, half the recall token budget. Raised again 512 -> 2048 on 2026-09-15: the pool is
 * `max(candidatePoolSize, limit * 2)` clamped here, so at 512 a caller asking for more than 256
 * memories silently got fewer, and the ceiling — not the ranking — decided what the model saw.
 */
export const MAX_CANDIDATE_POOL_SIZE = 2_048;

/**
 * How many candidates one `memory_recall` call retrieves and ranks.
 *
 * Split from `MAX_CANDIDATE_POOL_SIZE` on 2026-09-15. The tool used to ask for that ceiling
 * directly, so raising the ceiling to let auto-recall inject more memories would also have made
 * every tool call fuse and rerank four times as many rows for a result the token packer bounds
 * at `DEFAULT_RECALL_TOKEN_BUDGET` anyway. This keeps the tool's cost where it was measured.
 */
export const MAX_RECALL_TOOL_CANDIDATES = 512;

/**
 * How many live rows of the same subject the arrival retirement judgement is shown for one
 * ending, ranked own-attribute first and then by similarity, in batches of sixteen. Was a
 * hard-coded 64 inside the write door; raised to 128 on 2026-09-07 (owner order): a persona's
 * live profile holds 72–107 rows, so at 64 every other-attribute candidate was cut and an ending
 * filed under one attribute could not retire the state filed under another (129 truncations in
 * one six-persona run, against 50 the day before).
 */
export const ARRIVAL_RETIREMENT_CANDIDATE_CAP = 128;

/**
 * Measurement-only overrides for the block 210 retrieval-breadth experiment.
 *
 * Both are OFF unless the named environment variable is set, and neither is
 * reachable from the plugin configuration schema, so a deployed plugin cannot
 * turn them on: the experiment harness sets them on the process it starts and
 * nothing else does. They exist because the runtime and the schema both stop
 * the candidate pool at `MAX_CANDIDATE_POOL_SIZE`, which makes the pool-200
 * cell impossible to run at all without one enabling edit (PRD 210 DEC-1).
 *
 * Read at call time, not at import time, so a harness that sets the variable
 * after this module loads still gets the value it asked for.
 */
export function experimentCandidatePoolOverride(): number | undefined {
	const raw = process.env.MEM_CLAW_EXPERIMENT_CANDIDATE_POOL_SIZE?.trim();
	if (!raw) return undefined;
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed < 1) return undefined;
	return parsed;
}

/** True only while the block 210 experiment harness has asked for MMR off. */
export function experimentMmrDisabled(): boolean {
	return process.env.MEM_CLAW_EXPERIMENT_DISABLE_MMR?.trim() === "1";
}

/**
 * Maximum aggregation evidence rows materialized into one recall result.
 * Derived from the largest measured population (290) plus ~10% headroom, then raised with the
 * candidate pool ceiling on 2026-09-06 so a whole-population read can serve past that ceiling.
 * This bounds the synchronous storage read; a separate token budget bounds
 * the serialized tool result.
 */
export const MAX_AGGREGATION_ROWS = 640;

/**
 * Token budget for the aggregation payload ONE consumer receives.
 *
 * Derived, and every number is a measurement. The answering engine's context is 64K tokens (owner,
 * 2026-08-14, raised from 32K with the Qwen 3.8 rollout); half is reserved for the question, the
 * surrounding prompt and the answer, leaving 32K for recalled evidence. Measured with
 * `dev-scripts/census-aggregation-payload.mts` against the largest real store
 * (`academic_researcher_weekly`, 138 active profile/episodic rows): the ENTIRE population renders in
 * 43,699 characters ~= 10,925 tokens, a sixth of the context. A complete aggregation is therefore
 * the ordinary case on real data, not an aspiration.
 *
 * The HALF is the load-bearing part, not the literal number. When the context moved to 64K this
 * constant did not move with it for one commit, and a budget that stays put while its derivation
 * doubles silently becomes a quarter of the context — a tightening nobody decided and nobody would
 * find. That is the same shape as defect 2 below. If the context changes again, this changes.
 *
 * Known trade, stated rather than discovered later: widening this window is what raised aggregation
 * from 0.045 to 0.744 on 2026-08-13, and it is also what dropped FAA 0.647 -> 0.600 in the same
 * run, because retired rows the old ceiling had hidden came back into view. The answer to that is
 * REM removing them (PRD 30/40), never a smaller recall window — shrinking this to protect FAA
 * re-severs the counting path, which is the defect this constant exists to record.
 *
 * This replaces three ceilings that stacked on one path and severed it. Measured on the full
 * benchmark run of 2026-08-13: 30 counting questions scored 0.045 mean with 28 of them exactly
 * 0.000, while the same personas' other 60 questions scored 0.748. The model was not wrong — asked
 * for a week of steps it answered "14,392 steps (recorded on June 7). No other step data is logged
 * for the rest of the week", because 8 rows of 138 reached it. A model cannot total rows it was
 * never shown. The three were:
 *
 *   1. `MAX_AGGREGATION_OUTPUT_ROWS = 8` — no derivation anywhere; 5.8% of a population handed to a
 *      question whose entire job is to total that population.
 *   2. `MAX_AGGREGATION_TOOL_RESULT_CHARS = 16_384` — a unit error. 16,384 was the OLD 16K context
 *      in TOKENS, applied as a CHARACTER count, binding 3-4x tighter than it read.
 *   3. Charging each consumer for the other's copy: the budget measured `JSON.stringify(result)`,
 *      which carries every row twice — once rendered, once in `memories` — while the OpenClaw host
 *      reads only the rendered text and the eval reads only `memories`.
 *
 * So this budget is counted in tokens, against the larger of the two consumer views, never a sum.
 */
export const MAX_AGGREGATION_RESULT_TOKENS = 32_768;


/** Pool size = max(candidatePoolSize, limit * PRECISION_RECALL_POOL_SIZE_FACTOR) */
export const PRECISION_RECALL_POOL_SIZE_FACTOR = 2;

// =============================================================================
// RETRIEVAL — SCORING PIPELINE
// =============================================================================

/** Enable age-based retrieval scoring only when explicitly requested. */
export const TEMPORAL_WEIGHTING_DEFAULT = false;

/** Recency boost half-life in days (entries this old get 50% boost) */
export const RECENCY_HALF_LIFE_DAYS = 14;

/** Additive recency boost magnitude */
export const RECENCY_WEIGHT = 0.1;

/** Maximum allowed recency weight */
export const RECENCY_WEIGHT_MAX = 0.5;

/** Base multiplier for importance weighting (score * (base + importance * base)) */
export const IMPORTANCE_WEIGHT_BASE = 0.7;

/**
 * Reference text length for log normalization (longer texts penalized).
 * 0 disables the stage (see `applyLengthNormalization`'s early-return).
 * Disabled 2026-07-05: confirmed actively harmful, not just miscalibrated —
 * it demotes memories by parent-document verbosity, not by how much of the
 * matched chunk is relevant, and was the dominant compressor feeding the
 * MMR scale-mismatch bug (see MMR_LAMBDA below). Anchor value 500 (chars)
 * also never matched the chunk geometry (256-448 tokens) it was scoring.
 */
export const LENGTH_NORM_ANCHOR = 0;

/** Time decay half-life in days */
export const TIME_DECAY_HALF_LIFE_DAYS = 60;

/** Minimum time decay multiplier (floor for very old entries) */
export const TIME_DECAY_FLOOR = 0.6;

/** Dynamic memories use a shorter half-life when temporal decay is enabled */
export const TEMPORAL_DYNAMIC_HALF_LIFE_DIVISOR = 3;

/**
 * Relevance vs diversity tradeoff for MMR (0.7 = 70% relevance, 30% diversity).
 * `applyMmrDiversity` normalizes the relevance term to [0,1] (batch-max) before
 * applying this weight — without that normalization, the shrinker chain above
 * compresses relevance so far below the [0,1] cosine-similarity diversity term
 * that this ratio was moot (diversity always won). Fixed 2026-07-05.
 */
export const MMR_LAMBDA = 0.7;

// =============================================================================
// RETRIEVAL — RERANKING
// =============================================================================

/** Weight for fusion score in rerank blend */
export const RERANK_BLEND_VECTOR = 0.3;

/** Weight for cross-encoder score in rerank blend */
export const RERANK_BLEND_CROSS = 0.7;

/** Fusion-score weight in local cosine-blend rerank */
export const LIGHTWEIGHT_FUSION_WEIGHT = 0.7;

/** Cosine-similarity weight in local cosine-blend rerank */
export const LIGHTWEIGHT_COSINE_WEIGHT = 0.3;

/** Default rerank model identifier */
export const DEFAULT_RERANK_MODEL = "rerank-2";

/** Default timeout for rerank API calls in milliseconds */
export const DEFAULT_RERANK_TIMEOUT_MS = 15_000;

/**
 * How many rerank batches may be in flight at once. A candidate pool of
 * `MAX_CANDIDATE_POOL_SIZE` divided by a provider's per-request batch limit is 11 requests for
 * TEI, and sending them one after another put `DEFAULT_RERANK_TIMEOUT_MS` on the clock 11 times
 * over. Four is what the Sno GPU serves concurrently at near-linear 4x (owner-measured
 * 2026-08-17); the first failing wave still ends the whole rerank, so a wedged reranker costs one
 * timeout rather than one per batch.
 */
export const DEFAULT_RERANK_BATCH_CONCURRENCY = 4;

/**
 * Texts per HTTP request, applied whatever `rerankMaxCandidates` allows out in total: that one
 * is the operator's budget, this one is the transport's own per-request limit.
 *
 * Confirmed 2026-09-14 against the deployed self-hosted ranker, which answers a 51-text request
 * with `{"error":"too many texts: max 50, got 51"}`. Such a deployment rejects an over-limit
 * batch outright rather than truncating it, and the retriever files that HTTP 400 as "reranker
 * unavailable" — so getting this wrong degrades every call to raw fusion order with no visible
 * error.
 *
 * It binds every provider, not only the self-hosted one it was measured against. Making it
 * conditional on the configured provider name put the guarantee in a deploy script instead of
 * in the code. Hosted providers (voyage, jina, pinecone, dashscope) document much higher
 * limits, so holding them to this one only sends more, smaller requests, which the rerank waves
 * already run four at a time.
 */
export const DEFAULT_TEI_RERANK_MAX_CANDIDATES = 50;


// =============================================================================
// EMBEDDING — CHUNKER
// =============================================================================

/**
 * THE per-record token ceiling, and the only number of its kind in this repository (owner
 * ruling 2026-09-14). One stored memory record, one embedder input, one rerank candidate,
 * one row rendered into an aggregation answer: each is at most this many tokens, counted by
 * the embedder's own tokenizer (`Embedder.countTokens`), never estimated from characters.
 * Why one number: the local ONNX embedder silently truncates past its context window, the
 * Sno reranker silently truncates past its own, and a record longer than either scores on
 * its first half only — measured 2026-09-14, a claim placed past the cut ranked 0.0001.
 * The reranker's window is shared with the query and a fixed instruction, so this ceiling
 * must leave that room. It does NOT leave it by itself: a record at this ceiling plus any
 * query at all is already past the reranker's window, which is why the rerank path cuts the
 * request copy of a candidate down to what the query leaves, inside this same number.
 * The two tokenizers are no longer one vocabulary either — the deployed ranking model is not
 * the embedder's model (measured 2026-09-14), so a count taken here is an estimate of the
 * ranker's count, and the ranker's own refusal is the only exact measure.
 * Extraction is told to split anything longer (skill `extract-atomic-memory`); the store
 * refuses a longer record outright. Every other size in this file that describes a piece
 * of a record derives from this constant — do not write its value, or a fraction of it, as
 * a literal anywhere else.
 */
export const DEFAULT_MAX_CONTEXT_TOKENS = 512;

/**
 * Tokens the ranking model's own prompt template adds to a pair, on top of the query and the
 * document. Measured against the deployed endpoint 2026-09-14: a 509-token pair is accepted
 * and reported back as 512 input tokens, and a 510-token pair is refused as 513.
 */
export const RERANK_PROMPT_TEMPLATE_TOKENS = 3;

/** Maximum lines per chunk before forcing an earlier split at a line boundary */
export const DEFAULT_MAX_LINES_PER_CHUNK = 50;

// =============================================================================
// STORAGE — SQLITE
// =============================================================================

/** Default list query page size */
export const DEFAULT_LIST_LIMIT = 50;

/** Maximum allowed list query page size; also caps each search branch, so it stays ≥ the pool ceiling */
export const MAX_LIST_LIMIT = 512;

/** Maximum number of to-dos prepended to one recall result */
export const MAX_RECALLED_TODOS = 50;
export const MAX_RECALLED_TODO_TOKENS = 1_000;

/**
 * Ceiling for chunk-level fetch budgets (semantic/keyword chunk search).
 * Deliberately independent of MAX_LIST_LIMIT: memory-level wrappers overfetch
 * chunks (limit * 8) so one high-recall parent cannot collapse parent diversity.
 */
export const MAX_CHUNK_FETCH_LIMIT = 4096;

/** Batch size for bulk delete operations (respects SQLite ~32k bind-param limit) */
export const DELETE_BATCH_SIZE = 500;

// =============================================================================
// STORAGE — FORGET TOOL
// =============================================================================

/** Default limit for forget-query similarity search */
export const FORGET_QUERY_DEFAULT_LIMIT = 10;

/** Minimum score threshold for forget-query matches */
export const FORGET_QUERY_MIN_SCORE = 0.8;

// =============================================================================
// BACKUP
// =============================================================================

/**
 * Minimum age of the newest backup before another is taken (1 day). A backup is a full copy of
 * the store, so an hourly cadence cost a 1.7 GB store 40 GB of disk a day.
 */
export const BACKUP_INTERVAL_MS = 86_400_000;

/** Number of backup files to retain before rotation */
export const BACKUP_RETENTION_COUNT = 6;

/**
 * Share of the backup volume that must stay free. Before a backup is written the oldest backups are
 * deleted until the copy fits above this floor, and again afterwards if the volume is still under
 * it; the newest backup is always kept, and when even that is not enough the backup is skipped.
 */
export const BACKUP_MIN_FREE_DISK_RATIO = 0.1;

// =============================================================================
// MAINTENANCE
// =============================================================================
// One timer wakes every MAINTENANCE_TICK_MS and runs each job whose own interval has elapsed.
// Every job has its own constant so changing one cadence never moves another.

/** How often the maintenance timer wakes to see which jobs are due (1 hour). */
export const MAINTENANCE_TICK_MS = 3_600_000;

/** Full-page integrity sweep (1 hour). */
export const INTEGRITY_CHECK_INTERVAL_MS = 3_600_000;

/** Usage-telemetry outbox drain and quarantine cleanup (1 hour). */
export const USAGE_OUTBOX_INTERVAL_MS = 3_600_000;

/** Pruning of expired recall/inject usage events (1 hour). */
export const USAGE_EVENT_RETENTION_INTERVAL_MS = 3_600_000;

/** Full-text index segment merge (1 hour). */
export const FTS_MERGE_INTERVAL_MS = 3_600_000;

/** Query-planner statistics refresh (1 hour). */
export const PLANNER_STATISTICS_INTERVAL_MS = 3_600_000;

/**
 * How often the automatic REM trigger is evaluated (1 hour). Evaluating is only a check: REM
 * itself runs on its own daily schedule and volume rule in src/sidecar/rem-trigger.ts.
 */
export const REM_TRIGGER_CHECK_INTERVAL_MS = 3_600_000;

// =============================================================================
// CACHE — EMBEDDER
// =============================================================================

/** Embedder LRU cache max entries */
export const CACHE_SIZE = 256;

/** Embedder LRU cache TTL in milliseconds (30 minutes) */
export const CACHE_TTL_MS = 1_800_000;

// =============================================================================
// CACHE — SYSTEM
// =============================================================================

/** Kill switch file check interval in milliseconds */
export const KILL_SWITCH_CACHE_TTL_MS = 100;

/** Cost estimate cache TTL in milliseconds */
export const COST_ESTIMATE_CACHE_TTL_MS = 5_000;

// =============================================================================
// SESSION TRACKING
// =============================================================================

/** Max sessions tracked in LRU map */
export const MAX_TRACKED_SESSIONS = 100;

/** Max recall history entries per session */
export const MAX_SESSION_RECALL_ENTRIES = 200;

/** Default number of recent messages to read from a session file */
export const DEFAULT_SESSION_MESSAGE_COUNT = 15;

/** Chunk size for reading last JSON line from session files */
export const LAST_JSON_LINE_CHUNK_BYTES = 4_096;

/** Token budget per session-summary chunk sent to the model */
export const SESSION_SUMMARY_CHUNK_TOKENS = 4_096;

/**
 * Total token budget for a session-summary transcript before chunking. Message count is bounded
 * upstream but per-message text is not, so a handful of very large messages can otherwise produce
 * an effectively unlimited number of chunks. The most-recent portion is kept (drop-oldest).
 */
export const SESSION_SUMMARY_MAX_INPUT_TOKENS = 32_768;

/**
 * Hard cap on sequential model calls in one reset-time session-summary capture. Backstops the input
 * budget so a single capture can never run indefinitely even if the pre-chunk budget has a gap. At
 * the default 30s per-chunk timeout this bounds a capture to roughly SESSION_SUMMARY_MAX_CHUNKS × 30s.
 */
export const SESSION_SUMMARY_MAX_CHUNKS = 8;

// =============================================================================
// CAPTURE — INPUT FILTERING
// =============================================================================

/** Transcript budget shared by an atomic window and its preceding context. */
export const ATOMIC_EXTRACTION_MAX_INPUT_TOKENS = 4_096;
export const ATOMIC_ENRICHMENT_OUTPUT_TOKEN_BUDGET = 1_400;
/**
 * Output cap of one capture call. The capture reply lists every claim and then every fact with
 * its quote, roughly 70 tokens per fact; at 4,096 a 35-turn session replayed as one turn hit the
 * cap and lost the whole window (43 of 272 LoCoMo sessions, measured 2026-09-13).
 */
export const ATOMIC_CAPTURE_OUTPUT_TOKEN_BUDGET = 8_192;

/** Minimum text length for CJK content to be captured */
export const CAPTURE_MIN_LENGTH_CJK = 4;

/** Minimum text length for non-CJK content to be captured */
export const CAPTURE_MIN_LENGTH_STANDARD = 10;

/** Maximum character length of auto-recall query before truncation */
export const DEFAULT_AUTO_RECALL_MAX_QUERY_LENGTH = 2000;

/** Maximum emoji count before content is rejected as noise */
export const CAPTURE_MAX_EMOJI_COUNT = 3;

/** Minimum trimmed text length before content is classified as noise */
export const NOISE_MIN_TEXT_LENGTH = 5;

// =============================================================================
// CAPTURE — AMBIENT LEARNING TUNABLES (eval-tracked, 2026-04-17)
// =============================================================================
// These are the knobs exercised by the memory-bench harness. Before
// changing a value here, capture the baseline scorecard; after changing, run
// one `eval-plugin.sh` pass and diff. Comments note the winning value and
// the bench delta that produced it, so the history is discoverable in code.

/**
 * Whether ambient-learning requires a text to match the `MEMORY_TRIGGERS` regex
 * whitelist (e.g. `i prefer`, `my X is Y`, `we decided`, `remember`, ...).
 *
 * When `true`, texts lacking any trigger keyword are dropped — high precision,
 * low recall. The bench corpus exposes the cost: teach turns like
 *   "My team lead at Anthropic is Maya Patel"  (fails `my\s+\w+\s+is` — 4 words)
 *   "My go-to coffee is an oat milk latte"     (fails — "go-to" has hyphen)
 *   "My teammates on Glacier are Jin ..."      (fails — "are" not "is")
 * were silently dropped, contributing 5 of 7 missing probes at 53%.
 *
 * When `false`, only length / noise / prompt-injection filters apply.
 * Content-hash dedup in the store keeps volume bounded.
 *
 * Bench history:
 *   - true  → 53% (post-runtime-fix baseline).
 *   - false → TBD (under evaluation 2026-04-17).
 */
export const AMBIENT_LEARNING_REQUIRE_TRIGGER_MATCH = false;

/**
 * Top-K memories injected into the agent's prepend context at
 * `before_agent_start`. Higher values expose more facts but increase
 * prompt size + reranker workload.
 *
 * Bench history (LoCoMo mid, 50 rows, isolated sessions, 2026-04-22):
 *   - 5 → 52% (original default) — too many R3 refusals on specific-date/object
 *     queries because the answer memory wasn't ranked in the top 5.
 *   - 15 → 66% (+14pp) — opens the budget for list/count/temporal queries.
 *     Peak score; the remaining failures are memories ranked beyond 15 or
 *     wrong-content retrievals (architectural, not budget).
 *   - 25 → 64% (−2pp vs 15) — wider top-k dilutes with noise; agent surfaces
 *     adjacent-but-wrong memories.
 *
 * 2026-04-27 (commit 6a3ab60): raised to 20 — the Round-B chunked retrieval
 * pipeline tightened candidate quality enough that the K=15→20 dilution risk
 * noted above no longer dominated, and the wider budget caught list/count/
 * temporal queries whose answer ranked 16-20 on conv0.
 *
 * 2026-07-02: re-tightened to 10 after the RETRIEVAL_CHUNK_PROFILE migration
 * (target 384→512, max 448→1536) ballooned per-question prompts to ~123k
 * chars and the score fell to 58%. That large-chunk profile was itself
 * reverted the next day (`RETRIEVAL_STORAGE_CHUNK_PROFILE` back to
 * 256/384/448/32, validated 86% on 2026-07-03) — but this constant was never
 * reverted alongside it, leaving it stuck compensating for a regression that
 * no longer exists.
 *
 * 2026-07-05: reverted to 20 to match. The shipped default must equal what
 * the eval harness actually validates (`run-eval.sh` pins `recallTopK: 20`;
 * the 86% run above used it) — production and eval must not diverge.
 */
export const AUTO_RECALL_INJECTION_TOP_K = 20;

/**
 * Lean recall top-K — the lower-cost alternative surfaced in onboarding copy.
 * Pre-512-geometry history (K=15 lean vs K=20 default, LoCoMo conv0 74-fact
 * corpus, 4-run avg ±0.88pp): 86.25% correctness, ~9.3M prompt tokens /
 * 400 QAs, ~25% cheaper than the then-default K=20.
 *
 * 2026-07-02: rescaled 15 → 8 alongside the default's 20 → 10 for a
 * large-chunk profile that was itself reverted the next day. 2026-07-05:
 * reverted to 15 alongside AUTO_RECALL_INJECTION_TOP_K's 10 → 20 revert,
 * restoring the original ~0.75 lean:default ratio.
 *
 * This constant is the source of truth for the "Lean N" token in
 * `openclaw.plugin.json` uiHints and the Path A install nudge.
 * AC5 drift test (`tests/apps/mem-claw/unit/config-drift.test.ts`)
 * pins all four surfaces to this constant.
 */
export const AUTO_RECALL_LEAN_TOP_K = 15;

// =============================================================================
// REFLECTION — PIPELINE
// =============================================================================

/** Default number of recent messages used for reflection input */
export const DEFAULT_REFLECTION_MESSAGE_COUNT = 120;

/** Maximum input characters for reflection prompt */
export const DEFAULT_REFLECTION_MAX_INPUT_CHARS = 24_000;

/** Timeout for individual reflection LLM calls in milliseconds */
export const DEFAULT_REFLECTION_TIMEOUT_MS = 20_000;

/** Maximum error reminder entries included in reflection prompt */
export const DEFAULT_REFLECTION_ERROR_REMINDER_MAX_ENTRIES = 3;

/** Session TTL in reflection tracking map (30 minutes) */
export const DEFAULT_REFLECTION_SESSION_TTL_MS: number = 30 * 60 * 1000;

/** Maximum sessions tracked in reflection state */
export const DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS = 200;

/** Maximum chars scanned for error signals in conversation */
export const DEFAULT_REFLECTION_ERROR_SCAN_MAX_CHARS = 8_000;

// =============================================================================
// REFLECTION — EXTRACTION & STORAGE
// =============================================================================

/** Maximum invariant entries extracted from a single reflection */
export const REFLECTION_MAX_INVARIANTS = 8;

/** Maximum derived delta entries extracted from a single reflection */
export const REFLECTION_MAX_DERIVED = 10;

/** Cosine similarity threshold above which a reflection is considered duplicate */
export const REFLECTION_DEDUP_THRESHOLD = 0.97;

/** Minimum score for dedup similarity search (low to catch near-dupes) */
export const REFLECTION_DEDUP_MIN_SCORE = 0.1;

/** Importance score assigned to stored reflection entries */
export const REFLECTION_IMPORTANCE = 0.75;

/** Maximum filename collision retries for reflection FS output */
export const REFLECTION_MAX_FILENAME_ATTEMPTS = 10;

/** Cache TTL for loaded reflection slices in milliseconds */
export const REFLECTION_SLICE_CACHE_TTL_MS = 15_000;

/** Maximum age for derived deltas to be included in context (2 hours) */
export const REFLECTION_DERIVED_MAX_AGE_MS = 7_200_000;

// =============================================================================
// EXTRACTION — PROFILE MERGE
// =============================================================================

/**
 * Minimum cosine score for `handleProfileMerge` to fire an unconditional merge
 * on an identity row. NO dedup LLM gate runs after this — the threshold is
 * the only filter — so it must be tight enough that "plausibly related"
 * identity facts do not get merged together. Matched to the compaction
 * clustering bar.
 */
export const PROFILE_MERGE_THRESHOLD = 0.88;

// =============================================================================
// CHUNKING — MIRRORED PACKAGE DEFAULTS (PRD §15.1.2)
// =============================================================================
// mem-claw's retrieval storage chunk geometry. LoCoMo-tuned to 256/384/448/32,
// validated at 86% on stratified-100 (2026-07-03). Deliberately smaller than
// `@snoai/chunking` RETRIEVAL_CHUNK_PROFILE (256/512/1536/128): under top-20
// auto-recall injection, the large-chunk profile overflowed the agent prompt
// (~123k chars) and the model drowned in noise (~58%). Small, fact-dense chunks
// keep the injected window usable. This mem-claw-local override is the source of
// truth for what memory-store-row-codec actually chunks with; the shared package
// default is unchanged so other consumers keep the multi-dataset 512/1536 sizing.
// Expressed as fractions of DEFAULT_MAX_CONTEXT_TOKENS (1/2, 3/4, 7/8, 1/16) so the
// validated geometry is preserved exactly while the only literal stays the ceiling itself.
export const RETRIEVAL_STORAGE_CHUNK_PROFILE: {
	readonly minTokens: number;
	readonly targetTokens: number;
	readonly maxTokens: number;
	readonly overlapTokens: number;
} = {
	minTokens: DEFAULT_MAX_CONTEXT_TOKENS / 2,
	targetTokens: (DEFAULT_MAX_CONTEXT_TOKENS * 3) / 4,
	maxTokens: (DEFAULT_MAX_CONTEXT_TOKENS * 7) / 8,
	overlapTokens: DEFAULT_MAX_CONTEXT_TOKENS / 16,
};

/** Minimum tokens per chunk before merge (mirrors RETRIEVAL_STORAGE_CHUNK_PROFILE). */
export const CHUNK_MIN_TOKENS: typeof RETRIEVAL_STORAGE_CHUNK_PROFILE.minTokens =
	RETRIEVAL_STORAGE_CHUNK_PROFILE.minTokens;

/** Target tokens per chunk (mirrors RETRIEVAL_STORAGE_CHUNK_PROFILE). */
export const CHUNK_TARGET_TOKENS: typeof RETRIEVAL_STORAGE_CHUNK_PROFILE.targetTokens =
	RETRIEVAL_STORAGE_CHUNK_PROFILE.targetTokens;

/** Max tokens per chunk before split (mirrors RETRIEVAL_STORAGE_CHUNK_PROFILE). */
export const CHUNK_MAX_TOKENS: typeof RETRIEVAL_STORAGE_CHUNK_PROFILE.maxTokens =
	RETRIEVAL_STORAGE_CHUNK_PROFILE.maxTokens;

/** Overlap tokens between adjacent chunks (mirrors RETRIEVAL_STORAGE_CHUNK_PROFILE). */
export const CHUNK_OVERLAP_TOKENS: typeof RETRIEVAL_STORAGE_CHUNK_PROFILE.overlapTokens =
	RETRIEVAL_STORAGE_CHUNK_PROFILE.overlapTokens;

/** Tokenizer mode used by the chunker (mirrors DEFAULT_CHUNK_CONFIG.tokenizerMode). */
export const CHUNK_TOKENIZER_MODE: typeof DEFAULT_CHUNK_CONFIG.tokenizerMode =
	DEFAULT_CHUNK_CONFIG.tokenizerMode;

/** Chunking pipeline version stamp (re-exported from @snoai/chunking). */
export { CHUNKING_VERSION };

// =============================================================================
// HEAD-EXTRACT (PRD §15.1.2)
// =============================================================================

/** Head-extract tunables re-exported from @snoai/chunking. */
export {
	HEAD_EXTRACT_MIN_CONTENT_TOKENS,
	HEAD_EXTRACT_OVERLAP_DROP_RATIO,
	HEAD_EXTRACT_TOKEN_BUDGET,
};

/**
 * Diagnostic threshold for intra-memory chunk cosine similarity (PRD §8.1).
 * Pairs above this score are flagged as redundant during eval / introspection.
 */
export const INTRA_MEMORY_COSINE_THRESHOLD = 0.92;

// =============================================================================
// EMBEDDER PROVENANCE (PRD §14 step 10)
// =============================================================================

/** Alias for VECTOR_DIMENSION_DEFAULT — the embedder output dimension. */
export const EMBEDDER_DIM: typeof VECTOR_DIMENSION_DEFAULT = VECTOR_DIMENSION_DEFAULT;

/** Default embedder provider id stamped into chunk provenance. */
export const EMBEDDER_PROVIDER_DEFAULT = "local-onnx" as const;

/**
 * Default embedder model id stamped into chunk provenance.
 *
 * Codex 2026-04-30 (batch-C C1): the previous hard-coded
 * `qwen3-embedding-4b@1024` did not match the actual local default
 * (`LOCAL_EMBEDDING_MODEL`, the bundled local embedding model), which would
 * mislabel every default-provider chunk in eval traces. Tracking the
 * embedder package's constant keeps provenance honest by construction.
 */
export const EMBEDDER_MODEL_DEFAULT: typeof LOCAL_EMBEDDING_MODEL = LOCAL_EMBEDDING_MODEL;

// =============================================================================
// AGGREGATION — MULTI-HIT / ADJACENCY BONUSES (PRD §15.1.2)
// =============================================================================

/** SQL window cap on chunks per parent memory (prevents parent flooding). */
export const MAX_CHUNKS_PER_PARENT = 16;

/** Per-hit bonus for repeated chunk hits inside one parent. */
export const MULTI_HIT_BONUS_PER_HIT: typeof DEFAULT_AGGREGATION_CONFIG.multiHitBonusPerHit =
	DEFAULT_AGGREGATION_CONFIG.multiHitBonusPerHit;

/** Cap on the cumulative multi-hit bonus per parent. */
export const MULTI_HIT_BONUS_CAP: typeof DEFAULT_AGGREGATION_CONFIG.multiHitBonusCap =
	DEFAULT_AGGREGATION_CONFIG.multiHitBonusCap;

/** Per-pair bonus for adjacent chunk hits within one parent. */
export const ADJACENCY_BONUS_PER_PAIR: typeof DEFAULT_AGGREGATION_CONFIG.adjacencyBonusPerPair =
	DEFAULT_AGGREGATION_CONFIG.adjacencyBonusPerPair;

/** Cap on the cumulative adjacency bonus per parent. */
export const ADJACENCY_BONUS_CAP: typeof DEFAULT_AGGREGATION_CONFIG.adjacencyBonusCap =
	DEFAULT_AGGREGATION_CONFIG.adjacencyBonusCap;

/** Invariant: bonusTotalInvariant >= MULTI_HIT_BONUS_CAP + ADJACENCY_BONUS_CAP. */
export const BONUS_TOTAL_INVARIANT: typeof DEFAULT_AGGREGATION_CONFIG.bonusTotalInvariant =
	DEFAULT_AGGREGATION_CONFIG.bonusTotalInvariant;

// =============================================================================
// SNIPPET EXPANSION (PRD §15.1.2)
// =============================================================================

/**
 * Number of preceding chunks pulled into a snippet window.
 *
 * Override (not the package default) — LoCoMo eval showed multi-fact
 * questions that span 4+ messages were partially answered when the window
 * was 1 (e.g. "what events has Caroline done to help children" landed on
 * mentorship but missed the school-speech chunk two messages away). Bumped
 * to 2 paired with the head-extract metadata-preserve fix (2026-05-01).
 * A later LoCoMo `3/3` trial improved mid-50 but regressed full conv0 by
 * adding nearby distractors, so the stable default remains `2/2`.
 */
export const SNIPPET_NEIGHBOR_BEFORE = 2;

/** Number of following chunks pulled into a snippet window. See above. */
export const SNIPPET_NEIGHBOR_AFTER = 2;
void DEFAULT_SNIPPET_NEIGHBOR_BEFORE;
void DEFAULT_SNIPPET_NEIGHBOR_AFTER;

// =============================================================================
// EVAL TRACE TOGGLES (PRD §11.2.2)
// =============================================================================

/** When false, retrieval traces are not written. Eval harness flips this on. */
export const EVAL_TRACE_ENABLED = false;

/** Filename for the per-eval-run config snapshot. */
export const EVAL_CONFIG_SNAPSHOT_FILENAME = "config-snapshot.json" as const;

/** Filename for per-QA retrieval traces emitted during eval runs. */
export const EVAL_QA_TRACES_FILENAME = "qa_traces.jsonl" as const;

// =============================================================================
// RETRIEVAL — MISC LIFTED LITERALS (PRD §15.1.3)
// =============================================================================

/** Multiplicative penalty applied to unreturned candidates after rerank. */
export const LIGHTWEIGHT_RERANK_PENALTY = 0.8;

/** Maximum tokens kept in a sanitized FTS5 MATCH expression. */
export const FTS_QUERY_TOKEN_CAP = 50;

// =============================================================================
// RECALL LIFECYCLE (PRD §6.1)
// =============================================================================
// Phase 0 lands code; Phase 1+ flips boolean defaults. All knobs are pinned to
// the values in `mem-lifecycle` PRD §6.1 — changing any pinned default requires
// a new openspec change proposal.

type RecallLifecycleConfigShape = {
	retentionScorer: boolean;
	tierPromoter: boolean;
	autoRecallAccessTracking: boolean;
	traceEnabled: boolean;
	tierFloorMode: "bare" | "withFloor";
	tierPromotionTopK: number;
	accessRateLimitMs: number;
	accessCountCeiling: number;
};

/**
 * Zod schema for the `recallLifecycle` config block. The whole block defaults
 * to `{}` so existing configs without it continue to parse and behave
 * bit-for-bit identically to the pre-Phase-0 baseline.
 *
 * Spec: openspec/changes/mem-lifecycle/specs/config/spec.md.
 */
export const recallLifecycleSchema: z.ZodType<RecallLifecycleConfigShape, unknown> = z
	.object({
		// --- Booleans (all default true — recallLifecycle fully enabled) ---
		retentionScorer: z.boolean().default(true), // PRD §6.1
		tierPromoter: z.boolean().default(true), // PRD §6.1
		autoRecallAccessTracking: z.boolean().default(true), // PRD §6.1
		// Lifecycle trace-writer extension: emits one trace row per
		// lifecycle step. Diagnostic only — no scoring path.
		traceEnabled: z.boolean().default(true),

		// --- Tuning knobs (pinned per PRD §6.1) ---
		tierFloorMode: z.enum(["bare", "withFloor"]).default("bare"), // PRD §6.1
		tierPromotionTopK: z.number().int().positive().default(3), // PRD §6.1
		accessRateLimitMs: z.number().int().nonnegative().default(3_600_000), // PRD §6.1 (1h)
		accessCountCeiling: z.number().int().positive().default(20), // PRD §6.1
	})
	.prefault({});

/** Inferred config shape for the `recallLifecycle` block. */
export type RecallLifecycleConfig = z.infer<typeof recallLifecycleSchema>;

/**
 * Resolved default `recallLifecycle` config. Use in code paths that need a
 * literal default object instead of re-parsing the schema each time.
 */
export const DEFAULT_RECALL_LIFECYCLE: RecallLifecycleConfig =
	recallLifecycleSchema.parse(undefined);
