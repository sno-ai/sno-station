import { describe, expect, test } from "vitest";
import { writeJsonArtifact } from "./helpers/artifacts";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import { sendGatewayTurn } from "./helpers/http";
import { finalizePrompt } from "./helpers/prompts";
import { readRemoteAuditEvidence } from "./helpers/remote-evidence";
import { loadAgentRun } from "./helpers/state";
import { waitForEvidence } from "./helpers/wait";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 30 finalize", () => {
	test(
		"ends the QA session through a real Gateway turn",
		async () => {
			const { config, state } = await loadAgentRun();
			const phaseStartedAt = new Date(Date.now() - 1_000).toISOString();
			const request = {
				input: finalizePrompt(),
				model: config.gatewayModel,
				stream: false,
				user: state.userCuid,
			};
			await writeJsonArtifact(config, "gateway-finalize-request.json", request);
			const finalizeTurn = await sendGatewayTurn(
				config,
				state.qaSession,
				request,
			);
			await writeJsonArtifact(
				config,
				"gateway-finalize-response.json",
				finalizeTurn.body,
			);
			expect(finalizeTurn.text.length).toBeGreaterThan(0);

			const audit = await waitForEvidence(
				() => readRemoteAuditEvidence(config, { since: phaseStartedAt }),
				(evidence) => evidence.agentEndCount > 0,
				{
					label: "agent_end audit lines after real Gateway finalization turn",
					pollMs: 5_000,
					timeoutMs: 120_000,
				},
			);
			await writeJsonArtifact(
				config,
				"audit-evidence-after-finalize.json",
				audit,
			);
			expect(audit.agentEndCount).toBeGreaterThan(0);
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});
