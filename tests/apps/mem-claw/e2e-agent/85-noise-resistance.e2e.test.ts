import { describe, test } from "vitest";
import { createUUIDv7 } from "../../../../packages/common-core/src/index.ts";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import {
	expectTextExcludesAll,
	expectTextIncludesAll,
	sendGatewayScenarioTurn,
	waitForScenarioMemory,
} from "./helpers/memory-quality";
import { loadAgentRun } from "./helpers/state";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 85 noise resistance", () => {
	test(
		"ignores conversational noise while preserving the real memory",
		async () => {
			const { config, state } = await loadAgentRun();
			const marker = `NOISE-RESIST-${state.runId}`;
			const noiseOne = createUUIDv7();
			const teachSession = createUUIDv7();
			const noiseTwo = createUUIDv7();
			const recallSession = createUUIDv7();

			await sendGatewayScenarioTurn(config, {
				artifactName: "noise-resistance-before",
				prompt: `Quick chat only, do not remember this: ${noiseOne}.`,
				sessionUuid: noiseOne,
				userCuid: state.userCuid,
			});
			await sendGatewayScenarioTurn(config, {
				artifactName: "noise-resistance-teach",
				prompt: `Please remember this real user preference: my dashboard review marker is ${marker}.`,
				sessionUuid: teachSession,
				userCuid: state.userCuid,
			});
			await waitForScenarioMemory(config, "noise-resistance-real", marker);
			await sendGatewayScenarioTurn(config, {
				artifactName: "noise-resistance-after",
				prompt: "Thanks, that is all for now.",
				sessionUuid: noiseTwo,
				userCuid: state.userCuid,
			});
			const recall = await sendGatewayScenarioTurn(config, {
				artifactName: "noise-resistance-recall",
				prompt: `What is my dashboard review marker for run ${state.runId}?`,
				sessionUuid: recallSession,
				userCuid: state.userCuid,
			});

			expectTextIncludesAll(recall.text, [marker]);
			expectTextExcludesAll(recall.text, [noiseOne, noiseTwo]);
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});
