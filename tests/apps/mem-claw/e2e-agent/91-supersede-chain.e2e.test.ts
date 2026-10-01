import { describe, expect, test } from "vitest";
import { createUUIDv7 } from "../../../../packages/common-core/src/index.ts";
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
	previewRemoteMemoryDeleteById,
	readRemoteMemoryEvidence,
} from "./helpers/remote-evidence";
import { loadAgentRun } from "./helpers/state";
import type { JsonObject } from "./helpers/types";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 91 supersede chain", () => {
	test(
		"keeps superseded originals recoverable while recall returns only the latest fact",
		async () => {
			const { config, state } = await loadAgentRun();
			const runMarker = state.runId.replace(/\D/g, "").slice(-8);
			const topicSlug = `phase91route${runMarker}`;
			const original = `alpha${runMarker}`;
			const middle = `bravo${runMarker}`;
			const latest = `charlie${runMarker}`;

			await sendGatewayScenarioTurn(config, {
				artifactName: "supersede-chain-original",
				prompt: [
					"Remember this as current profile information.",
					`Profile preference topic: ${topicSlug}.`,
					`The current value for this exact topic is ${original}.`,
					"This exact topic has exactly one current value.",
				].join(" "),
				sessionUuid: createUUIDv7(),
				userCuid: state.userCuid,
			});
			await waitForScenarioMemory(config, "supersede-chain-original", original);

			await sendGatewayScenarioTurn(config, {
				artifactName: "supersede-chain-middle",
				prompt: [
					"Remember this as current profile information.",
					`Profile preference topic: ${topicSlug}.`,
					`The current value for this exact same topic is ${middle}.`,
					"It replaces the prior value for this exact same topic.",
				].join(" "),
				sessionUuid: createUUIDv7(),
				userCuid: state.userCuid,
			});
			await waitForScenarioMemory(config, "supersede-chain-middle", middle);

			await sendGatewayScenarioTurn(config, {
				artifactName: "supersede-chain-latest",
				prompt: [
					"Remember this as current profile information.",
					`Profile preference topic: ${topicSlug}.`,
					`The current value for this exact same topic is ${latest}.`,
					"It replaces the prior value for this exact same topic.",
				].join(" "),
				sessionUuid: createUUIDv7(),
				userCuid: state.userCuid,
			});
			await waitForScenarioMemory(config, "supersede-chain-latest", latest);

			const evidence = await readRemoteMemoryEvidence(config, "", {
				limit: 50,
			});
			const latestRow = evidence.rows.find(
				(row) =>
					row.category === "profile" &&
					memoryRowText(row).includes(latest) &&
					memoryRowMetadata(row).invalidated_at === undefined,
			);
			if (!latestRow) throw new Error(`missing latest supersede row for ${topicSlug}`);

			const latestRowId = memoryRowId(latestRow);
			// The atomic write path records a replacement on the retired row only (superseded_by).
			const middleRow = evidence.rows.find(
				(row) => memoryMetadataString(row, "superseded_by") === latestRowId,
			);
			if (!middleRow) throw new Error(`missing middle supersede row for ${topicSlug}`);
			const middleRowId = memoryRowId(middleRow);
			const originalRow = evidence.rows.find(
				(row) => memoryMetadataString(row, "superseded_by") === middleRowId,
			);
			if (!originalRow) throw new Error(`missing original supersede row for ${topicSlug}`);

			expectTextIncludesAll(memoryRowText(originalRow), [original]);
			expectTextIncludesAll(memoryRowText(middleRow), [middle]);
			expectTextIncludesAll(memoryRowText(latestRow), [latest]);
			expectSupersededMemoryRow(originalRow, { supersededBy: middleRowId });
			expectSupersededMemoryRow(middleRow, { supersededBy: latestRowId });
			expectActiveMemoryRow(latestRow);

			const getByIdPreview = await previewRemoteMemoryDeleteById(
				config,
				memoryRowId(originalRow),
			);
			expectTextIncludesAll(getByIdPreview, [original, "Deletion cancelled."]);

			const recall = await sendGatewayScenarioTurn(config, {
				artifactName: "supersede-chain-recall",
				prompt: `Answer with only the current value for exact profile preference topic ${topicSlug}.`,
				sessionUuid: createUUIDv7(),
				userCuid: state.userCuid,
			});
			expectTextIncludesAll(recall.text, [latest]);
			expectTextExcludesAll(recall.text, [original, middle]);
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 360_000),
	);
});

function memoryMetadataString(row: JsonObject, key: string): string | undefined {
	const value = memoryRowMetadata(row)[key];
	return typeof value === "string" ? value : undefined;
}
