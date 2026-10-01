import { describe, expect, test } from "vitest";
import { createUUIDv7 } from "../../../../packages/common-core/src/index.ts";
import { writeJsonArtifact } from "./helpers/artifacts";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import { sendGatewayTurn } from "./helpers/http";
import { similarMemoryRecallPrompt } from "./helpers/prompts";
import { readRemoteMemoryEvidence } from "./helpers/remote-evidence";
import { loadAgentRun, saveAgentRunState } from "./helpers/state";
import { waitForEvidence } from "./helpers/wait";

assertLiveAgentE2EEnabled();

function requireString(value: string | undefined, label: string): string {
	if (value === undefined) throw new Error(`missing ${label}`);
	return value;
}

describe("Agent 1:1 phase 64 similar memory disambiguation", () => {
	test(
		"recalls the right value when two saved memories are similar",
		async () => {
			const { config, state } = await loadAgentRun();
			if (!state.similarCorrectCode || state.similarCorrectCode.includes("-")) {
				const suffix = createUUIDv7().replaceAll("-", "").slice(0, 8);
				state.similarDecoyCode = `notebook-${suffix}`;
				state.similarCorrectCode = `backpack-${suffix}`;
				state.similarMarker = `atlas-${suffix}`;
				state.similarTeachSession = createUUIDv7();
				state.similarRecallSession = createUUIDv7();
			}
			state.similarTeachSession ??= createUUIDv7();
			state.similarRecallSession ??= createUUIDv7();
			await saveAgentRunState(state);
			const similarMarker = requireString(state.similarMarker, "similar marker");
			const similarDecoyCode = requireString(state.similarDecoyCode, "similar decoy code");
			const similarCorrectCode = requireString(
				state.similarCorrectCode,
				"similar correct code",
			);
			const similarTeachSession = requireString(
				state.similarTeachSession,
				"similar teach session",
			);
			const similarRecallSession = requireString(
				state.similarRecallSession,
				"similar recall session",
			);

			const decoyTeachRequest = {
				input: similarDecoyTeachPrompt(
					similarMarker,
					similarDecoyCode,
				),
				model: config.gatewayModel,
				stream: false,
				user: state.userCuid,
			};
			await writeJsonArtifact(
				config,
				"gateway-similar-decoy-teach-request.json",
				decoyTeachRequest,
			);
			const decoyTeachTurn = await sendGatewayTurn(
				config,
				similarTeachSession,
				decoyTeachRequest,
			);
			await writeJsonArtifact(
				config,
				"gateway-similar-decoy-teach-response.json",
				decoyTeachTurn.body,
			);
			expect(decoyTeachTurn.text.length).toBeGreaterThan(0);

			const decoyMemory = await waitForEvidence(
				() => readRemoteMemoryEvidence(config, similarDecoyCode),
				(evidence) => evidence.count > 0,
				{
					label: "similar memory row containing decoy code",
					pollMs: 5_000,
					timeoutMs: numberEnv("SNO_AGENT_E2E_MEMORY_TIMEOUT_MS", 60_000),
				},
			);
			await writeJsonArtifact(
				config,
				"memory-evidence-after-similar-decoy-teach.json",
				decoyMemory,
			);

			const correctTeachRequest = {
				input: similarCorrectTeachPrompt(
					similarMarker,
					similarCorrectCode,
				),
				model: config.gatewayModel,
				stream: false,
				user: state.userCuid,
			};
			await writeJsonArtifact(
				config,
				"gateway-similar-correct-teach-request.json",
				correctTeachRequest,
			);
			const correctTeachTurn = await sendGatewayTurn(
				config,
				similarTeachSession,
				correctTeachRequest,
			);
			await writeJsonArtifact(
				config,
				"gateway-similar-correct-teach-response.json",
				correctTeachTurn.body,
			);
			expect(correctTeachTurn.text.length).toBeGreaterThan(0);

			const correctMemory = await waitForEvidence(
				() => readRemoteMemoryEvidence(config, similarCorrectCode),
				(evidence) => evidence.count > 0,
				{
					label: "similar memory row containing correct code",
					pollMs: 5_000,
					timeoutMs: numberEnv("SNO_AGENT_E2E_MEMORY_TIMEOUT_MS", 60_000),
				},
			);
			await writeJsonArtifact(
				config,
				"memory-evidence-after-similar-correct-teach.json",
				correctMemory,
			);

			const recallRequest = {
				input: similarMemoryRecallPrompt(similarMarker),
				model: config.gatewayModel,
				stream: false,
				user: state.userCuid,
			};
			await writeJsonArtifact(
				config,
				"gateway-similar-recall-request.json",
				recallRequest,
			);
			const recallTurn = await sendGatewayTurn(
				config,
				similarRecallSession,
				recallRequest,
			);
			await writeJsonArtifact(
				config,
				"gateway-similar-recall-response.json",
				recallTurn.body,
			);
			expect(recallTurn.text).toContain(similarCorrectCode);
			expect(recallTurn.text).not.toContain(similarDecoyCode);
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});

function similarDecoyTeachPrompt(marker: string, decoyCode: string): string {
	return `Please remember one project handoff detail for future sessions: For Project Atlas ${marker}, the blue notebook code is ${decoyCode}. Later I will ask about a different blue backpack code, so keep the notebook item distinct. Reply with exactly: noted.`;
}

function similarCorrectTeachPrompt(
	marker: string,
	correctCode: string,
): string {
	return `Please remember one project handoff detail for future sessions: For Project Atlas ${marker}, the blue backpack code is ${correctCode}. This is different from the notebook code; later I will ask for the backpack code only. Reply with exactly: noted.`;
}
