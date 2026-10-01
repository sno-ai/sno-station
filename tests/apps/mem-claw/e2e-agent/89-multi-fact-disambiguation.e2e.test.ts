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

describe("Agent 1:1 phase 89 multi-fact disambiguation", () => {
	test(
		"answers independent questions from one dense memory without mixing decoys",
		async () => {
			const { config, state } = await loadAgentRun();
			const marker = `MULTI-FACT-${createUUIDv7()}`;
			const project = `Atlas-${state.runId}`;
			const teachSession = createUUIDv7();
			const ownerSession = createUUIDv7();
			const portSession = createUUIDv7();
			const branchSession = createUUIDv7();

			await sendGatewayScenarioTurn(config, {
				artifactName: "multi-fact-teach",
				prompt: `Please remember this current project handoff detail for ${project}: owner is Mira; Gateway port is 19789, not 19790; release branch is dev; marker ${marker}.`,
				sessionUuid: teachSession,
				userCuid: state.userCuid,
			});
			await waitForScenarioMemory(config, "multi-fact", marker);
			const owner = await sendGatewayScenarioTurn(config, {
				artifactName: "multi-fact-owner-recall",
				prompt: `For ${project} marker ${marker}, who owns the project?`,
				sessionUuid: ownerSession,
				userCuid: state.userCuid,
			});
			const port = await sendGatewayScenarioTurn(config, {
				artifactName: "multi-fact-port-recall",
				prompt: `For ${project} marker ${marker}, what Gateway port should I use? Reply with only the port number.`,
				sessionUuid: portSession,
				userCuid: state.userCuid,
			});
			const branch = await sendGatewayScenarioTurn(config, {
				artifactName: "multi-fact-branch-recall",
				prompt: `For ${project} marker ${marker}, what release branch should I use?`,
				sessionUuid: branchSession,
				userCuid: state.userCuid,
			});

			expectTextIncludesAll(owner.text, ["Mira"]);
			expectTextIncludesAll(port.text, ["19789"]);
			expectTextExcludesAll(port.text, ["19790"]);
			expectTextIncludesAll(branch.text, ["dev"]);
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});
