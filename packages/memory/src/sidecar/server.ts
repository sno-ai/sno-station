import { MEMORY_SHUTDOWN_TIMEOUT_MS } from "../../config/index";
import { getPrincipal, getSidecarSocketPath, readBoundStorePath } from "../contract/profile";
/** @file server.ts
 * @purpose Runs the loopback HTTP surface and empty asynchronous REM executor.
 * @boundary Sno CLI requests, durable REM job state, and the existing local audit writer.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import path from "node:path";
import { createConnection, createServer as createSocketServer, type Server as SocketServer } from "node:net";
import { setImmediate as yieldTurn } from "node:timers/promises";
import locking from "fs-ext";
import { readDiscovery } from "../contract/discovery";
import { createLogger, effectiveLogLevel, emitDiagnostic } from "@snoai/utils/logger";
import { withLogContext } from "@snoai/utils/log-context";
import { z } from "zod";
import {
	parseRemOperationType,
	REM_BUILT_OPERATION_TYPES,
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
	REM_JOBS_PATH_PREFIX,
	REM_RUN_PATH,
	REM_SIDECAR_HOST,
	REM_SIDECAR_ORIGIN,
	REM_SOURCE,
} from "./config";
import { readJsonlLines } from "../engine/operations/jsonl-lines";
import type { MemoryRuntimePool } from "./memory-runtime";
import { PayloadTooLargeError, readRequestBody } from "./request-body";
import { serveMemoryRoute } from "./memory-routes";
import { RemChassisJournal } from "./rem-chassis-journal";
import {
	parseRemJobStats,
	type RemJob,
	type RemJobStats,
	RemJobStore,
} from "./rem-job-store";

const log = createLogger("sno-station-mem:rem-sidecar");
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

export class DuplicateSidecarError extends Error {}

async function socketIsLive(socketPath: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		socket.once("connect", () => { socket.destroy(); resolve(true); });
		socket.once("error", error => {
			socket.destroy();
			if ("code" in error && (error.code === "ECONNREFUSED" || error.code === "ENOENT")) resolve(false);
			else reject(error);
		});
	});
}

async function bindSidecarSocket(): Promise<SocketServer> {
	const socketPath = getSidecarSocketPath();
	await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
	const directory = await open(path.dirname(socketPath), "r");
	// Serialize probe/unlink/bind on the existing directory, never on a replaceable pid file.
	try {
		for (;;) {
			try { locking.flockSync(directory.fd, "exnb"); break; }
			catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "EAGAIN")) throw error;
				await yieldTurn();
			}
		}
		const guard = createSocketServer(socket => socket.destroy());
		for (;;) {
			try {
				await new Promise<void>((resolve, reject) => {
					guard.once("error", reject);
					guard.listen(socketPath, () => { guard.removeListener("error", reject); resolve(); });
				});
				return guard;
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;
				if (await socketIsLive(socketPath)) {
					const discovery = await readDiscovery().catch(() => undefined);
					emitDiagnostic("info", "sidecar.duplicate.exit", { pid: discovery?.pid }, {
						event_name: "sidecar.duplicate.exit", file: "packages/sno-station-mem/src/sidecar/server.ts",
						function: "bindSidecarSocket", site_id: "sidecar.duplicate.exit",
					});
					throw new DuplicateSidecarError();
				}
				await rm(socketPath, { force: true });
			}
		}
	} finally { await directory.close(); }
}

export async function startRemSidecar(): Promise<RunningRemSidecar> {
	const guard = await bindSidecarSocket();
	const exitCleanup = (): void => { guard.close(); };
	process.once("exit", exitCleanup);
	const releaseGuard = async (): Promise<void> => {
		await new Promise<void>(resolve => guard.close(() => resolve()));
		process.removeListener("exit", exitCleanup);
	};
	try {
		const sidecar = await startOwnedRemSidecar();
		return {
			port: sidecar.port,
			async stop(): Promise<void> {
				let drained: Promise<void> | undefined;
				try { ({ drained } = await sidecar.stop()); }
				finally {
					if (drained) void drained.then(releaseGuard);
					else await releaseGuard();
				}
			},
		};
	} catch (error) {
		await releaseGuard();
		throw error;
	}
}

async function startOwnedRemSidecar(): Promise<{ port: number; stop(): Promise<{ drained?: Promise<void> }> }> {
	let stopping = false;
	let currentMemory: MemoryRuntimePool | undefined;
	let openingMemory: Promise<MemoryRuntimePool> | undefined;
	const memory = {
		current: (): MemoryRuntimePool | undefined => currentMemory,
		async open(): Promise<MemoryRuntimePool> {
			if (currentMemory) return currentMemory;
			openingMemory ??= import("./memory-runtime").then(module => module.MemoryRuntimePool.open()).then(pool => { currentMemory = pool; if (stopping) pool.stopTimers(); return pool; })
				.finally(() => { openingMemory = undefined; });
			return openingMemory;
		},
	};
	const token = randomBytes(32).toString("hex");
	const holdMs = readRemTestHoldMs();
	const chassisJournal = new RemChassisJournal(getRemChassisJournalPath());
	const store = RemJobStore.open(getRemJobJournalPath(), (job) => {
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
	const pendingTimers = new Map<NodeJS.Timeout, () => void>();
	const startPendingStarts = (): void => {
		for (const start of pendingTimers.values()) start();
	};
	const activeTasks = new Set<Promise<void> & { label?: string; method?: string }>();
	const pendingRequests = new Set<string>();
	const server = createServer((request, response) => {
		const started = performance.now();
		const operationId = `rem-http-${randomUUID()}`;
		const context: RequestLogContext = {};
		const requestLabel = `${operationId} ${request.method} ${requestPath(request)}`;
		pendingRequests.add(requestLabel);
		let requestLogged = false;
		const recordRequest = (cancelled = false): void => {
			if (requestLogged) return;
			requestLogged = true;
			pendingRequests.delete(requestLabel);
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
			store,
			chassisJournal,
			holdMs,
			pendingTimers,
			activeTasks,
			context,
			memory,
			() => stopping,
		).catch((error: unknown) => {
				let httpError = new HttpError(500, "internal_error");
				if (error instanceof HttpError) httpError = error;
				else if (error instanceof PayloadTooLargeError) httpError = new HttpError(413, "payload_too_large");
				context.error_code = httpError.code;
				log.error("request_failed", { error }, {
						event_name: "sno_station_mem.server.request.failed",
						file: "packages/sno-station-mem/src/sidecar/server.ts",
						function: "<anonymous callback>",
						site_id: "server.<anonymous callback>.a7a2656a08",
				});
				if (!response.headersSent) {
					sendJson(response, httpError.status, { error: httpError.code });
				} else {
					response.end();
				}
			}));
	});

	const jobs = await store;
	const recoveryJobs = jobs.nonTerminalJobs();
	await listen(server);
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("REM sidecar did not bind a TCP address");
	}
	const discoveryPath = getRemDiscoveryPath();
	const discovery = { port: address.port, token, pid: process.pid } satisfies DiscoveryState;
	let discoveryTimer: NodeJS.Timeout | undefined;
	let discoveryAttempt = 0;
	const publishDiscovery = async (): Promise<void> => {
		discoveryAttempt++;
		try {
			await writeDiscovery(discoveryPath, discovery);
			if (discoveryAttempt > 1) log.info("sidecar.discovery.published", { attempt: discoveryAttempt }, {
				event_name: "sidecar.discovery.published", file: "packages/sno-station-mem/src/sidecar/server.ts",
				function: "publishDiscovery", site_id: "sidecar.discovery.published",
			});
		} catch (error) {
			log.error("sidecar.discovery.failed", { attempt: discoveryAttempt, error }, {
				event_name: "sidecar.discovery.failed", file: "packages/sno-station-mem/src/sidecar/server.ts",
				function: "publishDiscovery", site_id: "sidecar.discovery.failed",
			});
			if (!stopping) discoveryTimer = setTimeout(() => { discoveryPublication = publishDiscovery(); }, 5_000);
		}
	};
	let discoveryPublication = publishDiscovery();
	await discoveryPublication;
	const recovery = (async () => {
		const jobIds = await recoverInterruptedJobs(jobs, await readCompletedJobStats(new Set(recoveryJobs.map(job => job.job_id))), recoveryJobs);
		for (const jobId of jobIds) await runChassisJob(jobs, chassisJournal, jobId, 0);
	})().catch(error => reportSidecarFailure("recovery", error));
	activeTasks.add(Object.assign(recovery, { label: "rem-recovery" }));
	void recovery.finally(() => activeTasks.delete(recovery));
	const exitCleanup = (): void => {
		removeOwnedDiscoverySync(discoveryPath, token);
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
		async stop(): Promise<{ drained?: Promise<void> }> {
			const started = performance.now();
			let cleanedUp = false;
			let phase = "http_requests";
			let timer: NodeJS.Timeout | undefined;
			stopping = true;
			clearTimeout(discoveryTimer);
			process.removeListener("exit", exitCleanup);
			try {
				startPendingStarts();
				currentMemory?.stopTimers();
				const cleanup = (async () => {
					await closeServer(server);
					// Requests still reading their body can allocate a delayed start during close.
					startPendingStarts();
					phase = "active_tasks";
					await Promise.allSettled(activeTasks);
					phase = "runtime_open";
					await openingMemory?.catch(() => undefined);
					phase = "runtime_close";
					await currentMemory?.close();
					phase = "discovery";
					await discoveryPublication;
					return true;
				})();
				cleanedUp = await Promise.race([cleanup, new Promise<false>(resolve => {
					timer = setTimeout(() => {
						log.error("sidecar.shutdown.timeout", {
							phase, active_tasks: activeTasks.size, pending_requests: [...pendingRequests],
							running_tasks: [...activeTasks].map(task => task.label ?? "rem"),
						}, {
							event_name: "sidecar.shutdown.timeout", file: "packages/sno-station-mem/src/sidecar/server.ts",
							function: "startRemSidecar.stop", site_id: "sidecar.shutdown.timeout",
						});
						for (const task of activeTasks) withLogContext({ operation_id: task.label }, () => {
							log.error("sidecar.shutdown.task.running", { method: task.method ?? "rem" }, {
								event_name: "sidecar.shutdown.task.running", file: "packages/sno-station-mem/src/sidecar/server.ts",
								function: "startRemSidecar.stop", site_id: "sidecar.shutdown.task.running",
							});
						});
						server.closeAllConnections();
						currentMemory?.stopTimers();
						resolve(false);
					}, MEMORY_SHUTDOWN_TIMEOUT_MS);
				})]);
			} finally {
				clearTimeout(timer);
				// Keep the socket guard until no publication can overwrite a successor.
				await discoveryPublication;
				await removeOwnedDiscovery(discoveryPath, token);
				log[cleanedUp ? "info" : "error"]("REM sidecar cleanup completed", {
					outcome: cleanedUp ? "success" : "failed",
					duration_ms: performance.now() - started, active_tasks: activeTasks.size,
				}, {
					event_name: "sidecar.shutdown.completed", file: "packages/sno-station-mem/src/sidecar/server.ts",
					function: "startRemSidecar.stop", site_id: "sidecar.shutdown.completed",
				});
			}
			return cleanedUp ? {} : { drained: Promise.allSettled(activeTasks).then(() => undefined) };
		},
	};
}

async function routeRequest(
	request: IncomingMessage,
	response: ServerResponse,
	pendingStore: Promise<RemJobStore>,
	chassisJournal: RemChassisJournal,
	holdMs: number,
	pendingTimers: Map<NodeJS.Timeout, () => void>,
	activeTasks: Set<Promise<void>>,
	context: RequestLogContext,
	memory: { current(): MemoryRuntimePool | undefined; open(): Promise<MemoryRuntimePool> },
	isStopping: () => boolean,
): Promise<void> {
	const url = new URL(request.url ?? HEALTH_PATH, REM_SIDECAR_ORIGIN);
	if (request.method === "GET" && url.pathname === HEALTH_PATH) {
		sendJson(response, 200, { status: "ok", log_level: effectiveLogLevel(), principal: getPrincipal(),
			storePath: await readBoundStorePath(), accessCounters: memory.current()?.counters ?? { engineAccesses: 0, storeAccesses: 0 } });
		return;
	}
	if (url.pathname.startsWith("/v1/")) {
		if (await serveMemoryRoute(request, response, url.pathname, () => memory.open(), activeTasks)) return;
	}
	if (request.method === "POST" && url.pathname === REM_RUN_PATH) {
		const correlationId = readCorrelationId(request) ?? `rem-corr-${randomUUID()}`;
		context.correlation_id = correlationId;
		const raw = await readJsonBody(request);
		const parsedInput = runRequestSchema.safeParse(raw);
		if (!parsedInput.success) throw new HttpError(400, "invalid_request");
		const input = parsedInput.data;
		const types = "types" in input ? input.types : [input.type];
		const requestedTypes = types.filter(type => REM_BUILT_OPERATION_TYPES.some(operation => operation === type));
		const unknownTypes = types.filter(type => !requestedTypes.includes(type));
		if (unknownTypes.length) {
			reportSidecarFailure("unsupported_rem_type", new Error(unknownTypes.join(",")));
			context.error_code = "unsupported_rem_type";
			sendJson(response, 400, { error: "unsupported_rem_type", unknownTypes });
			return;
		}
		const store = await pendingStore;
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
			const { promise: task, resolve, reject } = Promise.withResolvers<void>();
			activeTasks.add(Object.assign(task, { label: job.job_id }));
			void task.catch(error => reportSidecarFailure("rem_run", error))
				.finally(() => activeTasks.delete(task));
			const start = (): void => {
				clearTimeout(timer);
				pendingTimers.delete(timer);
				void runChassisJob(store, chassisJournal, job.job_id, holdMs).then(resolve, reject);
			};
			const timer = setTimeout(start, delayMs);
			pendingTimers.set(timer, start);
			if (isStopping()) start();
		}
		sendJson(response, 202, { job_id: job.job_id, waveId: job.job_id });
		return;
	}
	if (request.method === "GET" && url.pathname.startsWith(REM_JOBS_PATH_PREFIX)) {
		const store = await pendingStore;
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
): Promise<void> {
	const queued = store.get(waveId);
	if (queued === undefined) throw new Error(`REM wave not found: ${waveId}`);
	const resuming = queued.state === "running";
	return withLogContext({ operation_id: queued.job_id, job_id: queued.job_id, session_reference: queued.scope, external_reference: queued.correlation_id }, async () => {
		const started = performance.now();
		let persistence: CompletionPersistence = "unavailable";
		let completion: RemJobStats | undefined;
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
			const configuration = configSource === undefined
				? readRemOperationalConfig()
				: readRemOperationalConfig(configSource);
			const enabledOperations: RemBuiltOperationType[] = [];
			const cleanRefusalReasons: string[] = [];
			for (const operation of requestedOperations) {
				let reason: string;
				if (!isBuiltOperation(operation)) {
					reason = `not-built:${operation}`;
				} else if (configuration.operations[operation]) {
					enabledOperations.push(operation);
					continue;
				} else {
					reason = `switched-off:${operation}`;
				}
				cleanRefusalReasons.push(reason);
				await appendChassisRefusal(journal, queued, operation, "refused", reason);
			}
			const { runRemProductionOrderedWave } = await import("./rem-batch-executor");
			const result = enabledOperations.length === 0
				? {
						decision: "allow" as const,
						reasonCode: null,
						waveId: queued.job_id,
						actionsApplied: 0,
						actionableCandidateCount: 0,
						appliedFraction: null,
						candidateCount: 0,
						stampedSkippedCount: 0,
						parseFailureCount: 0,
						topRefusalReasons: [],
						measurements: {
							rowsConsidered: 0,
							pairsBuilt: 0,
							pairCapBinding: false,
							modelCalls: 0,
							modelTokens: 0,
							wallMs: 0,
						},
						perOperation: [],
					}
				: await runRemProductionOrderedWave({
						stateRoot: getStateDir(),
						personaDbPath: process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"],
						configSource: JSON.stringify(configuration),
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
				...(result.perOperation.length === 0
					? {}
					: {
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
						}),
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
			else if ((completion?.applied_count ?? 0) > 0) outcome = "success";
			log[failed || persistence === "unavailable" ? "error" : "info"]("REM job completed", {
				outcome,
				job_id: queued.job_id,
				basis: persistence,
				applied_count: completion?.applied_count ?? (writesApplied ? null : 0),
				candidate_count: completion?.scan?.candidate_count ?? null,
				parse_failure_count: completion?.parse_failure_count ?? null,
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
	store: RemJobStore, job: RemJob, stats: RemJobStats,
): Promise<CompletionPersistence> {
	const auditPersisted = await auditRem("rem_completed", job, { stats });
	await store.transition(job.job_id, { state: "done", finished_at: new Date().toISOString(), stats });
	if (store.isPersisted(job.job_id)) return "job_journal";
	if (auditPersisted) return "completed_audit";
	reportSidecarFailure("completion-persistence", new Error("completed work has no durable completion receipt"));
	return "unavailable";
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
	jobs: RemJob[],
): Promise<string[]> {
	const resumableJobIds: string[] = [];
	for (const job of jobs) {
		try {
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
		} catch (error) { reportSidecarFailure("job-recovery", error); }
	}
	return resumableJobIds;
}

async function readCompletedJobStats(wantedJobs: ReadonlySet<string>): Promise<Map<string, RemJobStats>> {
	const completed = new Map<string, RemJobStats>();
	for await (const line of readJsonlLines(getAuditPath(getSnoStationMemStateDir()))) {
		if (line.length === 0) continue;
		try {
			const entry: unknown = JSON.parse(line);
			if (!isRecord(entry) || entry["event"] !== "rem_completed") continue;
			const details = entry["details"];
			if (!isRecord(details) || typeof details["job_id"] !== "string" || !wantedJobs.has(details["job_id"])) continue;
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
): Promise<boolean> {
	return appendAuditEntryStrict(getSnoStationMemStateDir(), {
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

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	const body = await readRequestBody(request);
	try {
		return JSON.parse(body) as unknown;
	} catch {
		throw new HttpError(400, "invalid_request");
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
		try {
			await handle.writeFile(JSON.stringify(discovery), "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporaryPath, discoveryPath);
		await syncDirectory(parent);
	} finally {
		await rm(temporaryPath, { force: true });
	}
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function reportSidecarFailure(step: string, error: unknown): void {
	log.error("sidecar.operation.failed", { step, error }, {
		event_name: "sidecar.operation.failed", file: "packages/sno-station-mem/src/sidecar/server.ts",
		function: "reportSidecarFailure", site_id: "sidecar.operation.failed",
	});
}
