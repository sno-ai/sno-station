import { expect } from "vitest";
import { createUUIDv7 } from "../../../../../packages/common-core/src/index.ts";
import { writeJsonArtifact } from "./artifacts";
import { numberEnv } from "./config";
import { sendGatewayTurn } from "./http";
import { hasSessionEvent } from "./observe-evidence";
import { readRemoteMemoryEvidence } from "./remote-evidence";
import type {
	AgentRunState,
	EventSummary,
	GatewayTurn,
	JsonObject,
	TestConfig,
} from "./types";
import { waitForEvidence } from "./wait";

export type MemoryQualityScenario = {
	artifactPrefix: string;
	forbidden?: string[];
	memoryEvidenceQuery?: string;
	recallPrompt: string;
	required: string[];
	teachPrompt: string;
	userCuid?: string;
};

export async function runMemoryQualityScenario(
	config: TestConfig,
	state: AgentRunState,
	scenario: MemoryQualityScenario,
): Promise<{
	recallSession: string;
	recallTurn: GatewayTurn;
	teachSession: string;
}> {
	const teachSession = createUUIDv7();
	const recallSession = createUUIDv7();
	const userCuid = scenario.userCuid ?? state.userCuid;

	await sendGatewayScenarioTurn(config, {
		artifactName: `${scenario.artifactPrefix}-teach`,
		prompt: scenario.teachPrompt,
		sessionUuid: teachSession,
		userCuid,
	});
	if (scenario.memoryEvidenceQuery) {
		await waitForScenarioMemory(
			config,
			scenario.artifactPrefix,
			scenario.memoryEvidenceQuery,
		);
	}
	const recallTurn = await sendGatewayScenarioTurn(config, {
		artifactName: `${scenario.artifactPrefix}-recall`,
		prompt: scenario.recallPrompt,
		sessionUuid: recallSession,
		userCuid,
	});

	expectTextIncludesAll(recallTurn.text, scenario.required);
	expectTextExcludesAll(recallTurn.text, scenario.forbidden ?? []);

	return { recallSession, recallTurn, teachSession };
}

export async function waitForScenarioMemory(
	config: TestConfig,
	artifactPrefix: string,
	query: string,
): Promise<void> {
	const memory = await waitForEvidence(
		() => readRemoteMemoryEvidence(config, query),
		(evidence) => evidence.count > 0,
		{
			label: `${artifactPrefix} memory evidence`,
			pollMs: 5_000,
			timeoutMs: numberEnv("SNO_AGENT_E2E_MEMORY_TIMEOUT_MS", 60_000),
		},
	);
	await writeJsonArtifact(config, `memory-evidence-${artifactPrefix}.json`, memory);
}

export async function sendGatewayScenarioTurn(
	config: TestConfig,
	options: {
		agentId?: string;
		artifactName: string;
		prompt: string;
		sessionUuid: string;
		userCuid: string;
	},
): Promise<GatewayTurn> {
	const request: JsonObject = {
		input: options.prompt,
		model: config.gatewayModel,
		stream: false,
		user: options.userCuid,
	};
	await writeJsonArtifact(
		config,
		`gateway-${options.artifactName}-request.json`,
		request,
	);
	const turn = await sendGatewayTurn(config, options.sessionUuid, request, {
		agentId: options.agentId,
	});
	await writeJsonArtifact(
		config,
		`gateway-${options.artifactName}-response.json`,
		turn.body,
	);
	expect(turn.text.length).toBeGreaterThan(0);
	return turn;
}

export function expectTextIncludesAll(
	text: string,
	required: readonly string[],
): void {
	for (const value of required) {
		expect(text).toContain(value);
	}
}

export function expectTextExcludesAll(
	text: string,
	forbidden: readonly string[],
): void {
	for (const value of forbidden) {
		expect(text).not.toContain(value);
	}
}

export function hasMemoryWriteAndReadEvidence(
	events: EventSummary[],
	writeSession: string,
	readSession: string,
): boolean {
	return (
		hasSessionEvent(events, writeSession, "memory.write") &&
		hasSessionEvent(
			events,
			readSession,
			"memory.read",
			(event) => (event.hitCount ?? 0) > 0,
		)
	);
}
