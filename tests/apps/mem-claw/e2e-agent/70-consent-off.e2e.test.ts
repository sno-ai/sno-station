import { describe, expect, test } from "vitest";
import { createUUIDv7 } from "../../../../packages/common-core/src/index.ts";
import { writeJsonArtifact } from "./helpers/artifacts";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import { sendGatewayScenarioTurn } from "./helpers/memory-quality";
import { setObserveConsent } from "./helpers/observe-api";
import { consentMarker, consentTeachPrompt } from "./helpers/prompts";
import {
	readRemoteMemoryEvidence,
	readRemoteSnoIdentity,
} from "./helpers/remote-evidence";
import { loadAgentRun, saveAgentRunState } from "./helpers/state";
import type { TestConfig } from "./helpers/types";
import { waitForEvidence } from "./helpers/wait";

assertLiveAgentE2EEnabled();

type MemoryEvidence = Awaited<ReturnType<typeof readRemoteMemoryEvidence>>;

describe("Agent 1:1 phase 70 consent off", () => {
	test(
		"keeps plugin memory working while Observe consent is off",
		async () => {
			const { config, state } = await loadAgentRun();
			const consentOffSession = createUUIDv7();
			const consentOffNonce = createUUIDv7();
			Object.assign(state, {
				consentOffNonce,
				consentOffObserveSession: undefined,
				consentOffSession,
				consentUserCuid: state.userCuid,
			});
			await saveAgentRunState(state);
			const identity = await readRemoteSnoIdentity(config);

			await setObserveConsent(config, identity.machine_secret, {
				level: "off",
				machineUuid: identity.machine_uuid,
				reason: "agent_e2e_off",
			});
			await sendMemoryTeachTurn(
				config,
				consentOffSession,
				state.userCuid,
				consentMarker("off", consentOffNonce),
			);

			const localOffMemory = await waitForMemoryEvidence(
				config,
				consentOffNonce,
				"local memory row written while Observe consent is off",
			);
			await writeJsonArtifact(
				config,
				"memory-evidence-consent-off.json",
				localOffMemory,
			);
			expect(localOffMemory.count).toBeGreaterThan(0);
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});

async function sendMemoryTeachTurn(
	config: TestConfig,
	sessionUuid: string | undefined,
	userCuid: string,
	marker: string,
): Promise<void> {
	if (!sessionUuid) {
		throw new Error("Missing session UUID for consent scenario");
	}
	const turn = await sendGatewayScenarioTurn(config, {
		artifactName: "consent-off-teach",
		prompt: consentTeachPrompt(marker),
		sessionUuid,
		userCuid,
	});
	expect(turn.text.length).toBeGreaterThan(0);
}

async function waitForMemoryEvidence(
	config: TestConfig,
	nonce: string,
	label: string,
): Promise<MemoryEvidence> {
	return await waitForEvidence(
		() => readRemoteMemoryEvidence(config, nonce),
		(evidence) => evidence.count > 0,
		{
			label,
			pollMs: 5_000,
			timeoutMs: numberEnv("SNO_AGENT_E2E_MEMORY_TIMEOUT_MS", 60_000),
		},
	);
}
