import { describe, expect, test } from "vitest";
import { writeJsonArtifact } from "./helpers/artifacts";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import { sendGatewayTurn } from "./helpers/http";
import { updateRecallPrompt } from "./helpers/prompts";
import { loadAgentRun } from "./helpers/state";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 51 update recall", () => {
	test(
		"recalls the corrected value from a fresh session",
		async () => {
			const { config, state } = await loadAgentRun();
			expect(state.updateQaSession).toBeDefined();
			expect(state.updateOldNonce).toBeDefined();
			expect(state.updateNewNonce).toBeDefined();
			expect(state.updateSubject).toBeDefined();
			const updateQaSession = state.updateQaSession;
			const updateOldNonce = state.updateOldNonce;
			const updateNewNonce = state.updateNewNonce;
			const updateSubject = state.updateSubject;
			if (!updateQaSession || !updateOldNonce || !updateNewNonce || !updateSubject) {
				return;
			}

			const request = {
				input: updateRecallPrompt(updateSubject),
				model: config.gatewayModel,
				stream: false,
				user: state.userCuid,
			};
			await writeJsonArtifact(config, "gateway-update-recall-request.json", request);
			const turn = await sendGatewayTurn(config, updateQaSession, request);
			await writeJsonArtifact(config, "gateway-update-recall-response.json", turn.body);

			expect(turn.text).toContain(updateNewNonce);
			expect(turn.text).not.toContain(updateOldNonce);
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});
