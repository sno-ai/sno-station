/**
 * Per PRD §7.1, §7.2, §7.4. Deterministic structure-aware chunker.
 *
 * Greedy linear scan over content-type-specific boundaries. Same input + same
 * config → byte-identical output. No timestamps, no random IDs — Task 5
 * implements deterministic ID generation; until then `chunkId` is `""`.
 */

import {
	detectConversationBoundaries,
	detectProseBoundaries,
} from "./boundaries.js";
import { type ChunkConfig, ChunkConfigSchema, type TokenizerMode } from "./chunk-config.js";
import type { ChunkMetadataDraft } from "./chunk-metadata.js";
import { CHUNKING_VERSION } from "./chunking-version.js";
import type { ContentType } from "./content-type.js";
import { chunkStructured } from "./structured.js";
import { countTokens } from "./tokenize.js";

/** Per PRD §7.2. Picks the boundary detector for a given content type. */
function pickDetector(contentType: ContentType): (text: string) => { offsets: number[] } {
	switch (contentType) {
		case "conversation":
			return detectConversationBoundaries;
		case "prose":
		case "structured":
			return detectProseBoundaries;
		default: {
			const _exhaustive: never = contentType;
			throw new Error(`Unexpected contentType: ${String(_exhaustive)}`);
		}
	}
}

/** Per PRD §7.1. Approximate char-per-token ratio for the given text+mode. */
function charsPerToken(text: string, config: ChunkConfig): number {
	if (text.length === 0) return 3;
	const tokens = countTokens(text, config.tokenizerMode);
	if (tokens === 0) return 3;
	return text.length / tokens;
}

/** Per PRD §7.2. Find the largest boundary index strictly greater than `start`. */
function nextBoundaryIndex(boundaries: number[], start: number, fromIdx: number): number {
	for (let i = fromIdx; i < boundaries.length; i++) {
		const b = boundaries[i];
		if (b !== undefined && b > start) return i;
	}
	return -1;
}

/**
 * Per PRD §7.2. Force-split point inside an oversized span.
 *
 * Validates by `countTokens` (not by char-ratio) so mixed-CJK input cannot
 * exceed `maxTokens`: re-evaluating the divisor per-slice is the only way
 * to honor the cap when CJK density varies along the text.
 */
function forceSplitOffset(
	text: string,
	start: number,
	targetTokens: number,
	maxTokens: number,
	tokenizerMode: TokenizerMode,
): number {
	// Binary search for the largest end such that countTokens(start..end) <= maxTokens.
	let lo = start;
	let hi = text.length;
	while (lo < hi) {
		const mid = Math.floor((lo + hi + 1) / 2);
		if (countTokens(text.slice(start, mid), tokenizerMode) <= maxTokens) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	// Never cut between the two halves of a surrogate pair (an emoji, for one):
	// both chunks would hold a broken character. Stepping back only lowers the count.
	const end = splitsSurrogatePair(text, lo) ? lo - 1 : lo;
	// Try to snap back to a whitespace boundary while still >= targetTokens.
	const minSnapTokens = Math.max(targetTokens, 1);
	for (let i = end; i > start; i--) {
		const ch = text[i - 1];
		if (ch === " " || ch === "\n" || ch === "\t") {
			const snapped = countTokens(text.slice(start, i), tokenizerMode);
			if (snapped >= minSnapTokens && snapped <= maxTokens) {
				return i;
			}
		}
	}
	if (end > start) return end;
	return Math.min(text.length, splitsSurrogatePair(text, start + 1) ? start + 2 : start + 1);
}

/** True when `offset` falls between a high surrogate and its low surrogate. */
function splitsSurrogatePair(text: string, offset: number): boolean {
	const before = text.charCodeAt(offset - 1);
	const after = text.charCodeAt(offset);
	return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** Per PRD §7.2. Never return a chunk end that violates maxTokens. */
function capEndAtMaxTokens(text: string, start: number, end: number, config: ChunkConfig): number {
	const tokens = countTokens(text.slice(start, end), config.tokenizerMode);
	if (tokens <= config.maxTokens) return end;
	return forceSplitOffset(
		text,
		start,
		config.targetTokens,
		config.maxTokens,
		config.tokenizerMode,
	);
}

/** Per PRD §7.2. Find the largest boundary `<= target` and `> floor`. */
function snapBackToBoundary(boundaries: number[], target: number, floor: number): number {
	let pick = floor;
	for (const b of boundaries) {
		if (b > floor && b <= target) pick = b;
		if (b > target) break;
	}
	return pick;
}

interface ChunkSpan {
	startOffset: number;
	endOffset: number;
	flags?: ["oversized"];
}

interface ExtendStep {
	end: number;
	tokens: number;
	idx: number;
	stop: boolean;
}

/** Per PRD §7.2. One step of boundary-walk extension. */
function extendOnce(
	text: string,
	boundaries: number[],
	start: number,
	state: { end: number; tokens: number; idx: number },
	config: ChunkConfig,
	respectTurnBoundary: boolean,
): ExtendStep {
	const nextIdx = nextBoundaryIndex(boundaries, state.end, state.idx + 1);
	if (nextIdx < 0) {
		const end = capEndAtMaxTokens(text, start, text.length, config);
		return {
			end,
			tokens: countTokens(text.slice(start, end), config.tokenizerMode),
			idx: state.idx,
			stop: true,
		};
	}
	const candidateEnd = boundaries[nextIdx] ?? text.length;
	const candidateTokens = countTokens(text.slice(start, candidateEnd), config.tokenizerMode);
	if (candidateTokens > config.maxTokens) {
		// Conversation only (REQ-9): if the NEXT individual turn
		// (state.end..candidateEnd) is itself oversized on its own, it must
		// never be force-split into from a prior accumulation — that would cut
		// inside the oversized turn without ever emitting the `oversized` flag.
		// Stop at state.end (a clean boundary) so the outer loop's
		// allowOversizedFirstSpan check owns the next turn whole, on its own,
		// next iteration. Prose has no such guarantee and must keep the legacy
		// 0.99.1 force-split-across-the-boundary behavior for byte-identical
		// output (REQ-13).
		if (respectTurnBoundary) {
			const segmentTokens = countTokens(text.slice(state.end, candidateEnd), config.tokenizerMode);
			if (segmentTokens > config.maxTokens) {
				return { end: state.end, tokens: state.tokens, idx: state.idx, stop: true };
			}
		}
		// Boundary-only walk would leave us below minTokens — force-split forward.
		if (state.tokens < config.minTokens) {
			const forced = forceSplitOffset(
				text,
				start,
				config.targetTokens,
				config.maxTokens,
				config.tokenizerMode,
			);
			return {
				end: forced > state.end ? forced : state.end,
				tokens: state.tokens,
				idx: state.idx,
				stop: true,
			};
		}
		return { end: state.end, tokens: state.tokens, idx: state.idx, stop: true };
	}
	return { end: candidateEnd, tokens: candidateTokens, idx: nextIdx, stop: false };
}

/** Per PRD §7.2. Choose the next chunk's end offset starting at `start`. */
function chooseChunkEnd(
	text: string,
	boundaries: number[],
	start: number,
	config: ChunkConfig,
	respectTurnBoundary: boolean,
): number {
	const idx0 = nextBoundaryIndex(boundaries, start, 0);
	if (idx0 < 0) return capEndAtMaxTokens(text, start, text.length, config);
	let end = boundaries[idx0] ?? text.length;
	let tokens = countTokens(text.slice(start, end), config.tokenizerMode);
	let idx = idx0;

	// If first span already exceeds max, force-split.
	if (tokens > config.maxTokens) {
		return forceSplitOffset(
			text,
			start,
			config.targetTokens,
			config.maxTokens,
			config.tokenizerMode,
		);
	}

	while (tokens < config.targetTokens) {
		const step = extendOnce(
			text,
			boundaries,
			start,
			{ end, tokens, idx },
			config,
			respectTurnBoundary,
		);
		end = step.end;
		tokens = step.tokens;
		idx = step.idx;
		if (step.stop) return end;
	}
	return end;
}

/** Per PRD §7.2. Compute next chunk start with overlap, snapped to a boundary. */
function nextStartWithOverlap(
	text: string,
	boundaries: number[],
	prevStart: number,
	end: number,
	config: ChunkConfig,
): number {
	if (end >= text.length) return text.length;
	const ratio = charsPerToken(text.slice(0, end), config);
	const overlapChars = Math.floor(config.overlapTokens * ratio);
	const target = Math.max(0, end - overlapChars);
	// Floor the snap at `prevStart` so the next chunk cannot restart at or
	// before the previous chunk's start. Without this guard, sparse boundaries
	// can snap to a boundary `b <= prevStart`, restarting the next chunk
	// inside (or before) the previous one and re-emitting most of its content.
	const snapped = snapBackToBoundary(boundaries, target, prevStart);
	if (snapped <= prevStart) return end; // No usable boundary; advance with no overlap.
	// Validate the actual overlap by token count, not by char approximation.
	// Char-based budget can underestimate overlap when token density varies
	// (e.g. a low-density prefix followed by CJK-dense overlap region — the
	// prefix-wide ratio understates tokens-per-char near `end`). If actual
	// overlap exceeds 2× the configured token budget, advance to `end` with
	// no overlap rather than silently violate the budget. The next chunk
	// still starts at a clean boundary because `chooseChunkEnd` walks forward.
	const overlapTokens = countTokens(text.slice(snapped, end), config.tokenizerMode);
	if (overlapTokens > config.overlapTokens * 2) return end;
	return snapped;
}

/** Per PRD §7.2. Walk boundaries greedily and emit chunk spans. */
function computeSpans(
	text: string,
	boundaries: number[],
	config: ChunkConfig,
	allowOversizedFirstSpan: boolean,
): ChunkSpan[] {
	const spans: ChunkSpan[] = [];
	let start = 0;
	let guard = 0;
	while (start < text.length) {
		if (guard++ > text.length + 1) break; // pathological-input safety net
		if (allowOversizedFirstSpan) {
			const idx0 = nextBoundaryIndex(boundaries, start, 0);
			const firstBoundaryEnd = idx0 < 0 ? text.length : (boundaries[idx0] ?? text.length);
			if (
				firstBoundaryEnd > start &&
				countTokens(text.slice(start, firstBoundaryEnd), config.tokenizerMode) > config.maxTokens
			) {
				spans.push({
					startOffset: start,
					endOffset: firstBoundaryEnd,
					flags: ["oversized"],
				});
				start = firstBoundaryEnd;
				continue;
			}
		}
		const end = chooseChunkEnd(text, boundaries, start, config, allowOversizedFirstSpan);
		if (end <= start) break;
		spans.push({ startOffset: start, endOffset: end });
		if (end >= text.length) break;
		const nextStart = nextStartWithOverlap(text, boundaries, start, end, config);
		// Strict forward progress — overlap must not stall the loop.
		start = nextStart > start ? nextStart : end;
	}
	return spans;
}

/** Per PRD §7.2. Build a `ChunkMetadata` for one span. */
function buildChunk(
	text: string,
	span: ChunkSpan,
	chunkIndex: number,
	config: ChunkConfig,
	memoryId: string,
): ChunkMetadataDraft {
	const chunkText = text.slice(span.startOffset, span.endOffset);
	const draft: ChunkMetadataDraft = {
		chunkId: "",
		memoryId,
		chunkIndex,
		chunkText,
		densePayload: "",
		startOffset: span.startOffset,
		endOffset: span.endOffset,
		tokenCount: countTokens(chunkText, config.tokenizerMode),
		contentType: config.contentType,
		chunkingVersion: CHUNKING_VERSION,
	};
	if (span.flags !== undefined) draft.flags = span.flags;
	return draft;
}

/** Per PRD §7.1, §7.2, §7.4. Public API: deterministic structure-aware chunker. */
export function chunk(
	text: string,
	config?: Partial<ChunkConfig>,
	parentMemoryId?: string,
): ChunkMetadataDraft[] {
	const cfg = ChunkConfigSchema.parse(config ?? {});
	if (text.length === 0) return [];
	const memoryId = parentMemoryId ?? "";

	if (cfg.contentType === "structured") {
		return chunkStructured(text, cfg, memoryId);
	}

	if (countTokens(text, cfg.tokenizerMode) <= cfg.maxTokens) {
		return [buildChunk(text, { startOffset: 0, endOffset: text.length }, 0, cfg, memoryId)];
	}

	const detector = pickDetector(cfg.contentType);
	const { offsets } = detector(text);
	const spans = computeSpans(text, offsets, cfg, cfg.contentType === "conversation");
	return spans.map((span, i) => buildChunk(text, span, i, cfg, memoryId));
}
