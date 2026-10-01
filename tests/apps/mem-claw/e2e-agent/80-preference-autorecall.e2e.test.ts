import { describe, test } from "vitest";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import { runMemoryQualityScenario } from "./helpers/memory-quality";
import { loadAgentRun } from "./helpers/state";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 80 preference autorecall", () => {
	test(
		"uses a saved workflow preference in a later session",
		async () => {
			const { config, state } = await loadAgentRun();
			const marker = `DEPLOY-CHECKLIST-${state.runId}`;

			await runMemoryQualityScenario(config, state, {
				artifactPrefix: "preference-autorecall",
				memoryEvidenceQuery: marker,
				recallPrompt: `I need to deploy a plugin update for workflow ${marker}. Use my saved deployment answer format for that workflow.`,
				required: [marker, "Plan", "Verify", "Rollback"],
				teachPrompt: `Replace any old deployment checklist preference for workflow ${marker} with this current workflow preference: whenever I ask about that workflow deployment, answer with a three item checklist titled ${marker}. The checklist items must be Plan, Verify, and Rollback.`,
			});
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});
