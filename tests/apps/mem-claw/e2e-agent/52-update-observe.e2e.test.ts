import { describe, expect, test } from "vitest";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import {
	hasSessionEvent,
	observeRedactedTextHash,
	sha256Hex,
} from "./helpers/observe-evidence";
import { waitForObserveSummaries } from "./helpers/observe-phase";
import { updateCorrectionPrompt } from "./helpers/prompts";
import { readRemoteMemoryEvidence } from "./helpers/remote-evidence";
import { loadAgentRun, saveAgentRunState } from "./helpers/state";
import type { EventSummary, ExpectedEventType } from "./helpers/types";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 52 update observe", () => {
	test(
		"proves the correction write reached Sno Observe",
		async () => {
			const { config, state } = await loadAgentRun();
			const updateTeachSession = state.updateTeachSession;
			const updateQaSession = state.updateQaSession;
			expect(updateTeachSession).toBeDefined();
			expect(updateQaSession).toBeDefined();
			expect(state.updateOldNonce).toBeDefined();
			expect(state.updateNewNonce).toBeDefined();
			expect(state.updateSubject).toBeDefined();
			if (
				!updateTeachSession ||
				!updateQaSession ||
				!state.updateOldNonce ||
				!state.updateNewNonce ||
				!state.updateSubject
			) {
				return;
			}
			const correctionPromptHash = observeRedactedTextHash(
				updateCorrectionPrompt(
					state.updateSubject,
					state.updateOldNonce,
					state.updateNewNonce,
				),
			);

			const summaries = await waitForObserveSummaries(config, state, {
				artifactName: "observe-update",
				label: "Sno update correction write",
				matches: (events) => {
					const correctionPromptEvents = findPromptEventsByHash(
						events,
						correctionPromptHash,
						["prompt.submit", "llm.call"],
					);
					return (
						correctionPromptEvents.length > 0 &&
						postPromptMemoryWrites(events, correctionPromptEvents).length > 0
					);
				},
			});
			const correctionPromptEvents = findPromptEventsByHash(
				summaries,
				correctionPromptHash,
				["prompt.submit", "llm.call"],
			);
			// The session recorded for later phases is the one the write followed, so take the
			// first submission, not the last.
			const correctionPromptEvent = [...correctionPromptEvents].sort((left, right) =>
				left.eventId.localeCompare(right.eventId),
			)[0];
			const observeTeachSession = correctionPromptEvent?.scopeSessionUuid;
			expect(observeTeachSession).toBeDefined();
			if (!correctionPromptEvent || !observeTeachSession) {
				return;
			}
			state.updateTeachObserveSession = observeTeachSession;
			await saveAgentRunState(state);
			const correctedMemory = await readRemoteMemoryEvidence(
				config,
				state.updateNewNonce,
			);

			const updateWrites = postPromptMemoryWrites(summaries, correctionPromptEvents);
			const expectedKeyHashes = new Set(
				correctedMemory.rows
					.filter(
						(row) =>
							typeof row.text === "string" &&
							row.text.includes(state.updateNewNonce ?? ""),
					)
					.map((row) => row.content_hash)
					.filter((value): value is string => typeof value === "string")
					.map((contentHash) => sha256Hex(contentHash)),
			);
			expect(expectedKeyHashes.size).toBeGreaterThan(0);
			expect(
				updateWrites.some(
					(summary) =>
						summary.keyHash !== undefined &&
					expectedKeyHashes.has(summary.keyHash),
				),
			).toBe(true);
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});

function findPromptEventsByHash(
	summaries: EventSummary[],
	promptHash: string,
	requiredEvents: readonly ExpectedEventType[],
): EventSummary[] {
	// EVERY submission of this prompt, not the newest one. The runner retries a failed phase
	// once, so a correction turn that failed on its first attempt and passed on its second
	// leaves two sessions carrying the same prompt hash — and the memory was written by the
	// attempt that reached the plugin, which is not necessarily the later one. Anchoring on a
	// single "newest" match then discards every write that came before it and the phase fails
	// with the evidence sitting right there in the activity.
	return summaries.filter((summary) => {
		if (
			summary.eventType !== "prompt.submit" ||
			summary.promptHash !== promptHash ||
			summary.scopeSessionUuid === undefined
		) {
			return false;
		}
		const sessionUuid = summary.scopeSessionUuid;
		return requiredEvents.every((eventType) =>
			hasSessionEvent(summaries, sessionUuid, eventType),
		);
	});
}

function postPromptMemoryWrites(
	summaries: EventSummary[],
	promptEvents: EventSummary[],
): EventSummary[] {
	// Anchored on the EARLIEST matching submission. Extraction writes lag the turn that caused
	// them, so a later retry's prompt event is newer than the writes the first attempt already
	// produced; measuring from the newest submission discards exactly the evidence this phase
	// looks for. The claim is that the correction write followed the correction prompt, and the
	// first submission proves that for every attempt.
	const earliest = promptEvents
		.map((event) => event.eventId)
		.sort((left, right) => left.localeCompare(right))[0];
	if (earliest === undefined) return [];
	return summaries.filter(
		(summary) =>
			summary.eventType === "memory.write" &&
			summary.keyHash !== undefined &&
			summary.eventId > earliest,
	);
}
