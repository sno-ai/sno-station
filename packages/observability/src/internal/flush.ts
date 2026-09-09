import { createUUIDv7 } from "@snoai/common-core";
import {
	type BufferStore,
	decodeEnvelope,
	type PendingChain,
	type PendingRow,
} from "./buffer-store.js";
import { type MachineRegistrationCache, registerBeforeFlush } from "./flush-registration.js";
import { type EventPostResult, postEvent } from "./http.js";
import { logger } from "./log.js";
import type { PathEnv } from "./paths.js";
import { type Identity, SDK_VERSION } from "./types.js";

export const SCHEDULE_FLUSH_DELAY_MS = 5_000;

export interface FlushOptions {
	baseUrl?: string;
	env?: PathEnv;
	fetch?: typeof fetch;
	force?: boolean;
	identity: Identity;
	machineRegistrationCache?: MachineRegistrationCache;
	signal?: AbortSignal;
}

export interface FlushResult {
	shipped: number;
	terminal: number;
	retryable: number;
	retryAfterMs?: number;
}

interface RowFlushResult extends FlushResult {
	retryScope?: "chain";
	stopBatch?: boolean;
}

export interface DrainResult {
	flushedCount: number;
	failedCount: number;
	lastError?: string;
}

const MAX_STAGNANT_DRAIN_STEPS = 100;
const PERMANENT_PREDECESSOR_GAP_MS = 5 * 60 * 1_000;
const MAX_RETRY_BACKOFF_MS = 30_000;
const SAFEGUARD_RETRY_DELAY_MS = 15 * 60 * 1_000;

export class FlushEngine {
	private state: "idle" | "scheduled" | "flushing" = "idle";
	private timer: ReturnType<typeof setTimeout> | null = null;
	private timerDeadlineMs = 0;
	private timerPreemptible = false;
	private beforeExitInstalled = false;
	private beforeExitHandler: (() => void) | null = null;
	private activeFlush: Promise<FlushResult> | null = null;
	private readonly machineRegistrationCache: MachineRegistrationCache = { registered: false };
	private disposed = false;
	private backoffMs = 5_000;
	private retryNotBeforeMs = 0;

	constructor(
		private readonly store: BufferStore,
		private readonly identityProvider: () => Identity,
		private readonly baseUrlProvider: () => string,
		private readonly envProvider: () => PathEnv = () => process.env,
		private readonly fetchProvider: () => typeof fetch | undefined = () => undefined,
	) {}

	schedule(delayMs: number, preemptible = false): void {
		if (this.disposed) {
			return;
		}
		if (this.state === "flushing") {
			return;
		}
		if (this.state === "scheduled") {
			const requestedDeadline = Date.now() + delayMs;
			if (
				!this.timerPreemptible ||
				this.timer === null ||
				requestedDeadline >= this.timerDeadlineMs
			) {
				return;
			}
			clearTimeout(this.timer);
			this.timer = null;
			this.state = "idle";
		}
		this.state = "scheduled";
		this.timerDeadlineMs = Date.now() + delayMs;
		this.timerPreemptible = preemptible;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.timerDeadlineMs = 0;
			this.timerPreemptible = false;
			if (this.disposed) {
				return;
			}
			this.state = "idle";
			void this.flush(this.flushOptions(false)).catch((error: unknown) => {
				logger.errorRateLimited("scheduled-flush", "sno observe scheduled flush failed", {
					error: errorName(error),
				}, {
					event_name: "sno.observe.internal.flush.schedule",
					file: "packages/sno-observe/src/internal/flush.ts",
					function: "schedule",
					site_id: "sno.observe.internal.flush.schedule.1",
				});
				let shouldRetry = true;
				try {
					shouldRetry = this.store.countPending() > 0;
				} catch {}
				if (!this.disposed && shouldRetry) {
					this.schedule(SCHEDULE_FLUSH_DELAY_MS, true);
				}
			});
		}, delayMs);
		this.timer.unref?.();
		this.installBeforeExit();
	}

	async flush(options: Omit<FlushOptions, "baseUrl">): Promise<FlushResult> {
		if (this.disposed) {
			return { shipped: 0, terminal: 0, retryable: 0 };
		}
		if (this.state === "flushing") {
			return this.activeFlush ?? { shipped: 0, terminal: 0, retryable: 0 };
		}
		const retryDelayMs = Math.max(
			0,
			this.retryNotBeforeMs - Date.now(),
			this.store.getRetryDelay(),
		);
		if (retryDelayMs > 0) {
			this.schedule(retryDelayMs);
			return { shipped: 0, terminal: 0, retryable: 1, retryAfterMs: retryDelayMs };
		}
		const activeFlush = this.runFlush(options);
		this.activeFlush = activeFlush;
		try {
			return await activeFlush;
		} finally {
			if (this.activeFlush === activeFlush) {
				this.activeFlush = null;
			}
		}
	}

	private async runFlush(options: Omit<FlushOptions, "baseUrl">): Promise<FlushResult> {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
			this.timerDeadlineMs = 0;
			this.timerPreemptible = false;
		}
		this.state = "flushing";
		try {
			const result = await flushPending(this.store, {
				...options,
				baseUrl: this.baseUrlProvider(),
				machineRegistrationCache: this.machineRegistrationCache,
			});
			if (result.shipped > 0) {
				this.backoffMs = 5_000;
			}
			if (result.retryable > 0) {
				this.state = "idle";
				const globalRetryDelayMs = this.store.getRetryDelay();
				const globalRetry = globalRetryDelayMs > 0;
				const baseDelayMs = globalRetry
					? Math.max(globalRetryDelayMs, result.retryAfterMs ?? 0)
					: (result.retryAfterMs ?? this.backoffMs);
				const delayMs = jitterDelay(baseDelayMs);
				this.retryNotBeforeMs = globalRetry ? Date.now() + delayMs : 0;
				if (globalRetry) {
					this.store.deferRetriesUntil(this.retryNotBeforeMs);
				}
				this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
				const wakeDelayMs = !globalRetry && this.store.getReadyPending(1).length > 0
					? SCHEDULE_FLUSH_DELAY_MS
					: delayMs;
				this.schedule(wakeDelayMs, !globalRetry);
			} else {
				this.retryNotBeforeMs = 0;
			}
			if (result.retryable === 0 && this.store.countPending() > 0) {
				this.state = "idle";
				this.schedule(SCHEDULE_FLUSH_DELAY_MS);
			}
			return result;
		} finally {
			if (this.state === "flushing") {
				this.state = "idle";
			}
		}
	}

	async drain(): Promise<DrainResult> {
		let flushedCount = 0;
		let terminalCount = 0;
		let lastError: string | undefined;
		let stagnantDrainSteps = 0;
		while (stagnantDrainSteps < MAX_STAGNANT_DRAIN_STEPS) {
			try {
				const step = await this.drainStep();
				if (step === null) {
					break;
				}
				flushedCount += step.result.shipped;
				terminalCount += step.result.terminal;
				if (step.stop) {
					break;
				}
				if (step.pendingAfter < step.pendingBefore) {
					stagnantDrainSteps = 0;
				} else {
					stagnantDrainSteps += 1;
				}
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
				logger.error("sno observe drain failed", { error: lastError }, {
					event_name: "sno.observe.internal.flush.drain",
					file: "packages/sno-observe/src/internal/flush.ts",
					function: "drain",
					site_id: "sno.observe.internal.flush.drain.2",
				});
				break;
			}
		}
		const pendingCount = this.store.countPending();
		if (
			stagnantDrainSteps >= MAX_STAGNANT_DRAIN_STEPS &&
			pendingCount > 0 &&
			lastError === undefined
		) {
			lastError = "sno observe drain made no progress";
			logger.warn("sno observe drain stopped after repeated no-progress steps", {
				max_stagnant_drain_steps: MAX_STAGNANT_DRAIN_STEPS,
				pending_count: pendingCount,
			}, {
				event_name: "sno.observe.internal.flush.drain",
				file: "packages/sno-observe/src/internal/flush.ts",
				function: "drain",
				site_id: "sno.observe.internal.flush.drain.3",
			});
		}
		const failedCount = terminalCount + pendingCount;
		return { flushedCount, failedCount, ...(lastError === undefined ? {} : { lastError }) };
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.timerDeadlineMs = 0;
		this.timerPreemptible = false;
		if (this.beforeExitHandler !== null) {
			process.off("beforeExit", this.beforeExitHandler);
			this.beforeExitHandler = null;
			this.beforeExitInstalled = false;
		}
		this.state = "idle";
	}

	private installBeforeExit(): void {
		if (this.beforeExitInstalled) {
			return;
		}
		this.beforeExitInstalled = true;
		this.beforeExitHandler = () => {
			this.beforeExitInstalled = false;
			this.beforeExitHandler = null;
			if (this.disposed) {
				return;
			}
			void this.flush(this.flushOptions(true)).catch((error: unknown) => {
				logger.errorRateLimited("before-exit-flush", "sno observe before-exit flush failed", {
					error: errorName(error),
				}, {
					event_name: "sno.observe.internal.flush.installbeforeexit",
					file: "packages/sno-observe/src/internal/flush.ts",
					function: "installBeforeExit",
					site_id: "sno.observe.internal.flush.installbeforeexit.4",
				});
			});
		};
		process.once("beforeExit", this.beforeExitHandler);
	}

	private flushOptions(force: boolean): Omit<FlushOptions, "baseUrl"> {
		const fetchImpl = this.fetchProvider();
		return {
			identity: this.identityProvider(),
			env: this.envProvider(),
			force,
			...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
		};
	}

	private async drainStep(): Promise<{
		result: FlushResult;
		stop: boolean;
		pendingBefore: number;
		pendingAfter: number;
	} | null> {
		const activeFlush = this.activeFlush;
		if (activeFlush !== null) {
			const pendingBefore = this.store.countPending();
			const result = await activeFlush;
			const pendingAfter = this.store.countPending();
			return {
				result,
				stop: shouldStopDrain(result, pendingBefore, pendingAfter),
				pendingBefore,
				pendingAfter,
			};
		}
		const pendingBefore = this.store.countPending();
		if (pendingBefore === 0) {
			return null;
		}
		const result = await this.flush(this.flushOptions(true));
		const pendingAfter = this.store.countPending();
		return {
			result,
			stop: shouldStopDrain(result, pendingBefore, pendingAfter),
			pendingBefore,
			pendingAfter,
		};
	}
}

function shouldStopDrain(
	result: FlushResult,
	pendingBefore: number,
	pendingAfter: number,
): boolean {
	return (
		result.retryable > 0 ||
		(pendingAfter >= pendingBefore && result.shipped === 0 && result.terminal === 0)
	);
}

export async function flushPending(
	store: BufferStore,
	options: FlushOptions,
): Promise<FlushResult> {
	const persistentRetryDelay = store.getRetryDelay();
	if (persistentRetryDelay > 0) {
		return { shipped: 0, terminal: 0, retryable: 1, retryAfterMs: persistentRetryDelay };
	}
	const leaseOwner = createUUIDv7();
	const leaseRetryDelay = store.acquireFlushLease(leaseOwner);
	if (leaseRetryDelay > 0) {
		return { shipped: 0, terminal: 0, retryable: 1, retryAfterMs: leaseRetryDelay };
	}
	try {
		const postLeaseRetryDelay = store.getRetryDelay();
		if (postLeaseRetryDelay > 0) {
			return { shipped: 0, terminal: 0, retryable: 1, retryAfterMs: postLeaseRetryDelay };
		}
		return await flushPendingWithLease(store, options, leaseOwner);
	} finally {
		try {
			store.releaseFlushLease(leaseOwner);
		} catch (error) {
			logger.warn("Sno Observe flush lease release failed", { error }, {
				event_name: "observe.flush.lease_release_failed",
				file: "packages/sno-observe/src/internal/flush.ts",
				function: "flushPending",
				site_id: "observe.flush.lease_release_failed",
			});
		}
	}
}

async function flushPendingWithLease(
	store: BufferStore,
	options: FlushOptions,
	leaseOwner: string,
): Promise<FlushResult> {
	const firstRows = store.getReadyPending(1);
	if (firstRows.length === 0) {
		if (store.countPending() > 0) {
			return {
				shipped: 0,
				terminal: 0,
				retryable: 1,
				retryAfterMs: store.getNextChainRetryDelay() || 5_000,
			};
		}
		await maintainAfterRetention(store);
		store.clearElapsedRetryDeadline();
		return { shipped: 0, terminal: 0, retryable: 0 };
	}
	const registrationFailure = await registerBeforeFlush(store, firstRows, options);
	if (registrationFailure !== null) {
		store.pruneRetention();
		return persistRetryDeadline(store, registrationFailure);
	}

	let shipped = 0;
	let terminal = 0;
	let retryable = 0;
	let globalRetryable = 0;
	let chainRetryAfterMs: number | undefined;
	let globalRetryAfterMs: number | undefined;
	let submitted = 0;
	const blockedChains: PendingChain[] = [];
	let stopBatch = false;
	while (submitted < 100 && !stopBatch) {
		const rows = store.getPendingExcludingChains(blockedChains, 100 - submitted);
		if (rows.length === 0) {
			break;
		}
		let requery = false;
		for (const row of rows) {
			if (!store.renewFlushLease(leaseOwner)) {
				retryable += 1;
				globalRetryable += 1;
				globalRetryAfterMs = minDefined(globalRetryAfterMs, 5_000);
				stopBatch = true;
				break;
			}
			const result = await flushRow(store, row, options);
			submitted += 1;
			shipped += result.shipped;
			terminal += result.terminal;
			retryable += result.retryable;
			if (result.retryScope !== "chain") {
				globalRetryable += result.retryable;
				globalRetryAfterMs = minDefined(globalRetryAfterMs, result.retryAfterMs);
			} else {
				chainRetryAfterMs = minDefined(chainRetryAfterMs, result.retryAfterMs);
			}
			if (result.retryScope === "chain") {
				blockedChains.push({
					machineId: row.machine_id,
					agentId: row.agent_id,
					chainEpoch: row.chain_epoch,
				});
				requery = true;
				break;
			}
			if (result.retryable > 0 || result.stopBatch === true) {
				stopBatch = true;
				break;
			}
		}
		if (!requery) {
			break;
		}
	}
	await maintainAfterRetention(store);
	const retryAfterMs = globalRetryable > 0 ? globalRetryAfterMs : chainRetryAfterMs;
	return persistRetryDeadline(
		store,
		withOptionalRetryAfter({ shipped, terminal, retryable }, retryAfterMs),
		globalRetryable > 0,
	);
}

async function maintainAfterRetention(store: BufferStore): Promise<void> {
	const report = store.pruneRetention();
	if (
		report.deletedEvents === 0 &&
		report.deletedChainTail === 0 &&
		report.deletedChainState === 0 &&
		report.deletedChainRetry === 0 &&
		store.countPending() === 0
	) {
		await store.compactIfNeeded();
	}
}

function persistRetryDeadline(
	store: BufferStore,
	result: FlushResult,
	persistRetry = result.retryable > 0,
): FlushResult {
	if (result.retryable > 0 && persistRetry) {
		store.deferRetriesUntil(Date.now() + (result.retryAfterMs ?? 5_000));
	} else if (result.retryable === 0) {
		store.clearElapsedRetryDeadline();
	}
	return result;
}

async function flushRow(
	store: BufferStore,
	row: PendingRow,
	options: FlushOptions,
): Promise<RowFlushResult> {
	try {
		const response = await postEvent(
			options.baseUrl ?? "https://www.sno.ai",
			row.payload.toString("utf8"),
			options.identity.machine_secret,
			options.fetch,
			options.signal,
		);
		if (response.status === 401 || response.status === 403) {
			if (options.machineRegistrationCache !== undefined) {
				options.machineRegistrationCache.registered = false;
			}
		}
		return handlePostResult(store, row, response);
	} catch (error) {
		store.incrementAttempts(row.rowid);
		const retryAfterMs = retryDelay(store, row, undefined);
		logger.warnRateLimited(`network:${row.event_id}:${errorName(error)}`, "sno observe network error", {
			event_id: row.event_id,
			error,
		}, {
			event_name: "sno.observe.internal.flush.flushrow",
			file: "packages/sno-observe/src/internal/flush.ts",
			function: "flushRow",
			site_id: "sno.observe.internal.flush.flushrow.5",
		});
		return { shipped: 0, terminal: 0, retryable: 1, retryAfterMs };
	}
}

type ResponseRoute =
	| { kind: "shipped" }
	| { kind: "invalid"; reason: string }
	| { kind: "chain"; reason: string }
	| {
			kind: "retry";
			message: string;
			retryAfterMs?: number;
			error?: boolean;
			retryScope?: "chain";
	  };

const ACCEPTED_DUPLICATE_CODES = new Set([
	"duplicate_event",
	"event_already_accepted",
	"event_already_exists",
	"already_accepted",
	"idempotent_replay",
]);

const CHAIN_REJECTION_CODES = new Set([
	"chain_gap",
	"payload_conflict",
	"chain_seed_required",
	"prev_hash_mismatch",
	"self_hash_mismatch",
]);

const INVALID_EVENT_CODES = new Set([
	"agent_id_not_in_enum",
	"batch_wrapper_rejected",
	"consent_level_not_in_enum",
	"invalid_envelope",
	"invalid_json",
	"legacy_flat_shape_rejected",
	"schema_invalid",
	"single_envelope_required",
	"tokens_method_required",
]);

const FORBIDDEN_EVENT_CODES = new Set([
	"identity_mismatch",
	"machine_scope_forbidden",
	"ownership_denied",
	"scope_user_mismatch",
]);

function handlePostResult(
	store: BufferStore,
	row: PendingRow,
	response: EventPostResult,
): RowFlushResult {
	const route = routeResponse(response, row);
	switch (route.kind) {
		case "shipped":
			store.markShipped(row.rowid);
			return { shipped: 1, terminal: 0, retryable: 0 };
		case "invalid": {
			const recoveryState = recoveryStateFor(row);
			const terminal = store.quarantineEpochSuffix(
				row,
				response.status,
				route.reason,
				response.body,
				recoveryState,
			);
			reseedRejectedSuffix(store, row);
			logger.error("sno observe event rejected as invalid", {
				event_id: row.event_id,
				status: response.status,
				reason: route.reason,
			}, {
				event_name: "sno.observe.internal.flush.handlepostresult",
				file: "packages/sno-observe/src/internal/flush.ts",
				function: "handlePostResult",
				site_id: "sno.observe.internal.flush.handlepostresult.6",
			});
			return { shipped: 0, terminal, retryable: 0, stopBatch: true };
		}
		case "chain": {
			const recoveryState = recoveryStateFor(row);
			const terminal = store.quarantineEpochSuffix(
				row,
				response.status,
				route.reason,
				response.body,
				recoveryState,
			);
			reseedRejectedSuffix(store, row);
			logChainRejection(row, response.status, route.reason);
			return { shipped: 0, terminal, retryable: 0, stopBatch: true };
		}
		case "retry":
			return retryRow(
				store,
				row,
				response.status,
				response.body,
				route.message,
				route.retryAfterMs,
				route.error,
				route.retryScope,
			);
	}
}

function routeResponse(response: EventPostResult, row: PendingRow): ResponseRoute {
	const code = responseErrorCode(response.body);
	switch (response.status) {
		case 202:
			return { kind: "shipped" };
		case 200:
			return {
				kind: "retry",
				message: "sno observe returned unexpected event-ingest status; will retry",
				retryAfterMs: response.retryAfterMs ?? 5_000,
			};
		case 400:
			return code !== undefined && INVALID_EVENT_CODES.has(code)
				? { kind: "invalid", reason: code }
				: retryRoute(response.retryAfterMs ?? 5_000, "chain");
		case 409:
		case 422:
			return routeConflict(response, row);
		case 401:
			return { kind: "retry", message: "sno observe unauthorized; will retry" };
		case 403:
			return code !== undefined && FORBIDDEN_EVENT_CODES.has(code)
				? { kind: "invalid", reason: code }
				: retryRoute(response.retryAfterMs ?? 5_000, "chain");
		case 429:
			return retryRoute(response.retryAfterMs ?? 3_600_000);
		case 503:
			return retryRoute(response.retryAfterMs ?? 5_000);
		default:
			return response.status >= 400 && response.status < 500
				? retryRoute(response.retryAfterMs ?? undefined, "chain")
				: retryRoute(response.retryAfterMs ?? undefined);
	}
}

function routeConflict(response: EventPostResult, row: PendingRow): ResponseRoute {
	const code = responseErrorCode(response.body);
	if (code !== undefined && ACCEPTED_DUPLICATE_CODES.has(code)) {
		return { kind: "shipped" };
	}
	if (code === "chain_predecessor_not_ready") {
		if (isPermanentPredecessorGap(response.body, row)) {
			return { kind: "chain", reason: "permanent_predecessor_gap" };
		}
		return retryRoute(response.retryAfterMs ?? 5_000, "chain");
	}
	if (code !== undefined && CHAIN_REJECTION_CODES.has(code)) {
		return { kind: "chain", reason: code };
	}
	return {
		kind: "retry",
		message: "sno observe conflict response is not terminal; will retry",
		retryAfterMs: response.retryAfterMs ?? 5_000,
		retryScope: "chain",
	};
}

function isPermanentPredecessorGap(body: string, row: PendingRow): boolean {
	const parsed = parseResponseBody(body);
	if (parsed === null || parsed.code !== "chain_predecessor_not_ready") {
		return false;
	}
	const details = gapDetails(parsed.root, parsed.nestedError);
	if (details === null) {
		return false;
	}
	const expectedSeq = integerDetail(details["expected_seq"]);
	const receivedSeq = integerDetail(details["received_seq"]);
	const lastCommittedSeq = committedSequenceDetail(details["last_committed_seq"]);
	const stallMs = integerDetail(details["chain_stall_ms"]);
	return (
		details["machine_uuid"] === row.machine_id &&
		details["agent_id"] === row.agent_id &&
		integerDetail(details["chain_epoch"]) === row.chain_epoch &&
		details["latest_state"] === "committed" &&
		stallMs !== undefined &&
		stallMs >= PERMANENT_PREDECESSOR_GAP_MS &&
		expectedSeq !== undefined &&
		receivedSeq === row.seq &&
		receivedSeq === expectedSeq + 1 &&
		lastCommittedSeq === expectedSeq - 1
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function integerDetail(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined;
}

function committedSequenceDetail(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= -1
		? value
		: undefined;
}

function responseErrorCode(body: string): string | undefined {
	return parseResponseBody(body)?.code;
}

function parseResponseBody(body: string): {
	root: Record<string, unknown>;
	nestedError: Record<string, unknown> | null;
	code: string | undefined;
} | null {
	try {
		const parsed = JSON.parse(body) as unknown;
		if (!isRecord(parsed)) {
			return null;
		}
		const nestedError = isRecord(parsed["error"]) ? parsed["error"] : null;
		const candidates = new Set<string>();
		for (const key of ["reason", "code", "error_code", "error"]) {
			const value = parsed[key];
			if (typeof value === "string" && value.length > 0) {
				candidates.add(value);
			}
		}
		if (nestedError !== null) {
			const code = nestedError["code"];
			if (typeof code === "string" && code.length > 0) {
				candidates.add(code);
			}
		}
		return {
			root: parsed,
			nestedError,
			code: candidates.size === 1 ? candidates.values().next().value : undefined,
		};
	} catch {
		return null;
	}
}

const GAP_DETAIL_KEYS = [
	"machine_uuid",
	"agent_id",
	"chain_epoch",
	"expected_seq",
	"received_seq",
	"latest_state",
	"last_committed_seq",
	"chain_stall_ms",
];

function gapDetails(
	root: Record<string, unknown>,
	nested: Record<string, unknown> | null,
): Record<string, unknown> | null {
	const details: Record<string, unknown> = {};
	for (const key of GAP_DETAIL_KEYS) {
		const rootHas = Object.hasOwn(root, key);
		const nestedHas = nested !== null && Object.hasOwn(nested, key);
		if (rootHas && nestedHas && root[key] !== nested[key]) {
			return null;
		}
		if (nestedHas && nested !== null) {
			details[key] = nested[key];
		} else if (rootHas) {
			details[key] = root[key];
		}
	}
	return details;
}

function retryRoute(retryAfterMs?: number, retryScope?: "chain"): ResponseRoute {
	return withRetryAfter(
		{
			kind: "retry",
			message: "sno observe transport will retry",
			...(retryScope === undefined ? {} : { retryScope }),
		},
		retryAfterMs,
	);
}

function logChainRejection(row: PendingRow, status: number, reason: string): void {
	const envelope = decodeEnvelope(row.payload);
	logger.error("sno observe chain rejected", {
		event_id: envelope.event_id,
		status,
		agent_id: envelope.scope.agent_id,
		reason,
	}, {
		event_name: "sno.observe.internal.flush.logchainrejection",
		file: "packages/sno-observe/src/internal/flush.ts",
		function: "logChainRejection",
		site_id: "sno.observe.internal.flush.logchainrejection.7",
	});
}

function retryRow(
	store: BufferStore,
	row: PendingRow,
	status: number,
	body: string,
	message: string,
	retryAfterMs?: number,
	error = false,
	retryScope?: "chain",
): RowFlushResult {
	store.incrementAttempts(row.rowid);
	const effectiveRetryAfterMs = retryDelay(store, row, retryAfterMs, retryScope === "chain");
	if (retryScope === "chain") {
		store.deferChainRetriesUntil(
			{ machineId: row.machine_id, agentId: row.agent_id, chainEpoch: row.chain_epoch },
			Date.now() + effectiveRetryAfterMs,
		);
	}
	const code = responseErrorCode(body);
	const context = {
		event_id: row.event_id,
		status,
		failure_code: code,
		retry_after_ms: effectiveRetryAfterMs,
	};
	const failureKey = `http:${row.event_id}:${status}:${code ?? message}`;
	if (error) {
		logger.errorRateLimited(failureKey, "Sno Observe delivery deferred", context, {
			event_name: "sno.observe.internal.flush.retryrow",
			file: "packages/sno-observe/src/internal/flush.ts",
			function: "retryRow",
			site_id: "sno.observe.internal.flush.retryrow.8",
		});
	} else {
		logger.warnRateLimited(failureKey, "Sno Observe delivery deferred", context, {
			event_name: "sno.observe.internal.flush.retryrow",
			file: "packages/sno-observe/src/internal/flush.ts",
			function: "retryRow",
			site_id: "sno.observe.internal.flush.retryrow.9",
		});
	}
	return {
		...withOptionalRetryAfter(
		{ shipped: 0, terminal: 0, retryable: 1 },
		effectiveRetryAfterMs,
		),
		...(retryScope === undefined ? {} : { retryScope }),
	};
}

function retryDelay(
	store: BufferStore,
	row: PendingRow,
	requested: number | undefined,
	chainScoped = false,
): number {
	const attempt = row.attempts + 1;
	const exponent = Math.min(Math.max(0, attempt - 1), 3);
	const attemptDelay = Math.min(5_000 * 2 ** exponent, MAX_RETRY_BACKOFF_MS);
	const safeguardDelay =
		chainScoped || store.getQueueSafeguard() === null ? 0 : SAFEGUARD_RETRY_DELAY_MS;
	return Math.max(requested ?? attemptDelay, attemptDelay, safeguardDelay);
}

function jitterDelay(delayMs: number): number {
	const jitterWindowMs = Math.min(delayMs * 0.2, MAX_RETRY_BACKOFF_MS);
	return Math.ceil(delayMs + Math.random() * jitterWindowMs);
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : typeof error;
}

function reseedRejectedSuffix(store: BufferStore, row: PendingRow): void {
	const envelope = decodeEnvelope(row.payload);
	if (envelope.event_type === "agent.identify") {
		return;
	}
	store.append({
		eventId: createUUIDv7(),
		eventType: "agent.identify",
		lane: envelope.lane,
		tsEdgeMs: Date.now(),
		consentLevel: envelope.consent_level,
		redacted: false,
		scope: envelope.scope,
		payload: {
			agent_id: envelope.scope.agent_id,
			machine_id: envelope.scope.machine_id,
			sdk_version: SDK_VERSION,
		},
		terminal: false,
		chainEpoch: store.nextEpoch(row.machine_id, row.agent_id),
	});
}

function recoveryStateFor(row: PendingRow): "reseed_required" | "retired" {
	return decodeEnvelope(row.payload).event_type === "agent.identify"
		? "retired"
		: "reseed_required";
}

function minDefined(left: number | undefined, right: number | undefined): number | undefined {
	return left === undefined ? right : right === undefined ? left : Math.min(left, right);
}

function withOptionalRetryAfter(
	result: FlushResult,
	retryAfterMs: number | undefined,
): FlushResult {
	return retryAfterMs === undefined ? result : { ...result, retryAfterMs };
}

function withRetryAfter(
	result: Extract<ResponseRoute, { kind: "retry" }>,
	retryAfterMs: number | undefined,
): Extract<ResponseRoute, { kind: "retry" }> {
	return retryAfterMs === undefined ? result : { ...result, retryAfterMs };
}
