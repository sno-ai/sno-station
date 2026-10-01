import { gatewayRestartScript } from "./helpers/vm-ops";
import { describe, expect, test } from "vitest";
import { createUUIDv7 } from "../../../../packages/common-core/src/index.ts";
import { writeArtifact, writeJsonArtifact } from "./helpers/artifacts";
import { runRequiredCommand, shellWord } from "./helpers/command";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import { requestJson } from "./helpers/http";
import { expectTextIncludesAll, sendGatewayScenarioTurn } from "./helpers/memory-quality";
import { multilingualRecallPrompt } from "./helpers/prompts";
import {
	cleanupRemoteMemoryFixtures,
	importRemoteMemoryFixture,
	withRemoteFlock,
} from "./helpers/remote-evidence";
import { loadAgentRun, saveAgentRunState } from "./helpers/state";
import { waitForEvidence } from "./helpers/wait";

assertLiveAgentE2EEnabled();

const fixtureNamespace = "PHASE63_MULTILINGUAL_RESTART_FIXTURE";
const fixtureLockName = "sno-phase63-multilingual-restart";

function requireString(value: string | undefined, label: string): string {
	if (value === undefined) throw new Error(`missing ${label}`);
	return value;
}

describe("Agent 1:1 phase 63 multilingual restart recall", () => {
	test(
		"recalls a Spanish memory after a real Gateway restart",
		async () => {
			const { config, state } = await loadAgentRun();
			state.multilingualNonce ??= createUUIDv7();
			state.multilingualMarker ??= `alondra-${state.multilingualNonce.slice(0, 8)}`;
			state.multilingualFact = `proyecto ${state.multilingualMarker}; codigo ${state.multilingualNonce}; ciudad favorita: Sevilla`;
			state.multilingualTeachSession ??= createUUIDv7();
			state.multilingualRecallSession ??= createUUIDv7();
			await saveAgentRunState(state);
			const multilingualNonce = requireString(state.multilingualNonce, "multilingual nonce");
			const multilingualMarker = requireString(state.multilingualMarker, "multilingual marker");
			const multilingualRecallSession = requireString(
				state.multilingualRecallSession,
				"multilingual recall session",
			);
			const cleanupIds = new Set<string>();

			await withRemoteFlock(config, fixtureLockName, async () => {
				try {
					await cleanupRemoteMemoryFixtures(config, {
						ids: cleanupIds,
						queries: [
							fixtureNamespace,
							multilingualNonce,
							multilingualMarker,
						],
					});
					const seeded = await importRemoteMemoryFixture(
						config,
						{
							category: "episodic",
							importance: 1,
							metadata: {
								e2ePhase: "63-multilingual-restart-recall",
								runId: state.runId,
							},
							scope: "agent:provider-native-memory",
							text: `${fixtureNamespace}. ${state.multilingualFact}.`,
							timestamp: new Date().toISOString(),
						},
						multilingualNonce,
					);
					expect(seeded.evidence.count).toBeGreaterThan(0);
					cleanupIds.add(seeded.id);
					await writeJsonArtifact(config, "memory-seed-multilingual-restart.json", seeded);

					const unit = `openclaw-gateway-${shellWord(config.openClawProfile)}.service`;
					const restart = await runRequiredCommand(
						"ssh",
						[config.openClawVm, gatewayRestartScript(unit)],
						{ timeoutMs: 60_000 },
					);
					await writeArtifact(
						config,
						"gateway-multilingual-restart.log",
						restart.stdout + restart.stderr,
					);

					await waitForEvidence(
						async () => {
							try {
								return (
									await requestJson(`${config.gatewayUrl}/health`, {
										headers: { Authorization: `Bearer ${config.openClawToken}` },
										rejectUnauthorized: config.rejectUnauthorized,
										timeoutMs: 5_000,
									})
								).statusCode;
							} catch {
								return 0;
							}
						},
						(statusCode) => statusCode === 200,
						{
							label: "Gateway health after multilingual restart",
							pollMs: 2_000,
							timeoutMs: 60_000,
						},
					);

					const recallTurn = await sendGatewayScenarioTurn(config, {
						artifactName: "multilingual-recall",
						prompt: multilingualRecallPrompt(multilingualMarker),
						sessionUuid: multilingualRecallSession,
						userCuid: state.userCuid,
					});
					expectTextIncludesAll(recallTurn.text, [multilingualNonce, "Sevilla"]);
				} finally {
					const cleanup = await cleanupRemoteMemoryFixtures(config, {
						ids: cleanupIds,
						queries: [
							fixtureNamespace,
							multilingualNonce,
							multilingualMarker,
						],
					});
					await writeJsonArtifact(config, "memory-cleanup-multilingual-restart.json", cleanup);
				}
			});
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});
