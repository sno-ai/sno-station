/** @file error-signals.ts
 * @purpose Classifies error-like text patterns used by capture and retrieval heuristics.
 * @boundary Multilingual runtime regexes and operational signal extraction.
 * @see capture-policy-detector.ts, intent-analyzer.ts, memory-noise-classifier.ts.
 */

import { createHash } from "node:crypto";
import { DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS } from "../../../config/index";
import { redactSecrets } from "./redact";

export type ReflectionErrorSignal = {
	at: number;
	toolName: string;
	summary: string;
	source: "tool_error" | "tool_output";
	signature: string;
	signatureHash: string;
};

export type ReflectionErrorState = {
	entries: ReflectionErrorSignal[];
	lastInjectedCount: number;
	signatureSet: Set<string>;
	updatedAt: number;
};

const ERROR_SIGNAL_PATTERNS: RegExp[] = [
	/\[error\]|error:|exception:|fatal:|traceback|syntaxerror|typeerror|referenceerror|npm err!/,
	/command not found|no such file|permission denied|non-zero|exit code/,
	/"status"\s*:\s*"error"|"status"\s*:\s*"failed"|\biserror\b/,
	/错误\s*[：:]|异常\s*[：:]|报错\s*[：:]|失败\s*[：:]/,
];

const SUMMARY_MAX_LEN = 220;
const SIGNATURE_MAX_LEN = 240;
const MAX_ENTRIES_PER_SESSION = 30;

type CreateErrorSignalTrackerOptions = {
	maxTrackedSessions?: number;
};

/** Implements touch session state as the local runtime error signal extraction operation. */
function touchSessionState(
	sessions: Map<string, ReflectionErrorState>,
	key: string,
	state: ReflectionErrorState,
): ReflectionErrorState {
	sessions.delete(key);
	sessions.set(key, state);
	// Centralize the operational safety fallback value at the boundary of this helper.
	return state;
}

/** Filters oldest sessions before it affects runtime error signal extraction decisions. */
function pruneOldestSessions(
	sessions: Map<string, ReflectionErrorState>,
	maxSessions: number,
): void {
	const cappedMaxSessions = Math.max(0, maxSessions);
	while (sessions.size > cappedMaxSessions) {
		const oldestKey = sessions.keys().next().value;
		// Guard this branch early so the remaining operational safety path works with normalized inputs.
		if (oldestKey === undefined) break;
		sessions.delete(oldestKey);
	}
}

/** Implements contains error signal as the local runtime error signal extraction operation. */
export function containsErrorSignal(text: string): boolean {
	const normalized = text.toLowerCase();
	// Centralize the operational safety fallback value at the boundary of this helper.
	return ERROR_SIGNAL_PATTERNS.some((p) => p.test(normalized));
}

/**
 * Normalizes error signature at the boundary before runtime error signal extraction uses it.
 */
export function normalizeErrorSignature(text: string): string {
	// Centralize the operational safety fallback value at the boundary of this helper.
	return redactSecrets(String(text || ""))
		.toLowerCase()
		.replace(/[a-z]:\\[^ \n\r\t]+/gi, "<path>")
		.replace(/\/[^ \n\r\t]+/g, "<path>")
		.replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
		.replace(/\b\d+\b/g, "<n>")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, SIGNATURE_MAX_LEN);
}

/** Implements summarize error text as the local runtime error signal extraction operation. */
export function summarizeErrorText(text: string, maxLen: number = SUMMARY_MAX_LEN): string {
	const oneLine = redactSecrets(text).replace(/\s+/g, " ").trim();
	// Route failure states into a deterministic recovery or reporting branch.
	if (!oneLine) return "(empty tool error)";
	// Centralize the operational safety fallback value at the boundary of this helper.
	return oneLine.length <= maxLen ? oneLine : `${oneLine.slice(0, maxLen - 3)}...`;
}

/** Implements sha256 hex as the local runtime error signal extraction operation. */
export function sha256Hex(text: string): string {
	// Centralize the operational safety fallback value at the boundary of this helper.
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Extracts text from tool result from raw inputs while tolerating partial data. */
export function extractTextFromToolResult(result: unknown): string {
	// Guard this branch early so the remaining operational safety path works with normalized inputs.
	if (result == null) return "";
	// Guard this branch early so the remaining operational safety path works with normalized inputs.
	if (typeof result === "string") return result;
	// Guard this branch early so the remaining operational safety path works with normalized inputs.
	if (typeof result !== "object") return "";
	const obj = result as Record<string, unknown>;
	const content = obj.content;
	// Handle the absent-value case explicitly before the happy path depends on it.
	if (!Array.isArray(content)) {
		return typeof obj.text === "string" ? obj.text : "";
	}
	const parts: string[] = [];
	// Iterate deterministically so error tracking output order remains stable.
	for (const item of content) {
		// Guard this branch early so the remaining operational safety path works with normalized inputs.
		if (!item || typeof item !== "object") continue;
		const rec = item as Record<string, unknown>;
		// Guard rec.text here so the remaining operational safety path works with normalized inputs.
		if (rec.type === "text" && typeof rec.text === "string") {
			parts.push(rec.text);
		}
	}
	return parts.join("\n");
}
export type ErrorSignalTracker = ReturnType<typeof createErrorSignalTracker>;

/** Creates the per-session tracker that batches runtime errors for reflection feedback. */
export function createErrorSignalTracker(options: CreateErrorSignalTrackerOptions = {}): {
	getState: (sessionKey: string) => ReflectionErrorState;
	addSignal: (sessionKey: string, signal: ReflectionErrorSignal, dedupeEnabled: boolean) => void;
	getPendingSignals: (sessionKey: string, maxEntries: number) => ReflectionErrorSignal[];
	clearSession: (sessionKey: string) => void;
	prune: (ttlMs: number, maxSessions: number) => void;
} {
	const sessions = new Map<string, ReflectionErrorState>();
	const maxTrackedSessions = Math.max(
		0,
		options.maxTrackedSessions ?? DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS,
	);

	/** Returns state from runtime error signal extraction state without side effects. */
	const getState = (sessionKey: string): ReflectionErrorState => {
		const key = sessionKey.trim();
		const current = sessions.get(key);
		// Guard guard condition here so the remaining operational safety path works with normalized inputs.
		if (current) {
			current.updatedAt = Date.now();
			return touchSessionState(sessions, key, current);
		}
		pruneOldestSessions(sessions, Math.max(0, maxTrackedSessions - 1));
		const created: ReflectionErrorState = {
			entries: [],
			lastInjectedCount: 0,
			signatureSet: new Set<string>(),
			updatedAt: Date.now(),
		};
		return touchSessionState(sessions, key, created);
	};

	return {
		getState,

		/** Adds signal to the local runtime error signal extraction accumulator. */
		addSignal(sessionKey: string, signal: ReflectionErrorSignal, dedupeEnabled: boolean): void {
			// Guard this branch early so the remaining operational safety path works with normalized inputs.
			if (!sessionKey.trim()) return;
			const state = getState(sessionKey);
			// Guard this branch early so the remaining operational safety path works with normalized inputs.
			if (dedupeEnabled && state.signatureSet.has(signal.signatureHash)) return;
			state.entries.push(signal);
			state.signatureSet.add(signal.signatureHash);
			state.updatedAt = Date.now();
			// Guard state.entries.length here so the remaining operational safety path works with normalized inputs.
			if (state.entries.length > MAX_ENTRIES_PER_SESSION) {
				const removed = state.entries.length - MAX_ENTRIES_PER_SESSION;
				state.entries.splice(0, removed);
				state.lastInjectedCount = Math.max(0, state.lastInjectedCount - removed);
				state.signatureSet = new Set(state.entries.map((e) => e.signatureHash));
			}
		},

		/** Drains the not-yet-injected error signals, advancing the injection marker so callers never re-receive them. */
		getPendingSignals(sessionKey: string, maxEntries: number): ReflectionErrorSignal[] {
			// Guard this branch early so the remaining operational safety path works with normalized inputs.
			if (maxEntries <= 0) return [];
			const key = sessionKey.trim();
			const state = sessions.get(key);
			// Guard this branch early so the remaining operational safety path works with normalized inputs.
			if (!state) return [];
			state.updatedAt = Date.now();
			touchSessionState(sessions, key, state);
			const start = Math.min(Math.max(0, state.lastInjectedCount), state.entries.length);
			const pending = state.entries.slice(start);
			// "Returned" is treated as "injected": the sole caller (the per-turn prompt-injection hook)
			// consumes the result inline, so advance the marker to the current length even when the
			// maxEntries cap trims older pending entries — they must never be re-injected.
			state.lastInjectedCount = state.entries.length;
			return pending.length > maxEntries ? pending.slice(-maxEntries) : pending;
		},

		/** Removes session while preserving runtime error signal extraction invariants. */
		clearSession(sessionKey: string): void {
			sessions.delete(sessionKey.trim());
		},

		/** Implements prune as the local runtime error signal extraction operation. */
		prune(ttlMs: number, maxSessions: number): void {
			const now = Date.now();
			// Iterate deterministically so error tracking output order remains stable.
			for (const [key, state] of sessions.entries()) {
				// Guard this branch early so the remaining operational safety path works with normalized inputs.
				if (now - state.updatedAt > ttlMs) sessions.delete(key);
			}
			pruneOldestSessions(sessions, maxSessions);
		},
	};
}
