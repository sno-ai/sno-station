import { describe, expect, test } from "vitest";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import {
	hasHostAgentLlmEvidence,
	hasMemoryReadTokenEvidence,
	hasRecallObserveEvidence,
	hasSessionEvent,
	sessionEvents,
} from "./helpers/observe-evidence";
import { waitForObserveSummaries } from "./helpers/observe-phase";
import { recallPrompt } from "./helpers/prompts";
import { loadAgentRun, saveAgentRunState } from "./helpers/state";
import type { EventSummary } from "./helpers/types";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 21 recall observe", () => {
	test(
		"proves the recall session reached Sno Observe with a memory hit",
		async () => {
			const { config, state } = await loadAgentRun();
			const teachSessions = candidateSessions(
				state.teachPromptObserveSession,
				state.teachObserveSession,
				state.teachSession,
			);
			const excludedSessions = new Set(teachSessions);
			const promptByteLen = Buffer.byteLength(
				recallPrompt(state.runId),
				"utf8",
			);
			const summaries = await waitForObserveSummaries(config, state, {
				artifactName: "observe-recall",
				label: "Sno activity for seeded write and recall memory.read hit",
				matches: (events) => {
					const qaSession = findRecallObserveSession(
						events,
						excludedSessions,
						promptByteLen,
					);
					return (
						teachSessions.some((sessionUuid) =>
							hasSessionEvent(
								events,
								sessionUuid,
								"memory.write",
								(summary) => summary.keyHash !== undefined,
							),
						) &&
						qaSession !== undefined &&
						hasRecallObserveEvidence(events, qaSession)
					);
				},
			});

			const qaSession = findRecallObserveSession(
				summaries,
				excludedSessions,
				promptByteLen,
			);
			expect(qaSession).toBeDefined();
			if (!qaSession) return;
			state.qaObserveSession = qaSession;
			await saveAgentRunState(state);
			expect(hasRecallObserveEvidence(summaries, qaSession)).toBe(true);
			expect(
				hasHostAgentLlmEvidence(summaries, qaSession),
			).toBe(true);
			expect(hasMemoryReadTokenEvidence(summaries, qaSession)).toBe(true);
			const seededWriteKeyHashes = new Set(
				teachSessions
					.flatMap((sessionUuid) =>
						sessionEvents(summaries, sessionUuid, "memory.write"),
					)
					.map((summary) => summary.keyHash)
					.filter((keyHash): keyHash is string => keyHash !== undefined),
			);
			expect(seededWriteKeyHashes.size).toBeGreaterThan(0);
			const reads = sessionEvents(summaries, qaSession, "memory.read");
			expect(reads.every((summary) => summary.tokensMethod !== "bpe")).toBe(
				true,
			);
			expect(reads.every((summary) => summary.tokensMethod !== "fast")).toBe(
				true,
			);
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});

function candidateSessions(...values: (string | undefined)[]): string[] {
	return [...new Set(values.filter((value): value is string => value !== undefined))];
}

function findRecallObserveSession(
	summaries: EventSummary[],
	excludedSessions: ReadonlySet<string>,
	promptByteLen: number,
): string | undefined {
	// Anchor on the prompt this phase actually sent, the way phase 11 anchors on the teach
	// prompt. The old rule — first session that is not a teach session and carries recall
	// evidence — matched an onboarding session from earlier in the run, because onboarding
	// also starts a session, submits a prompt and recalls. The run then recorded that
	// stranger as the QA session, and phase 31 waited 120s for finalize events on a session
	// no phase would ever end.
	const candidates = summaries
		.filter(
			(summary) =>
				summary.eventType === "prompt.submit" &&
				summary.byteLen === promptByteLen &&
				summary.scopeSessionUuid !== undefined,
		)
		.map((summary) => summary.scopeSessionUuid);
	for (const sessionUuid of candidates) {
		if (
			sessionUuid &&
			!excludedSessions.has(sessionUuid) &&
			hasRecallObserveEvidence(summaries, sessionUuid)
		) {
			return sessionUuid;
		}
	}
	return undefined;
}
