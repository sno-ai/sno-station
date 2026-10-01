import { describe, expect, test } from "vitest";
import { readSnoStationCoreWorkspaceVersion } from "../../../../packages/memory/src/engine/observability/version-metadata.ts";
import { writeJsonArtifact } from "./helpers/artifacts";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import { verifyAuditEvent } from "./helpers/observe-api";
import { hasAuditProofForEvent } from "./helpers/observe-audit-proof";
import {
	hasAgentIdentifyVersionMetadata,
	hasExpectedRunEvents,
	hasSeparatedTokenEvidence,
} from "./helpers/observe-evidence";
import { waitForObserveSummaries } from "./helpers/observe-phase";
import { readRemoteSnoIdentity } from "./helpers/remote-evidence";
import { loadAgentRun } from "./helpers/state";
import type {
	EventSummary,
	ExpectedEventType,
	TestConfig,
} from "./helpers/types";
import { sleep } from "./helpers/wait";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 31 finalize observe", () => {
	test(
		"proves final session events and audit verification through Sno API",
		async () => {
			const { config, state } = await loadAgentRun();
			const teachPromptSession =
				state.teachPromptObserveSession ??
				state.teachObserveSession ??
				state.teachSession;
			const teachWriteSession = state.teachObserveSession ?? state.teachSession;
			const qaSession = state.qaObserveSession ?? state.qaSession;
			const summaries = await waitForObserveSummaries(config, state, {
				artifactName: "observe-finalize",
				label: "Sno activity for completed Agent 1:1 run",
				matches: (events) =>
					hasExpectedRunEvents(
						events,
						teachPromptSession,
						qaSession,
						teachWriteSession,
					),
				sessionUuids: new Set([teachPromptSession, teachWriteSession, qaSession]),
			});
			expect(
				hasExpectedRunEvents(
					summaries,
					teachPromptSession,
					qaSession,
					teachWriteSession,
				),
			).toBe(true);
			const expectedVersion = readSnoStationCoreWorkspaceVersion();
			expect(expectedVersion).toBeDefined();
			expect(hasAgentIdentifyVersionMetadata(summaries, expectedVersion)).toBe(
				true,
			);
			expect(state.teachGatewayUsage).toBeDefined();
			expect(state.qaGatewayUsage).toBeDefined();
			expect(
				hasSeparatedTokenEvidence(summaries, teachPromptSession, qaSession, {
					qa: state.qaGatewayUsage,
					teach: state.teachGatewayUsage,
				}),
			).toBe(true);

			const identity = await readRemoteSnoIdentity(config);
			const verifyTargets = [
				findSessionEvent(summaries, teachWriteSession, "memory.write"),
				findSessionEvent(summaries, qaSession, "session.end"),
			];
			expect(verifyTargets.every(Boolean)).toBe(true);
			const verifyResults: AuditVerifyEvidence[] = [];
			for (const target of verifyTargets) {
				if (!target) {
					continue;
				}
				await waitForAuditProof(
					config,
					identity.machine_secret,
					target,
					verifyResults,
				);
			}
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});

type AuditVerifyEvidence = {
	body: unknown;
	eventId: string;
	eventType: ExpectedEventType;
	statusCode: number;
};

async function waitForAuditProof(
	config: TestConfig,
	machineSecret: string,
	target: EventSummary,
	verifyResults: AuditVerifyEvidence[],
): Promise<void> {
	const deadline = Date.now() + config.observeTimeoutMs;
	let lastStatusCode = 0;
	let lastText = "";

	while (Date.now() < deadline) {
		const result = await verifyAuditEvent(
			config,
			machineSecret,
			target.eventId,
		);
		lastStatusCode = result.statusCode;
		lastText = result.text;
		verifyResults.push({
			body: result.body,
			eventId: target.eventId,
			eventType: target.eventType,
			statusCode: result.statusCode,
		});
		await writeJsonArtifact(config, "audit-verify.json", verifyResults);

		if (
			result.statusCode === 200 &&
			hasAuditProofForEvent(result.body, target.eventId)
		) {
			return;
		}
		if (result.statusCode !== 404 && result.statusCode < 500) {
			throw new Error(
				`Sno audit verify failed for ${target.eventType} ${target.eventId} with HTTP ${result.statusCode}: ${result.text}`,
			);
		}

		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			break;
		}
		await sleep(Math.min(config.observePollMs, remainingMs));
	}

	throw new Error(
		`Timed out waiting for Sno audit proof for ${target.eventType} ${target.eventId}; last HTTP ${lastStatusCode}: ${lastText}`,
	);
}

function findSessionEvent(
	summaries: EventSummary[],
	sessionUuid: string,
	eventType: ExpectedEventType,
): EventSummary | undefined {
	return summaries.find(
		(summary) =>
			summary.scopeSessionUuid === sessionUuid &&
			summary.eventType === eventType,
	);
}
