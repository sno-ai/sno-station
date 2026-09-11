/** @file server.ts
 * @purpose Runs the loopback HTTP surface and empty asynchronous REM executor.
 * @boundary Sno CLI requests, durable REM job state, and the existing local audit writer.
 */

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import path from "node:path";
import { createLogger, effectiveLogLevel } from "@snoai/utils/logger";
import { withLogContext } from "@snoai/utils/log-context";
import { z } from "zod";
import {
	loadRemEnableGate,
	parseRemOperationType,
	REM_BUILT_OPERATION_TYPES,
	REM_ENABLE_GATE_BINDINGS,
	type RemBuiltOperationType,
	type RemOperationType,
} from "../engine/rem/index.js";
import {
	appendAuditEntryStrict,
	getAuditPath,
	getSnoStationMemStateDir,
	getStateDir,
} from "../engine/operations/runtime-audit-log";
import {
	getRemChassisJournalPath,
	HEALTH_PATH,
	readRemConfigSource,
	readRemOperationalConfig,
	readRemTestHoldMs,
	REM_ASYNC_START_DELAY_MS,
	REM_CORRELATION_ID_HEADER,
	getRemDiscoveryPath,
	getRemJobJournalPath,
	getRemSidecarLockKey,
	REM_JOBS_PATH_PREFIX,
	REM_REQUEST_BODY_LIMIT_BYTES,
	REM_RUN_PATH,
	REM_SIDECAR_HOST,
	REM_SIDECAR_ORIGIN,
	REM_SIDECAR_TOKEN_HEADER,
	REM_SOURCE,
} from "./config";
import { acquireRemSidecarLock } from "./lifecycle-lock";
import { MemoryRuntimePool } from "./memory-runtime";
import { serveMemoryRoute } from "./memory-routes";
import { runRemProductionOrderedWave } from "./rem-batch-executor";
import { validateRemOperationalGrammarActivation } from "./rem-entry-foundations";
import { RemChassisJournal } from "./rem-chassis-journal";
import {
	parseRemJobStats,
	type RemJob,
	type RemJobStats,
	RemJobStore,
} from "./rem-job-store";

const log = createLogger("sno-station-mem:rem-sidecar");
const COMPLETION_PERSIST_ATTEMPTS = 5;
type CompletionPersistence = "job_journal" | "completed_audit" | "unavailable";
type RunRequest =
	| { type: string; scope: string }
	| { types: string[]; scope: string };

const runRequestSchema: z.ZodType<RunRequest> = z.union([
	z.object({ type: z.string().min(1), scope: z.string().trim().min(1) }).strict(),
	z
		.object({
			types: z.array(z.string().min(1)).min(1),
			scope: z.string().trim().min(1),
		})
		.strict(),
]);

interface DiscoveryState {
	port: number;
	token: string;
	pid: number;
}

interface RequestLogContext {
	job_id?: string;
	error_code?: string;
	correlation_id?: string;
}

export interface RunningRemSidecar {
	port: number;
	stop: () => Promise<void>;
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
	) {
		super(code);
	}
}

export async function startRemSidecar(): Promise<RunningRemSidecar> {
	const lifecycleLock = await acquireRemSidecarLock(getRemSidecarLockKey());
	try {
		return await startLockedRemSidecar(lifecycleLock);
	} catch (error) {
		await lifecycleLock.release();
		throw error;
	}
}

async function startLockedRemSidecar(
	lifecycleLock: Awaited<ReturnType<typeof acquireRemSidecarLock>>,
): Promise<RunningRemSidecar> {
	const memory = await MemoryRuntimePool.open();
	const token = randomBytes(32).toString("hex");
	const holdMs = readRemTestHoldMs();
	const chassisJournal = new RemChassisJournal(getRemChassisJournalPath());
	const store = await RemJobStore.open(getRemJobJournalPath(), (job) => {
		log.info("job_transition_durable", {
			event: "job_transition_durable",
			job_id: job.job_id,
			state: job.state,
			correlation_id: job.correlation_id,
			durable: true,
		}, {
			event_name: "sno_station_mem.server.job.transition.durable",
			file: "packages/sno-station-mem/src/sidecar/server.ts",
			function: "<anonymous callback>",
			site_id: "server.<anonymous callback>.5eb5a60e6b",
		});
	});
	const resumableJobIds = await recoverInterruptedJobs(store, await readCompletedJobStats());
	const pendingTimers = new Set<NodeJS.Timeout>();
	const activeTasks = new Set<Promise<void>>();
	for (const jobId of resumableJobIds) {
		const task = runChassisJob(store, chassisJournal, jobId, 0, true);
		activeTasks.add(task);
		void task.finally(() => activeTasks.delete(task));
	}
	const server = createServer((request, response) => {
		const started = performance.now();
		const operationId = `rem-http-${randomUUID()}`;
		const context: RequestLogContext = {};
		let requestLogged = false;
		const recordRequest = (cancelled = false): void => {
			if (requestLogged) return;
			requestLogged = true;
			let outcome = "success";
			if (cancelled) outcome = "cancelled";
			else if (response.statusCode >= 500) outcome = "failed";
			else if (response.statusCode >= 400) outcome = "refused";
			withLogContext({ operation_id: operationId, job_id: context.job_id, external_reference: context.correlation_id }, () => {
			log[outcome === "failed" ? "error" : "info"]("http_request", {
				outcome,
				method: request.method ?? "UNKNOWN",
				path: requestPath(request),
				status: response.statusCode,
				duration_ms: Math.max(0, Math.round(performance.now() - started)),
				...context,
			}, {
				event_name: "sno_station_mem.server.http.request",
				file: "packages/sno-station-mem/src/sidecar/server.ts",
				function: "recordRequest",
				site_id: "server.<anonymous callback>.47c4662916",
			});
			});
		};
		response.once("finish", () => recordRequest());
		response.once("close", () => recordRequest(!response.writableFinished));
		void withLogContext({ operation_id: operationId }, () => routeRequest(
			request,
			response,
			token,
			store,
			chassisJournal,
			holdMs,
			pendingTimers,
			activeTasks,
			context,
			memory,
		).catch((error: unknown) => {
				const httpError =
					error instanceof HttpError ? error : new HttpError(500, "internal_error");
				context.error_code = httpError.code;
				if (!(error instanceof HttpError)) {
					log.error("request_failed", { error }, {
						event_name: "sno_station_mem.server.request.failed",
						file: "packages/sno-station-mem/src/sidecar/server.ts",
						function: "<anonymous callback>",
						site_id: "server.<anonymous callback>.a7a2656a08",
					});
				}
				if (!response.headersSent) {
					sendJson(response, httpError.status, { error: httpError.code });
				} else {
					response.end();
				}
			}));
	});

	await listen(server);
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("REM sidecar did not bind a TCP address");
	}
	const discoveryPath = getRemDiscoveryPath();
	const discovery = { port: address.port, token, pid: process.pid } satisfies DiscoveryState;
	await writeDiscovery(discoveryPath, discovery);
	const exitCleanup = (): void => {
		removeOwnedDiscoverySync(discoveryPath, token);
		lifecycleLock.releaseSync();
	};
	process.once("exit", exitCleanup);

	log.info("started", { host: REM_SIDECAR_HOST, port: address.port, pid: process.pid }, {
		event_name: "sno_station_mem.server.started",
		file: "packages/sno-station-mem/src/sidecar/server.ts",
		function: "startLockedRemSidecar",
		site_id: "server.startLockedRemSidecar.96a92b085b",
	});
	return {
		port: address.port,
		async stop(): Promise<void> {
			const started = performance.now();
			let cleanedUp = false;
			process.removeListener("exit", exitCleanup);
			try {
				for (const timer of pendingTimers) clearTimeout(timer);
				pendingTimers.clear();
				memory.stopTimers();
				await closeServer(server);
				await Promise.allSettled(activeTasks);
				await memory.close();
				await removeOwnedDiscovery(discoveryPath, token);
				cleanedUp = true;
			} finally {
				let released = false;
				try {
					await lifecycleLock.release();
					released = true;
				} finally {
				log[cleanedUp && released ? "info" : "error"]("REM sidecar cleanup completed", {
					outcome: cleanedUp && released ? "success" : "failed",
					lifecycle_lock_released: released,
					duration_ms: performance.now() - started,
					active_tasks: activeTasks.size,
				}, {
					event_name: "sidecar.shutdown.completed",
					file: "packages/sno-station-mem/src/sidecar/server.ts",
					function: "startLockedRemSidecar.stop",
					site_id: "sidecar.shutdown.completed",
				});
				}
			}
		},
	};
}

async function routeRequest(
	request: IncomingMessage,
	response: ServerResponse,
	token: string,
	store: RemJobStore,
	chassisJournal: RemChassisJournal,
	holdMs: number,
	pendingTimers: Set<NodeJS.Timeout>,
	activeTasks: Set<Promise<void>>,
	context: RequestLogContext,
	memory: MemoryRuntimePool,
): Promise<void> {
	const url = new URL(request.url ?? HEALTH_PATH, REM_SIDECAR_ORIGIN);
	if (!isAuthorized(request, token)) {
		context.error_code = "unauthorized";
		sendJson(response, 401, { error: "unauthorized" });
		return;
	}
	if (request.method === "GET" && url.pathname === HEALTH_PATH) {
		sendJson(response, 200, { status: "ok", log_level: effectiveLogLevel(), principal: memory.principal,
			storePath: memory.storePath, accessCounters: memory.counters });
		return;
	}
	if (await serveMemoryRoute(request, response, url.pathname, memory, activeTasks)) return;
	if (request.method === "POST" && url.pathname === REM_RUN_PATH) {
		const correlationId = readCorrelationId(request) ?? `rem-corr-${randomUUID()}`;
		context.correlation_id = correlationId;
		const parsedInput = runRequestSchema.safeParse(await readJsonBody(request));
		if (!parsedInput.success) {
			context.error_code = "invalid_request";
			sendJson(response, 400, { error: "invalid_request" });
			return;
		}
		const input = parsedInput.data;
		const requestedTypes = "types" in input ? input.types : [input.type];
		if (requestedTypes.some((type) => parseRemOperationType(type) === undefined)) {
			context.error_code = "unsupported_rem_type";
			sendJson(response, 400, { error: "unsupported_rem_type" });
			return;
		}
		let allocation: Awaited<ReturnType<RemJobStore["createQueued"]>>;
		try {
			allocation = await store.createQueued(requestedTypes, input.scope, correlationId);
		} catch (error) {
			if (errorMessage(error) === "wave_closed") {
				context.error_code = "wave_closed";
				sendJson(response, 409, { error: "wave_closed" });
				return;
			}
			throw error;
		}
		const { created, job } = allocation;
		context.job_id = job.job_id;
		log.info("job_allocated", {
			created,
			event: "job_allocated",
			job_id: job.job_id,
			type: job.type,
			scope: job.scope,
			correlation_id: job.correlation_id,
		}, {
			event_name: "sno_station_mem.server.job.allocated",
			file: "packages/sno-station-mem/src/sidecar/server.ts",
			function: "routeRequest",
			site_id: "server.routeRequest.0ea180a77c",
		});
		if (created) {
			const delayMs = "types" in input ? 0 : REM_ASYNC_START_DELAY_MS;
			const timer = setTimeout(() => {
				pendingTimers.delete(timer);
				const task = runChassisJob(store, chassisJournal, job.job_id, holdMs);
				activeTasks.add(task);
				void task.finally(() => activeTasks.delete(task));
			}, delayMs);
			pendingTimers.add(timer);
		}
		sendJson(response, 202, { job_id: job.job_id, waveId: job.job_id });
		return;
	}
	if (request.method === "GET" && url.pathname.startsWith(REM_JOBS_PATH_PREFIX)) {
		const jobId = url.pathname.slice(REM_JOBS_PATH_PREFIX.length);
		const job = store.get(jobId);
		context.job_id = jobId;
		context.correlation_id = readCorrelationId(request) ?? job?.correlation_id;
		if (!job) {
			context.error_code = "job_not_found";
			sendJson(response, 404, { error: "job_not_found" });
			return;
		}
		sendJson(response, 200, job);
		return;
	}
	context.error_code = "not_found";
	sendJson(response, 404, { error: "not_found" });
}

async function runChassisJob(
	store: RemJobStore,
	journal: RemChassisJournal,
	waveId: string,
	holdMs: number,
	resume = false,
): Promise<void> {
	const queued = store.get(waveId);
	if (queued === undefined) throw new Error(`REM wave not found: ${waveId}`);
	const resuming = queued.state === "running";
	if (resuming && !resume) throw new Error(`REM wave is already running: ${waveId}`);
	if (!resuming && queued.state !== "queued") {
		throw new Error(`REM wave cannot run from state ${queued.state}: ${waveId}`);
	}
	return withLogContext({ operation_id: queued.job_id, job_id: queued.job_id, session_reference: queued.scope, external_reference: queued.correlation_id }, async () => {
		const started = performance.now();
		let persistence: CompletionPersistence = "unavailable";
		let completion: RemJobStats | undefined;
		let refused = false;
		let failed = false;
		let failure: unknown;
		const requestedOperations = queued.requested_operations.flatMap((operation) => {
			const parsed = parseRemOperationType(operation);
			return parsed === undefined ? [] : [parsed];
		});
		let writesApplied = false;
		try {
			const running = resuming
				? queued
				: await store.transition(queued.job_id, {
						state: "running",
						started_at: new Date().toISOString(),
					});
			if (!resuming) await auditRem("rem_triggered", running);
			if (holdMs > 0) {
				await new Promise((resolvePromise) => setTimeout(resolvePromise, holdMs));
			}
			const configSource = readRemConfigSource();
			let configuration: ReturnType<typeof readRemOperationalConfig>;
			try {
				configuration = readRemOperationalConfig();
			} catch (error) {
				const reason = `configuration:env:SNO_REM_CONFIG_JSON:${errorMessage(error)}`;
				await appendChassisRefusal(journal, queued, requestedOperations[0] ?? "rem-replace", "failed", reason);
				throw new Error(reason);
			}
			if (configSource === undefined) {
				throw new Error("configuration:env:SNO_STATION_MEM_REM_CONFIG_JSON:missing");
			}
			const cleanRefusalReasons: string[] = [];
			const enabledOperations: RemBuiltOperationType[] = [];
			for (const operation of requestedOperations) {
				const reason = !configuration.operations[operation]
					? `switched-off:${operation}`
					: !isBuiltOperation(operation)
						? `not-built:${operation}`
						: undefined;
				if (reason !== undefined) {
					await appendChassisRefusal(journal, running, operation, "refused", reason);
					cleanRefusalReasons.push(reason);
					continue;
				}
				if (isBuiltOperation(operation)) enabledOperations.push(operation);
			}
			if (enabledOperations.length === 0) {
				refused = true;
				persistence = await completeCleanRefusal(store, running, cleanRefusalReasons);
				return;
			}
			const grammarGate = validateRemOperationalGrammarActivation({
				stateRoot: getStateDir(),
				configSource,
			});
			if (grammarGate.decision === "refuse") {
				const operation = requestedOperations[0] ?? "rem-replace";
				await appendChassisRefusal(journal, queued, operation, "failed", grammarGate.reasonCode);
				throw new Error(grammarGate.reasonCode);
			}
			for (const operation of enabledOperations) {
				try {
					loadRemEnableGate({
						stateDir: getSnoStationMemStateDir(),
						jobType: operation,
						...REM_ENABLE_GATE_BINDINGS,
						artifactSha256: configuration.enableGateDigests[operation],
						now: new Date().toISOString(),
					});
				} catch (error) {
					const reason = `operation-gate:${operation}:${errorMessage(error)}`;
					await appendChassisRefusal(journal, queued, operation, "failed", reason);
					throw new Error(reason);
				}
			}
			const result = await runRemProductionOrderedWave({
				stateRoot: getStateDir(),
				personaDbPath: process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"],
				configSource,
				scope: queued.scope,
				waveId: queued.job_id,
				requestedOperations: enabledOperations,
			});
			if (result.decision === "refuse") {
				const operation = enabledOperations[0] ?? "rem-replace";
				const reason = result.reasonCode;
				await appendChassisRefusal(journal, queued, operation, "failed", reason);
				throw new Error(reason);
			}
			writesApplied = true;
			const completionStats: RemJobStats = {
				operations: result.actionsApplied,
				applied_count: result.actionsApplied,
				actionable_candidate_count: result.actionableCandidateCount,
				applied_fraction: result.appliedFraction,
				scan: {
					scope: queued.scope,
					candidate_count: result.candidateCount,
					stamped_skipped_count: result.stampedSkippedCount,
					actionable_candidate_count: result.actionableCandidateCount,
				},
				parse_failure_count: result.parseFailureCount,
				top_refusal_reasons: [...cleanRefusalReasons, ...result.topRefusalReasons].slice(0, 2),
				measured: {
					rows_considered: result.measurements.rowsConsidered,
					pairs_built: result.measurements.pairsBuilt,
					pair_cap_binding: result.measurements.pairCapBinding,
					model_calls: result.measurements.modelCalls,
					model_tokens: result.measurements.modelTokens,
					wall_ms: result.measurements.wallMs,
				},
				by_operation: result.perOperation.map(({ operation, ...operationResult }) => ({
					operation,
					applied_count: operationResult.actionsApplied,
					actionable_candidate_count: operationResult.actionableCandidateCount,
					candidate_count: operationResult.candidateCount,
					parse_failure_count: operationResult.parseFailureCount,
					top_refusal_reasons: operationResult.topRefusalReasons,
					measured: {
						rows_considered: operationResult.measurements.rowsConsidered,
						pairs_built: operationResult.measurements.pairsBuilt,
						pair_cap_binding: operationResult.measurements.pairCapBinding,
						model_calls: operationResult.measurements.modelCalls,
						model_tokens: operationResult.measurements.modelTokens,
						wall_ms: operationResult.measurements.wallMs,
					},
				})),
			};
			completion = completionStats;
			persistence = await persistCompletedJob(store, running, completionStats);
			// The chassis journal also records each operation's own terminal outcome.
			for (const operationResult of result.perOperation) {
				try {
					await journal.appendJournalWithCorrelation(
						running.job_id,
						operationResult.operation,
						running.correlation_id,
						{
							stage: operationResult.operation,
							outcome: operationResult.actionsApplied > 0 ? "done" : "no-action",
							pairsScanned: operationResult.measurements.pairsBuilt,
							verdicts: operationResult.actionableCandidateCount,
							actionsApplied: operationResult.actionsApplied,
						},
					);
				} catch (error) {
					log.error("job_completion_journal_failed", {
						error,
						job_id: running.job_id,
						job_type: operationResult.operation,
						correlation_id: running.correlation_id,
					}, {
						event_name: "sno_station_mem.server.job.completion.journal.failed",
						file: "packages/sno-station-mem/src/sidecar/server.ts",
						function: "runChassisJob",
						site_id: "server.runChassisJob.e7639bd8fc",
					});
				}
			}
		} catch (error) {
			failed = true;
			failure = error;
			if (!writesApplied) {
				await failNonTerminalJob(store, queued.job_id, errorMessage(error));
			}
		} finally {
			let outcome = "empty-success";
			if (failed) outcome = writesApplied ? "partial" : "failed";
			else if (persistence === "unavailable") outcome = "partial";
			else if (refused) outcome = "refused";
			else if ((completion?.applied_count ?? 0) > 0) outcome = "success";
			log[failed || persistence === "unavailable" ? "error" : "info"]("REM job completed", {
				outcome,
				job_id: queued.job_id,
				basis: persistence,
				applied_count: completion?.applied_count ?? (writesApplied ? null : 0),
				candidate_count: completion?.scan?.candidate_count ?? (refused ? 0 : null),
				parse_failure_count: completion?.parse_failure_count ?? (refused ? 0 : null),
				duration_ms: performance.now() - started,
				...(failure === undefined ? {} : { error: failure }),
			}, {
				event_name: "sidecar.job.completed",
				file: "packages/sno-station-mem/src/sidecar/server.ts",
				function: "runChassisJob",
				site_id: "sidecar.job.completed",
			});
		}
	});
}

async function persistCompletedJob(
	store: RemJobStore,
	job: RemJob,
	stats: RemJobStats,
): Promise<CompletionPersistence> {
	const finishedAt = new Date().toISOString();
	let retryMs = 100;
	for (let attempt = 1; attempt <= COMPLETION_PERSIST_ATTEMPTS; attempt += 1) {
		let auditPersisted = false;
		try {
			await auditRem("rem_completed", job, { stats });
			auditPersisted = true;
		} catch (error) {
			log.error("job_completion_audit_failed", {
				error,
				job_id: job.job_id,
				correlation_id: job.correlation_id,
			}, {
				event_name: "sno_station_mem.server.job.completion.audit.failed",
				file: "packages/sno-station-mem/src/sidecar/server.ts",
				function: "persistCompletedJob",
				site_id: "server.persistCompletedJob.bc6b30658e",
			});
		}
		try {
			await store.transition(job.job_id, {
				state: "done",
				finished_at: finishedAt,
				stats,
			});
			return "job_journal";
		} catch (error) {
			log.error("job_completion_state_failed", {
				error,
				job_id: job.job_id,
				correlation_id: job.correlation_id,
			}, {
				event_name: "sno_station_mem.server.job.completion.state.failed",
				file: "packages/sno-station-mem/src/sidecar/server.ts",
				function: "persistCompletedJob",
				site_id: "server.persistCompletedJob.a959322a6a",
			});
			if (store.get(job.job_id)?.state === "done") return "job_journal";
			if (auditPersisted) {
				store.applyCompletionReceipt(job.job_id, finishedAt, stats);
				return "completed_audit";
			}
		}
		if (attempt === COMPLETION_PERSIST_ATTEMPTS) break;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, retryMs));
		retryMs = Math.min(retryMs * 2, 5_000);
	}
	log.error("job_completion_persistence_exhausted", {
		job_id: job.job_id,
		correlation_id: job.correlation_id,
		attempts: COMPLETION_PERSIST_ATTEMPTS,
	}, {
		event_name: "sno_station_mem.server.job.completion.persistence.exhausted",
		file: "packages/sno-station-mem/src/sidecar/server.ts",
		function: "persistCompletedJob",
		site_id: "server.persistCompletedJob.8dde75d5b4",
	});
	return "unavailable";
}

async function completeCleanRefusal(
	store: RemJobStore,
	job: RemJob,
	reasons: readonly string[],
): Promise<CompletionPersistence> {
	const stats: RemJobStats = {
		operations: 0,
		applied_count: 0,
		actionable_candidate_count: 0,
		applied_fraction: null,
		scan: {
			scope: job.scope,
			candidate_count: 0,
			stamped_skipped_count: 0,
			actionable_candidate_count: 0,
		},
		parse_failure_count: 0,
		top_refusal_reasons: reasons.slice(0, 2),
	};
	return persistCompletedJob(store, job, stats);
}

async function appendChassisRefusal(
	journal: RemChassisJournal,
	job: RemJob,
	jobType: RemOperationType,
	outcome: "failed" | "refused",
	reason: string,
): Promise<void> {
	await journal.appendJournalWithCorrelation(job.job_id, jobType, job.correlation_id, {
		stage: jobType,
		outcome,
		pairsScanned: 0,
		verdicts: 0,
		actionsApplied: 0,
		reason,
	});
}

function isBuiltOperation(jobType: RemOperationType): jobType is RemBuiltOperationType {
	return REM_BUILT_OPERATION_TYPES.some((operation) => operation === jobType);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function failNonTerminalJob(
	store: RemJobStore,
	jobId: string,
	reason: string,
): Promise<void> {
	const current = store.get(jobId);
	if (!current || (current.state !== "queued" && current.state !== "running")) return;
	try {
		await auditRem("rem_failed", current, { error: reason });
		await store.transition(jobId, {
			state: "failed",
			finished_at: new Date().toISOString(),
			error: reason,
		});
	} catch (error) {
		log.error("job_failure_audit_failed", { error, job_id: jobId }, {
			event_name: "sno_station_mem.server.job.failure.audit.failed",
			file: "packages/sno-station-mem/src/sidecar/server.ts",
			function: "failNonTerminalJob",
			site_id: "server.failNonTerminalJob.cf84e07c6d",
		});
	}
}

async function recoverInterruptedJobs(
	store: RemJobStore,
	completedJobStats: ReadonlyMap<string, RemJobStats>,
): Promise<string[]> {
	const resumableJobIds: string[] = [];
	for (const job of store.nonTerminalJobs()) {
		const stats = completedJobStats.get(job.job_id);
		if (stats !== undefined) {
			await store.transition(job.job_id, {
				state: "done",
				finished_at: new Date().toISOString(),
				stats,
			});
			continue;
		}
		if (job.state === "running") {
			log.warn("job_recovery_resuming", {
				job_id: job.job_id,
				correlation_id: job.correlation_id,
				reason: "completion_receipt_missing_replay_same_wave",
			}, {
				event_name: "sno_station_mem.server.job.recovery.resuming",
				file: "packages/sno-station-mem/src/sidecar/server.ts",
				function: "recoverInterruptedJobs",
				site_id: "server.recoverInterruptedJobs.15309ea841",
			});
			resumableJobIds.push(job.job_id);
			continue;
		}
		await auditRem("rem_failed", job, { error: "sidecar_restart" });
		await store.transition(job.job_id, {
			state: "failed",
			finished_at: new Date().toISOString(),
			error: "sidecar_restart",
		});
	}
	return resumableJobIds;
}

async function readCompletedJobStats(): Promise<Map<string, RemJobStats>> {
	let raw: string;
	try {
		raw = await readFile(getAuditPath(getSnoStationMemStateDir()), "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return new Map();
		throw error;
	}
	const completed = new Map<string, RemJobStats>();
	for (const line of raw.split("\n")) {
		if (line.length === 0) continue;
		try {
			const entry: unknown = JSON.parse(line);
			if (!isRecord(entry) || entry["event"] !== "rem_completed") continue;
			const details = entry["details"];
			if (!isRecord(details) || typeof details["job_id"] !== "string") continue;
			const type = details["type"];
			if (typeof type !== "string" || parseRemOperationType(type) === undefined) continue;
			const stats = parseRemJobStats(details["stats"]);
			if (stats === undefined) continue;
			completed.set(details["job_id"], stats);
		} catch {
			// A crash can leave a partial final JSONL line; earlier complete records remain usable.
		}
	}
	return completed;
}

async function auditRem(
	event: "rem_triggered" | "rem_completed" | "rem_failed",
	job: RemJob,
	extra: Record<string, unknown> = {},
): Promise<void> {
	await appendAuditEntryStrict(getSnoStationMemStateDir(), {
		event,
		scope: job.scope,
		resultStatus: event === "rem_failed" ? "error" : "ok",
		details: {
			type: job.type,
			scope: job.scope,
			job_id: job.job_id,
			correlation_id: job.correlation_id,
			source: REM_SOURCE,
			stats: { operations: 0 },
			...extra,
		},
	});
}

function readCorrelationId(request: IncomingMessage): string | undefined {
	const value = request.headers[REM_CORRELATION_ID_HEADER];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
	const authorization = request.headers.authorization;
	const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : undefined;
	const provided = bearer ?? (request.url?.startsWith("/v1/") ? undefined : request.headers[REM_SIDECAR_TOKEN_HEADER]);
	if (typeof provided !== "string") return false;
	const expectedBuffer = Buffer.from(token);
	const providedBuffer = Buffer.from(provided);
	return (
		expectedBuffer.length === providedBuffer.length &&
		timingSafeEqual(expectedBuffer, providedBuffer)
	);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > REM_REQUEST_BODY_LIMIT_BYTES) {
			throw new HttpError(413, "request_too_large");
		}
		chunks.push(buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch {
		throw new HttpError(400, "invalid_json");
	}
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	response.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload),
	});
	response.end(payload);
}

function requestPath(request: IncomingMessage): string {
	try {
		return new URL(request.url ?? HEALTH_PATH, REM_SIDECAR_ORIGIN).pathname;
	} catch {
		return request.url ?? HEALTH_PATH;
	}
}

async function listen(server: Server): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, REM_SIDECAR_HOST, () => {
			server.removeListener("error", reject);
			resolvePromise();
		});
	});
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolvePromise, reject) => {
		server.close((error) => (error ? reject(error) : resolvePromise()));
	});
}

async function writeDiscovery(discoveryPath: string, discovery: DiscoveryState): Promise<void> {
	const parent = path.dirname(discoveryPath);
	await mkdir(parent, { recursive: true });
	const temporaryPath = `${discoveryPath}.${randomUUID()}.tmp`;
	const handle = await open(temporaryPath, "wx", 0o600);
	try {
		await handle.writeFile(JSON.stringify(discovery), "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temporaryPath, discoveryPath);
	await syncDirectory(parent);
}

async function removeOwnedDiscovery(discoveryPath: string, token: string): Promise<void> {
	if (!(await discoveryBelongsTo(discoveryPath, token))) return;
	await rm(discoveryPath, { force: true });
	await syncDirectory(path.dirname(discoveryPath));
}

function removeOwnedDiscoverySync(discoveryPath: string, token: string): void {
	try {
		const parsed = JSON.parse(readFileSync(discoveryPath, "utf8")) as { token?: unknown };
		if (parsed.token === token) rmSync(discoveryPath, { force: true });
	} catch {
		// Exit cleanup is best-effort; restart recovery replaces stale discovery atomically.
	}
}

async function discoveryBelongsTo(discoveryPath: string, token: string): Promise<boolean> {
	if (!existsSync(discoveryPath)) return false;
	try {
		const parsed = JSON.parse(await readFile(discoveryPath, "utf8")) as { token?: unknown };
		return parsed.token === token;
	} catch {
		return false;
	}
}

async function syncDirectory(directory: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
