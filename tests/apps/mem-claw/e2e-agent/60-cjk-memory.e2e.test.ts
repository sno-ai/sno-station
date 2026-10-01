import { describe, expect, test } from "vitest";
import { createUUIDv7 } from "../../../../packages/common-core/src/index.ts";
import { writeJsonArtifact } from "./helpers/artifacts";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import { sendGatewayTurn } from "./helpers/http";
import { cjkRecallPrompt, cjkTeachPrompt } from "./helpers/prompts";
import { loadAgentRun, saveAgentRunState } from "./helpers/state";
import { waitForEvidence } from "./helpers/wait";

assertLiveAgentE2EEnabled();

function includesCjkAnswer(text: string): boolean {
	const hasProject = text.includes("青岚") || text.includes("青嵐");
	const hasTea = text.includes("冻顶乌龙") || text.includes("凍頂烏龍");
	return hasProject && hasTea;
}

function requireString(value: string | undefined, label: string): string {
	if (value === undefined) throw new Error(`missing ${label}`);
	return value;
}

describe("Agent 1:1 phase 60 CJK memory", () => {
	test(
		"stores and recalls a Chinese memory through real Gateway turns",
		async () => {
			const { config, state } = await loadAgentRun();
			state.cjkNonce ??= createUUIDv7();
			if (!state.cjkFact || state.cjkFact.includes("中文记忆验证码")) {
				state.cjkFact = "我的中文项目代号是青岚九号，默认茶饮偏好是冻顶乌龙。";
				state.cjkTeachSession = createUUIDv7();
				state.cjkRecallSession = createUUIDv7();
			}
			state.cjkTeachSession ??= createUUIDv7();
			state.cjkRecallSession ??= createUUIDv7();
			await saveAgentRunState(state);
			const cjkFact = requireString(state.cjkFact, "CJK fact");
			const cjkTeachSession = requireString(state.cjkTeachSession, "CJK teach session");
			const cjkRecallSession = requireString(state.cjkRecallSession, "CJK recall session");

			const teachRequest = {
				input: cjkTeachPrompt(cjkFact),
				model: config.gatewayModel,
				stream: false,
				user: state.userCuid,
			};
			await writeJsonArtifact(
				config,
				"gateway-cjk-teach-request.json",
				teachRequest,
			);
			const teachTurn = await sendGatewayTurn(
				config,
				cjkTeachSession,
				teachRequest,
			);
			await writeJsonArtifact(
				config,
				"gateway-cjk-teach-response.json",
				teachTurn.body,
			);
			expect(teachTurn.text.length).toBeGreaterThan(0);

			const recallRequest = {
				input: cjkRecallPrompt(),
				model: config.gatewayModel,
				stream: false,
				user: state.userCuid,
			};
			await writeJsonArtifact(
				config,
				"gateway-cjk-recall-request.json",
				recallRequest,
			);
			const recallTurn = await waitForEvidence(
				() => sendGatewayTurn(config, cjkRecallSession, recallRequest),
				(turn) => includesCjkAnswer(turn.text),
				{
					label: "CJK recall response containing project name and tea",
					pollMs: 10_000,
					timeoutMs: numberEnv("SNO_AGENT_E2E_MEMORY_TIMEOUT_MS", 120_000),
				},
			);
			await writeJsonArtifact(
				config,
				"gateway-cjk-recall-response.json",
				recallTurn.body,
			);
			expect(includesCjkAnswer(recallTurn.text)).toBe(true);
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});
