import { describe, test } from "vitest";
import { createUUIDv7 } from "../../../../packages/common-core/src/index.ts";
import { writeJsonArtifact } from "./helpers/artifacts";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import {
	expectActiveMemoryRow,
	expectSupersededMemoryRow,
	memoryRowId,
	memoryRowMetadata,
	memoryRowText,
} from "./helpers/memory-kind-assertions";
import {
	expectTextExcludesAll,
	expectTextIncludesAll,
	sendGatewayScenarioTurn,
	waitForScenarioMemory,
} from "./helpers/memory-quality";
import {
	cleanupRemoteMemoryFixtures,
	previewRemoteMemoryDeleteById,
	readRemoteMemoryEvidence,
} from "./helpers/remote-evidence";
import { loadAgentRun } from "./helpers/state";
import type { JsonObject } from "./helpers/types";
import { waitForEvidence } from "./helpers/wait";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 84 stale memory replaced", () => {
	test(
		"uses a corrected current value instead of a stale saved value",
		async () => {
			const { config, state } = await loadAgentRun();
			const oldEndpoint = `https://api.sno.ai/legacy-${state.runId}`;
			const newEndpoint = `https://www.sno.ai/api/live-${state.runId}`;
			const cleanupQueries = [oldEndpoint, newEndpoint];

			try {
				const oldSession = createUUIDv7();
				const newSession = createUUIDv7();
				const recallSession = createUUIDv7();

				await sendGatewayScenarioTurn(config, {
					artifactName: "stale-memory-old-teach",
					prompt: [
						`Please remember my current Sno Observe endpoint preference for run ${state.runId}.`,
						`The endpoint I prefer is ${oldEndpoint}.`,
						"Use it as the active endpoint until I correct it.",
					].join(" "),
					sessionUuid: oldSession,
					userCuid: state.userCuid,
				});
				await waitForScenarioMemory(config, "stale-memory-old", oldEndpoint);
				await sendGatewayScenarioTurn(config, {
					artifactName: "stale-memory-new-teach",
					prompt: [
						`Correction to my Sno Observe endpoint preference for run ${state.runId}: replace ${oldEndpoint}.`,
						`The endpoint I now prefer is ${newEndpoint}.`,
						"Use the new endpoint as active; the old endpoint is no longer correct.",
					].join(" "),
					sessionUuid: newSession,
					userCuid: state.userCuid,
				});
				const currentEvidence = await waitForEvidence(
					() => readRemoteMemoryEvidence(config, newEndpoint, { limit: 20 }),
					(evidence) => Boolean(findCurrentPreferenceRow(evidence.rows, newEndpoint)),
					{
						label: "stale-memory-current profile evidence",
						pollMs: 5_000,
						timeoutMs: 120_000,
					},
				);
				const currentRow = findCurrentPreferenceRow(currentEvidence.rows, newEndpoint);
				if (!currentRow) throw new Error(`missing current superseding row for ${newEndpoint}`);
				expectActiveMemoryRow(currentRow);
				const currentRowId = memoryRowId(currentRow);
				const oldEvidence = await readRemoteMemoryEvidence(config, oldEndpoint, {
					limit: 20,
				});
				const oldRow = oldEvidence.rows.find((row) => {
					if (row.category !== "profile" || !memoryRowText(row).includes(oldEndpoint)) {
						return false;
					}
					const metadata = memoryRowMetadata(row);
					const sectionName = metadata.section_name;
					return (
						typeof sectionName === "string" &&
						sectionName.trim().length > 0 &&
						metadata.superseded_by === currentRowId
					);
				});
				if (!oldRow) throw new Error(`missing old superseded row for ${oldEndpoint}`);
				expectSupersededMemoryRow(oldRow, { supersededBy: currentRowId });
				const deletePreview = await previewRemoteMemoryDeleteById(config, memoryRowId(oldRow));
				expectTextIncludesAll(deletePreview, ["Will delete:", "Deletion cancelled."]);
				const recall = await sendGatewayScenarioTurn(config, {
					artifactName: "stale-memory-recall",
					prompt: `Answer with only the current Sno Observe endpoint I should use for run ${state.runId}.`,
					sessionUuid: recallSession,
					userCuid: state.userCuid,
				});

				expectTextIncludesAll(recall.text, [newEndpoint]);
				expectTextExcludesAll(recall.text, [oldEndpoint]);
			} finally {
				const cleanup = await cleanupRemoteMemoryFixtures(config, {
					queries: cleanupQueries,
				});
				await writeJsonArtifact(config, "memory-cleanup-stale-memory-replaced.json", cleanup);
			}
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 360_000),
	);
});

function findCurrentPreferenceRow(rows: JsonObject[], endpoint: string): JsonObject | undefined {
	return rows.find((row) => {
		if (row.category !== "profile" || !memoryRowText(row).includes(endpoint)) {
			return false;
		}
		const sectionName = memoryRowMetadata(row).section_name;
		return typeof sectionName === "string" && sectionName.trim().length > 0;
	});
}
