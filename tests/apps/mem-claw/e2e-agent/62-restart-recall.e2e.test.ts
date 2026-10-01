import { gatewayRestartScript } from "./helpers/vm-ops";
import { describe, expect, test } from "vitest";
import { createUUIDv7 } from "../../../../packages/common-core/src/index.ts";
import { writeArtifact, writeJsonArtifact } from "./helpers/artifacts";
import { runRequiredCommand, shellWord } from "./helpers/command";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import { requestJson, sendGatewayTurn } from "./helpers/http";
import { teachPrompt } from "./helpers/prompts";
import { readRemoteMemoryEvidence } from "./helpers/remote-evidence";
import { loadAgentRun, saveAgentRunState } from "./helpers/state";
import { waitForEvidence } from "./helpers/wait";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 62 restart recall", () => {
	test(
		"reopens encrypted memory after a real Gateway restart and recalls it",
		async () => {
			const { config, state } = await loadAgentRun();
			state.restartNonce ??= createUUIDv7();
			const restartProject = `RestartVault-${state.runId}`;
			state.restartFact = `For ${restartProject}, encrypted restart recall marker ${state.restartNonce}; gemstone lapis-lazuli.`;
			state.restartTeachSession ??= createUUIDv7();
			state.restartRecallSession ??= createUUIDv7();
			await saveAgentRunState(state);

			const teachRequest = {
				input: teachPrompt(state.restartFact),
				model: config.gatewayModel,
				stream: false,
				user: state.userCuid,
			};
			await writeJsonArtifact(
				config,
				"gateway-restart-teach-request.json",
				teachRequest,
			);
			const teachTurn = await sendGatewayTurn(
				config,
				state.restartTeachSession,
				teachRequest,
			);
			await writeJsonArtifact(
				config,
				"gateway-restart-teach-response.json",
				teachTurn.body,
			);

			const beforeRestartEvidence = await waitForEvidence(
				() => readRemoteMemoryEvidence(config, state.restartNonce ?? ""),
				(evidence) => evidence.count > 0,
				{
					label: "encrypted memory row before Gateway restart",
					pollMs: 2_000,
					timeoutMs: 60_000,
				},
			);
			await writeJsonArtifact(
				config,
				"gateway-restart-memory-before.json",
				beforeRestartEvidence,
			);

			const unit = `openclaw-gateway-${shellWord(config.openClawProfile)}.service`;
			const restart = await runRequiredCommand(
				"ssh",
				[config.openClawVm, gatewayRestartScript(unit)],
				{ timeoutMs: 60_000 },
			);
			await writeArtifact(
				config,
				"gateway-restart.log",
				restart.stdout + restart.stderr,
			);

			await waitForEvidence(
				async () => {
					try {
						return (
							await requestJson(`${config.gatewayUrl}/health`, {
								headers: { Authorization: `Bearer ${config.openClawToken}` },
								rejectUnauthorized: config.rejectUnauthorized,
								timeoutMs: 5_000,
							})
						).statusCode;
					} catch {
						return 0;
					}
				},
				(statusCode) => statusCode === 200,
				{
					label: "Gateway health after restart",
					pollMs: 2_000,
					timeoutMs: 60_000,
				},
			);

			const afterRestartEvidence = await waitForEvidence(
				() => readRemoteMemoryEvidence(config, state.restartNonce ?? ""),
				(evidence) => evidence.count > 0,
				{
					label: "encrypted memory row after Gateway restart",
					pollMs: 2_000,
					timeoutMs: 60_000,
				},
			);
			await writeJsonArtifact(
				config,
				"gateway-restart-memory-after.json",
				afterRestartEvidence,
			);

			const request = {
				input: `For ${restartProject}, what is my encrypted restart recall marker and gemstone? Answer with only the marker UUID and gemstone.`,
				model: config.gatewayModel,
				stream: false,
				user: state.userCuid,
			};
			await writeJsonArtifact(
				config,
				"gateway-restart-recall-request.json",
				request,
			);
			const turn = await sendGatewayTurn(
				config,
				state.restartRecallSession,
				request,
			);
			await writeJsonArtifact(
				config,
				"gateway-restart-recall-response.json",
				turn.body,
			);

			const answer = turn.text.toLowerCase();
			expect(answer).toContain(state.restartNonce);
			expect(answer).toContain("lapis");
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});
