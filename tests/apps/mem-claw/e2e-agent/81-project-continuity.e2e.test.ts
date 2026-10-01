import { describe, test } from "vitest";
import { createUUIDv7 } from "../../../../packages/common-core/src/index.ts";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import { runMemoryQualityScenario } from "./helpers/memory-quality";
import { loadAgentRun } from "./helpers/state";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 81 project continuity", () => {
	test(
		"carries a project status note into a later planning turn",
		async () => {
			const { config, state } = await loadAgentRun();
			const scenarioId = createUUIDv7();
			const scenarioToken = scenarioId.replaceAll("-", "").slice(-8);
			const action = `queue-beacon-${scenarioToken}`;
			const marker = `PROJECT-CONTINUITY-${state.runId}-${scenarioId}`;
			const project = `HarborEvent-${scenarioToken}`;
			const status = `amber-lattice-${scenarioToken}`;

			await runMemoryQualityScenario(config, state, {
				artifactPrefix: "project-continuity",
				memoryEvidenceQuery: marker,
				recallPrompt: `For ongoing project marker ${marker}, answer with the project name, status, next action, and marker for ${project}.`,
				required: [project, status, action, marker],
				teachPrompt: `On 2026-05-11 we decided that Project ${project} is blocked by ${status}; going forward the next action is ${action}; tracking marker ${marker}. Please remember this project decision for later planning turns.`,
			});
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});
