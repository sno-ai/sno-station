import { describe, expect, test } from "vitest";
import { writeJsonArtifact } from "./helpers/artifacts";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import { sendGatewayTurn, summarizeGatewayUsage } from "./helpers/http";
import { recallPrompt } from "./helpers/prompts";
import { readRemoteAuditEvidence } from "./helpers/remote-evidence";
import { loadAgentRun, saveAgentRunState } from "./helpers/state";
import { waitForEvidence } from "./helpers/wait";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 20 recall", () => {
	test(
		"recalls the fact from a fresh session and proves local recall",
		async () => {
			const { config, state } = await loadAgentRun();
			const phaseStartedAt = new Date(Date.now() - 1_000).toISOString();
			const request = {
				input: recallPrompt(state.runId),
				model: config.gatewayModel,
				stream: false,
				user: state.userCuid,
			};
			await writeJsonArtifact(config, "gateway-qa-request.json", request);
			const qaTurn = await sendGatewayTurn(config, state.qaSession, request);
			await writeJsonArtifact(config, "gateway-qa-response.json", qaTurn.body);
			const usage = summarizeGatewayUsage(qaTurn.usage);
			await writeJsonArtifact(config, "gateway-qa-usage.json", usage);
			state.qaGatewayUsage = usage;
			await saveAgentRunState(state);

			const answer = qaTurn.text.toLowerCase();
			expect(answer).toContain(state.nonce);
			expect(answer).toContain("cerulean");

			const audit = await waitForEvidence(
				() => readRemoteAuditEvidence(config, { since: phaseStartedAt }),
				(evidence) => evidence.autoRecallCount > 0,
				{
					label: "auto_recall audit line",
					pollMs: 5_000,
					timeoutMs: 120_000,
				},
			);
			await writeJsonArtifact(
				config,
				"audit-evidence-after-recall.json",
				audit,
			);
			expect(audit.autoRecallCount).toBeGreaterThan(0);
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});
