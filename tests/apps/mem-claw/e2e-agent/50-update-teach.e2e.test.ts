import { describe, expect, test } from "vitest";
import { createUUIDv7 } from "../../../../packages/common-core/src/index.ts";
import { writeJsonArtifact } from "./helpers/artifacts";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import { sendGatewayTurn } from "./helpers/http";
import {
	updateCorrectionPrompt,
	updateOldPrompt,
	updateRecallPrompt,
} from "./helpers/prompts";
import { readRemoteMemoryEvidence } from "./helpers/remote-evidence";
import { loadAgentRun, saveAgentRunState } from "./helpers/state";
import { waitForEvidence } from "./helpers/wait";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 50 update teach", () => {
	test(
		"teaches a correction through the real agent",
		async () => {
			const { config, state } = await loadAgentRun();
			const updateTeachSession = state.updateTeachSession ?? createUUIDv7();
			const updateQaSession = state.updateQaSession ?? createUUIDv7();
			const updateProbeSession = createUUIDv7();
			const updateOldNonce = state.updateOldNonce ?? createUUIDv7();
			const updateNewNonce = state.updateNewNonce ?? createUUIDv7();
			const updateSubject = state.updateSubject ?? createUUIDv7();
			Object.assign(state, {
				updateNewNonce,
				updateOldNonce,
				updateQaSession,
				updateSubject,
				updateTeachSession,
			});
			await saveAgentRunState(state);

			const requests = [
				{
					input: updateOldPrompt(updateSubject, updateOldNonce),
					model: config.gatewayModel,
					stream: false,
					user: state.userCuid,
				},
				{
					input: updateCorrectionPrompt(
						updateSubject,
						updateOldNonce,
						updateNewNonce,
					),
					model: config.gatewayModel,
					stream: false,
					user: state.userCuid,
				},
			];
			const responses = [];
			for (const request of requests) {
				const turn = await sendGatewayTurn(config, updateTeachSession, request);
				responses.push(turn.body);
				expect(turn.text.length).toBeGreaterThan(0);
			}
			await writeJsonArtifact(
				config,
				"gateway-update-teach-responses.json",
				responses,
			);

			const memory = await waitForEvidence(
				() => readRemoteMemoryEvidence(config, updateNewNonce),
				(evidence) => evidence.count > 0,
				{
					label: "updated memory row containing new nonce",
					pollMs: 5_000,
					// A correction is not one write. It is extraction, then conflict
					// adjudication, then the rewrite, and under rem-enhanced two of those
					// reach our own GPU. Measured during a live agent run from the Sno
					// activity feed on 2026-08-26: correction prompt 21:27:30.427Z, its
					// memory.write 21:29:13.415Z in the same session — 103 s. The 60 s
					// budget was below that, so the first attempt timed out in runs 5, 6
					// and 8, and the phase passed only when the runner's single retry
					// happened to land. 180 s is the measured cost plus headroom; if this
					// starts timing out again the write itself got slower, which is worth
					// chasing rather than raising again.
					timeoutMs: numberEnv("SNO_AGENT_E2E_MEMORY_TIMEOUT_MS", 180_000),
				},
			);
			await writeJsonArtifact(
				config,
				"memory-evidence-after-update.json",
				memory,
			);
			expect(memory.count).toBeGreaterThan(0);

			const staleMemory = await readRemoteMemoryEvidence(
				config,
				updateOldNonce,
			);
			await writeJsonArtifact(
				config,
				"memory-evidence-after-update-old.json",
				staleMemory,
			);

			const recall = await sendGatewayTurn(config, updateProbeSession, {
				input: updateRecallPrompt(updateSubject),
				model: config.gatewayModel,
				stream: false,
				user: state.userCuid,
			});
			await writeJsonArtifact(
				config,
				"gateway-update-probe-response.json",
				recall.body,
			);
			expect(recall.text).toContain(updateNewNonce);
			expect(recall.text).not.toContain(updateOldNonce);
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});
