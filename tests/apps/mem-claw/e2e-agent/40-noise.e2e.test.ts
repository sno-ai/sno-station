import { describe, expect, test } from "vitest";
import {
	createCuid2,
	createUUIDv7,
} from "../../../../packages/common-core/src/index.ts";
import { writeJsonArtifact } from "./helpers/artifacts";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import { sendGatewayTurn } from "./helpers/http";
import { noisePrompt } from "./helpers/prompts";
import { readRemoteMemoryEvidence } from "./helpers/remote-evidence";
import { loadAgentRun, saveAgentRunState } from "./helpers/state";
import { sleep } from "./helpers/wait";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 40 noise", () => {
	test(
		"sends ordinary non-memory chat through the real agent",
		async () => {
			const { config, state } = await loadAgentRun();
			const noiseSession = state.noiseSession ?? createUUIDv7();
			const noiseNonce = state.noiseNonce ?? createUUIDv7();
			const noiseUserCuid = state.noiseUserCuid ?? createCuid2();
			state.noiseNonce = noiseNonce;
			state.noiseSession = noiseSession;
			state.noiseUserCuid = noiseUserCuid;
			await saveAgentRunState(state);

			const noiseMarker = noisePrompt(noiseNonce);
			const prompts = [noiseMarker];
			const responses = [];
			for (const input of prompts) {
				const request = {
					input,
					model: config.gatewayModel,
					stream: false,
					user: noiseUserCuid,
				};
				const turn = await sendGatewayTurn(config, noiseSession, request);
				responses.push(turn.body);
				expect(turn.text.length).toBeGreaterThan(0);
			}
			await writeJsonArtifact(
				config,
				"gateway-noise-responses.json",
				responses,
			);

			await sleep(numberEnv("SNO_AGENT_E2E_NOISE_ABSENCE_MS", 10_000));
			const memory = await readRemoteMemoryEvidence(config, noiseMarker);
			await writeJsonArtifact(
				config,
				"memory-evidence-after-noise.json",
				memory,
			);
			expect(memory.count).toBe(0);
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});
