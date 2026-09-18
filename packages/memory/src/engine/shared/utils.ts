/** @file utils.ts
 * @purpose Provides shared utility functions used across plugin runtime modules.
 * @boundary Text normalization, hashing, filesystem helpers, and small conversions.
 * @see store.ts, capture-policy-detector.ts, memory-management-cli.ts.
 */

import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { sanitizeContentIngress } from "@snoai/content-sanitizer";
import { DEFAULT_IMPORTANCE, FTS_QUERY_TOKEN_CAP } from "../../../config/index";
import { redactSecrets } from "../security/redact";
import { stripHtmlTags, tokenizeForFts, truncateGraphemes } from "./i18n-text";

/**
 * Clamps integer options into the configured range before they reach storage or ranking code.
 */
export function clampInt(value: number, min: number, max: number): number {
	// Guard this branch early so the remaining module behavior path works with normalized inputs.
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Clamps score-like values to the 0..1 range while honoring a caller-provided fallback. */
export function clamp01(value: number, fallback: number = DEFAULT_IMPORTANCE): number {
	// Guard this branch early so the remaining module behavior path works with normalized inputs.
	if (!Number.isFinite(value)) return fallback;
	return Math.min(1, Math.max(0, value));
}

/** Resolves env vars with the fallback order required by shared utility helpers. */
export function resolveEnvVars(value: string): string {
	return value.replace(/\$\{([^}]+)\}/g, (_matched, envVar) => {
		const envValue = process.env[envVar];
		// Guard env value here so the remaining module behavior path works with normalized inputs.
		if (!envValue) {
			// Surface this invalid utility behavior state as an explicit typed failure.
			throw new Error(`Environment variable ${envVar} is not set`);
		}
		return envValue;
	});
}

/** Redacts markup-sensitive characters before memory text is embedded in prompt context. */
export function sanitizeForContext(text: string, maxChars = 500, newlineReplacement = " "): string {
	const storageSafe = sanitizeContentIngress({
		source: "generic-text",
		content: text,
	}).projections.plainText;
	const sanitized = stripHtmlTags(storageSafe)
		.replace(/[\r\n]+/g, newlineReplacement)
		.replace(/</g, "\uFF1C")
		.replace(/>/g, "\uFF1E")
		.replace(/\s+/g, " ")
		.trim();
	return truncateGraphemes(sanitized, maxChars);
}

const FTS5_RESERVED_TOKENS = new Set(["AND", "OR", "NOT", "NEAR"]);
const MAX_FTS_QUERY_TOKENS = FTS_QUERY_TOKEN_CAP;

// Common English function words. Space-joining quoted FTS5 tokens defaults to
// AND (every token must co-occur in one row), so a question like "Which
// basketball team does Tim support?" required "which" and "does" to appear
// in the same 384-token chunk as "tim" and "support" — the keyword branch
// returned zero results on ordinary questions (confirmed 2026-07-05). Dropping
// these before the OR join (below) keeps the query on real content words.
const FTS_STOPWORDS = new Set([
	"a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "for",
	"is", "are", "was", "were", "be", "been", "being", "do", "does", "did",
	"has", "have", "had", "what", "which", "who", "whom", "when", "where",
	"how", "why", "this", "that", "these", "those", "with", "as", "by", "from",
	"it", "its", "i", "you", "he", "she", "we", "they", "them", "his", "her",
	"their", "our", "your", "my",
]);

/** Escapes SQLite FTS operators so user queries cannot break MATCH syntax. */
export function sanitizeFtsQuery(rawQuery: string): string {
	const tokens = tokenizeForFts(rawQuery)
		.filter((token) => token.length > 0)
		.filter((token) => !FTS5_RESERVED_TOKENS.has(token.toUpperCase()))
		.filter((token) => !FTS_STOPWORDS.has(token.toLowerCase()))
		.slice(0, MAX_FTS_QUERY_TOKENS);
	// Treat the empty collection as a first-class outcome instead of widening behavior.
	if (tokens.length === 0) return "";

	// OR (not AND, FTS5's default for space-joined tokens): a keyword match
	// should surface a chunk containing ANY of the query's content words, with
	// `bm25()` ranking rows by how many/how rare the matched terms are — it
	// does not require every token to co-occur in one chunk.
	return tokens.map((token) => `"${token}"`).join(" OR ");
}

/** Builds a conjunctive FTS predicate from validated structured aggregation terms. */
export function sanitizeFtsConjunctiveQuery(terms: readonly string[]): string {
	let remainingTokens = MAX_FTS_QUERY_TOKENS;
	const clauses = terms.flatMap((term) => {
		const tokens = tokenizeForFts(term)
			.filter((token) => token.length > 0)
			.filter((token) => !FTS5_RESERVED_TOKENS.has(token.toUpperCase()))
			.slice(0, remainingTokens);
		remainingTokens -= tokens.length;
		return tokens.length > 0 ? [`(${tokens.map((token) => `"${token}"`).join(" OR ")})`] : [];
	});
	return clauses.join(" AND ");
}

/** Serializes Float32 vectors into little-endian bytes for SQLite vector storage. */
// LH: Float32Array is the canonical vector type throughout sno-station-mem so adapters do not repeatedly coerce number arrays.
// LH: sqlite-vec expects packed f32 bytes, so conversion belongs in one helper with alignment handled explicitly.
// LH: Keeping vector serialization centralized protects retrieval math from silent precision and byte-order regressions.
// LH: Callers should validate vector dimensions before this conversion so byte output is only a storage concern.
export function f32ToBytes(f32: Float32Array): Uint8Array {
	return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

/** Rehydrates SQLite vector bytes into Float32 values and rejects malformed payloads. */
// LH: Byte reads always copy into aligned storage because SQLite blobs can expose offsets that Float32Array cannot use safely.
// LH: Callers receive a real Float32Array so rerank, compaction, and reflection stores can share vector math directly.
// LH: Do not return a view into the SQLite-owned buffer; callers may retain vectors beyond statement lifetime.
// LH: This function is the inverse of f32ToBytes and should remain boring, deterministic, and allocation-safe.
export function bytesToF32(bytes: Uint8Array): Float32Array {
	// better-sqlite3 (Node prod) returns pooled Buffer slices with arbitrary
	// byteOffset. Float32Array requires 4-byte alignment, so always copy into
	// a fresh ArrayBuffer before viewing. The copy is cheap (1024 f32 = 4 KB).
	if (bytes.byteLength % 4 !== 0) {
		// Surface this invalid utility behavior state as an explicit typed failure.
		throw new Error(`bytesToF32: byteLength ${bytes.byteLength} not a multiple of 4`);
	}
	const aligned = new Uint8Array(bytes.byteLength);
	aligned.set(bytes);
	return new Float32Array(aligned.buffer);
}

/** Produces the stable content hash used for deduplication and idempotent writes. */
export function stableHash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Return a short, secret-redacted, whitespace-collapsed preview of `text` for
 * debug audit logs — but only when `SNO_STATION_MEM_DEBUG_CONTENT=1`. Off-by-default
 * and passes the text through `redactSecrets` first because previews persist
 * in audit.jsonl on disk. Enable for bench investigations only.
 */
export function debugContentPreview(text: string | undefined, maxChars = 80): string | undefined {
	// Guard this branch early so the remaining module behavior path works with normalized inputs.
	if (process.env.SNO_STATION_MEM_DEBUG_CONTENT !== "1") return undefined;
	if (!text) return undefined;
	const collapsed = redactSecrets(text).replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) return undefined;
	return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars)}...` : collapsed;
}

/** Max bytes to read from the tail of a session JSONL file (512 KB). */
const SESSION_TAIL_MAX_BYTES = 512 * 1024;

/**
 * Read the tail of a text file (up to `maxBytes`).
 * Returns the file content from the tail. If the file is smaller than `maxBytes`,
 * returns the entire file. The first partial line is dropped (it was likely truncated).
 */
export async function readFileTail(
	filePath: string,
	maxBytes: number = SESSION_TAIL_MAX_BYTES,
): Promise<string> {
	const fileStat = await stat(filePath);
	if (fileStat.size <= maxBytes) {
		const handle = await open(filePath, "r");
		try {
			const buf = Buffer.alloc(fileStat.size);
			await handle.read(buf, 0, fileStat.size, 0);
			return buf.toString("utf-8");
		} finally {
			await handle.close();
		}
	}

	const handle = await open(filePath, "r");
	try {
		const startPos = fileStat.size - maxBytes;
		const buf = Buffer.alloc(maxBytes);
		await handle.read(buf, 0, maxBytes, startPos);
		const raw = buf.toString("utf-8");
		// Drop the first partial line since we likely sliced mid-line.
		// host 2026-04-30 (batch-C C3): if no newline is present at all the
		// entire window is the tail of a single (truncated) record — returning
		// `raw` would feed downstream JSONL parsers half a record. Return the
		// empty string instead so callers fall through to "no content".
		const firstNewline = raw.indexOf("\n");
		if (firstNewline === -1) return "";
		return raw.slice(firstNewline + 1);
	} finally {
		await handle.close();
	}
}
