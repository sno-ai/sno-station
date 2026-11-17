import { realpathSync } from "node:fs";
import { createLogger } from "@snoai/utils/logger";
import { NightBudgetExhausted, runPrecisionNightSteps, precisionNightBudget, journalPrecisionNight } from "../engine/precision-night";
import { FIXED_MEMORY_SNO_EXTRACT_CHAT } from "../model/signed-registry-constants";
import { createEmbedder } from "../engine/extraction/embedding-provider-client";
import { remNeedsHost } from "./rem-trigger";
import { settingsToPluginConfig, type Settings } from "../../config/settings";
import { createLlmClient, type LlmClient } from "../model/llm-client";
import type { ProductMode } from "../../config/plugin-config-mode-schema";
import type { AgentLlmPort } from "../model/agent-llm-port";
import { CODING_SKIN_CHILD_DEADLINE_MS } from "../../config/coding-skin";
import { pickLlmRoutingConfig } from "../model/llm-mode-routing";
import { loadStorageExtensions } from "../store/connection";
import { getSnoStationMemStateDir } from "../engine/operations/runtime-audit-log";
import { MemoryStore } from "../store/store";
import { initSqliteRuntime, openSqliteDatabase, type SqliteDatabaseLike } from "../store/sqlite-runtime";
import { runPrecisionBackup, removeOlderPrecisionBackups } from "../store/backup";
import { logPrecisionFailure } from "../engine/precision-cleanup";
import { judgeNightlyLoadedFiles } from "../engine/precision-loaded-files";
import { chooseNightlySessionStart } from "../engine/precision-session-start";
const log = createLogger("sno-station-mem:rem-sidecar:batch");
const canonicalStoreWriteQueues = new Map<string, Promise<void>>();
interface BatchRuntime {
 database: SqliteDatabaseLike;
 store: MemoryStore;
 llm: LlmClient;
 close(): Promise<void>;
}

export async function runPrecisionNightly(input: {
	settings: Settings; mode?: ProductMode; agentPort?: AgentLlmPort; waveId: string; full?: boolean;
}): Promise<void> {
	try {
		if (!input.agentPort || (input.agentPort.reachable && !await input.agentPort.reachable())) {
			log.info("Nightly precision cleanup did not run: no registered model; nothing deleted", { operation: "precision-nightly" }, {
				event_name: "memory.precision.nightly.no_model", file: "packages/memory/src/sidecar/rem-batch-executor.ts", function: "runPrecisionNightly", site_id: "memory.precision.nightly.no_model",
			});
			return;
		}
		await runWithCanonicalStoreWriteMutex(input.settings.store.path, async () => {
			const runtime = await openBatchRuntime({ ...input, jobId: input.waveId, jobType: "precision-nightly" });
			try {
				const db = runtime.database;
				const day = new Date(Date.now()).toLocaleDateString("en-CA");
				let previousAt = 0;
				const identity = realpathSync(input.settings.store.path);
				const marker = "memory-precision-last-night";
				try {
					db.exec("CREATE TABLE IF NOT EXISTS nodix_memory_migration_markers (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL, payload TEXT NOT NULL)");
					const prior = db.prepare("SELECT applied_at, payload FROM nodix_memory_migration_markers WHERE name = ?").get(marker) as { applied_at: number; payload: string } | undefined;
					const payload: { day?: string; since?: number } = prior ? JSON.parse(prior.payload) : {};
					previousAt = payload.since ?? prior?.applied_at ?? 0;
					if (!input.full && payload.day === day) return;
				} catch (error) { logPrecisionFailure("read-nightly-marker", identity, error); }
				if (!input.full) {
					try {
						db.prepare("INSERT INTO nodix_memory_migration_markers(name, applied_at, payload) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET applied_at = excluded.applied_at, payload = excluded.payload")
							.run(marker, Date.now(), JSON.stringify({ day, waveId: input.waveId }));
					} catch (error) { logPrecisionFailure("write-nightly-marker", identity, error); }
				}
				const stateDir = getSnoStationMemStateDir();
				const progress = db.prepare(`SELECT coalesce(sum(actions_applied), 0)
					+ (SELECT count(*) FROM nodix_place_modes)
					+ (SELECT count(*) FROM nodix_loaded_file_judgments)
					+ (SELECT count(*) FROM nodix_memories WHERE json_extract(metadata, '$.start_label') IS NOT NULL) AS changed,
					count(DISTINCT CASE WHEN outcome = 'fine' THEN stage || ':' || row_id END) AS judged,
					count(CASE WHEN stage = 'loaded-files' AND outcome = 'undecided' THEN 1 END) AS deferred
					FROM nodix_rem_journal WHERE job_id = ? AND job_type = 'precision-nightly'`);
				let since = previousAt;
				try {
					for (;;) {
						const before = input.full ? progress.get(input.waveId) as { changed: number; judged: number; deferred: number }
							: { changed: 0, judged: 0, deferred: 0 };
						let backup: boolean | undefined;
						const beforeMutation = async (): Promise<boolean> => {
							if (backup !== undefined) return backup;
							try {
								const result = runPrecisionBackup(input.settings.store.path, stateDir);
								removeOlderPrecisionBackups(result.path);
								backup = true;
								try {
									db.prepare("INSERT INTO nodix_memory_migration_markers(name, applied_at, payload) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET applied_at = excluded.applied_at, payload = excluded.payload")
										.run("memory-precision-backup", Date.now(), JSON.stringify(result));
								} catch (error) { logPrecisionFailure("write-backup-marker", identity, error); }
								return true;
							} catch (error) {
								backup = false;
								logPrecisionFailure("nightly-backup; memory changes disabled", input.settings.store.path, error);
								return false;
							}
						};
						const budget = precisionNightBudget(runtime.llm);
						let deferred: NightBudgetExhausted | undefined;
						try {
							if (input.full) {
								if (!await beforeMutation()) return;
								try { await chooseNightlySessionStart(runtime.store, budget.llm, { waveId: input.waveId, full: true }); }
								catch (error) {
									if (error instanceof NightBudgetExhausted) error.stage = "session-start";
									throw error;
								}
							}
							await runPrecisionNightSteps({ store: runtime.store, waveId: input.waveId, complete: budget.complete, beforeMutation, previousAt });
							if (backup === false) return;
							for (const [stage, run] of [
								["session-start", () => chooseNightlySessionStart(runtime.store, budget.llm)],
								["loaded-files", () => judgeNightlyLoadedFiles(runtime.store, budget.llm, stateDir, input.waveId, previousAt)],
							] as const) {
								if (input.full && stage === "session-start") continue;
								try { await run(); }
								catch (error) {
									if (error instanceof NightBudgetExhausted) {
										error.stage = stage;
										throw error;
									}
									const rows = runtime.store.listPrecisionProjects().flatMap(project => runtime.store.readActivePrecisionRows(project));
									journalPrecisionNight(runtime.store, input.waveId, stage, "failed", rows, error);
									logPrecisionFailure(stage, identity, error);
								}
							}
						} catch (error) {
							if (!(error instanceof NightBudgetExhausted)) throw error;
							deferred = error;
						}
						if (deferred) {
							const remaining = deferred.remaining;
							const stage = deferred.stage;
							log.info(input.full ? "Full cleanup pass call limit reached" : "Nightly call limit reached; remaining rows deferred until tomorrow", { operation: stage, remaining_rows: remaining }, {
								event_name: "memory.precision.nightly.deferred", file: "packages/memory/src/sidecar/rem-batch-executor.ts", function: "runPrecisionNightly", site_id: "memory.precision.nightly.deferred",
							});
							journalPrecisionNight(runtime.store, input.waveId, stage, "undecided", [],
								input.full ? `Full cleanup pass budget exhausted; ${remaining} rows deferred to next pass` : `Nightly call budget exhausted; ${remaining} rows left for next night`, "global");
						}
						if (!budget.exhausted) journalPrecisionNight(runtime.store, input.waveId, "night", "fine", [], undefined, "global");
						if (input.full) {
							const after = progress.get(input.waveId) as { changed: number; judged: number; deferred: number };
							if (deferred || after.deferred > before.deferred) {
								if (after.changed === before.changed && after.judged === before.judged) {
									const reason = "Full cleanup stopped: deferred pass changed nothing and judged no new row";
									log.info(reason, { operation: "precision-nightly" }, {
										event_name: "memory.precision.nightly.no_progress", file: "packages/memory/src/sidecar/rem-batch-executor.ts", function: "runPrecisionNightly", site_id: "memory.precision.nightly.no_progress",
									});
									journalPrecisionNight(runtime.store, input.waveId, "night", "undecided", [], reason, "global");
									break;
								}
								continue;
							}
						}

						if (!budget.exhausted) since = Date.now();
						if (!input.full) try {
							db.prepare("UPDATE nodix_memory_migration_markers SET payload = ? WHERE name = ?")
								.run(JSON.stringify({ day, waveId: input.waveId, since: budget.exhausted ? previousAt : Date.now() }), marker);
						} catch (error) { logPrecisionFailure("write-nightly-continuation", identity, error); }
						break;
					}
				} finally {
					if (input.full) {
						try {
							db.prepare("INSERT INTO nodix_memory_migration_markers(name, applied_at, payload) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET applied_at = excluded.applied_at, payload = excluded.payload")
								.run(marker, Date.now(), JSON.stringify({ day: new Date(Date.now()).toLocaleDateString("en-CA"), waveId: input.waveId, since }));
						} catch (error) { logPrecisionFailure("write-nightly-marker", identity, error); }
					}
				}
			} finally { await runtime.close(); }
		});
	} catch (error) { logPrecisionFailure("precision-nightly", input.settings.store.path, error); }
}

export async function runWithCanonicalStoreWriteMutex<T>(
	canonicalStorePath: string,
	action: () => Promise<T>,
): Promise<T> {
	const identity = realpathSync(canonicalStorePath);
	const predecessor = canonicalStoreWriteQueues.get(identity) ?? Promise.resolve();
	let release: (() => void) | undefined;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = predecessor.catch(() => undefined).then(() => current);
	canonicalStoreWriteQueues.set(identity, queued);
	await predecessor.catch(() => undefined);
	try {
		return await action();
	} finally {
		release?.();
		if (canonicalStoreWriteQueues.get(identity) === queued) canonicalStoreWriteQueues.delete(identity);
	}
}

async function openBatchRuntime(input: {
	settings: Settings;
	mode?: ProductMode;
	agentPort?: AgentLlmPort;
	jobId: string;
	jobType: "precision-nightly";
}): Promise<BatchRuntime> {
	const settings = input.settings;
	const dbPath = settings.store.path;
	const pluginConfig = settingsToPluginConfig(settings, process.env.SNO_USAGE_CLASS === "research" ? "research" : "product");
	initSqliteRuntime(settings.store.encryptionKey);
	const embedder = createEmbedder(pluginConfig.embedding, getSnoStationMemStateDir());
	let store: MemoryStore | undefined;
	let database: ReturnType<typeof openSqliteDatabase> | undefined;
	try {
		store = new MemoryStore({
			dbPath,
			vectorDim: embedder.dimensions,
			embedder,
			memoryTelemetry: pluginConfig.memoryTelemetry,
		});
		database = openSqliteDatabase(dbPath, { fileMustExist: true });
		log.info("database_opened", {
			event: "database_opened",
			job_id: input.jobId,
			job_type: input.jobType,
			database_path: realpathSync(dbPath),
		}, {
			event_name: "sno_station_mem.rem-batch-executor.database.opened",
			file: "packages/memory/src/sidecar/rem-batch-executor.ts",
			function: "openBatchRuntime",
			site_id: "rem-batch-executor.openBatchRuntime.86fa720e8f",
		});
		loadStorageExtensions(database);
		const llm = createLlmClient({
			preset: FIXED_MEMORY_SNO_EXTRACT_CHAT,
			usageClass: pluginConfig.extraction.llm.usageClass,
			operationId: input.jobId,
			apiKey: settings.snoGpu.apiKey,
			baseURL: settings.snoGpu.baseUrl,
			timeoutMs: Math.max(120_000, CODING_SKIN_CHILD_DEADLINE_MS),
			agentPort: input.agentPort,
			refuseOnUnavailable: true,
			hostRequired: remNeedsHost(input.mode ?? pluginConfig.mode, settings.modelCalls),
			routing: pickLlmRoutingConfig({ mode: input.mode ?? pluginConfig.mode, modelCalls: settings.modelCalls }),
			onProviderResponse: ({ callId, destination, provider, requestId, model, usage }) => {
				log.info("llm_provider_response", {
					event: "llm_provider_response",
					job_id: input.jobId,
					job_type: input.jobType,
					call_id: callId,
					destination,
					request_id: requestId ?? null,
					provider,
					model: model ?? null,
					usage: usage ? { ...usage, source: "provider-returned" } : null,
				}, {
					event_name: "sno_station_mem.rem-batch-executor.llm.provider.response",
					file: "packages/memory/src/sidecar/rem-batch-executor.ts",
					function: "onProviderResponse",
					site_id: "rem-batch-executor.onProviderResponse.df4f2d4fa1",
				});
			},
		});
		return {
			database: database.db,
			store,
			llm,
			async close(): Promise<void> {
				database?.db.close();
				await store?.close();
				await embedder.dispose();
			},
		};
	} catch (error) {
		database?.db.close();
		await store?.close();
		await embedder.dispose();
		throw error;
	}
}

const REM_CANDIDATE_PREDICATE_SQL = `lane = 'active'
	AND length(trim(text)) > 0
	AND category IN ('profile', 'episodic', 'state')
	AND json_valid(metadata)
	AND json_extract(metadata, '$.superseded_by') IS NULL`;

export function enumerateRemCandidateScopes(
	database: SqliteDatabaseLike,
): Array<{ scope: string; candidateCount: number }> {
	const rows = database
		.prepare(
			`SELECT project_id AS scope, count(*) AS candidate_count
			FROM nodix_memories
			WHERE ${REM_CANDIDATE_PREDICATE_SQL}
			GROUP BY project_id
			ORDER BY project_id`,
		)
		.all() as Array<{ scope: string; candidate_count: number }>;
	return rows.map((row) => ({ scope: row.scope, candidateCount: row.candidate_count }));
}
