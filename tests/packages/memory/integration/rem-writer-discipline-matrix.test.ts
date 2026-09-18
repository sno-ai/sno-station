/** Independent writer logic coverage plus production-entry lifecycle acceptance. */

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
	hashRemMemoryRow,
	installRemSchema,
	REM_ROW_HASH_VERSION,
	writeRemTwoFacetTransaction,
} from "../../../../packages/sno-station-mem/src/engine/rem/index.ts";
import { openSqliteDatabase } from "../../../../packages/sno-station-mem/src/store/sqlite-runtime.ts";
import { seedRemRecoveryState } from "../../../apps/mem-claw/helpers/rem-recovery-state-fixture.ts";
import { seedRemWriteVerdict } from "../../../apps/mem-claw/helpers/rem-write-verdict-fixture.ts";
import { createTestDb, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";
import {
	startQcg17ScriptedInvalidResponseFixture,
	type Qcg17ScriptedInvalidResponseFixture,
} from "../../../apps/mem-claw/helpers/rem-qcg17-scripted-invalid-response-fixture.ts";
import {
	seedProductionMemory,
	startRemProductionEntryFixture,
} from "../../../apps/mem-claw/helpers/rem-production-entry-fixture.ts";

type WriterScenario =
	| "success"
	| "failure"
	| "refusal"
	| "invalid-model-response"
	| "evidence-mismatch"
	| "resolved-retry"
	| "exhausted-retry";

type WriterOperation =
	| { kind: "moveLane"; targetLane: "parked"; reason: string; timestamp: string }
	| { kind: "writeTextVersion"; replacementText: string; reason: string; timestamp: string }
	| { kind: "softClose"; successorId: string; reason: string; timestamp: string }
	| { kind: "restoreLane"; recoveryHandle: string }
	| { kind: "restoreTextVersion"; recoveryHandle: string }
	| { kind: "restoreMark"; recoveryHandle: string }
	| { kind: "applyRemTextVersion"; replacementText: string; reason: string; timestamp: string };

interface RemWriteAuthorization {
	rowId: string;
	preWriteContentSha256: string;
	proposedTextSha256: string;
	evidenceId: string;
	configurationSha256: string;
}

interface AttemptHandle {
	attemptId: string;
}

interface MutationResolution {
	applied: boolean;
	attemptOrdinal: number;
	reasonCode: string | null;
}

interface AttemptOutcome extends MutationResolution {
	attemptId: string;
	outcome: "succeeded" | "failed" | "refused" | "degraded";
	preWriteContentSha256: string;
	postWriteContentSha256: string | null;
}

interface RemMutationExecutor {
	openAttempt(input: {
		jobId: string;
		stage: string;
		rowId: string;
		writer: WriterOperation["kind"];
		authorization: RemWriteAuthorization;
	}): Promise<AttemptHandle>;
	mutateAttempt(handle: AttemptHandle, operation: WriterOperation): Promise<MutationResolution>;
	closeAttempt(handle: AttemptHandle, resolution: MutationResolution): Promise<AttemptOutcome>;
	recoverPendingAttempts(): Promise<AttemptOutcome[]>;
}

type CreateRemMutationExecutor = (input: {
	database: TestDb["runtime"]["db"];
	configurationSha256: string;
	liveContentionRetries: number;
	modelResponse?: { kind: "absent" | "invalid"; value?: string };
}) => RemMutationExecutor;

const writers = [
	"moveLane",
	"writeTextVersion",
	"softClose",
	"restoreLane",
	"restoreTextVersion",
	"restoreMark",
	"applyRemTextVersion",
] as const satisfies readonly WriterOperation["kind"][];
const scenarios: readonly WriterScenario[] = [
	"success",
	"failure",
	"refusal",
	"invalid-model-response",
	"evidence-mismatch",
	"resolved-retry",
	"exhausted-retry",
];
const matrix = writers.flatMap((writer) =>
	scenarios.map((scenario) => ({ writer, scenario })),
);
const scriptedFixtures: Qcg17ScriptedInvalidResponseFixture[] = [];

afterEach(async () => {
	for (const fixture of scriptedFixtures.splice(0)) await fixture.close();
});

describe("REM writer discipline census matrix (coverage only; direct lifecycle calls)", () => {
	it.each(matrix)("$writer records $scenario through the production lifecycle", async ({
		writer,
		scenario,
	}) => {
		const fixture = createTestDb();
		installRemSchema(fixture.runtime.db);
		const rowId = `clrem${writer.toLowerCase()}${scenario.replaceAll("-", "")}`;
		seedRealWriterState(fixture, rowId);
		seedSuccessorState(fixture, writer, `${rowId}-successor`);
		seedRemWriteVerdict(fixture, {
			rowId,
			evidenceId:
				scenario === "refusal"
					? `absent-${rowId}`
					: scenario === "evidence-mismatch"
						? `mismatched-${rowId}`
						: `evidence-${rowId}`,
			relationship:
				scenario === "refusal"
					? "absent"
					: scenario === "evidence-mismatch"
						? "mismatch"
						: "match",
			...(writer === "softClose" ? { winnerRowId: `${rowId}-successor` } : {}),
		});
		seedRemRecoveryState(fixture, writer, rowId);
		const beforeMutation = readMutationState(fixture, rowId);
		try {
			const product = await import(
				"../../../../packages/sno-station-mem/src/store/rem-sqlite-adapter.ts"
			);
			const candidate = (product as Record<string, unknown>)[
				"createMemClawRemMutationExecutor"
			];
			expect(
				candidate,
				`missing production lifecycle factory createMemClawRemMutationExecutor for ${writer}/${scenario}`,
			).toBeTypeOf("function");

			const createExecutor = candidate as CreateRemMutationExecutor;
			const executor = createExecutor({
				database: fixture.runtime.db,
				configurationSha256: "c".repeat(64),
				liveContentionRetries: scenario.includes("retry") ? 1 : 0,
				...(scenario === "invalid-model-response"
					? { modelResponse: { kind: "invalid" as const, value: "not-json" } }
					: {}),
			});
			const authorization = authorizationFor(writer, rowId, scenario);
			const handle = await executor.openAttempt({
				jobId: `rem-unbuilt-${writer}-${scenario}`,
				stage: "rem-update",
				rowId,
				writer,
				authorization,
			});
			const pending = readAttempt(fixture, handle.attemptId);
			expect(pending?.outcome).toBe("pending");
			expect(pending?.attempt_ordinal).toBe(1);

			applyRealScenarioState(fixture, rowId, scenario);
			const externalState = readMutationState(fixture, rowId);
			const resolution = await executor.mutateAttempt(handle, operationFor(writer, rowId));
			const outcome = await executor.closeAttempt(handle, resolution);
			expect(outcome, "the logical attempt must reach a durable terminal row").toBeDefined();
			if (outcome === undefined) throw new Error("attempt outcome missing after close or recovery");
			expect(outcome.outcome).toBe(expectedOutcome(scenario));
			expect(outcome.reasonCode).toBe(expectedReason(scenario));
			expect(outcome.attemptOrdinal).toBe(expectedOrdinal(scenario));
			expect(readAttempt(fixture, handle.attemptId)?.outcome).toBe(outcome.outcome);
			const attempts = fixture.runtime.raw
				.prepare("SELECT * FROM nodix_rem_write_attempts WHERE attempt_id = ?")
				.all(handle.attemptId) as Array<Record<string, unknown>>;
			expect(attempts).toHaveLength(1);
			expect(attempts[0]).toMatchObject({
				outcome: outcome.outcome,
				attempt_ordinal: expectedOrdinal(scenario),
				row_id: rowId,
				writer,
			});
			const afterMutation = readMutationState(fixture, rowId);
			if (scenario === "success" || scenario === "resolved-retry") {
				expect(afterMutation).not.toEqual(beforeMutation);
			} else {
				expect(afterMutation).toEqual(externalState);
			}
			if (scenario === "invalid-model-response") {
				expect(outcome.postWriteContentSha256).toBeNull();
			}
		} finally {
			fixture.cleanup();
		}
	});

	it("does not leave a committed mutation pending for recovery", async () => {
		const fixture = createTestDb();
		installRemSchema(fixture.runtime.db);
		const rowId = "clrempendingcrash";
		seedRealWriterState(fixture, rowId);
		seedRemWriteVerdict(fixture, { rowId, evidenceId: `evidence-${rowId}` });
		try {
			const product = await import(
				"../../../../packages/sno-station-mem/src/store/rem-sqlite-adapter.ts"
			);
			const candidate = (product as Record<string, unknown>)[
				"createMemClawRemMutationExecutor"
			];
			expect(candidate, "missing production lifecycle factory").toBeTypeOf("function");
			const createExecutor = candidate as CreateRemMutationExecutor;
			const executor = createExecutor({
				database: fixture.runtime.db,
				configurationSha256: "c".repeat(64),
				liveContentionRetries: 0,
			});
			const handle = await executor.openAttempt({
				jobId: "rem-unbuilt-pending-crash",
				stage: "rem-update",
				rowId,
				writer: "writeTextVersion",
				authorization: authorizationFor("writeTextVersion", rowId, "success"),
			});
			const mutation = await executor.mutateAttempt(
				handle,
				operationFor("writeTextVersion", rowId),
			);
			expect(mutation).toMatchObject({ applied: true });
			expect(readAttempt(fixture, handle.attemptId)?.outcome).toBe("succeeded");

			const recovered = await createExecutor({
				database: fixture.runtime.db,
				configurationSha256: "c".repeat(64),
				liveContentionRetries: 0,
			}).recoverPendingAttempts();
			expect(recovered).toEqual([]);
			const attempts = fixture.runtime.raw
				.prepare("SELECT * FROM nodix_rem_write_attempts WHERE attempt_id = ?")
				.all(handle.attemptId) as Array<Record<string, unknown>>;
			expect(attempts).toHaveLength(1);
			expect(attempts[0]).toMatchObject({
				outcome: "succeeded",
				reason_code: null,
			});
		} finally {
			fixture.cleanup();
		}
	});
});

describe("ACC-37 production edge: mutation lifecycle", () => {
	it("records live writer outcomes and consumes the recovery factory", { timeout: 30_000 }, async () => {
		const marker = "REM_MUTATION_LIFECYCLE_SCRIPTED_INVALID_ONLY";
		const responseFixture = await startQcg17ScriptedInvalidResponseFixture({
			invalidPromptMarker: marker,
			upstreamUrl: "http://localhost:8070/codex/v1/chat/completions",
		});
		scriptedFixtures.push(responseFixture);
		const originalProcessEnv = process.env;
		const parentGpuBaseUrlMutations: string[] = [];
		process.env = new Proxy(originalProcessEnv, {
			deleteProperty(target, property) {
				if (property === "GPU_BASE_URL") parentGpuBaseUrlMutations.push("delete");
				return Reflect.deleteProperty(target, property);
			},
			set(target, property, value) {
				if (property === "GPU_BASE_URL") parentGpuBaseUrlMutations.push("set");
				return Reflect.set(target, property, value);
			},
		});
		let fixture: Awaited<ReturnType<typeof startRemProductionEntryFixture>> | undefined;
		try {
			fixture = await startRemProductionEntryFixture({ gpuBaseUrl: responseFixture.url });
			expect(fixture.configuration["modelRoute"]).toBe(
				"http://localhost:8070/codex/v1/chat/completions",
			);
			const scope = "persona:production-mutation-lifecycle";
			seedProductionMemory(fixture.database.sqlite, {
				id: "clremmutationstale000000001",
				metadata: { section_name: "preferences.workspace", topic: "preferences.workspace" },
				scope,
				text: `${marker}: The user preferred a standing desk.`,
				timestamp: "2026-08-08T08:00:00.000Z",
			});
			seedProductionMemory(fixture.database.sqlite, {
				id: "clremmutationcurrent000001",
				metadata: { section_name: "preferences.workspace", topic: "preferences.workspace" },
				scope,
				text: "The user now prefers a quiet library desk.",
				timestamp: "2026-08-09T08:00:00.000Z",
			});
			const started = await fixture.submit(
				"rem-update",
				scope,
				"correlation-production-mutation-lifecycle",
			);
			const terminal = await fixture.waitForTerminal(productionIdentity(started), 20_000);
			expect(terminal).toMatchObject({ state: "failed", error: "ordered_wave_stage_failed" });
			const attempts = fixture.database.sqlite
				.prepare(
					`SELECT writer, outcome, reason_code, pre_write_content_sha256,
					        post_write_content_sha256
					 FROM nodix_rem_write_attempts ORDER BY writer, attempt_id`,
				)
				.all() as Array<Record<string, unknown>>;
			expect(attempts.length).toBeGreaterThan(0);
			expect(new Set(attempts.map((row) => row["writer"]))).toEqual(
				new Set(writers),
			);
			expect(attempts.every((row) => row["outcome"] !== "pending")).toBe(true);
			expect(
				attempts.every(
					(row) =>
						row["outcome"] === "refused" &&
						row["reason_code"] === "model_response_invalid" &&
						row["post_write_content_sha256"] === null,
				),
			).toBe(true);
			const observation = responseFixture.observation();
			expect(
				observation.injectedCalls,
				`scripted fixture observation=${JSON.stringify(observation)}; sidecar stderr=${fixture.stderr()}`,
			).toBe(1);
			expect(observation.requestPaths.length).toBeGreaterThan(0);
			expect(new Set(observation.requestPaths)).toEqual(
				new Set(["/extract/v1/chat/completions"]),
			);
			expect(fixture.stderr()).toContain('"event":"llm_provider_response"');
			expect(fixture.stderr()).toContain('"call_label":"rem-update-relation-judgment"');
			expect(fixture.stderr()).toContain("REM LLM calls all failed: model_response_invalid");
			process.stdout.write(
				"ACC-37 scripted response integration; static data-contract proof: dev-scripts/tests/rem-per-write-degraded-contract.sh; paired real E2E: tests/apps/mem-claw/e2e-agent/rem-write-path-reachable.e2e.sh\n",
			);
		} finally {
			if (fixture !== undefined) await fixture.stop();
			process.env = originalProcessEnv;
			expect(parentGpuBaseUrlMutations).toEqual([]);
		}
	});
});

function productionIdentity(response: Record<string, unknown>): string {
	for (const key of ["waveId", "wave_id", "job_id"]) {
		const value = response[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	throw new Error(`production response omitted wave identity: ${JSON.stringify(response)}`);
}

function seedRealWriterState(fixture: TestDb, rowId: string): void {
	const contentHash = "a".repeat(64);
	// The test helper's hand-written schema mirrors the migrations only through 0013; `timezone`
	// arrives with 0028, which Drizzle applies on top the moment a MemoryStore is constructed. Cases
	// in this suite that never construct one therefore have no such column, and naming it
	// unconditionally made all 53 of them fail with "table `nodix_memories` has no column named
	// timezone". Ask the table what it has rather than assuming which world we are in.
	const hasTimezone = (
		fixture.runtime.raw.prepare("PRAGMA table_info(nodix_memories)").all() as Array<{
			name: string;
		}>
	).some((column) => column.name === "timezone");
	fixture.runtime.raw
		.prepare(
			hasTimezone
				? `INSERT INTO nodix_memories(
				id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash,
				fact_id, lane, raw_candidate_json
			) VALUES (?, ?, 'profile', ?, 0.8, ?, 'UTC', '{}', ?, ?, 'active', ?)`
				: `INSERT INTO nodix_memories(
				id, text, category, project_id, importance, timestamp, metadata, content_hash,
				fact_id, lane, raw_candidate_json
			) VALUES (?, ?, 'profile', ?, 0.8, ?, '{}', ?, ?, 'active', ?)`,
		)
		.run(
			rowId,
			"The user prefers the shared workspace near the entrance.",
			"test-rem-unbuilt-writers",
			Date.parse("2026-08-08T08:00:00.000Z"),
			contentHash,
			`fact-${rowId}`,
			JSON.stringify({ evidenceId: `evidence-${rowId}` }),
		);
}

function seedSuccessorState(fixture: TestDb, writer: WriterOperation["kind"], rowId: string): void {
	if (writer !== "softClose") return;
	fixture.runtime.raw
		.prepare(
			`INSERT INTO nodix_memories(
				id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash,
				fact_id, lane, raw_candidate_json
			) VALUES (?, ?, 'profile', ?, 0.8, ?, 'UTC', '{}', ?, ?, 'active', '{}')`,
		)
		.run(
			rowId,
			"The successor row keeps the current workspace preference.",
			"test-rem-unbuilt-writers",
			Date.parse("2026-08-08T08:00:01.000Z"),
			"e".repeat(64),
			`fact-${rowId}`,
		);
}

function applyRealScenarioState(fixture: TestDb, rowId: string, scenario: WriterScenario): void {
	if (scenario === "failure") {
		fixture.runtime.raw.exec(
			`CREATE TRIGGER rem_unbuilt_writer_failure BEFORE UPDATE ON nodix_memories
			 BEGIN SELECT RAISE(ABORT, 'forced real sqlite mutation failure'); END`,
		);
	}
	if (scenario === "resolved-retry" || scenario === "exhausted-retry") {
		const contender = openSqliteDatabase(fixture.dbPath, { fileMustExist: true });
		try {
			contender.raw
				.prepare("UPDATE nodix_memories SET content_hash = ? WHERE id = ?")
				.run("d".repeat(64), rowId);
		} finally {
			contender.raw.close();
		}
	}
	if (scenario === "resolved-retry") {
		fixture.runtime.raw.exec(`
			CREATE TRIGGER rem_unbuilt_resolve_retry
			AFTER UPDATE OF attempt_ordinal ON nodix_rem_write_attempts
			WHEN NEW.attempt_ordinal = 2
			BEGIN
				UPDATE nodix_memories
				SET content_hash = '${"a".repeat(64)}'
				WHERE id = NEW.row_id;
			END;
		`);
	}
}

function authorizationFor(
	writer: WriterOperation["kind"],
	rowId: string,
	scenario: WriterScenario,
): RemWriteAuthorization {
	return {
		rowId,
		preWriteContentSha256: "a".repeat(64),
		proposedTextSha256: createHash("sha256").update(proposedTextFor(writer)).digest("hex"),
		evidenceId:
			scenario === "refusal"
				? `absent-${rowId}`
				: scenario === "evidence-mismatch"
					? `mismatched-${rowId}`
					: `evidence-${rowId}`,
		configurationSha256: "c".repeat(64),
	};
}

function proposedTextFor(writer: WriterOperation["kind"]): string {
	if (writer === "writeTextVersion" || writer === "applyRemTextVersion") {
		return "The user now prefers the quiet workspace near the library.";
	}
	return "The user prefers the shared workspace near the entrance.";
}

function operationFor(writer: WriterOperation["kind"], rowId: string): WriterOperation {
	const reason = "The settled REM evidence authorizes this bounded mutation.";
	const timestamp = "2026-08-08T08:01:00.000Z";
	switch (writer) {
		case "moveLane":
			return { kind: writer, targetLane: "parked", reason, timestamp };
		case "writeTextVersion":
		case "applyRemTextVersion":
			return {
				kind: writer,
				replacementText: "The user now prefers the quiet workspace near the library.",
				reason,
				timestamp,
			};
		case "softClose":
			return { kind: writer, successorId: `${rowId}-successor`, reason, timestamp };
		case "restoreLane":
		case "restoreTextVersion":
		case "restoreMark":
			return { kind: writer, recoveryHandle: `recovery-${rowId}` };
	}
}

function readAttempt(
	fixture: TestDb,
	attemptId: string,
): { outcome: string; attempt_ordinal: number } | undefined {
	return fixture.runtime.raw
		.prepare("SELECT outcome, attempt_ordinal FROM nodix_rem_write_attempts WHERE attempt_id = ?")
		.get(attemptId) as { outcome: string; attempt_ordinal: number } | undefined;
}

function readMutationState(fixture: TestDb, rowId: string): Record<string, unknown> {
	return {
		row: fixture.runtime.raw.prepare("SELECT * FROM nodix_memories WHERE id = ?").get(rowId),
		facets: fixture.runtime.raw
			.prepare("SELECT * FROM nodix_rem_memory_facets WHERE memory_id = ? ORDER BY facet")
			.all(rowId),
		chunks: fixture.runtime.raw
			.prepare("SELECT * FROM nodix_memory_chunks WHERE memory_id = ? ORDER BY chunk_id")
			.all(rowId),
	};
}

function expectedOutcome(scenario: WriterScenario): AttemptOutcome["outcome"] {
	if (scenario === "success" || scenario === "resolved-retry") return "succeeded";
	if (scenario === "failure") return "failed";
	return "refused";
}

function expectedReason(scenario: WriterScenario): string | null {
	if (scenario === "success" || scenario === "resolved-retry") return null;
	if (scenario === "failure") return "mutation_failed";
	if (scenario === "invalid-model-response") return "model_response_invalid";
	if (scenario === "evidence-mismatch") return "verdict_evidence_mismatch";
	// The reason names the cause, not the response: an exhausted retry is still a row that
	// moved under the write. That the retries happened is proved by expectedOrdinal() below,
	// which requires ordinal 2 for this scenario.
	if (scenario === "exhausted-retry") return "content_changed";
	return "verdict_absent";
}

function expectedOrdinal(scenario: WriterScenario): number {
	return scenario === "resolved-retry" || scenario === "exhausted-retry" ? 2 : 1;
}

/**
 * Both cases below are regressions for defects that shipped together on 2026-08-27 and were only
 * caught by a full e2e-minus run two days later. They are here, at the lowest boundary that can
 * see them, so the next change to the write path fails in seconds instead of in a live REM job.
 */
describe("REM verified-write hash symmetry", () => {
	it("accepts an ordinary text-version write on a row that carries a timezone", async () => {
		const fixture = createTestDb();
		installRemSchema(fixture.runtime.db);
		const rowId = "clremhashsymmetry";
		seedRealWriterState(fixture, rowId);
		seedRemWriteVerdict(fixture, { rowId, evidenceId: `evidence-${rowId}` });
		try {
			const product = await import(
				"../../../../packages/sno-station-mem/src/store/rem-sqlite-adapter.ts"
			);
			const createExecutor = (product as Record<string, unknown>)[
				"createMemClawRemMutationExecutor"
			] as CreateRemMutationExecutor;
			const executor = createExecutor({
				database: fixture.runtime.db,
				configurationSha256: "c".repeat(64),
				liveContentionRetries: 0,
			});
			const handle = await executor.openAttempt({
				jobId: "rem-hash-symmetry-write",
				stage: "rem-update",
				rowId,
				writer: "writeTextVersion",
				authorization: authorizationFor("writeTextVersion", rowId, "success"),
			});
			// Before the shared row hash this refused with "committed mutation lacks matching
			// recovery state" — AFTER the transaction had committed, so the row had already moved
			// and the caller was told it had not.
			const mutation = await executor.mutateAttempt(
				handle,
				operationFor("writeTextVersion", rowId),
			);
			expect(mutation).toMatchObject({ applied: true, reasonCode: null });
			expect(readAttempt(fixture, handle.attemptId)?.outcome).toBe("succeeded");

			// The ordinary write layer must stamp the attempt with the content hash it produced,
			// without anything in the test supplying the attempt id. Crash recovery reads exactly
			// this column, so a writer that stops passing the id leaves recovery unable to tell a
			// committed write from a lost one — and that break is invisible to a test that carries
			// the id itself.
			const storedRow = fixture.runtime.raw
				.prepare("SELECT content_hash FROM nodix_memories WHERE id = ?")
				.get(rowId) as { content_hash: string };
			expect(
				fixture.runtime.raw
					.prepare(
						"SELECT expected_post_content_sha256 FROM nodix_rem_write_attempts WHERE attempt_id = ?",
					)
					.get(handle.attemptId),
			).toEqual({ expected_post_content_sha256: storedRow.content_hash });

			const recovery = fixture.runtime.raw
				.prepare(
					`SELECT expected_post_hash, row_hash_version FROM nodix_rem_recovery_history
					WHERE row_id = ? ORDER BY mutation_ts DESC LIMIT 1`,
				)
				.get(rowId) as { expected_post_hash: string; row_hash_version: number } | undefined;
			expect(recovery, "the write must leave a recovery record").toBeDefined();
			// The stored expectation must be reproducible from the stored row. When the two sides
			// hashed different column sets this was false for every write.
			const stored = fixture.runtime.raw
				.prepare("SELECT * FROM nodix_memories WHERE id = ?")
				.get(rowId) as Record<string, unknown>;
			expect(recovery?.row_hash_version).toBe(REM_ROW_HASH_VERSION);
			expect(recovery?.expected_post_hash).toBe(hashRemMemoryRow(stored));
			expect(stored["timezone"]).toBe("UTC");
		} finally {
			fixture.cleanup();
		}
	});

	it("recovers a committed write whose attempt was never closed as succeeded", async () => {
		const fixture = createTestDb();
		installRemSchema(fixture.runtime.db);
		const rowId = "clremcrashaftercommit";
		seedRealWriterState(fixture, rowId);
		seedRemWriteVerdict(fixture, { rowId, evidenceId: `evidence-${rowId}` });
		try {
			const product = await import(
				"../../../../packages/sno-station-mem/src/store/rem-sqlite-adapter.ts"
			);
			const createExecutor = (product as Record<string, unknown>)[
				"createMemClawRemMutationExecutor"
			] as CreateRemMutationExecutor;
			const handle = await createExecutor({
				database: fixture.runtime.db,
				configurationSha256: "c".repeat(64),
				liveContentionRetries: 0,
			}).openAttempt({
				jobId: "rem-crash-after-commit",
				stage: "rem-update",
				rowId,
				writer: "applyRemTextVersion",
				authorization: authorizationFor("applyRemTextVersion", rowId, "success"),
			});
			// The crash window this proves: the write transaction commits, and the process ends
			// before the attempt is closed. Driving the transaction directly is what reproduces it —
			// going through mutateAttempt would close the attempt on the way out.
			//
			// That the ordinary write layer passes the attempt id at all is proved by the case
			// above, on the real path; this case takes the id as given and proves only the half it
			// is about — that a stamped attempt left pending recovers as succeeded.
			const replacementText = "The user now prefers the quiet workspace near the library.";
			const written = await writeRemTwoFacetTransaction({
				database: fixture.runtime.db,
				memoryId: rowId,
				current: replacementText,
				history: "The user prefers the shared workspace near the entrance.",
				currentChunks: [
					{
						chunkId: `chunk-${rowId}`,
						chunkIndex: 0,
						chunkText: replacementText,
						densePayload: JSON.stringify({ terms: ["quiet", "workspace", "library"] }),
						startOffset: 0,
						endOffset: replacementText.length,
						tokenCount: 9,
						contentType: "prose",
						chunkingVersion: "1.1.0",
						embedderProvider: "local-onnx",
						embedderModel: "test-embedder",
						embedderDim: 1024,
						vectorBytes: new Uint8Array(new Float32Array(1024).buffer),
					},
				],
				metadata: JSON.stringify({ rem_updated_at: "2026-08-08T08:01:00.000Z" }),
				reason: "The settled REM evidence authorizes this bounded mutation.",
				timestamp: "2026-08-08T08:01:00.000Z",
				jobId: "rem-crash-after-commit",
				jobType: "rem-update",
				attemptId: handle.attemptId,
			});
			expect(readAttempt(fixture, handle.attemptId)?.outcome).toBe("pending");

			const recovered = await createExecutor({
				database: fixture.runtime.db,
				configurationSha256: "c".repeat(64),
				liveContentionRetries: 0,
			}).recoverPendingAttempts();
			// Recovery used to compare the row's content hash (text AND metadata) against the
			// proposed TEXT hash, which a REM update can never match, so a committed write was
			// recorded as failed forever with a null post-write hash.
			expect(recovered).toHaveLength(1);
			expect(recovered[0]).toMatchObject({
				applied: true,
				outcome: "succeeded",
				reasonCode: null,
				postWriteContentSha256: written.contentHash,
			});
			expect(readAttempt(fixture, handle.attemptId)?.outcome).toBe("succeeded");
		} finally {
			fixture.cleanup();
		}
	});
});
