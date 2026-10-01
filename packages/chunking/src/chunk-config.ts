import { z } from "zod";
import { CHUNKING_VERSION } from "./chunking-version.js";
import { CONTENT_TYPES, type ContentType } from "./content-type.js";

/**
 * Per PRD §7.1 / §15.1.2. Tokenizer modes used to count chunk tokens deterministically.
 *
 * Phase 1 ships a single mode. `tiktoken` is listed in §15.1.2 as aspirational
 * ("if added — must be deterministic"); it is not a member of this union until
 * the implementation lands, so a config like `{ tokenizerMode: "tiktoken" }`
 * fails schema validation rather than crashing inside `countTokens`.
 */
export const TOKENIZER_MODES = ["char-approximation"] as const;

/** Per PRD §7.1 / §15.1.2. */
export type TokenizerMode = (typeof TOKENIZER_MODES)[number];

/** Per PRD §7.1 / §15.1.2. Validates `ChunkConfig` at trust boundaries. */
export const ChunkConfigSchema = z
	.object({
		minTokens: z.number().int().positive().default(256),
		targetTokens: z.number().int().positive().default(384),
		maxTokens: z.number().int().positive().default(448),
		overlapTokens: z.number().int().nonnegative().default(32),
		tokenizerMode: z.enum(TOKENIZER_MODES).default("char-approximation"),
		chunkingVersion: z.literal(CHUNKING_VERSION).default(CHUNKING_VERSION),
		contentType: z.enum(CONTENT_TYPES).default("prose"),
	})
	.strict()
	.refine((c) => c.minTokens <= c.targetTokens && c.targetTokens <= c.maxTokens, {
		message: "minTokens <= targetTokens <= maxTokens must hold",
	})
	.refine((c) => c.overlapTokens < c.minTokens, {
		message: "overlapTokens must be smaller than minTokens",
	});

/** Per PRD §7.1. Inferred type — single source of truth derived from the schema. */
export type ChunkConfig = z.infer<typeof ChunkConfigSchema>;

/** Per PRD §7.1 / §15.1.2. Default values mirrored as constants for direct consumers. */
export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
	minTokens: 256,
	targetTokens: 384,
	maxTokens: 448,
	overlapTokens: 32,
	tokenizerMode: "char-approximation",
	chunkingVersion: CHUNKING_VERSION,
	contentType: "prose" satisfies ContentType,
};

/**
 * Size-only chunk profile (min/target/max/overlap in tokens). Sizing intent —
 * retrieval vs graph extraction — is orthogonal to boundary type
 * (prose/conversation/structured), so a profile carries only the four size
 * knobs and the caller supplies `contentType`.
 */
export interface ChunkSizeProfile {
	readonly minTokens: number;
	readonly targetTokens: number;
	readonly maxTokens: number;
	readonly overlapTokens: number;
}

/**
 * Recommended chunk-size profiles ship with the package so every consumer
 * references a named sizing intent instead of hard-coding a raw number.
 *
 * Spread a profile into a `chunk()` call and add the content type:
 *   chunk(text, { ...RETRIEVAL_CHUNK_PROFILE, contentType: "prose" }, memoryId)
 *
 * `RETRIEVAL_CHUNK_PROFILE` — embedding + FTS retrieval chunks. `targetTokens:
 * 512` per the 2026-01-25 multi-dataset
 * chunk-size evaluation (arXiv 2505.21700 finds 512–1024-token chunks suit
 * context-dependent retrieval; 64–128 only fits terse fact lookup). `maxTokens:
 * 1536` absorbs the occasional very long unit without a mid-unit force split.
 */
export const RETRIEVAL_CHUNK_PROFILE = {
	minTokens: 256,
	targetTokens: 512,
	maxTokens: 1536,
	overlapTokens: 128,
} as const satisfies ChunkSizeProfile;

/**
 * `GRAPH_EXTRACTION_CHUNK_PROFILE` — knowledge-graph extraction input.
 * Larger target so each chunk keeps enough cross-sentence context to identify
 * entity relationships, within Microsoft GraphRAG's 300–1200-token sweet spot
 * (its default is 1200). NOTE: adopt this in place of a larger legacy target only
 * after a graph-extraction eval confirms the target on the real corpus — smaller
 * chunks yield a denser graph (more entities/relations) but can sever
 * cross-sentence relations, so the target is corpus-dependent.
 */
export const GRAPH_EXTRACTION_CHUNK_PROFILE = {
	minTokens: 512,
	targetTokens: 1200,
	maxTokens: 1536,
	overlapTokens: 200,
} as const satisfies ChunkSizeProfile;
