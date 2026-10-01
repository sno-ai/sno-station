import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import { isRecord, parseJson } from "./helpers/json";
import {
	hasExpectedRunEvents,
	sessionEvents,
} from "./helpers/observe-evidence";
import { waitForObserveSummaries } from "./helpers/observe-phase";
import { loadAgentRun } from "./helpers/state";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 90 audit activity parity", () => {
	test(
		"proves local audit and Sno activity agree on write/read presence",
		async () => {
			const { config, state } = await loadAgentRun();
			const teachPromptSession =
				state.teachPromptObserveSession ??
				state.teachObserveSession ??
				state.teachSession;
			const teachWriteSession = state.teachObserveSession ?? state.teachSession;
			const qaSession = state.qaObserveSession ?? state.qaSession;
			const summaries = await waitForObserveSummaries(config, state, {
				artifactName: "observe-audit-parity",
				label: "Sno activity for baseline write/read run",
				matches: (events) =>
					hasExpectedRunEvents(
						events,
						teachPromptSession,
						qaSession,
						teachWriteSession,
					),
				sessionUuids: new Set([teachPromptSession, teachWriteSession, qaSession]),
			});
			const teachAudit = await readAuditArtifact(
				config.artifactDir,
				"audit-evidence-after-teach.json",
			);
			const recallAudit = await readAuditArtifact(
				config.artifactDir,
				"audit-evidence-after-recall.json",
			);

			const remoteWriteKeyHashes = new Set(
				sessionEvents(summaries, teachWriteSession, "memory.write")
					.map((event) => event.keyHash)
					.filter((keyHash): keyHash is string => keyHash !== undefined),
			);
			const remoteReads = sessionEvents(
				summaries,
				qaSession,
				"memory.read",
			).filter((event) => (event.hitCount ?? 0) > 0);

			expect(remoteWriteKeyHashes.size).toBeGreaterThan(0);
			expect(teachAudit.ambientLearningCount).toBeGreaterThan(0);
			expect(remoteReads.length).toBeGreaterThan(0);
			expect(recallAudit.autoRecallCount).toBeGreaterThan(0);
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});

async function readAuditArtifact(
	artifactDir: string,
	name: string,
): Promise<{
	ambientLearningCount: number;
	autoRecallCount: number;
	captureKeyHashes: string[];
}> {
	const parsed = parseJson(await readFile(join(artifactDir, name), "utf8"));
	if (!isRecord(parsed)) {
		throw new Error(`Invalid audit artifact: ${name}`);
	}
	return {
		ambientLearningCount:
			typeof parsed.ambientLearningCount === "number"
				? parsed.ambientLearningCount
				: 0,
		autoRecallCount:
			typeof parsed.autoRecallCount === "number" ? parsed.autoRecallCount : 0,
		captureKeyHashes: stringArray(parsed.captureKeyHashes),
	};
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}
