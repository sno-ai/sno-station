import { describe, expect, test } from "vitest";
import { createCuid2, createUUIDv7 } from "../../../../packages/common-core/src/index.ts";
import { writeJsonArtifact } from "./helpers/artifacts";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import { expectTextIncludesAll, sendGatewayScenarioTurn } from "./helpers/memory-quality";
import {
	cleanupRemoteMemoryFixtures,
	importRemoteMemoryFixture,
	withRemoteFlock,
} from "./helpers/remote-evidence";
import { loadAgentRun } from "./helpers/state";

assertLiveAgentE2EEnabled();

const fixtureNamespace = "PHASE86_PROFILE_SCOPE_FIXTURE";
const fixtureLockName = "sno-phase86-profile-memory-scope";

describe("Agent 1:1 phase 86 profile memory scope", () => {
	test(
		"keeps memory scoped to the OpenClaw profile, not the OpenResponses user routing key",
		async () => {
			const { config, state } = await loadAgentRun();
			const marker = `PROFILE-SCOPE-${createUUIDv7()}`;
			const project = `ProfileHarbor-${state.runId}`;
			const alternateRouteUserCuid = createCuid2();
			const recallSession = createUUIDv7();
			const cleanupIds = new Set<string>();

			await withRemoteFlock(config, fixtureLockName, async () => {
				try {
					await cleanupRemoteMemoryFixtures(config, {
						ids: cleanupIds,
						queries: [fixtureNamespace, marker, project],
					});
					const seeded = await importRemoteMemoryFixture(
						config,
						{
							category: "episodic",
							importance: 1,
							metadata: {
								e2ePhase: "86-profile-memory-scope",
								runId: state.runId,
							},
							scope: "agent:provider-native-memory",
							text: `${fixtureNamespace} OpenClaw profile detail for ${project}: marker ${marker}. This profile memory belongs to the OpenClaw profile, not an OpenResponses user routing key.`,
							timestamp: new Date().toISOString(),
						},
						marker,
					);
					expect(seeded.evidence.count).toBeGreaterThan(0);
					cleanupIds.add(seeded.id);
					await writeJsonArtifact(config, "memory-seed-profile-memory-scope.json", seeded);

					const recall = await sendGatewayScenarioTurn(config, {
						artifactName: "profile-memory-scope-recall",
						prompt: `What OpenClaw profile marker do you remember for ${project}?`,
						sessionUuid: recallSession,
						userCuid: alternateRouteUserCuid,
					});

					expectTextIncludesAll(recall.text, [marker]);
				} finally {
					const cleanup = await cleanupRemoteMemoryFixtures(config, {
						ids: cleanupIds,
						queries: [fixtureNamespace, marker, project],
					});
					await writeJsonArtifact(config, "memory-cleanup-profile-memory-scope.json", cleanup);
				}
			});
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});
