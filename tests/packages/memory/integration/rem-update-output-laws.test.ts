/** Independent update-output coverage plus production-entry durability acceptance. */

import { createHash } from "node:crypto";
import { readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { installRemSchema } from "../../../../packages/memory/src/engine/rem/index.ts";
import { openSqliteDatabase } from "../../../../packages/memory/src/store/sqlite-runtime.ts";
import { seedRemRecoveryState } from "../../../apps/mem-claw/helpers/rem-recovery-state-fixture.ts";
import { seedRemWriteVerdict } from "../../../apps/mem-claw/helpers/rem-write-verdict-fixture.ts";
import { startRemScriptedModelFixture } from "../../../apps/mem-claw/helpers/rem-scripted-model-fixture.ts";
import { createTestDb, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";
import {
	runInstalledSno,
	seedProductionMemory,
	startRemProductionEntryFixture,
} from "../../../apps/mem-claw/helpers/rem-production-entry-fixture.ts";

type ProductExports = Record<string, unknown>;
const writers = [
	"moveLane",
	"writeTextVersion",
	"softClose",
	"restoreLane",
	"restoreTextVersion",
	"restoreMark",
	"applyRemTextVersion",
] as const;
type Writer = (typeof writers)[number];
const writerRows = writers.map((writer) => ({ writer }));

interface OutputResolution {
	applied: boolean;
	reasonCode: string | null;
}

interface OutputExecutor {
	openAttempt(input: Record<string, unknown>): Promise<{ attemptId: string }>;
	mutateAttempt(handle: unknown, operation: Record<string, unknown>): Promise<OutputResolution>;
	closeAttempt(
		handle: unknown,
		resolution: OutputResolution,
	): Promise<{ outcome: string; reasonCode: string | null }>;
}

type CreateOutputExecutor = (input: Record<string, unknown>) => OutputExecutor;

async function boundary<T>(modulePath: string, name: string): Promise<T> {
	const product = (await import(modulePath)) as ProductExports;
	const candidate = product[name];
	expect(candidate, `missing production update-output boundary ${name}`).toBeTypeOf("function");
	return candidate as T;
}

function seed(fixture: ReturnType<typeof createTestDb>, rowId: string, retired: boolean): void {
	fixture.runtime.raw
		.prepare("INSERT INTO nodix_memories(id,text,category,project_id,importance,timestamp,timezone,metadata,content_hash,fact_id,lane,raw_candidate_json) VALUES (?,?,'profile','rem-output',0.8,1,'UTC',?,?,?,'active','{}')")
		.run(
			rowId,
			"The user prefers a standing desk.",
			JSON.stringify(retired ? { rem_retired_section: "preferences.workspace" } : {}),
			"a".repeat(64),
			`fact-${rowId}`,
		);
}

function seedSuccessor(fixture: ReturnType<typeof createTestDb>, writer: Writer, rowId: string): void {
	if (writer !== "softClose") return;
	fixture.runtime.raw
		.prepare(
			"INSERT INTO nodix_memories(id,text,category,project_id,importance,timestamp,timezone,metadata,content_hash,fact_id,lane,raw_candidate_json) VALUES (?,?,'profile','rem-output',0.8,1,'UTC','{}',?,?, 'active','{}')",
		)
		.run(
			`${rowId}-next`,
			"The successor preserves the user's current desk preference.",
			"e".repeat(64),
			`fact-${rowId}-next`,
		);
}

function authorization(writer: Writer, rowId: string): Record<string, unknown> {
	const proposedText =
		writer === "writeTextVersion" || writer === "applyRemTextVersion"
			? "The user prefers a quiet desk."
			: "The user prefers a standing desk.";
	return {
		rowId,
		preWriteContentSha256: "a".repeat(64),
		proposedTextSha256: createHash("sha256").update(proposedText).digest("hex"),
		evidenceId: `evidence-${rowId}`,
		configurationSha256: "c".repeat(64),
	};
}

function operation(writer: Writer, rowId: string): Record<string, unknown> {
	if (writer === "moveLane") return { kind: writer, targetLane: "parked", reason: "output law", timestamp: "2026-08-08T08:01:00Z" };
	if (writer === "writeTextVersion" || writer === "applyRemTextVersion") return { kind: writer, replacementText: "The user prefers a quiet desk.", reason: "output law", timestamp: "2026-08-08T08:01:00Z" };
	if (writer === "softClose") return { kind: writer, successorId: `${rowId}-next`, reason: "output law", timestamp: "2026-08-08T08:01:00Z" };
	return { kind: writer, recoveryHandle: `recovery-${rowId}` };
}

function readWriterState(
	fixture: ReturnType<typeof createTestDb>,
	rowId: string,
): Record<string, unknown> {
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

function readAttemptRows(
	fixture: ReturnType<typeof createTestDb>,
	attemptId: string,
): Array<Record<string, unknown>> {
	return fixture.runtime.raw
		.prepare("SELECT * FROM nodix_rem_write_attempts WHERE attempt_id = ?")
		.all(attemptId) as Array<Record<string, unknown>>;
}

describe("REM retired-section marker (coverage only; direct mutation lifecycle)", () => {
	it.each(writerRows)("$writer refuses a row already carrying the retired marker", async ({ writer }) => {
		const fixture = createTestDb(); installRemSchema(fixture.runtime.db);
		const rowId = `clremmarked${writer.toLowerCase()}`; seed(fixture, rowId, true);
		seedRemWriteVerdict(fixture, {
			rowId,
			evidenceId: `evidence-${rowId}`,
			...(writer === "softClose" ? { winnerRowId: `${rowId}-next` } : {}),
		});
		try {
			const before = readWriterState(fixture, rowId);
			const create = await boundary<CreateOutputExecutor>("../../../../packages/memory/src/store/rem-sqlite-adapter.ts", "createMemClawRemMutationExecutor");
			const executor = create({ database: fixture.runtime.db, configurationSha256: "c".repeat(64), liveContentionRetries: 0 });
			const handle = await executor.openAttempt({ jobId: `marked-${writer}`, stage: "rem-update", rowId, writer, authorization: authorization(writer, rowId) });
			const resolution = await executor.mutateAttempt(handle, operation(writer, rowId));
			expect(resolution).toMatchObject({ applied: false, reasonCode: "scope_mismatch" });
			expect(await executor.closeAttempt(handle, resolution)).toMatchObject({ outcome: "refused", reasonCode: "scope_mismatch" });
			expect(readWriterState(fixture, rowId)).toEqual(before);
			expect(readAttemptRows(fixture, handle.attemptId)).toEqual([
				expect.objectContaining({ outcome: "refused", reason_code: "scope_mismatch", row_id: rowId, writer }),
			]);
		} finally { fixture.cleanup(); }
	});

	it.each(writerRows)("$writer re-reads a marker written after attempt open", async ({ writer }) => {
		const fixture = createTestDb(); installRemSchema(fixture.runtime.db);
		const rowId = `clremraced${writer.toLowerCase()}`; seed(fixture, rowId, false);
		seedRemWriteVerdict(fixture, { rowId, evidenceId: `evidence-${rowId}` });
		try {
			const before = readWriterState(fixture, rowId);
			const create = await boundary<CreateOutputExecutor>("../../../../packages/memory/src/store/rem-sqlite-adapter.ts", "createMemClawRemMutationExecutor");
			const executor = create({ database: fixture.runtime.db, configurationSha256: "c".repeat(64), liveContentionRetries: 0 });
			const handle = await executor.openAttempt({ jobId: `raced-${writer}`, stage: "rem-update", rowId, writer, authorization: authorization(writer, rowId) });
			const contender = openSqliteDatabase(fixture.dbPath, { fileMustExist: true });
			try { contender.raw.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?").run(JSON.stringify({ rem_retired_section: "preferences.workspace" }), rowId); } finally { contender.raw.close(); }
			const resolution = await executor.mutateAttempt(handle, operation(writer, rowId));
			expect(resolution).toMatchObject({ applied: false, reasonCode: "scope_mismatch" });
			expect(await executor.closeAttempt(handle, resolution)).toMatchObject({ outcome: "refused", reasonCode: "scope_mismatch" });
			const expected = structuredClone(before);
			(expected.row as Record<string, unknown>).metadata = JSON.stringify({ rem_retired_section: "preferences.workspace" });
			expect(readWriterState(fixture, rowId)).toEqual(expected);
			expect(readAttemptRows(fixture, handle.attemptId)).toEqual([
				expect.objectContaining({ outcome: "refused", reason_code: "scope_mismatch", row_id: rowId, writer }),
			]);
		} finally { fixture.cleanup(); }
	});

	it.each(writerRows)("$writer writes normally without a retired marker", async ({ writer }) => {
		const fixture = createTestDb(); installRemSchema(fixture.runtime.db);
		const rowId = `clremopen${writer.toLowerCase()}`; seed(fixture, rowId, false); seedSuccessor(fixture, writer, rowId);
		seedRemWriteVerdict(fixture, {
			rowId,
			evidenceId: `evidence-${rowId}`,
			...(writer === "softClose" ? { winnerRowId: `${rowId}-next` } : {}),
		});
		seedRemRecoveryState(fixture, writer, rowId);
		try {
			const before = readWriterState(fixture, rowId);
			const create = await boundary<CreateOutputExecutor>("../../../../packages/memory/src/store/rem-sqlite-adapter.ts", "createMemClawRemMutationExecutor");
			const executor = create({ database: fixture.runtime.db, configurationSha256: "c".repeat(64), liveContentionRetries: 0 });
			const handle = await executor.openAttempt({ jobId: `open-${writer}`, stage: "rem-update", rowId, writer, authorization: authorization(writer, rowId) });
			const resolution = await executor.mutateAttempt(handle, operation(writer, rowId));
			expect(resolution).toMatchObject({ applied: true });
			expect(await executor.closeAttempt(handle, resolution)).toMatchObject({ outcome: "succeeded", reasonCode: null });
			expect(readWriterState(fixture, rowId)).not.toEqual(before);
			expect(readAttemptRows(fixture, handle.attemptId)).toEqual([
				expect.objectContaining({ outcome: "succeeded", reason_code: null, row_id: rowId, writer }),
			]);
		} finally { fixture.cleanup(); }
	});

	it.each(["writeTextVersion", "applyRemTextVersion"] as const)(
		"$writer keeps the attempt identity when a widened operation spoofs it",
		async (writer) => {
			const fixture = createTestDb();
			installRemSchema(fixture.runtime.db);
			const rowId = `clremidentity${writer.toLowerCase()}`;
			const jobId = `trusted-${writer}`;
			seed(fixture, rowId, false);
			seedRemWriteVerdict(fixture, { rowId, evidenceId: `evidence-${rowId}` });
			try {
				const received: Array<Record<string, unknown>> = [];
				const create = await boundary<CreateOutputExecutor>(
					"../../../../packages/memory/src/store/rem-sqlite-adapter.ts",
					"createMemClawRemMutationExecutor",
				);
				const executor = create({
					database: fixture.runtime.db,
					jobType: "rem-update",
					configurationSha256: "c".repeat(64),
					liveContentionRetries: 0,
					applyTextVersion: async (input: Record<string, unknown>) => {
						received.push(input);
						return { applied: true, contentHash: "b".repeat(64), recoveryHandle: "trusted" };
					},
				});
				const handle = await executor.openAttempt({
					jobId,
					stage: "rem-update",
					rowId,
					writer,
					authorization: authorization(writer, rowId),
				});
				const resolution = await executor.mutateAttempt(handle, {
					...operation(writer, rowId),
					jobId: "spoofed-job",
					jobType: "rem-replace",
				});

				expect(resolution).toMatchObject({ applied: false, reasonCode: "mutation_failed" });
				expect(await executor.closeAttempt(handle, resolution)).toMatchObject({
					applied: false,
					outcome: "failed",
					reasonCode: "mutation_failed",
				});
				expect(received).toEqual([
					expect.objectContaining({ jobId, jobType: "rem-update", rowId }),
				]);
				expect(received[0]).not.toMatchObject({ jobId: "spoofed-job" });
				expect(received[0]).not.toMatchObject({ jobType: "rem-replace" });
			} finally {
				fixture.cleanup();
			}
		},
	);

	it("derives the writer set from the production call graph", async () => {
		const discover = await boundary<(input: { entryPoints: string[] }) => { writers: Array<{ writer: string }> }>("../../../../packages/memory/src/engine/rem/index.ts", "discoverRemWritersFromCallGraph");
		const discovered = discover({
			entryPoints: [resolve(import.meta.dirname, "../../../../packages/memory/src/sidecar/main.ts")],
		}).writers.map(({ writer }) => writer);
		expect(discovered).toEqual([...writers]);
	});
});

describe("REM negated-current output (coverage only; direct composer calls)", () => {
	type Retraction = {
		shape: string;
		topic: string;
		assertions: Array<{ polarity: "affirmative" | "negative"; provenance: string }>;
		generatedRowId: string;
		consumedRowIds: string[];
	};
	const input = {
		topic: "tea preference",
		priorRowId: "row-affirmative-tea",
		retractionText: "The user no longer likes tea.",
	};
	it("selects the named shape and preserves the retracted topic", async () => {
		const compose = await boundary<(value: typeof input) => Retraction>("../../../../packages/memory/src/engine/rem/index.ts", "composeRemNegatedCurrent");
		const result = compose(input);
		expect(result).toMatchObject({ shape: "negated-current", topic: "tea preference" });
	});
	it("emits only the user's negative assertion provenance", async () => {
		const compose = await boundary<(value: typeof input) => Retraction>("../../../../packages/memory/src/engine/rem/index.ts", "composeRemNegatedCurrent");
		const result = compose(input);
		expect(result.assertions).toEqual([{ polarity: "negative", provenance: input.retractionText }]);
		expect(result.assertions.some(({ polarity }) => polarity === "affirmative")).toBe(false);
	});
	it("does not consume the generated negation row as retired input", async () => {
		const compose = await boundary<(value: typeof input) => Retraction>("../../../../packages/memory/src/engine/rem/index.ts", "composeRemNegatedCurrent");
		const result = compose(input);
		expect(result.consumedRowIds).toContain(input.priorRowId);
		expect(result.consumedRowIds).not.toContain(result.generatedRowId);
	});
});

describe("REM update routing (coverage only; production acceptance follows)", () => {
	const source = readFileSync(resolve(import.meta.dirname, "../../../../packages/memory/src/store/memory-store-rem-api.ts"), "utf8");
	const batchSource = readFileSync(resolve(import.meta.dirname, "../../../../packages/memory/src/sidecar/rem-batch-executor.ts"), "utf8");
	it("emits update audit through runWithMemoryAudit", () => {
		expect(source).toMatch(/runWithMemoryAudit\s*\(/u);
		expect(source).toMatch(/rem[_-]update/iu);
	});
	it("prepares replacement chunks before the two-facet write", () => {
		expect(source).toMatch(/prepareChunkInserts\s*\(/u);
		expect(source).toMatch(/currentChunks:\s*chunks\.map/u);
	});
	it("writes current and history through one two-facet transaction", () => {
		expect(source).toMatch(/writeRemTwoFacetTransaction\s*\(/u);
		expect(source).toMatch(/history:\s*input\.historyText\s*\?\?/u);
	});
	it.each([
		{ sameStore: true, expectedOverlap: false },
		{ sameStore: false, expectedOverlap: true },
	] as const)("serializes batches according to canonical store identity", async ({ sameStore, expectedOverlap }) => {
		const left = createTestDb();
		const right = sameStore ? undefined : createTestDb();
		const aliasPath = `${left.dbPath}.canonical-alias`;
		try {
			if (sameStore) symlinkSync(left.dbPath, aliasPath);
			if (sameStore) expect(batchSource).toMatch(/runWithCanonicalStoreWriteMutex\s*\(/u);
			const run = await boundary<(
				canonicalStorePath: string,
				action: () => Promise<void>,
			) => Promise<void>>(
				"../../../../packages/memory/src/sidecar/rem-batch-executor.ts",
				"runWithCanonicalStoreWriteMutex",
			);
			let active = 0;
			let maximumActive = 0;
			const action = async () => {
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				await new Promise<void>((done) => setTimeout(done, 10));
				active -= 1;
			};
			await Promise.all([
				run(left.dbPath, action),
				run(right?.dbPath ?? aliasPath, action),
			]);
			expect(maximumActive === 2).toBe(expectedOverlap);
		} finally {
			if (sameStore) unlinkSync(aliasPath);
			right?.cleanup();
			left.cleanup();
		}
	});
});

describe("ACC-37 production edge: two-facet transaction", () => {
	it("persists current/history/recovery and the user's negation through POST", { timeout: 90_000 }, async () => {
		const model = await startRemScriptedModelFixture([
			'{"supersedes":true,"retires_anything":true,"supersedes_everything":true}',
			'{"faithful":true,"retired_absent":true,"all_facts_accounted":true}',
		]);
		const fixture = await startRemProductionEntryFixture({ gpuBaseUrl: model.url });
		try {
			const { currentId, retractionId, scope } = seedRetractionProductionRows(
				fixture.database.sqlite,
			);
			const started = await fixture.submit(
				"rem-update",
				scope,
				"correlation-production-two-facet",
			);
			const identity = productionIdentity(started);
			const terminal = await fixture.waitForTerminal(identity, 80_000);
			expect(terminal["state"]).toBe("done");
			const facets = fixture.database.sqlite
				.prepare(
					"SELECT facet, text FROM nodix_rem_memory_facets WHERE memory_id = ? ORDER BY facet",
				)
				.all(currentId) as Array<Record<string, unknown>>;
			expect(facets).toEqual([
				expect.objectContaining({
					facet: "history",
					text: "The user likes jasmine tea every afternoon.",
				}),
			]);
			const retractionFacets = fixture.database.sqlite
				.prepare(
					"SELECT facet, text FROM nodix_rem_memory_facets WHERE memory_id = ? ORDER BY facet",
				)
				.all(retractionId) as Array<Record<string, unknown>>;
			expect(retractionFacets).toEqual([
				expect.objectContaining({
					facet: "current",
					text: "The user no longer likes jasmine tea in the afternoon.",
				}),
			]);
			const recoveryRows = fixture.database.sqlite
				.prepare("SELECT * FROM nodix_rem_recovery_history WHERE row_id = ?")
				.all(currentId);
			expect(recoveryRows.length).toBeGreaterThan(0);
			const attempts = fixture.database.sqlite
				.prepare("SELECT * FROM nodix_rem_write_attempts WHERE job_id = ?")
				.all(identity) as Array<Record<string, unknown>>;
			expect(attempts.some((row) => row["outcome"] === "succeeded")).toBe(true);
			expect(model.requestCount()).toBe(2);
		} finally {
			await fixture.stop();
			await model.close();
		}
	});
});

describe("ACC-33 production entry reaches all six write-path effects", () => {
	it("uses installed sno, encrypted SQLite, scripted model decisions, and recovery after process death", { timeout: 120_000 }, async () => {
		const model = await startRemScriptedModelFixture([
			'{"supersedes":true,"retires_anything":true,"supersedes_everything":true}',
			'{"faithful":true,"retired_absent":true,"all_facts_accounted":true}',
		]);
		const fixture = await startRemProductionEntryFixture({ entry: "built", gpuBaseUrl: model.url });
		try {
			const warmup = await fixture.submit(
				"rem-update",
				"persona:acc33-schema-warmup",
				"correlation-acc33-schema-warmup",
			);
			expect(await fixture.waitForTerminal(productionIdentity(warmup), 20_000)).toMatchObject({
				state: "done",
			});
			const { currentId, retractionId, scope, unsupportedId } = seedRetractionProductionRows(
				fixture.database.sqlite,
			);
			const crashAttemptId = "attempt-acc33-killed-process";
			fixture.database.sqlite
				.prepare(
					`INSERT INTO nodix_rem_write_attempts(
						attempt_id, job_id, stage, row_id, writer, attempt_ordinal, outcome,
						reason_code, pre_write_content_sha256, proposed_text_sha256, evidence_id,
						configuration_sha256, post_write_content_sha256, opened_at, closed_at
					) VALUES (?, ?, 'rem-update', ?, 'writeTextVersion', 1, 'pending', NULL,
					          ?, ?, ?, ?, NULL, ?, NULL)`,
				)
				.run(
					crashAttemptId,
					"wave-acc33-killed-process",
					currentId,
					"a".repeat(64),
					"b".repeat(64),
					"evidence-acc33-killed-process",
					"c".repeat(64),
					"2026-08-09T08:02:00.000Z",
				);
			await fixture.killSidecar();
			await fixture.restartSidecar();

			const started = runInstalledSno({
				args: [
					"station",
					"rem-start",
					"--type",
					"rem-update",
					"--scope",
					scope,
					"--json",
				],
				profileRoot: fixture.profileRoot,
				stateRoot: fixture.stateRoot,
			});
			expect(started.status, started.stderr).toBe(0);
			const startBody = JSON.parse(started.stdout) as Record<string, unknown>;
			const identity = productionIdentity(startBody);
			expect(await fixture.waitForTerminal(identity, 90_000)).toMatchObject({ state: "done" });

			const recovered = fixture.database.sqlite
				.prepare("SELECT outcome, reason_code FROM nodix_rem_write_attempts WHERE attempt_id = ?")
				.get(crashAttemptId);
			expect(recovered).toMatchObject({ outcome: "failed", reason_code: "crash_before_close" });
			const attempts = fixture.database.sqlite
				.prepare("SELECT writer, outcome FROM nodix_rem_write_attempts WHERE job_id = ?")
				.all(identity) as Array<Record<string, unknown>>;
			expect(attempts.length).toBeGreaterThan(0);
			expect(attempts.every((row) => row["outcome"] !== "pending")).toBe(true);
			const facets = fixture.database.sqlite
				.prepare("SELECT facet, text FROM nodix_rem_memory_facets WHERE memory_id = ? ORDER BY facet")
				.all(currentId) as Array<Record<string, unknown>>;
			expect(new Set(facets.map((row) => row["facet"]))).toEqual(new Set(["history"]));
			const retractionFacets = fixture.database.sqlite
				.prepare("SELECT facet, text FROM nodix_rem_memory_facets WHERE memory_id = ?")
				.all(retractionId) as Array<Record<string, unknown>>;
			expect(retractionFacets).toEqual([
				expect.objectContaining({ facet: "current" }),
			]);
			expect(JSON.stringify(retractionFacets)).toMatch(/no longer|does not|stopped/iu);
			expect(
				fixture.database.sqlite
					.prepare("SELECT * FROM nodix_memories WHERE id = ?")
					.get(unsupportedId),
			).toBeDefined();
			expect(
				fixture.database.sqlite
					.prepare("SELECT count(*) AS count FROM nodix_rem_recovery_history WHERE row_id = ?")
					.get(currentId),
			).toMatchObject({ count: expect.any(Number) });
		} finally {
			await fixture.stop();
			await model.close();
		}
	});
});

function seedRetractionProductionRows(database: TestDb["sqlite"]): {
	currentId: string;
	retractionId: string;
	scope: string;
	unsupportedId: string;
} {
	const scope = "persona:production-update-output";
	const currentId = seedProductionMemory(database, {
		id: "clremoutputaffirmative000001",
		metadata: { section_name: "preferences.tea", topic: "preferences.tea" },
		scope,
		text: "The user likes jasmine tea every afternoon.",
		timestamp: "2026-08-08T08:00:00.000Z",
	});
	const retractionId = seedProductionMemory(database, {
		id: "clremoutputretraction0000001",
		metadata: { section_name: "preferences.tea", topic: "preferences.tea" },
		scope,
		text: "The user no longer likes jasmine tea in the afternoon.",
		timestamp: "2026-08-09T08:00:00.000Z",
	});
	const unsupportedId = seedProductionMemory(database, {
		id: "clremoutputunsupported00001",
		metadata: {
			rem_retired_section: "preferences.workspace",
			section_name: "preferences.workspace",
			topic: "preferences.workspace",
		},
		scope,
		text: "An advisory guess says the user prefers a standing desk.",
		timestamp: "2026-08-09T08:01:00.000Z",
	});
	return { currentId, retractionId, scope, unsupportedId };
}

function productionIdentity(response: Record<string, unknown>): string {
	for (const key of ["waveId", "wave_id", "job_id"]) {
		const value = response[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	throw new Error(`production response omitted wave identity: ${JSON.stringify(response)}`);
}
