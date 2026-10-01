import { describe, expect, test } from "vitest";
import { createUUIDv7 } from "../../../../packages/common-core/src/index.ts";
import { writeJsonArtifact } from "./helpers/artifacts";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import {
	expectTextExcludesAll,
	expectTextIncludesAll,
	sendGatewayScenarioTurn,
} from "./helpers/memory-quality";
import {
	cleanupRemoteMemoryFixtures,
	importRemoteMemoryFixture,
	readRemoteAuditEvidence,
	readRemoteMemoryEvidence,
	withRemoteFlock,
} from "./helpers/remote-evidence";
import { loadAgentRun } from "./helpers/state";
import { waitForEvidence } from "./helpers/wait";

assertLiveAgentE2EEnabled();

const fixtureNamespace = "PHASE83_REFLECTION_DEBUGGING_FIXTURE";
const fixtureLockName = "sno-phase83-reflection-debugging";
const fixtureToken = "P83FIX";

describe("Agent 1:1 phase 83 reflection debugging insight", () => {
	test("stale runbook assertion only allows explicit per-occurrence rejection", () => {
		const runbook = "KEYCHAIN-RUNBOOK-unit";
		const staleRunbook = "KEYCHAIN-RUNBOOK-STALE-unit";

		expect(() =>
			expectCurrentRunbookSelected(`Use ${runbook}.`, runbook, staleRunbook),
		).not.toThrow();
		expect(() =>
			expectStaleRunbookOnlyRejected(
				`I'm explicitly ignoring the stale conflicting memory that mentioned ${staleRunbook}.`,
				staleRunbook,
			),
		).not.toThrow();

		for (const text of [
			`Use ${staleRunbook}.`,
			`Do not ignore stale memory ${staleRunbook}.`,
			`I will not use outdated checks; use ${staleRunbook}.`,
			`Use ${staleRunbook} despite conflict.`,
			`Use ${staleRunbook}; it is not stale.`,
			`${staleRunbook} is the stale runbook to use.`,
			`Use ${runbook}. Also use ${staleRunbook}. I am ignoring stale conflicting memory that mentioned ${staleRunbook}.`,
		]) {
			expect(() => expectStaleRunbookOnlyRejected(text, staleRunbook)).toThrow();
		}
	});

	test(
		"recalls a saved debugging lesson for a repeated failure pattern",
		async () => {
			const { config, state } = await loadAgentRun();
			const project = `Phase83Runbook-${state.runId}`;
			const marker = `DEBUG-INSIGHT-${state.runId}`;
			const runbook = `KEYCHAIN-RUNBOOK-${state.runId}`;
			const staleMarker = `DEBUG-INSIGHT-STALE-${state.runId}`;
			const staleRunbook = `KEYCHAIN-RUNBOOK-STALE-${state.runId}`;
			const ownerNamespace = `${fixtureNamespace} run=${state.runId}`;
			const cleanupIds = new Set<string>();

			await withRemoteFlock(config, fixtureLockName, async () => {
				try {
					await cleanupRemoteMemoryFixtures(config, {
						ids: cleanupIds,
						queries: [fixtureNamespace],
					});

					const seeded = await importRemoteMemoryFixture(
						config,
						{
							category: "episodic",
							importance: 1,
							metadata: {
								e2ePhase: "83-reflection-debugging-insight",
								runId: state.runId,
							},
							scope: "agent:provider-native-memory",
							text: `${fixtureToken} ${fixtureNamespace} ${ownerNamespace}. Stale ${project} memories are outdated. ${project} encrypted database startup runbook: use ${staleRunbook}; first checks: keychain DEK fingerprint and dbs.json manifest entry. Store marker ${staleMarker}.`,
							timestamp: new Date(Date.now() - 60_000).toISOString(),
						},
						staleMarker,
					);
					cleanupIds.add(seeded.id);
					await writeJsonArtifact(config, "memory-seed-reflection-debugging-insight.json", seeded);

					const teachPrompt = `Remember ${project} runbook. Its stale memories are outdated. Check keychain DEK fingerprint and dbs.json first. Use ${runbook}. Marker ${marker}. Token ${fixtureToken}. Reply: saved.`;
					expect(teachPrompt.length).toBeLessThan(320);
					const teachStartedAt = new Date(Date.now() - 1_000).toISOString();
					const teachTurn = await sendGatewayScenarioTurn(config, {
						artifactName: "reflection-debugging-insight-teach",
						prompt: teachPrompt,
						sessionUuid: createUUIDv7(),
						userCuid: state.userCuid,
					});
					expect(teachTurn.text.length).toBeLessThan(120);
					expect(`user: ${teachPrompt}\n\nassistant: ${teachTurn.text}`.length).toBeLessThan(500);

					const teachAudit = await waitForEvidence(
						() => readRemoteAuditEvidence(config, { since: teachStartedAt }),
						(evidence) => evidence.recallTopResultIds.includes(seeded.id),
						{
							label: "reflection-debugging-insight stale fixture auto-recall",
							pollMs: 5_000,
							timeoutMs: numberEnv("SNO_AGENT_E2E_MEMORY_TIMEOUT_MS", 60_000),
						},
					);
					await writeJsonArtifact(
						config,
						"audit-reflection-debugging-insight-teach.json",
						teachAudit,
					);

					const currentMemory = await waitForEvidence(
						() => readRemoteMemoryEvidence(config, marker),
						(evidence) => evidence.count > 0,
						{
							label: "reflection-debugging-insight memory evidence",
							pollMs: 5_000,
							timeoutMs: numberEnv("SNO_AGENT_E2E_MEMORY_TIMEOUT_MS", 60_000),
						},
					);
					await writeJsonArtifact(
						config,
						"memory-evidence-reflection-debugging-insight.json",
						currentMemory,
					);
					for (const row of currentMemory.rows) {
						if (typeof row.id === "string") {
							cleanupIds.add(row.id);
						}
					}

					const recallTurn = await sendGatewayScenarioTurn(config, {
						artifactName: "reflection-debugging-insight-recall",
						prompt: `For my ${project} encrypted database startup runbook with marker ${marker}, what runbook and first checks should you use?`,
						sessionUuid: createUUIDv7(),
						userCuid: state.userCuid,
					});
					expectTextIncludesAll(recallTurn.text, [runbook, "dbs.json"]);
					expect(recallTurn.text.toLowerCase()).toContain("keychain");
					expectCurrentRunbookSelected(recallTurn.text, runbook, staleRunbook);
					expectStaleRunbookOnlyRejected(recallTurn.text, staleRunbook);
					expectTextExcludesAll(recallTurn.text, [staleMarker]);
				} finally {
					const cleanupQueries = [
						fixtureNamespace,
						fixtureToken,
						staleMarker,
						marker,
						project,
					];
					const cleanup = await cleanupRemoteMemoryFixtures(config, {
						ids: cleanupIds,
						queries: cleanupQueries,
					});
					await writeJsonArtifact(
						config,
						"memory-cleanup-reflection-debugging-insight.json",
						cleanup,
					);
					expect(cleanup.errors).toEqual([]);
					expect(cleanup.remaining).toEqual([]);
					for (const query of cleanupQueries) {
						const evidence = await readRemoteMemoryEvidence(config, query);
						expect(evidence.count).toBe(0);
					}
				}
			});
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});

function expectCurrentRunbookSelected(text: string, runbook: string, staleRunbook: string): void {
	const selectionLine =
		text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.find((line) => /\buse\b/i.test(line) && line.includes("KEYCHAIN-RUNBOOK")) ?? text;

	expect(selectionLine).toContain(runbook);
	expect(selectionLine).not.toContain(staleRunbook);
}

function expectStaleRunbookOnlyRejected(text: string, staleRunbook: string): void {
	const acceptedSpans = collectAcceptedStaleRunbookRejectionSpans(text, staleRunbook);
	let occurrenceStart = text.indexOf(staleRunbook);
	while (occurrenceStart >= 0) {
		const occurrenceEnd = occurrenceStart + staleRunbook.length;
		const isCovered = acceptedSpans.some(
			(span) => span.start <= occurrenceStart && span.end >= occurrenceEnd,
		);
		expect(isCovered).toBe(true);
		occurrenceStart = text.indexOf(staleRunbook, occurrenceEnd);
	}
}

function collectAcceptedStaleRunbookRejectionSpans(
	text: string,
	staleRunbook: string,
): Array<{ end: number; start: number }> {
	const escapedStaleRunbook = escapeRegExp(staleRunbook);
	const rejectionPatterns = [
		new RegExp(
			`\\b(?:explicitly\\s+)?(?:ignoring|ignored|rejecting|rejected|discarding|discarded|disregarding|disregarded|avoiding|avoided)\\b[\\s\\S]{0,180}${escapedStaleRunbook}`,
			"gi",
		),
		new RegExp(
			`\\b(?:do\\s+not\\s+use|don't\\s+use|should\\s+not\\s+use|must\\s+not\\s+use)\\b[\\s\\S]{0,120}${escapedStaleRunbook}`,
			"gi",
		),
		new RegExp(
			`${escapedStaleRunbook}[\\s\\S]{0,120}\\b(?:is\\s+ignored|was\\s+ignored|should\\s+be\\s+ignored|is\\s+rejected|was\\s+rejected|should\\s+not\\s+be\\s+used|must\\s+not\\s+be\\s+used)\\b`,
			"gi",
		),
	];

	const spans: Array<{ end: number; start: number }> = [];
	for (const pattern of rejectionPatterns) {
		for (const match of text.matchAll(pattern)) {
			if (typeof match.index === "number") {
				spans.push({ end: match.index + match[0].length, start: match.index });
			}
		}
	}
	return spans;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
