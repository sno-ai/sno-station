import { describe, expect, test } from "vitest";
import { createUUIDv7 } from "../../../../packages/common-core/src/index.ts";
import { writeArtifact, writeJsonArtifact } from "./helpers/artifacts";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import { sendGatewayTurn } from "./helpers/http";
import {
	expectedLlmixSnoGpuPreset,
	findSnoGpuPluginCall,
	findSnoGpuPluginCallAfter,
	readVmExtractionConfig,
} from "./helpers/llmix-sno-gpu";
import { waitForObserveSummaries } from "./helpers/observe-phase";
import { loadAgentRun } from "./helpers/state";
import {
	vmAssertPluginLoaded,
	vmGatewayJournalSince,
	vmRestartGateway,
} from "./helpers/vm-ops";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 08 LLMIx Sno GPU restart proof", () => {
	test(
		"proves the deployed signed LLMIx registry still resolves after gateway restart",
		async () => {
			const { config, state } = await loadAgentRun();
			const phaseStartedAt = new Date(Date.now() - 1_000).toISOString();
			await vmRestartGateway(config);
			await vmAssertPluginLoaded(config, { since: phaseStartedAt });

			const vmConfig = await readVmExtractionConfig(config, state.runId);
			await writeJsonArtifact(
				config,
				"llmix-sno-gpu-restart-vm-config.json",
				vmConfig,
			);
			expect(vmConfig.productMode).toBe("rem-enhanced");
			expect(vmConfig.extractionDestination).toBe("sno-gpu");

			const marker = createUUIDv7();
			const session = createUUIDv7();
			const request = {
				input: [
					"Please remember this post-restart LLMIx Sno GPU proof.",
					`The proof marker is ${marker}.`,
					`The signed preset is still ${expectedLlmixSnoGpuPreset}.`,
					"The gateway has just restarted, so registry verification must happen in the deployed runtime.",
				].join(" "),
				model: config.gatewayModel,
				stream: false,
				user: state.userCuid,
			};
			await writeJsonArtifact(
				config,
				"llmix-sno-gpu-restart-request.json",
				request,
			);
			const observeEventFloor = createUUIDv7();
			const turn = await sendGatewayTurn(config, session, request);
			await writeJsonArtifact(
				config,
				"llmix-sno-gpu-restart-response.json",
				turn.body,
			);
			expect(turn.text.length).toBeGreaterThan(0);

			const summaries = await waitForObserveSummaries(config, state, {
				artifactName: "llmix-sno-gpu-restart-observe",
				label: "post-restart Sno Observe plugin_internal_paid llm.call from LLMIx Sno GPU",
				matches: (events) =>
					findSnoGpuPluginCallAfter(events, observeEventFloor) !== undefined,
			});
			const proofCall =
				findSnoGpuPluginCallAfter(summaries, observeEventFloor) ??
				findSnoGpuPluginCall(summaries);
			expect(proofCall).toBeDefined();
			if (!proofCall) return;
			await writeJsonArtifact(
				config,
				"llmix-sno-gpu-restart-call-proof.json",
				proofCall,
			);
			expect(proofCall.llmPromptTokens ?? 0).toBeGreaterThan(0);
			expect(proofCall.llmCompletionTokens ?? 0).toBeGreaterThan(0);

			const journal = await vmGatewayJournalSince(config, phaseStartedAt);
			await writeArtifact(
				config,
				"llmix-sno-gpu-restart-gateway-journal.log",
				journal,
			);
			expect(journal).not.toMatch(/signature-verification-failure/i);
			expect(journal).not.toMatch(/Unhandled promise rejection/i);
			expect(journal).not.toMatch(/MdaConfigError/i);
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});
