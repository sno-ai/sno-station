/** Frozen independent encrypted-store foundations for OpenSpec task 2.3. */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installRemSchema } from "../../../../packages/sno-station-mem/src/engine/rem/index.ts";
import { splitExactClauses } from "../../../../packages/sno-station-mem/src/engine/rem/clause-splitter.ts";
import {
	AUTO_RECALL_INJECTION_TOP_K,
	DEFAULT_MIN_SCORE,
	DEFAULT_TOP_K,
} from "../../../../packages/sno-station-mem/config/index.ts";
import {
	DEFAULT_RETRIEVAL_CONFIG,
	createRetriever,
} from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever.ts";
import {
	retrieveForAutoRecall,
	retrieveForMemoryRecallOrEval,
} from "../../../../packages/sno-station-mem/src/engine/retrieval/rem-consumer-retrieval.ts";
import {
	createMemClawRemMutationExecutor,
	createMemClawRemRecovery,
	createRemReplaceCarrierPort,
} from "../../../../packages/sno-station-mem/src/store/rem-sqlite-adapter.ts";
import { openSqliteDatabaseReadonly } from "../../../../packages/sno-station-mem/src/store/sqlite-runtime.ts";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store.ts";
import { prepareRemEntryArtifactFixture } from "../../../apps/mem-claw/helpers/rem-entry-artifact-fixture.ts";
import {
	createRemOwnerDecidedOperationalConfiguration,
	createRemOwnerNullOperationalConfiguration,
} from "../../../apps/mem-claw/helpers/rem-entry-config-fixture.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";
import { seedRemWriteVerdict } from "../../../apps/mem-claw/helpers/rem-write-verdict-fixture.ts";
import {
	readJsonLines,
	runInstalledSno,
	startRemProductionEntryFixture,
} from "../../../apps/mem-claw/helpers/rem-production-entry-fixture.ts";

type ProductExports = Record<string, unknown>;
type Decision = { decision: "allow" | "refuse"; reasonCode: string | null };
type OrderedWaveResult =
	| { decision: "refuse"; reasonCode: string }
	| { decision: "allow"; reasonCode: null; waveId: string };
type SafeChildDecisionEvent = {
	event: "ordered_wave_refusal" | "update_decision_evaluated" | "update_refusal";
	job_id?: string;
	row_id?: string;
	outcome?: "allow" | "refuse";
	reason?: string;
	shape?: "list-prune" | "negated-current" | "value-swap";
	tier?: "list" | "prose";
	relation?: {
		alias_count: number;
		from_spans: Array<[number, number]>;
		to_spans: Array<[number, number]>;
		transition_clause_spans: Array<[number, number]>;
		transition_spans: Array<[number, number]>;
	};
	selection?: {
		atoms: Array<{
			class: "current-fact" | "event-fact" | "retired-fact";
			status: "covered" | "uncovered" | "undetermined";
			unit_id: string;
		}>;
		current_spans: Array<[number, number]>;
	};
};

const repoRootPath = join(import.meta.dirname, "../../../..");
const tsxBinary = join(repoRootPath, "node_modules/.bin/tsx");
const orderedWaveChild = join(
	import.meta.dirname,
	"../../../apps/mem-claw/helpers/run-rem-ordered-wave-child.ts",
);
const acc6Scope = "agent:rem-acc6-owner-decided";

async function loadBoundary<T>(modulePath: string, name: string): Promise<T> {
	const product = (await import(modulePath)) as ProductExports;
	const candidate = product[name];
	expect(candidate, `missing production foundation boundary ${name}`).toBeTypeOf("function");
	return candidate as T;
}

function seedWaveRows(fixture: TestDb): void {
	for (const [id, text, hash] of [
		["clremreplace", "The user prefers a standing desk.", "a".repeat(64)],
		["clremupdate", "The user moved from tea to coffee.", "b".repeat(64)],
	] as const) {
		fixture.runtime.raw
			.prepare("INSERT INTO nodix_memories(id,text,category,project_id,importance,timestamp,timezone,metadata,content_hash,fact_id,lane,raw_candidate_json) VALUES (?,?,'profile','rem-foundations',0.8,1,'UTC','{}',?,?,'active','{}')")
			.run(id, text, hash, `fact-${id}`);
	}
}

async function seedOwnerDecidedWaveRows(
	fixture: TestDb,
	store: MemoryStore,
): Promise<{
	replaceCurrentId: string;
	replaceStaleId: string;
	updateId: string;
	updateCurrentEventFact: string;
	updateOriginalText: string;
	updateTransitionEventFact: string;
}> {
	const replaceStaleId = "clremacc6stale000000000001";
	const replaceCurrentId = "clremacc6current0000000001";
	const updateId = "clremacc6update00000000001";
	const updateOriginalText =
		"The user currently prefers Yo-Yo Ma's cello works because they find the rich, expressive sound of the cello incredibly soothing and profound. This is a shift from their previous enjoyment of Duke Ellington's jazz.";
	const exactClauses = splitExactClauses(updateOriginalText);
	const toValue = "Yo-Yo Ma's cello works";
	const toStart = updateOriginalText.indexOf(toValue);
	const toEnd = toStart + toValue.length;
	const updateCurrentEventFact = exactClauses.find(
		(clause) => clause.start < toEnd && toStart < clause.end,
	)?.value;
	const updateTransitionEventFact = exactClauses.find((clause) =>
		clause.value.includes("Duke Ellington's jazz"),
	)?.value;
	if (toStart < 0 || updateCurrentEventFact === undefined || updateTransitionEventFact === undefined) {
		throw new Error("missing deterministic update event clauses");
	}
	if (updateCurrentEventFact.length !== 77 || updateTransitionEventFact.length !== 71) {
		throw new Error("unexpected deterministic update event clause geometry");
	}
	const rows = [
		{
			id: replaceStaleId,
			text: "The current Atlas deployment region is us-east-1.",
			timestamp: Date.parse("2026-08-01T00:00:00.000Z"),
			metadata: {
				section_name: "preferences.acc6-atlas-region",
				topic: "preferences.acc6-atlas-region",
				valid_from: "2026-08-01T00:00:00.000Z",
			},
		},
		{
			id: replaceCurrentId,
			text: "The current Atlas deployment region is us-west-2.",
			timestamp: Date.parse("2026-08-02T00:00:00.000Z"),
			metadata: {
				section_name: "preferences.acc6-atlas-region-current",
				topic: "preferences.acc6-atlas-region",
				valid_from: "2026-08-02T00:00:00.000Z",
			},
		},
		{
			id: updateId,
			text: updateOriginalText,
			timestamp: Date.parse("2026-08-03T00:00:00.000Z"),
			metadata: {
				locale: "en",
				section_name: "preferences.acc6-music",
				topic: "preferences.acc6-music",
			},
		},
	] as const;
	for (const row of rows) {
		const contentHash = createHash("sha256").update(row.text).digest("hex");
		await store.importEntry({
			id: row.id,
			text: row.text,
			category: "profile",
			projectId: acc6Scope,
			importance: 0.8,
			timestamp: row.timestamp,
			metadata: JSON.stringify(row.metadata),
			contentHash,
			lane: "active",
			trusted: true,
		});
		fixture.runtime.raw
			.prepare("UPDATE nodix_memories SET raw_candidate_json = ? WHERE id = ?")
			.run(JSON.stringify({ source: row.text, metadata: row.metadata }), row.id);
	}
	return {
		replaceCurrentId,
		replaceStaleId,
		updateCurrentEventFact,
		updateId,
		updateOriginalText,
		updateTransitionEventFact,
	};
}

async function runOwnerDecidedWaveChild(input: {
	configSource: string;
	dbPath: string;
	stateRoot: string;
}): Promise<{ decisionEvents: SafeChildDecisionEvent[]; result: OrderedWaveResult }> {
	const child = spawn(
		"doppler",
		["run", "-p", "sno-station-core", "-c", "dev", "--", tsxBinary, orderedWaveChild],
		{
		env: {
			...process.env,
			SNO_STATION_MEM_REM_EXPECTED_DB_PATH: input.dbPath,
			OPENCLAW_STATE_DIR: input.stateRoot,
			REM_ACC6_CONFIG_SOURCE: input.configSource,
			REM_ACC6_PERSONA_DB_PATH: input.dbPath,
			REM_ACC6_SCOPE: acc6Scope,
			REM_ACC6_STATE_ROOT: input.stateRoot,
		},
		stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr.push(chunk);
		process.stderr.write(chunk);
		for (const line of chunk.toString("utf8").split("\n")) {
			if (line.includes("_progress") || line.includes("llm_provider_response")) {
				console.info("[acc6-child-progress] " + line);
			}
		}
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
	const [status, signal] = (await once(child, "exit")) as [
		number | null,
		NodeJS.Signals | null,
	];
	clearTimeout(timer);
	const stderrText = Buffer.concat(stderr).toString("utf8");
	const decisionEvents = extractSafeChildDecisionEvents(stderrText);
	for (const event of decisionEvents) {
		console.info("[acc6-child-decision] " + JSON.stringify(event));
	}
	expect(
		{ signal, status },
		"ordered-wave child failed; safe decisions: " + JSON.stringify(decisionEvents),
	).toEqual({
		signal: null,
		status: 0,
	});
	const result = JSON.parse(Buffer.concat(stdout).toString("utf8").trim()) as OrderedWaveResult;
	if (result.decision === "refuse") {
		const event = {
			event: "ordered_wave_refusal",
			reason: result.reasonCode,
		} as const;
		decisionEvents.push(event);
		console.info("[acc6-child-decision] " + JSON.stringify(event));
	}
	return {
		decisionEvents,
		result,
	};
}

function extractSafeChildDecisionEvents(stderrText: string): SafeChildDecisionEvent[] {
	const events: SafeChildDecisionEvent[] = [];
	for (const line of stderrText.split("\n")) {
		if (line.includes("update_decision_evaluated")) {
			const jsonStart = line.indexOf("{");
			if (jsonStart < 0) continue;
			try {
				const value = JSON.parse(line.slice(jsonStart)) as Record<string, unknown>;
				const outcome = value["outcome"];
				const event: SafeChildDecisionEvent = { event: "update_decision_evaluated" };
				if (typeof value["job_id"] === "string") event.job_id = value["job_id"];
				if (typeof value["row_id"] === "string") event.row_id = value["row_id"];
				if (outcome === "allow" || outcome === "refuse") event.outcome = outcome;
				if (typeof value["reason"] === "string") event.reason = value["reason"];
				if (
					value["shape"] === "list-prune" ||
					value["shape"] === "negated-current" ||
					value["shape"] === "value-swap"
				) {
					event.shape = value["shape"];
				}
				if (value["tier"] === "list" || value["tier"] === "prose") {
					event.tier = value["tier"];
				}
				const relation = asRecord(value["relation"]);
				if (relation !== undefined) {
					event.relation = {
						alias_count: Array.isArray(relation["aliases"]) ? relation["aliases"].length : 0,
						from_spans: safeSpanArray(relation["fromSpans"]),
						to_spans: safeSpanArray(relation["toSpans"]),
						transition_clause_spans: safeSpanArray(relation["transitionClauseSpans"]),
						transition_spans: safeSpanArray(relation["transitionSpans"]),
					};
				}
				const selection = asRecord(value["selection"]);
				if (selection !== undefined) {
					event.selection = {
						atoms: safeAtomArray(selection["atoms"]),
						current_spans: safeSpanArray(selection["currentSpans"]),
					};
				}
				events.push(event);
			} catch {
				continue;
			}
		}
		const refusal = line.match(/REM LLM calls all failed: ([a-z0-9_-]+)/u)?.[1];
		if (refusal !== undefined) events.push({ event: "update_refusal", reason: refusal });
	}
	return events;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function safeSpanArray(value: unknown): Array<[number, number]> {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const span = asRecord(item);
		const start = span?.["start"];
		const end = span?.["end"];
		return Number.isInteger(start) && Number.isInteger(end)
			? [[start as number, end as number] satisfies [number, number]]
			: [];
	});
}

function safeAtomArray(value: unknown): NonNullable<SafeChildDecisionEvent["selection"]>["atoms"] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const atom = asRecord(item);
		const unitId = atom?.["unitId"];
		const atomClass = atom?.["class"];
		const status = atom?.["status"];
		if (
			typeof unitId !== "string" ||
			!/^(?:anchor|clause|member):\d+$/u.test(unitId) ||
			(atomClass !== "current-fact" &&
				atomClass !== "event-fact" &&
				atomClass !== "retired-fact") ||
			(status !== "covered" && status !== "uncovered" && status !== "undetermined")
		) {
			return [];
		}
		return [{ class: atomClass, status, unit_id: unitId }];
	});
}

describe("REM ordered wave", () => {
	it("refuses the ordered wave before any stage while the coverage floor is unset", async () => {
		const fixture = createTestDb();
		installRemSchema(fixture.runtime.db);
		seedWaveRows(fixture);
		try {
			const before = readFileSync(fixture.dbPath);
			const run = await loadBoundary<(input: Record<string, unknown>) => Promise<Decision>>(
				"../../../../packages/sno-station-mem/src/sidecar/rem-batch-executor.ts",
				"runRemOrderedWave",
			);
			const result = await run({
				database: fixture.runtime.db,
				configuration: createRemOwnerNullOperationalConfiguration(),
			});
			expect(result).toEqual({ decision: "refuse", reasonCode: "coverage.accuracyFloor" });
			expect(readFileSync(fixture.dbPath)).toEqual(before);
		} finally {
			fixture.cleanup();
		}
	});

	it("ACC-17 refuses a whitespace scope before any database file is opened", async () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "rem-req19-blank-scope-"));
		try {
			const configSource = prepareRemEntryArtifactFixture(
				stateRoot,
				"valid",
				createRemOwnerDecidedOperationalConfiguration(),
			);
			const personaDbPath = join(stateRoot, "never-created", "persona.sqlite");
			const run = await loadBoundary<
				(input: Record<string, unknown>) => Promise<OrderedWaveResult>
			>(
				"../../../../packages/sno-station-mem/src/sidecar/rem-batch-executor.ts",
				"runRemProductionOrderedWave",
			);

			const result = await run({
				stateRoot,
				personaDbPath,
				configSource,
				// Whitespace, not the empty string: the guard trims, and an empty string would pass a
				// plain length check just as well, so it could not tell the two implementations apart.
				scope: "   ",
			});

			// The exact reasonCode IS the oracle, and loosening this to toMatchObject destroys the
			// proof. Every step after the guard produces a DIFFERENT observable on a persona path that
			// does not exist: `runRemEntryPreflight` refuses through `validateRemEntryArtifacts` with
			// its own reasonCode, and `openSqliteDatabaseReadonly` beneath it throws. So an
			// implementation that opened a database before refusing cannot return `scope_required` —
			// it returns some other code, or it throws.
			expect(result).toEqual({ decision: "refuse", reasonCode: "scope_required" });
			// Nothing was opened, so nothing was created either.
			expect(existsSync(personaDbPath)).toBe(false);
			expect(existsSync(join(stateRoot, "never-created"))).toBe(false);
		} finally {
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	it("ACC-17 keeps configuration refusals ahead of the blank-scope refusal", async () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "rem-req19-precedence-"));
		try {
			const run = await loadBoundary<
				(input: Record<string, unknown>) => Promise<OrderedWaveResult>
			>(
				"../../../../packages/sno-station-mem/src/sidecar/rem-batch-executor.ts",
				"runRemProductionOrderedWave",
			);

			const result = await run({
				stateRoot,
				personaDbPath: join(stateRoot, "never-created", "persona.sqlite"),
				configSource: "{ not json",
				scope: "   ",
			});

			// The scope guard sits AFTER the configuration gates on purpose. Moving it to the top of
			// the function would silently reorder error priority for a caller carrying both faults,
			// and this case is what notices.
			expect(result).toEqual({ decision: "refuse", reasonCode: "enable_config_malformed" });
		} finally {
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	it(
		"leaves one real replace effect and one real update effect under one wave id",
		{ timeout: 100_000 },
		async () => {
			const fixture = createTestDb();
			const stateRoot = mkdtempSync(join(tmpdir(), "rem-acc6-owner-decided-"));
			try {
				const embedder = await createTestEmbedder();
				const supportStore = new MemoryStore({ dbPath: fixture.dbPath, embedder });
				const supportRows: Array<{ fact: string; id: string }> = [];
				let seeded: Awaited<ReturnType<typeof seedOwnerDecidedWaveRows>> | undefined;
				try {
					const seededRows = await seedOwnerDecidedWaveRows(fixture, supportStore);
					seeded = seededRows;
					for (const support of [
						{
							fact: seededRows.updateCurrentEventFact,
							sectionName: "events.acc6-music-current",
						},
						{
							fact: seededRows.updateTransitionEventFact,
							sectionName: "events.acc6-music-transition",
						},
					]) {
						const row = await supportStore.store({
							text: support.fact,
							category: "persona",
							projectId: acc6Scope,
							importance: 0.8,
							metadata: JSON.stringify({ section_name: support.sectionName }),
							offlineFamily: true,
						});
						supportRows.push({ fact: support.fact, id: row.id });
					}
					// Each seeded support row is a carrier for the event the update row is about to
					// rewrite, so the close-side gate must report every one of them as retained.
					for (const support of supportRows) {
						const carrier = createRemReplaceCarrierPort({
							database: fixture.runtime.db,
							winnerRowId: support.id,
							loserRowId: seededRows.updateId,
							loserProjectId: acc6Scope,
							loserCategory: "persona",
						});
						await expect(carrier.carrierState()).resolves.toEqual({ retained: true });
					}
				} finally {
					await supportStore.close();
				}
				if (seeded === undefined) throw new Error("owner-decided wave rows were not seeded");
				const readProductionCandidates = await loadBoundary<
					(database: TestDb["runtime"]["db"], scope: string) => Array<{ id: string }>
				>("../../../../packages/sno-station-mem/src/sidecar/rem-batch-executor.ts", "readCandidates");
				expect(
					readProductionCandidates(fixture.runtime.db, acc6Scope)
						.map((row) => row.id)
						.sort(),
				).toEqual([seeded.replaceCurrentId, seeded.replaceStaleId, seeded.updateId].sort());
				writeFileSync(
					join(stateRoot, "openclaw.json"),
					JSON.stringify({
						plugins: {
							entries: {
								"sno-mem-claw": {
									config: {
										dbPath: fixture.dbPath,
										embedding: { dimensions: 1024, provider: "local-onnx" },
									},
								},
							},
						},
					}),
				);
				const configuration = createRemOwnerDecidedOperationalConfiguration();
				const configSource = prepareRemEntryArtifactFixture(
					stateRoot,
					"valid",
					configuration,
				);
				fixture.runtime.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
				fixture.runtime.raw.close();

				const child = await runOwnerDecidedWaveChild({
					configSource,
					dbPath: fixture.dbPath,
					stateRoot,
				});
				expect(child.result).toMatchObject({ decision: "allow", reasonCode: null });
				if (child.result.decision !== "allow") throw new Error(child.result.reasonCode);

				const reopened = openSqliteDatabaseReadonly(fixture.dbPath);
				try {
					const waveId = child.result.waveId;
					const supportRowReadbacks = supportRows.map((support) => {
						const supportRow = reopened.db
							.prepare("SELECT id, category, lane FROM nodix_memories WHERE id = ?")
							.get(support.id) as Record<string, unknown> | undefined;
						expect(supportRow).toEqual({ id: support.id, category: "persona", lane: "active" });
						return supportRow;
					});
					const affectedRows = reopened.db
						.prepare(
							"SELECT id, text, metadata, lane FROM nodix_memories WHERE id IN (?, ?, ?) ORDER BY id",
						)
						.all(seeded.replaceStaleId, seeded.replaceCurrentId, seeded.updateId) as Array<
						Record<string, unknown>
					>;
					const stale = affectedRows.find((row) => row["id"] === seeded.replaceStaleId);
					const updated = affectedRows.find((row) => row["id"] === seeded.updateId);
					expect(JSON.parse(String(stale?.["metadata"]))["superseded_by"]).toBe(
						seeded.replaceCurrentId,
					);
					expect(updated?.["text"]).not.toBe(seeded.updateOriginalText);
					expect(String(updated?.["text"])).toContain("Yo-Yo Ma");
					expect(String(updated?.["text"])).not.toContain("Duke Ellington");

					const facets = reopened.db
						.prepare(
							"SELECT memory_id, facet, text FROM nodix_rem_memory_facets WHERE memory_id = ? ORDER BY facet",
						)
						.all(seeded.updateId) as Array<Record<string, unknown>>;
					const chunks = reopened.db
						.prepare(
							"SELECT memory_id, facet, chunk_text FROM nodix_memory_chunks WHERE memory_id = ? ORDER BY facet, chunk_index",
						)
						.all(seeded.updateId) as Array<Record<string, unknown>>;
					expect(facets).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								facet: "history",
								text: seeded.updateOriginalText,
							}),
						]),
					);
					expect(new Set(chunks.map((row) => row["facet"]))).toEqual(
						new Set(["current", "history"]),
					);

					const journal = reopened.db
						.prepare(
							"SELECT sequence, job_id, job_type, stage, outcome, actions_applied FROM nodix_rem_journal WHERE job_id = ? ORDER BY sequence",
						)
						.all(waveId) as Array<Record<string, unknown>>;
					const replaceOutcomes = journal.filter(
						(row) => row["job_type"] === "rem-replace" && Number(row["actions_applied"]) > 0,
					);
					const updateOutcomes = journal.filter(
						(row) => row["job_type"] === "rem-update" && Number(row["actions_applied"]) > 0,
					);
					expect(replaceOutcomes.length).toBeGreaterThan(0);
					expect(updateOutcomes.length).toBeGreaterThan(0);
					expect(Math.max(...replaceOutcomes.map((row) => Number(row["sequence"])))).toBeLessThan(
						Math.min(...updateOutcomes.map((row) => Number(row["sequence"]))),
					);

					const census = {
						claims: reopened.db.prepare("SELECT * FROM nodix_rem_row_claims ORDER BY row_id").all(),
						generations: reopened.db
							.prepare("SELECT * FROM nodix_rem_scan_generations ORDER BY generation_id")
							.all(),
						ledger: reopened.db
							.prepare("SELECT * FROM nodix_rem_relation_ledger ORDER BY row_id")
							.all(),
						pairs: reopened.db
							.prepare("SELECT * FROM nodix_rem_scan_pairs ORDER BY generation_id, pair_id")
							.all(),
					};
					expect(census.generations.length).toBeGreaterThan(0);
					expect(census.pairs.length).toBeGreaterThan(0);
					expect(census.ledger.length).toBeGreaterThanOrEqual(affectedRows.length);
					expect(census.claims.length).toBeGreaterThanOrEqual(affectedRows.length);

					const configuredDigests = (
						JSON.parse(configSource)["enableGateDigests"] as Record<string, string>
					);
					const gateDigests = Object.fromEntries(
						Object.entries(configuredDigests).map(([artifactId, digest]) => [
							artifactId,
							{
								digest,
								readback: createHash("sha256")
									.update(
										readFileSync(
											join(stateRoot, "sno-station-mem", "rem-gates", artifactId + ".json"),
										),
									)
									.digest("hex"),
							},
						]),
					);
					expect(
						Object.values(gateDigests).every((entry) => entry.digest === entry.readback),
					).toBe(true);
					console.info(
						"[acc6-durable-readback] " +
							JSON.stringify({
								affectedRows,
								censusCounts: Object.fromEntries(
									Object.entries(census).map(([name, rows]) => [name, rows.length]),
								),
								chunkFacets: chunks.map((row) => row["facet"]),
								facetKinds: facets.map((row) => row["facet"]),
								gateDigests,
								journal,
								safeDecisionEvents: child.decisionEvents,
								supportRows: supportRowReadbacks,
								waveId,
							}),
					);
				} finally {
					reopened.db.close();
				}
			} finally {
				fixture.cleanup();
				rmSync(stateRoot, { recursive: true, force: true });
			}
		},
	);

	it("rejects journal-only stage markers as substantive wave effects", async () => {
		const fixture = createTestDb();
		installRemSchema(fixture.runtime.db);
		try {
			fixture.runtime.raw
				.prepare(
					"INSERT INTO nodix_rem_journal(job_id,job_type,stage,row_id,outcome,reason) VALUES ('wave-journal-only','rem-update','rem-replace-pair','row-a','done','stub'),('wave-journal-only','rem-update','rem-update','row-b','done','stub')",
				)
				.run();
			const validate = await loadBoundary<(input: Record<string, unknown>) => Decision>(
				"../../../../packages/sno-station-mem/src/engine/rem/index.ts",
				"validateRemSubstantiveWaveEffects",
			);
			expect(validate({ database: fixture.runtime.db, waveId: "wave-journal-only" })).toEqual({ decision: "refuse", reasonCode: "journal_only" });
		} finally {
			fixture.cleanup();
		}
	});
});

function guardFixture(kind: string): { root: string; input: Record<string, unknown>; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "rem-guard-census-"));
	const sourceRoot = join(root, "src");
	mkdirSync(sourceRoot);
	const guardId = "guard.rem.entry";
	const manifestRows = kind === "source-only" || kind === "empty" ? [] : [{ guardId, module: "guard.ts", export: "guardEntry", productionRoots: ["entry.ts"], requirementIds: ["REQ-6"] }];
	const requiredRows = kind === "required-missing" || kind === "empty" ? [] : [{ requirementId: "REQ-6", protection: "entry", guardId }];
	const guardSource = kind === "manifest-only" || kind === "empty" ? "export const harmless = true;" : kind === "unmarked" ? "export function guardEntry(): RemRefusalCode { return 'artifact_missing'; }" : "export const guardEntry = defineRemSafetyGuard({ guardId: 'guard.rem.entry' }, () => true);";
	const entrySource = kind === "unreachable" ? "export const startRemSidecar = () => true;" : "import { guardEntry } from './guard'; export const startRemSidecar = () => guardEntry();";
	writeFileSync(join(sourceRoot, "guard.ts"), guardSource);
	writeFileSync(join(sourceRoot, "entry.ts"), entrySource);
	const manifestPath = join(root, "guard-manifest.json");
	const requiredGuardsPath = join(root, "required-guards.json");
	writeFileSync(manifestPath, JSON.stringify(manifestRows));
	writeFileSync(requiredGuardsPath, JSON.stringify(requiredRows));
	return { root, input: { manifestPath, requiredGuardsPath, sourceRoots: [sourceRoot], productionRoots: [join(sourceRoot, "entry.ts")] }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("REM independently enumerated guard census", () => {
	it.each([
		{ kind: "manifest-only", reason: "manifest_source_inequality" },
		{ kind: "source-only", reason: "manifest_source_inequality" },
		{ kind: "empty", reason: "guard_inventory_empty" },
		{ kind: "required-missing", reason: "required_protection_missing" },
		{ kind: "unmarked", reason: "unmarked_guard" },
		{ kind: "unreachable", reason: "guard_unreachable" },
		{ kind: "complete", reason: null },
	] as const)("validates the $kind source and manifest fixture", async ({ kind, reason }) => {
		const fixture =
			kind === "complete"
				? {
						root: repoRoot(),
						input: {
							manifestPath: join(repoRoot(), "apps/mem-claw/config/rem/guard-manifest.json"),
							requiredGuardsPath: join(repoRoot(), "apps/mem-claw/config/rem/required-guards.json"),
							sourceRoots: [join(repoRoot(), "packages/rem-core"), join(repoRoot(), "packages/sno-station-mem/src/sidecar")],
							productionRoots: [join(repoRoot(), "packages/sno-station-mem/src/sidecar/main.ts")],
						},
						cleanup: () => undefined,
					}
				: guardFixture(kind);
		try {
			const validate = await loadBoundary<(input: Record<string, unknown>) => Decision>(
				"../../../../packages/sno-station-mem/src/engine/rem/index.ts",
				"validateRemGuardCensus",
			);
			expect(validate(fixture.input)).toEqual({ decision: reason === null ? "allow" : "refuse", reasonCode: reason });
		} finally {
			fixture.cleanup();
		}
	});
});

describe("REM two-facet persistence", () => {
	it("replaces prior history chunks and restores a repeated update", async () => {
		const fixture = createTestDb();
		const store = new MemoryStore({ dbPath: fixture.dbPath, embedder: await createTestEmbedder() });
		try {
			const stored = await store.store({
				text: "The user prefers tea in the morning and keeps the cup beside the desk.",
				category: "episodic",
				projectId: "rem-repeat-update",
				importance: 0.8,
			});
			const original = store.sqlite
				.prepare("SELECT content_hash FROM nodix_memories WHERE id = ?")
				.get(stored.id) as { content_hash: string };
			const firstText = "The user prefers coffee in the morning and keeps the cup beside the desk.";
			const first = await store.applyRemTextVersion({
				jobId: "test-job",
				jobType: "rem-update",
				rowId: stored.id,
				plannedContentHash: original.content_hash,
				replacementText: firstText,
				historyText: stored.text,
				reason: "First repeated-update regression step.",
				timestamp: "2026-08-11T08:00:00.000Z",
			});
			if (!first.applied) throw new Error(`first update refused: ${first.reason}`);
			const firstChunks = store.sqlite
				.prepare(
					"SELECT chunk_id, facet, chunk_index FROM nodix_memory_chunks WHERE memory_id = ? ORDER BY chunk_id",
				)
				.all(stored.id);
			const firstFacets = store.sqlite
				.prepare(
					"SELECT facet, text, updated_at_ms FROM nodix_rem_memory_facets WHERE memory_id = ? ORDER BY facet",
				)
				.all(stored.id);

			const second = await store.applyRemTextVersion({
				jobId: "test-job",
				jobType: "rem-update",
				rowId: stored.id,
				plannedContentHash: first.contentHash,
				replacementText: "The user prefers water in the morning and keeps the glass beside the desk.",
				historyText: firstText,
				reason: "Second repeated-update regression step.",
				timestamp: "2026-08-11T08:01:00.000Z",
			});
			if (!second.applied) throw new Error(`second update refused: ${second.reason}`);

			const chunks = store.sqlite
				.prepare(
					"SELECT facet, chunk_index FROM nodix_memory_chunks WHERE memory_id = ? ORDER BY facet, chunk_index",
				)
				.all(stored.id) as Array<{ facet: string; chunk_index: number }>;
			expect(chunks.some(({ facet }) => facet === "current")).toBe(true);
			expect(chunks.some(({ facet }) => facet === "history")).toBe(true);
				expect(new Set(chunks.map(({ facet, chunk_index }) => `${facet}:${chunk_index}`)).size).toBe(
					chunks.length,
				);
				// The facet write already stores the new chunks, their vectors and the
				// full-text rows, so it no longer queues grooming nobody performs. A journal
				// with standing pending rows reads as outstanding work that never lands.
				expect(
					store.sqlite
						.prepare(
							"SELECT stage FROM nodix_rem_journal WHERE outcome = 'pending' ORDER BY stage",
						)
						.all(),
				).toEqual([]);

			store.sqlite.markFailed("repeat-update recovery proof");
			createMemClawRemRecovery(store.sqlite).restoreTextVersion(second.recoveryHandle);
			const restored = store.sqlite.runRecoveryOperation((database) => ({
				row: database
					.prepare("SELECT text, content_hash FROM nodix_memories WHERE id = ?")
					.get(stored.id),
				chunks: database
					.prepare(
						"SELECT chunk_id, facet, chunk_index FROM nodix_memory_chunks WHERE memory_id = ? ORDER BY chunk_id",
					)
					.all(stored.id),
				facets: database
					.prepare(
						"SELECT facet, text, updated_at_ms FROM nodix_rem_memory_facets WHERE memory_id = ? ORDER BY facet",
					)
					.all(stored.id),
			}));
			expect(restored.row).toEqual({ text: firstText, content_hash: first.contentHash });
			expect(restored.chunks).toEqual(firstChunks);
			expect(restored.facets).toEqual(firstFacets);
			} finally {
			store.close();
			fixture.cleanup();
		}
	});

	it("migrates a previous encrypted store into the declared facet schema", async () => {
		const fixture = createTestDb();
		try {
			const migrate = await loadBoundary<(input: Record<string, unknown>) => void>("../../../../packages/sno-station-mem/src/store/migrations.ts", "applyRemTwoFacetMigration");
			migrate({ database: fixture.runtime.db });
			expect(fixture.runtime.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='nodix_rem_memory_facets'").get()).toBeDefined();
		} finally { fixture.cleanup(); }
	});

	it("rolls back row, facets, chunks, recovery, and audit together on failure", async () => {
		const fixture = createTestDb(); installRemSchema(fixture.runtime.db); seedWaveRows(fixture);
		try {
			const before = sha256DurabilityUnit(fixture);
			fixture.runtime.raw.exec("CREATE TRIGGER rem_foundation_abort BEFORE UPDATE ON nodix_memories BEGIN SELECT RAISE(ABORT,'abort'); END");
			const write = await loadBoundary<(input: Record<string, unknown>) => Promise<void>>("../../../../packages/sno-station-mem/src/engine/rem/index.ts", "writeRemTwoFacetTransaction");
			await expect(write({ database: fixture.runtime.db, memoryId: "clremupdate", current: "coffee", history: "tea" })).rejects.toThrow();
			expect(sha256DurabilityUnit(fixture)).toBe(before);
		} finally { fixture.cleanup(); }
	});

	it("uses the declared facet index in the actual production recall statement", async () => {
		const fixture = createTestDb();
		installRemSchema(fixture.runtime.db);
		try {
			const build = await loadBoundary<(input: { facet: "current" }) => { sql: string; parameters: unknown[] }>(
				"../../../../packages/sno-station-mem/src/engine/retrieval/retriever-search-modes.ts",
				"buildRemFacetRecallStatement",
			);
			const statement = build({ facet: "current" });
			const plan = fixture.runtime.raw
				.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
				.all(...statement.parameters) as Array<{ detail: string }>;
			expect(plan.map(({ detail }) => detail).join(" ")).toMatch(/facet.*index|index.*facet/i);
		} finally { fixture.cleanup(); }
	});

	it("exports one shared facet resolver for recall and eval answer assembly", async () => {
		const core = (await import("../../../../packages/sno-station-mem/src/engine/rem/index.ts")) as ProductExports;
		expect(core["resolveRecallFacetPolicy"]).toBeUndefined();
		expect(core["resolveEvalFacetPolicy"]).toBeUndefined();
	});

	it("keeps history out of automatic context injection", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const retriever = {
			retrieve: async (input: Record<string, unknown>) => {
				calls.push(input);
				return [];
			},
		} as unknown as Parameters<typeof retrieveForAutoRecall>[0];

		await retrieveForAutoRecall(retriever, {
			query: "current preference",
			limit: 3,
			scopeFilter: ["global"],
			nowMs: 1,
		});

		expect(calls).toEqual([
			expect.objectContaining({
				source: "auto-recall",
				facetPolicy: "current-only",
			}),
		]);
	});

	it("restores untouched migrated-store bytes exactly", async () => {
		const fixture = createTestDb();
		try {
			const before = readFileSync(fixture.dbPath);
			const migrate = await loadBoundary<(input: Record<string, unknown>) => void>("../../../../packages/sno-station-mem/src/store/migrations.ts", "applyRemTwoFacetMigration");
			const rollback = await loadBoundary<(input: Record<string, unknown>) => Decision>("../../../../packages/sno-station-mem/src/store/migrations.ts", "rollbackRemTwoFacetMigration");
			migrate({ database: fixture.runtime.db });
			expect(rollback({ database: fixture.runtime.db })).toEqual({ decision: "allow", reasonCode: null });
			expect(readFileSync(fixture.dbPath)).toEqual(before);
		} finally { fixture.cleanup(); }
	});

	it("refuses rollback after a post-migration write and preserves bytes", async () => {
		const fixture = createTestDb();
		seedWaveRows(fixture);
		try {
			const migrate = await loadBoundary<(input: Record<string, unknown>) => void>("../../../../packages/sno-station-mem/src/store/migrations.ts", "applyRemTwoFacetMigration");
			const rollback = await loadBoundary<(input: Record<string, unknown>) => Decision>("../../../../packages/sno-station-mem/src/store/migrations.ts", "rollbackRemTwoFacetMigration");
			migrate({ database: fixture.runtime.db });
			installRemSchema(fixture.runtime.db);
			const evidenceId = "evidence-post-migration-write";
			seedRemWriteVerdict(fixture, { rowId: "clremupdate", evidenceId });
			const executor = createMemClawRemMutationExecutor({
				database: fixture.runtime.db,
				jobType: "rem-update",
				configurationSha256: "c".repeat(64),
				liveContentionRetries: 0,
			});
			const replacementText = "The user now prefers coffee.";
			const attempt = await executor.openAttempt({
				jobId: "test-job",
				stage: "rem-update",
				rowId: "clremupdate",
				writer: "writeTextVersion",
				authorization: {
					rowId: "clremupdate",
					preWriteContentSha256: "b".repeat(64),
					proposedTextSha256: createHash("sha256").update(replacementText).digest("hex"),
					evidenceId,
					configurationSha256: "c".repeat(64),
				},
			});
			const resolution = await executor.mutateAttempt(attempt, {
				kind: "writeTextVersion",
				replacementText: "The user now prefers coffee.",
				reason: "post-migration writer proof",
				timestamp: "2026-08-08T08:01:00.000Z",
			});
			expect(await executor.closeAttempt(attempt, resolution)).toMatchObject({
				applied: true,
				outcome: "succeeded",
			});
			const before = readFileSync(fixture.dbPath);
			expect(rollback({ database: fixture.runtime.db })).toEqual({ decision: "refuse", reasonCode: "post_migration_writes" });
			expect(readFileSync(fixture.dbPath)).toEqual(before);
		} finally {
			fixture.cleanup();
		}
	});
});

function sha256DurabilityUnit(fixture: TestDb): string {
	const tables = [
		"nodix_memories",
		"nodix_rem_memory_facets",
		"nodix_memory_chunks",
		"nodix_rem_recovery_history",
		"nodix_rem_facet_recovery",
		"nodix_memory_events",
		"nodix_rem_journal",
	] as const;
	const state = Object.fromEntries(
		tables.map((table) => [
			table,
			fixture.runtime.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
		]),
	);
	return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

function repoRoot(): string {
	return join(import.meta.dirname, "../../../..");
}

describe.sequential("ACC-37 production edge: ordered wave governance", () => {
	it("continues the enabled operation when its wave sibling is disabled", { timeout: 20_000 }, async () => {
		const configuration = createRemOwnerDecidedOperationalConfiguration();
		if (typeof configuration["operations"] !== "object" || configuration["operations"] === null) {
			throw new Error("REM test configuration omitted operations");
		}
		Reflect.set(configuration["operations"], "rem-update", false);
		const fixture = await startRemProductionEntryFixture({ configuration });
		try {
			const wave = await fixture.submitWave(
				["rem-replace", "rem-update"],
				"persona:disabled-operation-wave",
				"correlation-disabled-operation-wave",
			);
			const terminal = await fixture.waitForTerminal(productionIdentity(wave), 10_000);
			expect(terminal).toMatchObject({
				state: "done",
				stats: { operations: 0, top_refusal_reasons: ["switched-off:rem-update"] },
			});
			const chassisJournal = readJsonLines(
				join(fixture.stateRoot, "sno-station-mem", "rem-chassis-journal.jsonl"),
			);
			expect(chassisJournal).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ stage: "rem-update", outcome: "refused" }),
				]),
			);
			const runtimeJournal = fixture.database.sqlite
				.prepare("SELECT stage, outcome FROM nodix_rem_journal WHERE job_id = ? ORDER BY sequence")
				.all(productionIdentity(wave));
			expect(runtimeJournal).toEqual(
				expect.arrayContaining([expect.objectContaining({ stage: "rem-replace" })]),
			);
		} finally {
			await fixture.stop();
		}
	});

	it("coalesces POST requests and applies substantive validation under one wave id", { timeout: 20_000 }, async () => {
		const fixture = await startRemProductionEntryFixture();
		try {
			const correlationId = "correlation-acc37-ordered-wave";
			const scope = "persona:acc37-ordered-wave";
			const wave = await fixture.submitWave(
				["rem-replace", "rem-update"],
				scope,
				correlationId,
			);
			const waveId = productionIdentity(wave);
			const terminal = await fixture.waitForTerminal(waveId, 10_000);
			expect(terminal["state"]).toBe("done");
			const jobs = readJsonLines(join(fixture.stateRoot, "sno-station-mem", "rem-wave-jobs.jsonl"));
			const durable = jobs.findLast(
				(row) =>
					(row["waveId"] === waveId || row["wave_id"] === waveId) &&
					row["state"] === "done",
			);
			expect(durable).toMatchObject({
				payloadVersion: 1,
				requestedOperations: ["rem-replace", "rem-update"],
				scope,
			});
			const terminalJournal = readJsonLines(
				join(fixture.stateRoot, "sno-station-mem", "rem-chassis-journal.jsonl"),
			).filter((row) => row["job_id"] === waveId && row["outcome"] === "no-action");
			expect(
				terminalJournal.map((row) => ({
					jobType: row["job_type"],
					stage: row["stage"],
					actionsApplied: row["actions_applied"],
				})),
			).toEqual([
				{ jobType: "rem-replace", stage: "rem-replace", actionsApplied: 0 },
				{ jobType: "rem-update", stage: "rem-update", actionsApplied: 0 },
			]);
		} finally {
			await fixture.stop();
		}
	});

	it("finishes the wave when the chassis journal cannot append", { timeout: 20_000 }, async () => {
		const fixture = await startRemProductionEntryFixture();
		try {
			const journalPath = join(fixture.stateRoot, "sno-station-mem", "rem-chassis-journal.jsonl");
			mkdirSync(journalPath, { recursive: true });
			const wave = await fixture.submitWave(
				["rem-replace", "rem-update"],
				"persona:journal-write-failure",
				"correlation-journal-write-failure",
			);
			const terminal = await fixture.waitForTerminal(productionIdentity(wave), 10_000);
			expect(terminal["state"]).toBe("done");
			expect(fixture.stderr()).toContain("job_completion_journal_failed");
		} finally {
			await fixture.stop();
		}
	});
});

describe.sequential("ACC-34 production POST enters one versioned ordered wave", () => {
	it("one request creates one one-operation wave", { timeout: 20_000 }, async () => {
		const fixture = await startRemProductionEntryFixture();
		try {
			const response = await fixture.submit(
				"rem-replace",
				"persona:acc34-one-operation",
				"correlation-acc34-one-operation",
			);
			const waveId = productionIdentity(response);
			await fixture.waitForTerminal(waveId, 10_000);
			const rows = readJsonLines(join(fixture.stateRoot, "sno-station-mem", "rem-wave-jobs.jsonl"));
			expect(rows.findLast((row) => row["waveId"] === waveId || row["wave_id"] === waveId)).toMatchObject({
				payloadVersion: 1,
				requestedOperations: ["rem-replace"],
			});
		} finally {
			await fixture.stop();
		}
	});

	it("uses the host-configured database when the runner path fence is absent", { timeout: 20_000 }, async () => {
		const fixture = await startRemProductionEntryFixture({ withoutExpectedDbPath: true });
		try {
			const started = await fixture.submit(
				"rem-replace",
				"persona:host-configured-database",
				"correlation-host-configured-database",
			);
			expect(await fixture.waitForTerminal(productionIdentity(started), 10_000)).toMatchObject({
				state: "done",
			});
		} finally {
			await fixture.stop();
		}
	});

	it("merges replace and update before dispatch in canonical order", { timeout: 20_000 }, async () => {
		const fixture = await startRemProductionEntryFixture();
		try {
			const scope = "persona:acc34-merge";
			const correlationId = "correlation-acc34-merge";
			const [replace, update] = await Promise.all([
				fixture.submit("rem-replace", scope, correlationId),
				fixture.submit("rem-update", scope, correlationId),
			]);
			expect(productionIdentity(update)).toBe(productionIdentity(replace));
			const waveId = productionIdentity(replace);
			await fixture.waitForTerminal(waveId, 10_000);
			const rows = readJsonLines(join(fixture.stateRoot, "sno-station-mem", "rem-wave-jobs.jsonl"));
			expect(rows.findLast((row) => row["waveId"] === waveId || row["wave_id"] === waveId)).toMatchObject({
				requestedOperations: ["rem-replace", "rem-update"],
			});
		} finally {
			await fixture.stop();
		}
	});

	it("returns the existing id for a repeated closed operation", { timeout: 20_000 }, async () => {
		const fixture = await startRemProductionEntryFixture();
		try {
			const scope = "persona:acc34-repeat";
			const correlationId = "correlation-acc34-repeat";
			const first = await fixture.submit("rem-replace", scope, correlationId);
			const waveId = productionIdentity(first);
			await fixture.waitForTerminal(waveId, 10_000);
			const repeated = await fixture.submit("rem-replace", scope, correlationId);
			expect(productionIdentity(repeated)).toBe(waveId);
		} finally {
			await fixture.stop();
		}
	});

	it("refuses a new operation on a closed merge key", { timeout: 20_000 }, async () => {
		const fixture = await startRemProductionEntryFixture();
		try {
			const scope = "persona:acc34-closed";
			const correlationId = "correlation-acc34-closed";
			const first = await fixture.submit("rem-replace", scope, correlationId);
			await fixture.waitForTerminal(productionIdentity(first), 10_000);
			await expect(fixture.submit("rem-update", scope, correlationId)).rejects.toThrow(
				"wave_closed",
			);
		} finally {
			await fixture.stop();
		}
	});

	it("archives an interrupted version-zero queue as failed and starts", async () => {
		const fixture = await startRemProductionEntryFixture({
			legacyJobs: [
					{
						correlation_id: "correlation-legacy-running",
						finished_at: null,
						job_id: "legacy-running-job",
						scope: "persona:legacy-running",
						started_at: "2026-08-09T08:00:00.000Z",
						state: "running",
						stats: { operations: 0 },
						type: "rem-replace",
				},
			],
		});
		try {
			const archived = readJsonLines(
				join(fixture.stateRoot, "sno-station-mem", "rem-jobs.v0.jsonl"),
			);
			expect(archived.at(-1)).toMatchObject({
				job_id: "legacy-running-job",
				state: "failed",
				error: "sidecar_upgrade_interrupted",
				finished_at: expect.any(String),
			});
		} finally {
			await fixture.stop();
		}
	});

	it("keeps one operation independent", { timeout: 20_000 }, async () => {
		const configuration = createRemOwnerDecidedOperationalConfiguration();
		(configuration["operations"] as Record<string, boolean>)["rem-update"] = false;
		const fixture = await startRemProductionEntryFixture({ configuration });
		try {
			const started = await fixture.submit(
				"rem-replace",
				"persona:acc34-independent",
				"correlation-acc34-independent",
			);
			expect(await fixture.waitForTerminal(productionIdentity(started), 10_000)).toMatchObject({
				state: "done",
			});
		} finally {
			await fixture.stop();
		}
	});

	it("refuses Memora correlation verification when an enabled operation is missing", () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "acc34-rem-correlation-"));
		try {
			const stateDirectory = join(stateRoot, "sno-station-mem");
			const correlationId = "correlation-acc34-missing-update";
			const waveId = "rem-wave-acc34-missing-update";
			mkdirSync(stateDirectory, { recursive: true });
			writeFileSync(
				join(stateDirectory, "rem-trace.jsonl"),
				`${JSON.stringify({
					command: "rem-status",
					component: "memora_harness",
					correlation_id: correlationId,
					event: "harness_cli_received",
					exit_code: 0,
					job_id: waveId,
					stdout: JSON.stringify({ state: "done", waveId }),
					timestamp: "2026-08-10T00:00:00.000Z",
				})}\n`,
			);
			writeFileSync(
				join(stateDirectory, "rem-wave-jobs.jsonl"),
				`${JSON.stringify({
					correlationId,
					finishedAt: "2026-08-10T00:00:01.000Z",
					payloadVersion: 1,
					requestedOperations: ["rem-replace"],
					scope: "persona:acc34-missing-update",
					startedAt: "2026-08-10T00:00:00.000Z",
					state: "done",
					stats: { operations: 1 },
					waveId,
				})}\n`,
			);

			const runnerPath = join(
				repoRoot(),
				"evals/memora/evals/agent_eval/run_memora_mem_claw.sh",
			);
			const runner = readFileSync(runnerPath, "utf8");
			const verifierStart = runner.indexOf("verify_rem_correlation() {");
			const verifierEnd = runner.indexOf("\n\nusage() {", verifierStart);
			expect(verifierStart).toBeGreaterThanOrEqual(0);
			expect(verifierEnd).toBeGreaterThan(verifierStart);
			const verifierSource = runner.slice(verifierStart, verifierEnd);
			const verification = spawnSync(
				"bash",
				[
					"-c",
					`set -uo pipefail
REM_STATE_ROOT="$1"
ENABLED_REM_TYPES=("rem-replace" "rem-update")
${verifierSource}
verify_rem_correlation "$2" "$3"`,
					"verify-rem-correlation",
					stateRoot,
					correlationId,
					waveId,
				],
				{ cwd: repoRoot(), encoding: "utf8" },
			);
			if (verification.error) throw verification.error;
			expect(verification.status, verification.stderr).not.toBe(0);
			expect(verification.stderr).toContain("rem-update");
		} finally {
			rmSync(stateRoot, { force: true, recursive: true });
		}
	});

	it("refuses Memora correlation verification when rem-replace is requested twice", () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "acc34-rem-correlation-"));
		try {
			const stateDirectory = join(stateRoot, "sno-station-mem");
			const correlationId = "correlation-acc34-duplicate-replace";
			const waveId = "rem-wave-acc34-duplicate-replace";
			mkdirSync(stateDirectory, { recursive: true });
			writeFileSync(
				join(stateDirectory, "rem-trace.jsonl"),
				`${JSON.stringify({
					command: "rem-status",
					component: "memora_harness",
					correlation_id: correlationId,
					event: "harness_cli_received",
					exit_code: 0,
					job_id: waveId,
					stdout: JSON.stringify({ state: "done", waveId }),
					timestamp: "2026-08-10T00:00:00.000Z",
				})}\n`,
			);
			writeFileSync(
				join(stateDirectory, "rem-wave-jobs.jsonl"),
				`${JSON.stringify({
					correlationId,
					finishedAt: "2026-08-10T00:00:01.000Z",
					payloadVersion: 1,
					requestedOperations: ["rem-replace", "rem-replace"],
					scope: "persona:acc34-duplicate-replace",
					startedAt: "2026-08-10T00:00:00.000Z",
					state: "done",
					stats: { operations: 2 },
					waveId,
				})}\n`,
			);

			const runnerPath = join(
				repoRoot(),
				"evals/memora/evals/agent_eval/run_memora_mem_claw.sh",
			);
			const runner = readFileSync(runnerPath, "utf8");
			const verifierStart = runner.indexOf("verify_rem_correlation() {");
			const verifierEnd = runner.indexOf("\n\nusage() {", verifierStart);
			expect(verifierStart).toBeGreaterThanOrEqual(0);
			expect(verifierEnd).toBeGreaterThan(verifierStart);
			const verifierSource = runner.slice(verifierStart, verifierEnd);
			const verification = spawnSync(
				"bash",
				[
					"-c",
					`set -uo pipefail
REM_STATE_ROOT="$1"
ENABLED_REM_TYPES=("rem-replace" "rem-update")
${verifierSource}
verify_rem_correlation "$2" "$3"`,
					"verify-rem-correlation",
					stateRoot,
					correlationId,
					waveId,
				],
				{ cwd: repoRoot(), encoding: "utf8" },
			);
			if (verification.error) throw verification.error;
			expect(verification.status, verification.stderr).not.toBe(0);
			expect(verification.stderr).toContain("rem-replace");
			expect(verification.stderr).toMatch(/duplicate|repeated|occurrences?|times|twice/iu);
			expect(verification.stderr).toMatch(/\b2\b/u);
		} finally {
			rmSync(stateRoot, { force: true, recursive: true });
		}
	});

	it("uses one installed-CLI wave id and one Memora correlation outside its submit loop", { timeout: 120_000 }, async () => {
		const fixture = await startRemProductionEntryFixture({ entry: "built" });
		try {
			const scope = "persona:acc34-installed-wave";
			const correlationId = "correlation-acc34-installed-wave";
			const invoke = (operation: "rem-replace" | "rem-update") =>
				runInstalledSno({
					args: ["station", "rem-start", "--type", operation, "--scope", scope, "--json"],
					extraEnv: { SNO_REM_CORRELATION_ID: correlationId },
					profileRoot: fixture.profileRoot,
					stateRoot: fixture.stateRoot,
				});
			const replace = invoke("rem-replace");
			const update = invoke("rem-update");
			expect(replace.status, replace.stderr).toBe(0);
			expect(update.status, update.stderr).toBe(0);
			const waveId = productionIdentity(JSON.parse(replace.stdout) as Record<string, unknown>);
			expect(productionIdentity(JSON.parse(update.stdout) as Record<string, unknown>)).toBe(waveId);
			expect(await fixture.waitForTerminal(waveId, 90_000)).toMatchObject({ state: "done" });
			const journal = fixture.database.sqlite
				.prepare(
					"SELECT sequence, job_id, job_type, actions_applied FROM nodix_rem_journal WHERE job_id = ? ORDER BY sequence",
				)
				.all(waveId) as Array<Record<string, unknown>>;
			const replaceRows = journal.filter((row) => row["job_type"] === "rem-replace");
			const updateRows = journal.filter((row) => row["job_type"] === "rem-update");
			expect(replaceRows.length).toBeGreaterThan(0);
			expect(updateRows.length).toBeGreaterThan(0);
			expect(Math.max(...replaceRows.map((row) => Number(row["sequence"])))).toBeLessThan(
				Math.min(...updateRows.map((row) => Number(row["sequence"]))),
			);
			const runner = readFileSync(
				join(repoRoot(), "evals/memora/evals/agent_eval/run_memora_mem_claw.sh"),
				"utf8",
			);
			const remBlock = runner.match(
				/if \[ "\$SNO_EDGE_REM" = "1" \][\s\S]*?if ! \$SKIP_ANSWER/u,
			)?.[0];
			expect(remBlock).toBeDefined();
			expect((remBlock?.match(/\bREM_CORRELATION_ID=/gu) ?? []).length).toBe(1);
			expect(remBlock?.indexOf("REM_CORRELATION_ID=")).toBeLessThan(
				remBlock?.indexOf("REM_REQUEST_JSON=") ?? -1,
			);
		} finally {
			await fixture.stop();
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
