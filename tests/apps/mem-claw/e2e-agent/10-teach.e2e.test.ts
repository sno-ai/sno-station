import { describe, expect, test } from "vitest";
import { writeJsonArtifact } from "./helpers/artifacts";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import { sendGatewayTurn, summarizeGatewayUsage } from "./helpers/http";
import { teachPrompt } from "./helpers/prompts";
import {
	readRemoteAuditEvidence,
	readRemoteMemoryEvidence,
} from "./helpers/remote-evidence";
import { loadAgentRun, saveAgentRunState } from "./helpers/state";
import { waitForEvidence } from "./helpers/wait";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 10 teach", () => {
	test(
		"teaches one fact through Gateway and proves local memory capture",
		async () => {
			const { config, state } = await loadAgentRun();
			const phaseStartedAt = new Date(Date.now() - 1_000).toISOString();
			const request = {
				input: teachPrompt(state.fact),
				model: config.gatewayModel,
				stream: false,
				user: state.userCuid,
			};
			await writeJsonArtifact(config, "gateway-teach-request.json", request);
			const teachTurn = await sendGatewayTurn(
				config,
				state.teachSession,
				request,
			);
			await writeJsonArtifact(
				config,
				"gateway-teach-response.json",
				teachTurn.body,
			);
			expect(teachTurn.text.length).toBeGreaterThan(0);
			const usage = summarizeGatewayUsage(teachTurn.usage);
			await writeJsonArtifact(config, "gateway-teach-usage.json", usage);
			state.teachGatewayUsage = usage;
			await saveAgentRunState(state);

			const memory = await waitForEvidence(
				() => readRemoteMemoryEvidence(config, state.nonce),
				(evidence) => evidence.rows.some((row) => row.source === "edge" && row.extractor_version === "atomic-v3" && JSON.stringify(row).includes(state.nonce)),
				{
					label: "agent_end capture row containing nonce",
					pollMs: 5_000,
					timeoutMs: numberEnv("SNO_AGENT_E2E_MEMORY_TIMEOUT_MS", 60_000),
				},
			);
			await writeJsonArtifact(
				config,
				"memory-evidence-after-teach.json",
				memory,
			);
			expect(
				memory.rows.some((row) => JSON.stringify(row).includes(state.nonce)),
			).toBe(true);

			const audit = await waitForEvidence(
				() => readRemoteAuditEvidence(config, { since: phaseStartedAt }),
				(evidence) => evidence.ambientLearningCount > 0,
				{
					label: "ambient_learning audit line",
					pollMs: 5_000,
					timeoutMs: 60_000,
				},
			);
			await writeJsonArtifact(config, "audit-evidence-after-teach.json", audit);
			expect(audit.ambientLearningCount).toBeGreaterThan(0);
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});
