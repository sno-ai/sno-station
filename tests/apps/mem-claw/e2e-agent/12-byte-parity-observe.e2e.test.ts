import { describe, expect, test } from "vitest";
import { writeJsonArtifact } from "./helpers/artifacts";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import {
	observeRedactedTextHash,
	sessionEvents,
} from "./helpers/observe-evidence";
import { waitForObserveSummaries } from "./helpers/observe-phase";
import { readRemoteMemoryRowsByScope } from "./helpers/remote-evidence";
import { loadAgentRun } from "./helpers/state";
import type { EventSummary, JsonObject, TestConfig } from "./helpers/types";

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 12 byte parity", () => {
	test(
		"proves memory.write byte_len matches the SQLite row bytes",
		async () => {
			const { config, state } = await loadAgentRun();
			const teachSessions = candidateSessions(
				state.teachPromptObserveSession,
				state.teachObserveSession,
				state.teachSession,
			);
			const summaries = await waitForObserveSummaries(config, state, {
				artifactName: "observe-byte-parity",
				label: "Sno memory.write byte_len with envelope project scope",
				matches: (events) =>
					candidateMemoryWrites(events, teachSessions).length > 0,
				sessionUuids: new Set(teachSessions),
			});
			const writes = candidateMemoryWrites(summaries, teachSessions);
			const matchedPairs = await matchWritesToMemoryRows(
				config,
				writes,
				state.startedAt,
			);
			await writeJsonArtifact(config, "memory-byte-parity-row.json", {
				matchedPairs,
				runStartedAt: state.startedAt,
			});

			expect(writes.length).toBeGreaterThan(0);
			expect(matchedPairs.length).toBeGreaterThan(0);
			for (const { event, row } of matchedPairs) {
				expect(memoryRowByteLength(row)).toBe(event.byteLen);
			}
			expect(writes.every((summary) => summary.tokensMethod !== "bpe")).toBe(
				true,
			);
			expect(writes.every((summary) => summary.tokensMethod !== "fast")).toBe(
				true,
			);
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 300_000),
	);
});

type MemoryWriteSummary = EventSummary & {
	byteLen: number;
	keyHash: string;
	scopeProjectId: string;
	tokensMethod: string;
};

type MatchedMemoryWrite = {
	event: MemoryWriteSummary;
	row: JsonObject;
};

function memoryRowByteLength(row: JsonObject): number {
	if (typeof row.text_bytes === "number") {
		return row.text_bytes;
	}
	if (typeof row.text === "string") {
		return Buffer.byteLength(row.text, "utf8");
	}
	throw new Error("SQLite memory row did not expose text bytes");
}

function candidateSessions(...values: (string | undefined)[]): string[] {
	return [
		...new Set(values.filter((value): value is string => value !== undefined)),
	];
}

function candidateMemoryWrites(
	summaries: EventSummary[],
	sessionUuids: string[],
): MemoryWriteSummary[] {
	return sessionUuids
		.flatMap((sessionUuid) =>
			sessionEvents(summaries, sessionUuid, "memory.write"),
		)
		.filter(isCompleteMemoryWriteSummary);
}

function isCompleteMemoryWriteSummary(
	summary: EventSummary,
): summary is MemoryWriteSummary {
	return (
		typeof summary.byteLen === "number" &&
		typeof summary.keyHash === "string" &&
		typeof summary.scopeProjectId === "string" &&
		typeof summary.tokensMethod === "string"
	);
}

async function matchWritesToMemoryRows(
	config: TestConfig,
	writes: MemoryWriteSummary[],
	since: string,
): Promise<MatchedMemoryWrite[]> {
	const rowsByScope = new Map<string, JsonObject[]>();
	const matched: MatchedMemoryWrite[] = [];
	for (const event of writes) {
		const rows =
			rowsByScope.get(event.scopeProjectId) ??
			(
				await readRemoteMemoryRowsByScope(config, event.scopeProjectId, {
					since,
				})
			).rows;
		rowsByScope.set(event.scopeProjectId, rows);
		const row = rows.find(
			(candidate) => memoryRowContentKeyHash(candidate) === event.keyHash,
		);
		if (row) {
			matched.push({ event, row });
		}
	}
	return matched;
}

function memoryRowContentKeyHash(row: JsonObject): string | undefined {
	if (typeof row.content_hash !== "string") {
		return undefined;
	}
	return observeRedactedTextHash(row.content_hash);
}
