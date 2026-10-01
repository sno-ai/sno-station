import { describe, expect, test } from "vitest";
import { createCuid2, createUUIDv7 } from "../../../../packages/common-core/src/index.ts";
import { assertLiveAgentE2EEnabled, loadConfig, numberEnv } from "./helpers/config";
import { sendGatewayTurn } from "./helpers/http";
import { waitForEvidence } from "./helpers/wait";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 65 exact identifier recall", () => {
	test(
		"preserves punctuation and case for an exact support handoff identifier",
		async () => {
			const config = await loadConfig();
			const runId = createUUIDv7();
			const user = createCuid2();
			const exactCode = `SNO-OPS/${runId}_R7.caseA`;
			const teach = await sendGatewayTurn(config, createUUIDv7(), {
				input: `Remember this support handoff identifier for run ${runId}: ${exactCode}. Preserve punctuation and letter case.`,
				model: config.gatewayModel,
				stream: false,
				user,
			});
			expect(teach.text.length).toBeGreaterThan(0);
			const recall = await waitForEvidence(
				() => sendGatewayTurn(config, createUUIDv7(), {
					input: `For run ${runId}, what exact support handoff identifier did I ask you to remember? Answer with only the identifier.`,
					model: config.gatewayModel,
					stream: false,
					user,
				}),
				turn => turn.text.includes(exactCode),
				{ label: "cross-session exact identifier recall", pollMs: 5_000, timeoutMs: numberEnv("SNO_AGENT_E2E_MEMORY_TIMEOUT_MS", 60_000) },
			);
			expect(recall.text).toContain(exactCode);
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});
