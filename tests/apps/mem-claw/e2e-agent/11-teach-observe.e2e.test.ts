import { describe, expect, test } from "vitest";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import {
	hasHostAgentLlmEvidence,
	hasMemoryWriteTokenEvidence,
	hasSessionEvent,
	hasTeachObserveEvidence,
} from "./helpers/observe-evidence";
import { waitForObserveSummaries } from "./helpers/observe-phase";
import { teachPrompt } from "./helpers/prompts";
import { loadAgentRun, saveAgentRunState } from "./helpers/state";
import type { EventSummary } from "./helpers/types";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 11 teach observe", () => {
	test(
		"proves the teach session reached Sno Observe",
		async () => {
			const { config, state } = await loadAgentRun();
			const promptByteLen = Buffer.byteLength(teachPrompt(state.fact), "utf8");
			const summaries = await waitForObserveSummaries(config, state, {
				artifactName: "observe-teach",
				label: "Sno activity for teach memory.write",
				matches: (events) => {
					const promptSession = findTeachPromptSession(
						events,
						promptByteLen,
					);
					// The write belongs to the teach turn itself. Picking "the newest session
					// carrying a memory.write" instead used to land on an onboarding session:
					// ambient learning writes after the turn returns, so at the moment this
					// first polls, the teach session has no write yet and an older one does.
					// The run then carried that stranger's id forward and phase 31 waited for
					// finalize events on a session nothing was ever going to finalize.
					const writeSession = promptSession;
					return (
						promptSession !== undefined &&
						writeSession !== undefined &&
						hasTeachObserveEvidence(events, promptSession, writeSession)
					);
				},
			});

			const promptSession = findTeachPromptSession(
				summaries,
				promptByteLen,
			);
			const writeSession = promptSession;
			expect(promptSession).toBeDefined();
			expect(writeSession).toBeDefined();
			if (!promptSession || !writeSession) return;
			state.teachPromptObserveSession = promptSession;
			state.teachObserveSession = writeSession;
			await saveAgentRunState(state);
			expect(hasTeachObserveEvidence(summaries, promptSession, writeSession)).toBe(
				true,
			);
			expect(
				hasHostAgentLlmEvidence(summaries, promptSession),
			).toBe(true);
			expect(hasMemoryWriteTokenEvidence(summaries, writeSession)).toBe(true);
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});

function findTeachPromptSession(
	summaries: EventSummary[],
	promptByteLen: number,
): string | undefined {
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
			hasSessionEvent(summaries, sessionUuid, "session.start") &&
			hasHostAgentLlmEvidence(summaries, sessionUuid)
		) {
			return sessionUuid;
		}
	}
	return undefined;
}
