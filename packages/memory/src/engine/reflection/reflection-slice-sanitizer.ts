/** @file reflection-slice-sanitizer.ts
 * @purpose Normalizes reflection slice lines and filters unsafe injectable text.
 * @boundary Line-level sanitization and injection detection only.
 */

import { sanitizeContentIngress } from "@snoai/content-sanitizer";

/**
 * Tests whether is placeholder reflection slice line without mutating reflection text slicing
 * state.
 */
export function isPlaceholderReflectionSliceLine(line: string): boolean {
	const normalized = line.replace(/\*\*/g, "").trim();
	if (!normalized) return true;
	if (/^\(none( captured)?\)$/i.test(normalized)) return true;
	if (/^(invariants?|reflections?|derived)[:：]$/i.test(normalized)) return true;
	if (/apply this session'?s deltas next run/i.test(normalized)) return true;
	if (/apply this session'?s distilled changes next run/i.test(normalized)) return true;
	if (/investigate why embedded reflection generation failed/i.test(normalized)) return true;
	return false;
}

/** Normalizes reflection slice line at the boundary before reflection text slicing uses it. */
export function normalizeReflectionSliceLine(line: string): string {
	const projected = sanitizeContentIngress({
		source: "generic-text",
		content: line,
	}).projections.plainText;
	return projected
		.replace(/\*\*/g, "")
		.replace(/^(invariants?|reflections?|derived)[:：]\s*/i, "")
		.trim();
}

/**
 * Implements sanitize reflection slice lines as the local reflection text slicing operation.
 */
export function sanitizeReflectionSliceLines(lines: string[]): string[] {
	return lines
		.map(normalizeReflectionSliceLine)
		.filter((line) => !isPlaceholderReflectionSliceLine(line));
}

const INJECTABLE_REFLECTION_BLOCK_PATTERNS: RegExp[] = [
	/^\s*(?:(?:next|this)(?:\s+run)?\s+)?(?:ignore|disregard|forget|override|bypass)\b[\s\S]{0,80}\b(?:instructions?|guardrails?|policy|developer|system)\b/i,
	/\b(?:reveal|print|dump|show|output)\b[\s\S]{0,80}\b(?:system prompt|developer prompt|hidden prompt|hidden instructions?|full prompt|prompt verbatim|secrets?|keys?|tokens?)\b/i,
	/<\s*\/?\s*(?:system|assistant|user|tool|developer|inherited-rules|derived-focus)\b[^>]*>/i,
	/^(?:system|assistant|user|developer|tool)\s*:/i,
];

function stripReflectionListPrefix(line: string): string {
	return line.replace(/^\s*(?:[-*•]+|\d+[.)])\s+/, "").trim();
}

/**
 * Tests whether is unsafe injectable reflection line without mutating reflection text slicing
 * state.
 */
export function isUnsafeInjectableReflectionLine(line: string): boolean {
	const normalized = stripReflectionListPrefix(normalizeReflectionSliceLine(line));
	if (!normalized) return true;
	return INJECTABLE_REFLECTION_BLOCK_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Implements sanitize injectable reflection lines as the local reflection text slicing operation.
 */
export function sanitizeInjectableReflectionLines(lines: string[]): string[] {
	return sanitizeReflectionSliceLines(lines).filter(
		(line) => !isUnsafeInjectableReflectionLine(line),
	);
}
