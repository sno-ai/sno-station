import { describe, expect, test } from "vitest";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import { sessionEventCount } from "./helpers/observe-evidence";
import {
	expectNoObserveEventForWindow,
	waitForObserveSummaries,
} from "./helpers/observe-phase";
import { noisePrompt } from "./helpers/prompts";
import { loadAgentRun, saveAgentRunState } from "./helpers/state";
import type { EventSummary } from "./helpers/types";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 41 noise observe", () => {
	test(
		"proves non-memory chat did not emit memory.write",
		async () => {
			const { config, state } = await loadAgentRun();
			expect(state.noiseSession).toBeDefined();
			if (!state.noiseSession) return;
			const knownSessions = new Set(
				[
					state.teachObserveSession,
					state.teachPromptObserveSession,
					state.qaObserveSession,
					state.teachSession,
					state.qaSession,
				].filter((value): value is string => typeof value === "string"),
			);

			// Phase 40 writes the nonce before this phase runs. Reading a missing one as ""
			// would silently anchor on a prompt nobody sent, and the phase would time out
			// with no hint why.
			expect(state.noiseNonce).toBeDefined();
			const promptByteLen = Buffer.byteLength(
				noisePrompt(String(state.noiseNonce)),
				"utf8",
			);

			const promptSummaries = await waitForObserveSummaries(config, state, {
				artifactName: "observe-noise",
				label: "Sno prompt activity for non-memory chat",
				matches: (events) =>
					findNewestPromptSession(events, knownSessions, promptByteLen) !==
					undefined,
			});
			const noiseSession = findNewestPromptSession(
				promptSummaries,
				knownSessions,
				promptByteLen,
			);
			expect(noiseSession).toBeDefined();
			if (!noiseSession) return;
			state.noiseObserveSession = noiseSession;
			await saveAgentRunState(state);

			const summaries = await expectNoObserveEventForWindow(config, state, {
				artifactName: "observe-noise",
				eventType: "memory.write",
				label: "non-memory chat",
				sessionUuid: noiseSession,
				sessionUuids: new Set([noiseSession]),
				timeoutMs: 30_000,
			});
			expect(sessionEventCount(summaries, noiseSession, "memory.write")).toBe(0);
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});

function findNewestPromptSession(
	summaries: EventSummary[],
	knownSessions: Set<string>,
	promptByteLen: number,
): string | undefined {
	// Anchored on the prompt this run actually sent. Without the byte-length check the newest
	// session this run has not already named wins — and before the noise turn's own
	// prompt.submit reaches the cloud, that is an onboarding session from earlier in the run.
	// The phase then proves "no memory.write" about the wrong session and passes for the
	// wrong reason. Same defect as the one that stranded phase 31, caught before it bit.
	return summaries
		.filter(
			(summary) =>
				summary.eventType === "prompt.submit" &&
				summary.byteLen === promptByteLen &&
				summary.scopeSessionUuid !== undefined &&
				!knownSessions.has(summary.scopeSessionUuid),
		)
		.sort((left, right) => right.eventId.localeCompare(left.eventId))[0]
		?.scopeSessionUuid;
}
