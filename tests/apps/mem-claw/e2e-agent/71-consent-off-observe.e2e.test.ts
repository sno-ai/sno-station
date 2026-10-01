import { describe, expect, test } from "vitest";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import { setObserveConsent } from "./helpers/observe-api";
import { observeRedactedTextHash } from "./helpers/observe-evidence";
import { expectNoObserveEventForWindow } from "./helpers/observe-phase";
import { consentMarker, consentTeachPrompt } from "./helpers/prompts";
import { readRemoteSnoIdentity } from "./helpers/remote-evidence";
import { loadAgentRun } from "./helpers/state";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 71 consent off observe", () => {
	test(
		"does not publish the prompt submitted while Observe consent is off",
		async () => {
			const { config, state } = await loadAgentRun();
			const offNonce = state.consentOffNonce;
			expect(offNonce).toBeDefined();
			if (!offNonce) return;
			const offPromptHash = observeRedactedTextHash(
				consentTeachPrompt(consentMarker("off", offNonce)),
			);

			try {
				const summaries = await expectNoObserveEventForWindow(config, state, {
					artifactName: "observe-consent-off",
					eventType: "prompt.submit",
					label: "consent-off session",
					matchesLeak: (summary) =>
						summary.eventType === "prompt.submit" &&
						summary.promptHash === offPromptHash,
					timeoutMs: 30_000,
				});
				expect(
					summaries.some(
						(summary) =>
							summary.eventType === "prompt.submit" &&
							summary.promptHash === offPromptHash,
					),
				).toBe(false);
			} finally {
				const restoreLevel = state.observeOriginalConsentLevel;
				if (restoreLevel) {
					const identity = await readRemoteSnoIdentity(config);
					await setObserveConsent(config, identity.machine_secret, {
						level: restoreLevel,
						machineUuid: identity.machine_uuid,
						reason: "agent_e2e_restore_original_consent",
					});
				}
			}
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});
