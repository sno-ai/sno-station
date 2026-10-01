import { describe, test } from "vitest";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import { runMemoryQualityScenario } from "./helpers/memory-quality";
import { loadAgentRun } from "./helpers/state";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 88 exact details recall", () => {
	test(
		"preserves exact date, identifier, and punctuation in recall",
		async () => {
			const { config, state } = await loadAgentRun();
			const code = `CASE-${state.runId.toUpperCase()}/R2.alpha_07`;
			const date = "2026-07-14";

			await runMemoryQualityScenario(config, state, {
				artifactPrefix: "exact-details-recall",
				memoryEvidenceQuery: code,
				recallPrompt: `What exact support date and case identifier did I ask you to remember for run ${state.runId}?`,
				required: [date, code],
				teachPrompt: `Remember these exact support details for run ${state.runId}: support date ${date}; case identifier ${code}. Preserve punctuation and letter case.`,
			});
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});
