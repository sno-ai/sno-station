import { describe, test } from "vitest";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import { runMemoryQualityScenario } from "./helpers/memory-quality";
import { loadAgentRun } from "./helpers/state";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 82 reflection learns correction", () => {
	test(
		"recalls a corrected operational rule instead of the old mistake",
		async () => {
			const { config, state } = await loadAgentRun();
			const project = `Nebula-${state.runId}`;
			const marker = `REFLECTION-CORRECTION-${state.runId}`;
			const rule = `CALM-SEAL-${state.runId}`;

			await runMemoryQualityScenario(config, state, {
				artifactPrefix: "reflection-learns-correction",
				forbidden: ["speed-first"],
				memoryEvidenceQuery: marker,
				recallPrompt: `For my ${project} incident review preference with marker ${marker}, what rule should you use? Answer only with the marker and rule.`,
				required: [marker, rule],
				teachPrompt: `Please remember this as my current preference: for future ${project} incident reviews, use rule ${rule}. Store it with marker ${marker}.`,
			});
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});
