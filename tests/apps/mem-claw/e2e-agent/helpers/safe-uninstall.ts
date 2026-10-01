import { expect } from "vitest";
import {
	createCuid2,
	createUUIDv7,
} from "../../../../../packages/common-core/src/index.ts";
import { writeJsonArtifact } from "./artifacts";
import { numberEnv } from "./config";
import { sendGatewayScenarioTurn } from "./memory-quality";
import type { GatewayTurn, TestConfig } from "./types";
import { sleep } from "./wait";

export type SafeUninstallFacts = {
	marker: string;
	recallPrompt: string;
	required: readonly string[];
	teachPrompt: string;
	userCuid: string;
};

export function createSafeUninstallFacts(scenario: string): SafeUninstallFacts {
	const marker = `SAFE-UNINSTALL-${scenario.toUpperCase()}-${createUUIDv7().slice(0, 8)}`;
	const required = [marker.toLowerCase(), "larry", "tab", "postgres"] as const;
	return {
		marker,
		recallPrompt:
			`For safe-uninstall marker ${marker}, start your answer with ${marker} and answer only from memory: ` +
			"what is my name, what indentation style do I prefer, and which database did I choose?",
		required,
		teachPrompt:
			`Please remember these three long-term memory facts for marker ${marker}: ` +
			"(1) my name is Larry; " +
			"(2) my preferred code indentation is tabs, never spaces; " +
			"(3) I chose PostgreSQL over MongoDB for my Sno project because JSONB helps. " +
			`Confirm by repeating ${marker}.`,
		userCuid: createCuid2(),
	};
}

export async function teachSafeUninstallFacts(
	config: TestConfig,
	scenario: string,
): Promise<SafeUninstallFacts> {
	const facts = createSafeUninstallFacts(scenario);
	const response = await sendGatewayScenarioTurn(config, {
		artifactName: `${scenario}-safe-uninstall-teach`,
		prompt: facts.teachPrompt,
		sessionUuid: createUUIDv7(),
		userCuid: facts.userCuid,
	});
	await writeJsonArtifact(
		config,
		`${scenario}-safe-uninstall-facts.json`,
		facts,
	);
	expect(response.text.length).toBeGreaterThan(0);
	await sleep(numberEnv("SNO_SAFE_UNINSTALL_CAPTURE_WAIT_MS", 12_000));
	return facts;
}

export async function recallSafeUninstallFacts(
	config: TestConfig,
	scenario: string,
	facts: SafeUninstallFacts,
): Promise<GatewayTurn> {
	const response = await sendGatewayScenarioTurn(config, {
		artifactName: `${scenario}-safe-uninstall-recall`,
		prompt: facts.recallPrompt,
		sessionUuid: createUUIDv7(),
		userCuid: facts.userCuid,
	});
	const normalized = response.text.toLowerCase();
	for (const required of facts.required) {
		expect(normalized).toContain(required);
	}
	return response;
}

export async function teachAndRecallSafeUninstallFacts(
	config: TestConfig,
	scenario: string,
): Promise<SafeUninstallFacts> {
	const facts = await teachSafeUninstallFacts(config, scenario);
	await recallSafeUninstallFacts(config, scenario, facts);
	return facts;
}
