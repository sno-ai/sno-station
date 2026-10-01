import { describe, expect, test } from "vitest";
import { createUUIDv7 } from "../../../../packages/common-core/src/index.ts";
import { writeArtifact, writeJsonArtifact } from "./helpers/artifacts";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import { sendGatewayTurn } from "./helpers/http";
import {
	expectedLlmixSnoGpuPreset,
	findSnoGpuPluginCall,
	findSnoGpuPluginCallAfter,
	probeVmSnoGpuRoutes,
	readVmExtractionConfig,
} from "./helpers/llmix-sno-gpu";
import { waitForObserveSummaries } from "./helpers/observe-phase";
import { loadAgentRun } from "./helpers/state";
import { vmGatewayJournalSince } from "./helpers/vm-ops";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 07 LLMIx Sno GPU", () => {
	test(
		"proves VM rem-enhanced extraction calls Sno GPU through the signed LLMIx preset",
		async () => {
			const { config, state } = await loadAgentRun();
			const phaseStartedAt = new Date(Date.now() - 1_000).toISOString();
			const marker = createUUIDv7();
			const llmixSession = createUUIDv7();
			const fact = [
				"Please remember this exact Sno Memory LLMIx provider proof for later.",
				`The proof marker is ${marker}.`,
				`The intended signed preset is ${expectedLlmixSnoGpuPreset}.`,
				"The route owner is Sno GPU, not the host agent model.",
			].join(" ");

			const vmConfig = await readVmExtractionConfig(config, state.runId);
			await writeJsonArtifact(config, "llmix-sno-gpu-vm-config.json", vmConfig);
			expect(vmConfig.productMode).toBe("rem-enhanced");
			expect(vmConfig.extractionDestination).toBe("sno-gpu");
			expect(vmConfig.gpuBaseUrl).not.toBe("");
			const routeProbe = await probeVmSnoGpuRoutes(config);
			await writeJsonArtifact(config, "llmix-sno-gpu-route-probe.json", routeProbe);
			expect(routeProbe.signedPresetRoute.httpCode).toBe(200);
			expect(routeProbe.signedPresetRoute.body).toBeDefined();
			expect(routeProbe.signedPresetRoute.contentPreview).toContain("sno-gpu-probe");
			expect(routeProbe.signedPresetRoute.completionTokens).toBeGreaterThan(0);
			expect(routeProbe.signedPresetRoute.promptTokens).toBeGreaterThan(0);
			expect(routeProbe.legacyExtractRoute.httpCode).toBe(404);

			const request = {
				input: fact,
				model: config.gatewayModel,
				stream: false,
				user: state.userCuid,
			};
			await writeJsonArtifact(config, "llmix-sno-gpu-request.json", request);
			const observeEventFloor = createUUIDv7();
			const turn = await sendGatewayTurn(config, llmixSession, request);
			await writeJsonArtifact(config, "llmix-sno-gpu-response.json", turn.body);
			expect(turn.text.length).toBeGreaterThan(0);

			const summaries = await waitForObserveSummaries(config, state, {
				artifactName: "llmix-sno-gpu-observe",
				label: "Sno Observe plugin_internal_paid llm.call from LLMIx Sno GPU",
				matches: (events) =>
					findSnoGpuPluginCallAfter(events, observeEventFloor) !== undefined,
			});
			const proofCall =
				findSnoGpuPluginCallAfter(summaries, observeEventFloor) ??
				findSnoGpuPluginCall(summaries);
			expect(proofCall).toBeDefined();
			if (!proofCall) return;
			await writeJsonArtifact(config, "llmix-sno-gpu-call-proof.json", proofCall);
			expect(proofCall.llmPromptTokens ?? 0).toBeGreaterThan(0);
			expect(proofCall.llmCompletionTokens ?? 0).toBeGreaterThan(0);

			const journal = await vmGatewayJournalSince(config, phaseStartedAt);
			await writeArtifact(config, "llmix-sno-gpu-gateway-journal.log", journal);
			expect(journal).not.toMatch(/signature-verification-failure/i);
			expect(journal).not.toMatch(/Unhandled promise rejection/i);
			expect(journal).not.toMatch(/MdaConfigError/i);
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});
