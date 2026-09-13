import { FIXED_PROTOCOL_VALUE_63, PERSISTED_PROVIDER_SYSTEM } from "../../model/signed-registry-constants";
/** @file sno-station-mem-message-transcript.ts
 * @purpose Normalizes SDK message records into capture transcripts and session timestamps.
 * @boundary Message-shape parsing and redaction for transcript construction only.
 */

import { sanitizeContentIngress } from "@snoai/content-sanitizer";
import { Temporal } from "@js-temporal/polyfill";
import {
	EXPLICIT_MEMORY_COMMAND_MANAGEMENT_PATTERNS,
	EXPLICIT_MEMORY_COMMAND_POSITIVE_PATTERNS,
} from "../extraction/capture-policy-detector";
import { normalizeAmbientLearningText } from "./sno-station-mem-runtime-dependencies";
import { parseIsoDateTimeMs } from "../shared/iso-date-time";
import { escapeTranscriptRoleContinuations } from "../shared/transcript-role-codec";




// Message helpers (ambient-learning)

/** Collects text chunks from SDK messages while ignoring unsupported content parts. */
export function extractAllMessageTexts(record: Record<string, unknown>): string[] {
	// Guard record.content here so the remaining module behavior path works with normalized inputs.
	if (typeof record.content === "string") {
		// Return a stable plugin lifecycle list shape for downstream consumers.
		return [record.content];
	}
	// Handle the absent-value case explicitly before the happy path depends on it.
	if (!Array.isArray(record.content)) {
		// Return a stable plugin lifecycle list shape for downstream consumers.
		return [];
	}
	const texts: string[] = [];
	// Iterate deterministically so plugin lifecycle output order remains stable.
	for (const chunk of record.content) {
		// Guard this branch early so the remaining module behavior path works with normalized inputs.
		if (!chunk || typeof chunk !== "object") continue;
		const chunkRecord = chunk as Record<string, unknown>;
		// Guard chunk record.text here so the remaining module behavior path works with normalized inputs.
		if (chunkRecord.type === "text" && typeof chunkRecord.text === "string") {
			// Append only after validation has accepted this value for the current branch.
			texts.push(chunkRecord.text);
		}
	}
	// Centralize the module behavior fallback value at the boundary of this helper.
	return texts;
}

/**
 * Marks a message this plugin injected into the host agent as its OWN model request.
 *
 * `sourceChannel` is the host's own message-origin field — optional, free-form, and part of the
 * persisted transcript schema (`sno-station-mem/dist/transcript-*.d.ts`). It is what survives the gap
 * that matters: the host records our turn, and ambient learning reads the session LATER, from an
 * unrelated async chain and possibly a later process. Nothing scoped to the originating call, and
 * nothing held in memory, is still observable there.
 *
 * Verified against a real recorded row on the E2E host, 2026-08-30: a persisted message is
 * `{role, timestamp, sourceChannel, content}` — this field is carried, an unknown field has no
 * such guarantee.
 *
 * This excludes text THIS PLUGIN authored and nothing else. A message without this origin is
 * untouched, so no incoming user turn can be dropped by this path — including one whose wording
 * happens to match ours.
 */
export const PLUGIN_OWNED_SOURCE_CHANNEL: typeof FIXED_PROTOCOL_VALUE_63 = FIXED_PROTOCOL_VALUE_63;

/** Whether a raw SDK message is one this plugin injected as its own model request. */
export function isPluginOwnedMessage(message: unknown): boolean {
	// Guard message here so the remaining module behavior path works with normalized inputs.
	if (!message || typeof message !== "object") {
		return false;
	}
	return (
		(message as Record<string, unknown>).sourceChannel === PLUGIN_OWNED_SOURCE_CHANNEL
	);
}

/** Narrows raw SDK messages to user/assistant turns eligible for ambient-learning. */
export function isAmbientLearningMessage(
	message: unknown,
): message is Record<string, unknown> & { role: "user" | "assistant" } {
	// Guard message here so the remaining module behavior path works with normalized inputs.
	if (!message || typeof message !== "object") {
		// Centralize the module behavior fallback value at the boundary of this helper.
		return false;
	}
	// A request this plugin sent to the host model is not a conversation turn and never was.
	if (isPluginOwnedMessage(message)) {
		return false;
	}
	const role = (message as Record<string, unknown>).role;
	// Centralize the module behavior fallback value at the boundary of this helper.
	return role === "user" || role === "assistant";
}

/**
 * Normalizes message timestamp ms at the boundary before plugin lifecycle orchestration uses
 * it.
 */
export function normalizeMessageTimestampMs(value: unknown): number | undefined {
	// Guard value here so the remaining module behavior path works with normalized inputs.
	if (typeof value === "number" && Number.isFinite(value)) {
		// Centralize the module behavior fallback value at the boundary of this helper.
		return value < 100_000_000_000 ? value * 1000 : value;
	}
	// Guard value here so the remaining module behavior path works with normalized inputs.
	if (typeof value === "string") {
		const trimmed = value.trim();
		// Guard this branch early so the remaining module behavior path works with normalized inputs.
		if (!trimmed) return undefined;
		const asNumber = Number(trimmed);
		// Guard guard condition here so the remaining module behavior path works with normalized inputs.
		if (Number.isFinite(asNumber)) {
			// Centralize the module behavior fallback value at the boundary of this helper.
			return normalizeMessageTimestampMs(asNumber);
		}
		return parseIsoDateTimeMs(trimmed);
	}
	// Guard guard condition here so the remaining module behavior path works with normalized inputs.
	if (value instanceof Date) {
		const timestampMs = value.getTime();
		// Centralize the module behavior fallback value at the boundary of this helper.
		return Number.isNaN(timestampMs) ? undefined : timestampMs;
	}
	// Signal an intentional miss with undefined instead of overloading an empty value.
	return undefined;
}

/**
 * Derive a session anchor from the most recent conversational message so the
 * insight distiller can resolve relative dates like "yesterday" or "last year".
 */
export function deriveSessionDateTime(
	messages: unknown[],
	captureAssistant = true,
): string | undefined {
	let latestTimestampMs = Number.NEGATIVE_INFINITY;

	// Iterate deterministically so plugin lifecycle output order remains stable.
	for (const message of messages) {
		// Guard this branch early so the remaining module behavior path works with normalized inputs.
		if (!isAmbientLearningMessage(message)) continue;
		if (message.role === "assistant" && !captureAssistant) continue;
		const timestampMs = normalizeMessageTimestampMs(message.timestamp);
		// Guard this branch early so the remaining module behavior path works with normalized inputs.
		if (timestampMs === undefined) continue;
		latestTimestampMs = Math.max(latestTimestampMs, timestampMs);
	}

	// Guard number.is finite here so the remaining module behavior path works with normalized inputs.
	if (!Number.isFinite(latestTimestampMs)) {
		// Signal an intentional miss with undefined instead of overloading an empty value.
		return undefined;
	}
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	return Temporal.Instant.fromEpochMilliseconds(latestTimestampMs)
		.toZonedDateTimeISO(timezone)
		.toString({ smallestUnit: "millisecond", timeZoneName: "never" });
}

const TRANSCRIPT_SESSION_DATE_HEADER = /^session_date_time:[ \t]*(\S[^\n]*)$/m;

/**
 * The session date a transcript states about itself. A replayed or imported log carries the date
 * it was actually spoken on; the gateway's message timestamps only say when it was replayed, and
 * anchoring "yesterday" to the replay day files every relative date years off. An ISO
 * `session_date_time:` line in a user message therefore outranks the message timestamps; a
 * header that does not parse as ISO is ignored, not guessed at.
 */
export function transcriptSessionDateTime(messages: unknown[]): string | undefined {
	for (const message of messages) {
		if (!isAmbientLearningMessage(message) || message.role !== "user") continue;
		for (const text of extractAllMessageTexts(message)) {
			const header = TRANSCRIPT_SESSION_DATE_HEADER.exec(text)?.[1];
			if (header === undefined) continue;
			const timestampMs = parseIsoDateTimeMs(header.trim());
			if (timestampMs === undefined) return undefined;
			const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
			return Temporal.Instant.fromEpochMilliseconds(timestampMs)
				.toZonedDateTimeISO(timezone)
				.toString({ smallestUnit: "millisecond", timeZoneName: "never" });
		}
	}
	return undefined;
}

/** Builds the chronological transcript used by session summary and capture logic. */
export function buildConversationText(
	messages: unknown[],
	captureAssistant: boolean,
): { text: string; latestUserMemorySourceText?: string } {
	const lines: string[] = [];
	let latestUserMemorySourceText: string | undefined;
	// Iterate deterministically so plugin lifecycle output order remains stable.
	for (const message of messages) {
		// Guard this branch early so the remaining module behavior path works with normalized inputs.
		if (!isAmbientLearningMessage(message)) continue;
		// Guard this branch early so the remaining module behavior path works with normalized inputs.
		if (message.role === "assistant" && !captureAssistant) continue;
		const texts = extractAllMessageTexts(message);
		const userChunks: string[] = [];
		// Iterate deterministically so plugin lifecycle output order remains stable.
		for (const text of texts) {
			const normalized = normalizeAmbientLearningText(message.role, text);
			if (!normalized) continue;
			const sanitized = sanitizeContentIngress({
				source: PERSISTED_PROVIDER_SYSTEM,
				content: normalized,
			}).projections.plainText;
			if (!sanitized) continue;
			if (message.role === "user") userChunks.push(sanitized);
			// No message is removed from the transcript because of its wording. Until 2026-08-21 an
			// assistant line matching 36 store-command regexes was dropped here, on the theory that it
			// would otherwise be re-extracted as a user fact. Measured that day through the real
			// ambient-learning path with the rule disabled: the same three memories were stored and
			// none derived from the assistant's echoed content, so the loop it guarded against did not
			// reproduce. Deletion is the least recoverable form of routing and is not used here.
			lines.push(`${message.role}: ${escapeTranscriptRoleContinuations(sanitized)}`);
		}
		if (message.role === "user" && userChunks.length > 0) {
			latestUserMemorySourceText = userChunks.join("\n");
		}
	}
	const text = lines.join("\n\n");
	return { text, latestUserMemorySourceText };
}
