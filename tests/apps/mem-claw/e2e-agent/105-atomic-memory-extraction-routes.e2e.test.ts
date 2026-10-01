import { readTestModelCalls, readTestSnoGpuSettings } from "../helpers/settings.ts";
/** @file Proves the atomic extraction entrypoint reaches both signed Sno GPU routes. */

import { channel } from "node:diagnostics_channel";
import { createHash } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	createSignedAtomicMemoryExtractionTransports,
	runAtomicMemoryExtraction,
} from "../../../../packages/memory/src/engine/extraction/atomic-memory-extraction.ts";
import type { AtomicExtractionTurn } from "../../../../packages/memory/src/engine/extraction/atomic-extraction-reply.ts";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import type {
	LlmClientConfig,
	ProviderResponseTrace,
} from "../../../../packages/memory/src/model/llm-client-types.ts";
import { llmRoutingConfigSchema } from "../../../../packages/memory/config/plugin-config-mode-schema.ts";
import { ATOMIC_MEMORY_VALID_INTERVAL_CHECK_SQL } from "../../../../packages/memory/src/store/atomic-memory-cutover-sql.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db.ts";
import { assertLiveAgentE2EEnabled } from "./helpers/config.ts";

assertLiveAgentE2EEnabled();

const PROJECT_ID_PREFIX = "atomic-live-routes";
const EXTRACTOR_VERSION = "atomic-v3-live-routes";
const EVENT_FROM_MS = Date.UTC(2026, 8, 2, 20, 15);
const SESSION_TIME_MS = Date.UTC(2026, 8, 10, 8, 44, 19);
type TransportAttempt = Parameters<NonNullable<LlmClientConfig["onTransportAttempt"]>>[0];

interface StoredAtomicRow {
	id: string;
	text: string;
	category: string;
	projectId: string;
	subject: string | null;
	attribute: string | null;
	validFrom: number | null;
	validUntil: number | null;
	lane: string;
	dispositionReason: string | null;
}

function assertProjectWall(rows: readonly StoredAtomicRow[], projectId: string): void {
	for (const row of rows) {
		if (row.projectId !== projectId) {
			throw new Error(`project wall failed: expected ${projectId}, got ${row.projectId}`);
		}
	}
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("atomic extraction signed Sno GPU routes", () => {
	let fixture: TestDb | undefined;
	let store: MemoryStore | undefined;
	let restoreFetch: (() => void) | undefined;
	const profileTurns = channel("sno-station-mem.profile-turns");
	const turnEvents: unknown[] = [];
	const genericCompletions: unknown[] = [];
	const genericPromptHashes: string[] = [];
	let observedRecords: unknown;
	const recordTurns = (message: unknown): void => { turnEvents.push(message); };

	afterEach(() => {
		profileTurns.unsubscribe(recordTurns);
		process.stdout.write(`ZEBRA_PROFILE_TURN_DIAGNOSTICS ${JSON.stringify({ turnEvents, genericPromptHashes, genericCompletions, records: observedRecords })}\n`);
		restoreFetch?.();
		restoreFetch = undefined;
		store?.closeSync();
		fixture?.cleanup();
		store = undefined;
		fixture = undefined;
	});

	it(
		"runs journey 1 through both signed routes and an encrypted store",
		{ timeout: 300_000 },
		async () => {
			turnEvents.length = 0;
			genericCompletions.length = 0;
			genericPromptHashes.length = 0;
		observedRecords = undefined;
		profileTurns.subscribe(recordTurns);
			const attempts: TransportAttempt[] = [];
			const pendingAttempts: TransportAttempt[] = [];
			const responses: ProviderResponseTrace[] = [];
			const requestUrls: string[] = [];
			const providerRequests: Array<{
				attempt: TransportAttempt;
				url: string;
				body: Record<string, unknown>;
			}> = [];
			const realFetch = globalThis.fetch;
			globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url =
					typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				requestUrls.push(url);
				const bodyText =
					typeof init?.body === "string"
						? init.body
						: input instanceof Request
							? await input.clone().text()
							: undefined;
				if (bodyText && url.includes("/extract/")) {
					let body: Record<string, unknown> | undefined;
					try {
						body = JSON.parse(bodyText) as Record<string, unknown>;
					} catch {
						// Registry and provider requests without JSON bodies are outside this assertion.
					}
					if (body) {
						const attempt = pendingAttempts.shift();
						if (!attempt) throw new Error(`provider request had no transport attempt: ${url}`);
						providerRequests.push({ attempt, url, body });
					}
				}
				return realFetch(input, init);
			}) as typeof globalThis.fetch;
			restoreFetch = () => {
				globalThis.fetch = realFetch;
			};

			const projectId = `${PROJECT_ID_PREFIX}-${Date.now()}`;
			const turns: AtomicExtractionTurn[] = [
				{
					role: "user",
					content: "My stable personal preference is jasmine tea.",
				},
				{
					role: "user",
					content:
						"At exactly 20:15 UTC on September 2, 2026, I switched my primary editor from Vim to Emacs.",
				},
				{
					role: "user",
					content: "Ada Lovelace is a mathematician.",
				},
				{
					role: "user",
					content: "I prefer curry and jazz.",
				},
				{
					role: "user",
					content: "I am halfway through writing the release notes.",
				},
			];
			const targetFixture = createTestDb();
			fixture = targetFixture;
			const targetStore = new MemoryStore({ dbPath: targetFixture.dbPath, embedder });
			store = targetStore;
			const transports = createSignedAtomicMemoryExtractionTransports({
				preset: "mem_claw/sno_ai_extract",
				apiKey: readTestSnoGpuSettings().apiKey,
				routing: llmRoutingConfigSchema.parse({ mode: "rem-enhanced", modelCalls: readTestModelCalls() }),
				timeoutMs: 120_000,
				onTransportAttempt: (attempt) => {
					attempts.push(attempt);
					pendingAttempts.push(attempt);
				},
				onProviderResponse: (response) => responses.push(response),
			});
			const completeGeneric = transports.generic.complete.bind(transports.generic);
			transports.generic.complete = async (request) => {
				genericPromptHashes.push(createHash("sha256").update(request.prompt).digest("hex"));
				const completion = await completeGeneric(request);
				genericCompletions.push(completion);
				return completion;
			};
			let nowMs = SESSION_TIME_MS;

			const result = await runAtomicMemoryExtraction({
				store: targetStore,
				projectId,
				ledgerKey: {
					conversationId: `${projectId}-conversation`,
					chunkHash: `${projectId}-chunk`,
					pipelineVersion: EXTRACTOR_VERSION,
				},
				turns,
				rawChunk: turns.map(({ role, content }) => `${role}: ${content}`).join("\n"),
				routingSnapshotId: `${projectId}-routing`,
				runParameters: {
					maxInputTokens: 4_096,
					outputTokenBudget: 4_096,
					subchunkCount: 1,
				},
				estimatedInputTokens: 110,
				extractorVersion: EXTRACTOR_VERSION,
				sessionDateTime: new Date(SESSION_TIME_MS).toISOString(),
				sessionTimestampMs: SESSION_TIME_MS,
				sessionTimezone: "UTC",
				transports,
				nowMs: () => nowMs++,
				requestId: `${projectId}-request`,
			});
			if (result.status !== "complete") {
				throw new Error(`atomic live-route extraction ended as ${result.status}`);
			}

			observedRecords = result.records;
			expect(result.records.length).toBeGreaterThan(0);
			expect(result.write.createdCount).toBeGreaterThan(0);
			expect(result.write.ledger.state).toBe("complete");
			const attemptCallIds = new Set(attempts.map(({ callId }) => callId));
			expect(attemptCallIds).toContain("E1");
			expect(attemptCallIds).toContain("E9");
			expect(attemptCallIds).toContain("E6");
			const responseCallIds = new Set(responses.map(({ callId }) => callId));
			expect(responseCallIds).toContain("E1");
			expect(responseCallIds).toContain("E9");
			expect(responseCallIds).toContain("E6");
			for (const response of responses) {
				expect(response.provider).toBe("sno-gpu");
				expect(response.model).not.toBe("");
			}

			expect(pendingAttempts).toEqual([]);
			expect(providerRequests).toHaveLength(attempts.length);
			const profileRequests = providerRequests.filter(
				({ attempt }) => attempt.callId === "E9",
			);
			expect(profileRequests).toHaveLength(
				attempts.filter(({ callId }) => callId === "E9").length,
			);
			expect(
				profileRequests.every(
					({ attempt, url }) =>
						attempt.transport === "raw-completions" && url.includes("/extract/profile/"),
				),
			).toBe(true);
			for (const callId of ["E1", "E6"]) {
				const matching = providerRequests.filter(({ attempt }) => attempt.callId === callId);
				expect(matching.length).toBeGreaterThan(0);
				expect(
					matching.every(
						({ attempt, url }) =>
							attempt.transport === "chat-completions" &&
							url.includes("/extract/v1/chat/completions"),
					),
				).toBe(true);
			}
			for (const { body } of providerRequests) {
				expect(body.temperature).not.toBe(0);
			}

			expect(result.write.cardIds.length).toBeGreaterThan(0);
			expect(result.write.suppressed).toEqual([]);
			expect(result.write.cardIds).toHaveLength(result.write.createdCount);
			const stored = result.write.cardIds.map((id) => targetStore.getById(id));
			expect(stored).toHaveLength(result.write.cardIds.length);
			expect(stored.every((row) => row !== undefined)).toBe(true);
			expect(stored.every((row) => row?.projectId === projectId)).toBe(true);
			expect(
				targetFixture.sqlite
					.prepare(
						"SELECT COUNT(*) AS count FROM nodix_memories WHERE project_id <> ? OR project_id IS NULL",
					)
					.get(projectId),
			).toEqual({ count: 0 });

			const rows = targetFixture.sqlite
				.prepare(
					`SELECT id, text, category, project_id AS projectId, subject, attribute,
						valid_from AS validFrom, valid_until AS validUntil, lane,
						disposition_reason AS dispositionReason
					FROM nodix_memories WHERE project_id = ? ORDER BY id`,
				)
				.all(projectId) as StoredAtomicRow[];
			expect(() => assertProjectWall(rows, projectId)).not.toThrow();
			const wallOracleRow = rows[0];
			if (!wallOracleRow) throw new Error("journey 1 stored no rows for the wall oracle");
			expect(() =>
				assertProjectWall([{ ...wallOracleRow, projectId: "wrong-project" }], projectId),
			).toThrow("project wall failed");

			const preference = result.records.find(
				(record) =>
					record.sourceSpan?.turnIndex === 0 &&
					record.subject === "user" &&
					record.attribute !== null,
			);
			if (!preference?.attribute) throw new Error("journey 1 produced no keyed preference");
			expect(
				rows.find(
					(row) => row.text === preference.claimText && row.attribute === preference.attribute,
				),
			).toMatchObject({ subject: "user", attribute: preference.attribute });

			const eventRecord = result.records.find(
				(record) => record.sourceSpan?.turnIndex === 1 && record.category === "episodic",
			);
			if (!eventRecord) throw new Error("journey 1 produced no episodic change event");
			expect(eventRecord.kind).toBe("occurrence");
			const event = rows.find((row) => row.text === eventRecord.claimText);
			expect(event).toMatchObject({
				category: "episodic",
				validFrom: EVENT_FROM_MS,
				validUntil: EVENT_FROM_MS + 1,
			});
			expect(targetStore.listAtomicValidAt(projectId, EVENT_FROM_MS).map(({ id }) => id)).toContain(
				event?.id,
			);
			expect(
				targetStore.listAtomicValidAt(projectId, EVENT_FROM_MS + 1).map(({ id }) => id),
			).not.toContain(event?.id);

			const entityRecord = result.records.find((record) => record.sourceSpan?.turnIndex === 2);
			expect(entityRecord?.subject).toMatch(/^entity:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
			expect(
				targetFixture.sqlite
					.prepare(
						"SELECT entity_id AS entityId, display_name AS displayName, project_id AS projectId FROM nodix_memory_entities WHERE project_id = ?",
					)
					.get(projectId),
			).toEqual({
				entityId: entityRecord?.subject,
				displayName: "Ada Lovelace",
				projectId,
			});

			const compoundRecords = result.records.filter(
				(record) => record.sourceSpan?.turnIndex === 3,
			);
			const curryRecord = compoundRecords.find(
				(record) =>
					record.singleClaim &&
					record.claimText.toLowerCase().includes("curry") &&
					!record.claimText.toLowerCase().includes("jazz"),
			);
			const jazzRecord = compoundRecords.find(
				(record) =>
					record.singleClaim &&
					record.claimText.toLowerCase().includes("jazz") &&
					!record.claimText.toLowerCase().includes("curry"),
			);
			const servedBundle = rows.some(
				(row) =>
					row.text.toLowerCase().includes("curry") &&
					row.text.toLowerCase().includes("jazz") &&
					targetStore.isMemoryOnFactSurface(row.id),
			);
			const splitCompound =
				curryRecord !== undefined &&
				jazzRecord !== undefined &&
				!servedBundle &&
				[curryRecord, jazzRecord].every((record) => {
					const row = rows.find((candidate) => candidate.text === record.claimText);
					return row !== undefined && targetStore.isMemoryOnFactSurface(row.id);
				});
			const parkedCompound = rows.find(
				(row) =>
					row.text.toLowerCase().includes("curry") &&
					row.text.toLowerCase().includes("jazz") &&
					row.lane === "parked" &&
					row.dispositionReason === "compound" &&
					row.subject === null &&
					row.attribute === null &&
					!targetStore.isMemoryOnFactSurface(row.id),
			);
			expect(splitCompound || parkedCompound !== undefined).toBe(true);
			expect(
				rows.some(
					(row) =>
						row.text.toLowerCase().includes("halfway") ||
						row.text.toLowerCase().includes("release notes"),
				),
			).toBe(false);

			targetFixture.sqlite.exec(
				`CREATE TABLE atomic_interval_check_copy (
					valid_from INTEGER,
					valid_until INTEGER,
					CHECK (${ATOMIC_MEMORY_VALID_INTERVAL_CHECK_SQL})
				)`,
			);
			expect(() =>
				targetFixture.sqlite
					.prepare("INSERT INTO atomic_interval_check_copy VALUES (?, ?)")
					.run(EVENT_FROM_MS, EVENT_FROM_MS),
			).toThrow();

			const attemptCountBeforeEmptyChunk = attempts.length;
			const rowCountBeforeEmptyChunk = rows.length;
			const taskProgressTurn = turns[4];
			if (!taskProgressTurn) throw new Error("journey 1 task-progress fixture is missing");
			const emptyResult = await runAtomicMemoryExtraction({
				store: targetStore,
				projectId,
				ledgerKey: {
					conversationId: `${projectId}-empty-conversation`,
					chunkHash: `${projectId}-empty-chunk`,
					pipelineVersion: EXTRACTOR_VERSION,
				},
				turns: [taskProgressTurn],
				rawChunk: `user: ${taskProgressTurn.content}`,
				routingSnapshotId: `${projectId}-empty-routing`,
				runParameters: {
					maxInputTokens: 4_096,
					outputTokenBudget: 4_096,
					subchunkCount: 1,
				},
				estimatedInputTokens: 12,
				extractorVersion: EXTRACTOR_VERSION,
				sessionDateTime: new Date(SESSION_TIME_MS).toISOString(),
				sessionTimestampMs: SESSION_TIME_MS,
				sessionTimezone: "UTC",
				transports,
				nowMs: () => nowMs++,
				requestId: `${projectId}-empty-request`,
			});
			if (emptyResult.status !== "complete") {
				throw new Error(`atomic empty extraction ended as ${emptyResult.status}`);
			}
			expect(emptyResult.records).toEqual([]);
			expect(emptyResult.write.createdCount).toBe(0);
			expect(
				targetFixture.sqlite
					.prepare("SELECT COUNT(*) AS count FROM nodix_memories WHERE project_id = ?")
					.get(projectId),
			).toEqual({ count: rowCountBeforeEmptyChunk });
			const emptyChunkAttempts = attempts
				.slice(attemptCountBeforeEmptyChunk)
				.map(({ callId }) => callId);
			expect(emptyChunkAttempts).toEqual(["E1"]);
			expect(pendingAttempts).toEqual([]);
			expect(providerRequests).toHaveLength(attempts.length);
			expect(providerRequests.every(({ body }) => body.temperature !== 0)).toBe(true);
			process.stdout.write(
				`ATOMIC_LIVE_ROUTE_EVIDENCE ${JSON.stringify({ attempts, responses, requestUrls, records: result.records, emptyChunkAttempts, providerRequests: providerRequests.map(({ attempt, url, body }) => ({ callId: attempt.callId, transport: attempt.transport, url, temperature: body.temperature ?? "absent" })) })}\n`,
			);
		},
	);
});
