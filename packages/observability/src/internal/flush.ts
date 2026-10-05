import { createUUIDv7 } from "@snoai/common-core";
import {
	type BufferStore,
	decodeEnvelope,
	type IdentifyPayloadFor,
	type PendingChain,
	type PendingRow,
} from "./buffer-store.js";
import { type MachineRegistrationCache, registerBeforeFlush } from "./flush-registration.js";
import { type EventPostResult, postEvent } from "./http.js";
import { logger } from "./log.js";
import type { PathEnv } from "./paths.js";
import { type Identity, SDK_VERSION, type WireEnvelope } from "./types.js";

export const SCHEDULE_FLUSH_DELAY_MS = 5_000;

export interface FlushOptions {
	baseUrl?: string;
	env?: PathEnv;
	fetch?: typeof fetch;
	force?: boolean;
	identity: Identity;
	identifyPayloadFor?: IdentifyPayloadFor;
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
	requery?: boolean;
}

export interface DrainResult {
	flushedCount: number;
	failedCount: number;
	lastError?: string;
}

const MAX_STAGNANT_DRAIN_STEPS = 100;

const minimalIdentifyPayload: IdentifyPayloadFor = (agentId, machineId) => ({
	agent_id: agentId,
	machine_id: machineId,
	sdk_version: SDK_VERSION,
});
const PERMANENT_PREDECESSOR_GAP_MS = 5 * 60 * 1_000;
const MAX_RETRY_BACKOFF_MS = 30_000;

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
		private readonly identifyPayloadFor: IdentifyPayloadFor = minimalIdentifyPayload,
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
					error,
				}, {
					event_name: "sno.observe.internal.flush.schedule",
					file: "packages/observability/src/internal/flush.ts",
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
		const activeFlush = this.runFlush({ identifyPayloadFor: this.identifyPayloadFor, ...options });
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
				this.backoffMs = Math.min(this.backoffMs * 2, MAX_RETRY_BACKOFF_MS);
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
				logger.error("sno observe drain failed", { error }, {
					event_name: "sno.observe.internal.flush.drain",
					file: "packages/observability/src/internal/flush.ts",
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
				file: "packages/observability/src/internal/flush.ts",
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
					error,
				}, {
					event_name: "sno.observe.internal.flush.installbeforeexit",
					file: "packages/observability/src/internal/flush.ts",
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
				file: "packages/observability/src/internal/flush.ts",
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
		pruneLoudly(store);
		store.clearElapsedRetryDeadline();
		return { shipped: 0, terminal: 0, retryable: 0 };
	}
	await registerBeforeFlush(options);

	let shipped = 0;
	let terminal = 0;
	let retryable = 0;
	let globalRetryable = 0;
	let chainRetryAfterMs: number | undefined;
	let globalRetryAfterMs: number | undefined;
	let submitted = 0;
	const blockedChains: PendingChain[] = [];
	// One rechain per agent per flush: a server that answers the fresh epoch with
	// the same conflict gets the ordinary retry backoff, not another epoch.
	const rechainedAgents = new Set<string>();
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
			const result = await flushRow(store, row, options, rechainedAgents);
			submitted += 1;
			shipped += result.shipped;
			terminal += result.terminal;
			retryable += result.retryable;
			if (result.retryScope === "chain") {
				chainRetryAfterMs = minDefined(chainRetryAfterMs, result.retryAfterMs);
				blockedChains.push({
					machineId: row.machine_id,
					agentId: row.agent_id,
					chainEpoch: row.chain_epoch,
				});
				requery = true;
				break;
			}
			if (result.retryable > 0) {
				globalRetryable += result.retryable;
				globalRetryAfterMs = minDefined(globalRetryAfterMs, result.retryAfterMs);
				stopBatch = true;
				break;
			}
			if (result.requery === true) {
				requery = true;
				break;
			}
		}
		if (!requery) {
			break;
		}
	}
	pruneLoudly(store);
	const retryAfterMs = globalRetryable > 0 ? globalRetryAfterMs : chainRetryAfterMs;
	return persistRetryDeadline(
		store,
		withOptionalRetryAfter({ shipped, terminal, retryable }, retryAfterMs),
		globalRetryable > 0,
	);
}

function pruneLoudly(store: BufferStore): void {
	const report = store.pruneRetention();
	if (report.overflowDeleted > 0) {
		logger.error("sno observe buffer over capacity; oldest already-sent events removed (unsent events are kept)", {
			dropped: report.overflowDeleted,
		}, {
			event_name: "sno.observe.internal.flush.pruneloudly",
			file: "packages/observability/src/internal/flush.ts",
			function: "pruneLoudly",
			site_id: "sno.observe.internal.flush.pruneloudly.1",
		});
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
	rechainedAgents: Set<string>,
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
		return handlePostResult(
			store,
			row,
			response,
			options.identifyPayloadFor ?? minimalIdentifyPayload,
			rechainedAgents,
		);
	} catch (error) {
		store.incrementAttempts(row.rowid);
		const retryAfterMs = retryDelay(row, undefined);
		logger.warnRateLimited(`network:${row.event_id}:${errorName(error)}`, "sno observe network error", {
			event_id: row.event_id,
			error,
		}, {
			event_name: "sno.observe.internal.flush.flushrow",
			file: "packages/observability/src/internal/flush.ts",
			function: "flushRow",
			site_id: "sno.observe.internal.flush.flushrow.5",
		});
		return { shipped: 0, terminal: 0, retryable: 1, retryAfterMs };
	}
}

/**
 * What a server answer means for the row:
 * - shipped: accepted (or already known).
 * - rejected: the server will never take these bytes; the head becomes local evidence and
 *   every later row of the epoch moves to a fresh epoch.
 * - rechain: the bytes are fine but the chain position is not; head and suffix move to a
 *   fresh epoch.
 * - wait: try again later (chain-scoped when only this chain must wait).
 */
type ResponseRoute =
	| { kind: "shipped" }
	| { kind: "suppressed" }
	| { kind: "refused"; reason: string }
	| { kind: "rechain"; reason: string }
	| { kind: "wait"; message: string; retryAfterMs?: number; retryScope?: "chain" };

const ACCEPTED_DUPLICATE_CODES = new Set([
	"duplicate_event",
	"event_already_accepted",
	"event_already_exists",
	"already_accepted",
	"idempotent_replay",
]);

const RECHAIN_CODES = new Set(["chain_gap", "prev_hash_mismatch", "chain_seed_required"]);

function handlePostResult(
	store: BufferStore,
	row: PendingRow,
	response: EventPostResult,
	identifyPayloadFor: IdentifyPayloadFor,
	rechainedAgents: Set<string>,
): RowFlushResult {
	const route = routeResponse(response, row);
	switch (route.kind) {
		case "shipped":
			store.markShipped(row.rowid);
			return { shipped: 1, terminal: 0, retryable: 0 };
		case "suppressed":
			return handleConsentSuppressed(store, row, response, identifyPayloadFor);
		case "refused": {
			// Never parked, never deleted. The rows behind it travel first and it is sent last;
			// alone, or an identify (which seeds the chain), it waits and is sent again.
			const isIdentify = decodeEnvelope(row.payload).event_type === "agent.identify";
			const moved = isIdentify ? undefined : store.carryForward(row, identifyPayloadFor, { headLast: true });
			logger.error("sno observe event refused by server; kept and will be sent again", {
				event_id: row.event_id,
				event_type: decodeEnvelope(row.payload).event_type,
				status: response.status,
				reason: route.reason,
				body: response.body.slice(0, 512),
			}, {
				event_name: "sno.observe.internal.flush.handlepostresult",
				file: "packages/observability/src/internal/flush.ts",
				function: "handlePostResult",
				site_id: "sno.observe.internal.flush.handlepostresult.6",
			});
			if (moved === undefined || moved.carried === 0) {
				return retryRow(store, row, response, { kind: "wait", message: `refused (${route.reason})`, retryScope: "chain" });
			}
			return { shipped: 0, terminal: 0, retryable: 0, requery: true };
		}
		case "rechain": {
			const agentKey = `${row.machine_id}:${row.agent_id}`;
			if (rechainedAgents.has(agentKey)) {
				return retryRow(store, row, response, {
					kind: "wait",
					message: `sno observe conflict repeated after rechain (${route.reason})`,
				});
			}
			rechainedAgents.add(agentKey);
			const moved = store.carryForward(row, identifyPayloadFor);
			logger.warn("sno observe chain reset; rows moved to a fresh epoch", {
				event_id: row.event_id,
				status: response.status,
				reason: route.reason,
				carried: moved.carried,
				chain_epoch: moved.chainEpoch,
			}, {
				event_name: "sno.observe.internal.flush.handlepostresult",
				file: "packages/observability/src/internal/flush.ts",
				function: "handlePostResult",
				site_id: "sno.observe.internal.flush.handlepostresult.7",
			});
			return { shipped: 0, terminal: 0, retryable: 0, requery: true };
		}
		case "wait":
			return retryRow(store, row, response, route);
	}
}

/**
 * The server's consent for this machine and lane is lower than what the row claims. A row
 * sent as `full` is re-sent as `metadata-only` (every schema is closed, so the payload
 * carries no text either way); a row already at `metadata-only` means consent is off on the
 * website for that lane: an identify waits for the lane to reopen, any other row is kept as
 * local evidence and the rows behind it are still tried.
 */
function handleConsentSuppressed(
	store: BufferStore,
	row: PendingRow,
	response: EventPostResult,
	identifyPayloadFor: IdentifyPayloadFor,
): RowFlushResult {
	const envelope = decodeEnvelope(row.payload);
	const source = {
		event_name: "sno.observe.internal.flush.handleconsentsuppressed",
		file: "packages/observability/src/internal/flush.ts",
		function: "handleConsentSuppressed",
		site_id: "sno.observe.internal.flush.handleconsentsuppressed.1",
	};
	if (envelope.consent_level === "full") {
		const moved = store.carryForward(row, identifyPayloadFor, {
			rewrite: (entry: WireEnvelope) =>
				entry.event_id === row.event_id
					? { consent_level: "metadata-only", payload: entry.payload }
					: { consent_level: entry.consent_level, payload: entry.payload },
		});
		logger.warn("sno observe server allows metadata-only on this lane; event re-sent at that level", {
			event_id: row.event_id,
			event_type: envelope.event_type,
			lane: envelope.lane,
			chain_epoch: moved.chainEpoch,
		}, source);
		return { shipped: 0, terminal: 0, retryable: 0, requery: true };
	}
	if (envelope.event_type === "agent.identify") {
		// Consent for the memory lane is off on the website: no chain can be seeded until it is
		// turned back on. Everything waits; nothing is dropped.
		logger.errorRateLimited(`consent-off:${row.machine_id}:${row.agent_id}`, "sno observe server consent is off for the memory lane; waiting, nothing sent", {
			event_id: row.event_id,
			pending: store.countPending(),
		}, source);
		return retryRow(store, row, response, {
			kind: "wait",
			message: "server consent off",
			retryAfterMs: response.retryAfterMs ?? 3_600_000,
			retryScope: "chain",
		});
	}
	// Consent is per lane: only the refused row is evidence; rows behind it get their own answer.
	const moved = store.carryForward(row, identifyPayloadFor, {
		quarantine: "head",
		detail: { status: response.status, reason: "consent_suppressed", body: response.body },
	});
	logger.error("sno observe server consent is off for this lane; event not sent and not kept (only its id and the server answer are recorded)", {
		event_id: row.event_id,
		event_type: envelope.event_type,
		lane: envelope.lane,
		chain_epoch: moved.chainEpoch,
	}, source);
	return { shipped: 0, terminal: moved.quarantined, retryable: 0, requery: true };
}

function routeResponse(response: EventPostResult, row: PendingRow): ResponseRoute {
	const code = responseErrorCode(response.body);
	switch (response.status) {
		case 202:
			return { kind: "shipped" };
		case 400:
		case 403:
		case 413:
			return { kind: "refused", reason: code ?? `http_${response.status}` };
		case 409:
		case 422:
			return routeConflict(response, row, code);
		case 401:
			return { kind: "wait", message: "sno observe unauthorized; will re-register and retry" };
		case 429:
			return { kind: "wait", message: "sno observe rate limited", retryAfterMs: response.retryAfterMs ?? 3_600_000 };
		default:
			return {
				kind: "wait",
				message: "sno observe transport will retry",
				...(typeof response.retryAfterMs === "number" ? { retryAfterMs: response.retryAfterMs } : {}),
			};
	}
}

function routeConflict(
	response: EventPostResult,
	row: PendingRow,
	code: string | undefined,
): ResponseRoute {
	if (code !== undefined && ACCEPTED_DUPLICATE_CODES.has(code)) {
		return { kind: "shipped" };
	}
	if (code === "consent_suppressed") {
		return { kind: "suppressed" };
	}
	if (code === "chain_predecessor_not_ready") {
		return isKnownPredecessorWait(response.body, row)
			? {
					kind: "wait",
					message: "sno observe predecessor not ready",
					retryAfterMs: response.retryAfterMs ?? 5_000,
					retryScope: "chain",
				}
			: { kind: "rechain", reason: "predecessor_unknown" };
	}
	if (code === undefined || RECHAIN_CODES.has(code)) {
		return { kind: "rechain", reason: code ?? `http_${response.status}` };
	}
	return { kind: "refused", reason: code };
}

/**
 * The server knows this epoch and is still waiting for the previous row from another
 * process: wait. An epoch it has no record of, or a predecessor it has waited on for
 * longer than the gap window, is never coming: rechain.
 */
function isKnownPredecessorWait(body: string, row: PendingRow): boolean {
	const parsed = parseResponseBody(body);
	if (parsed === null) {
		return false;
	}
	const details = { ...parsed.root, ...(parsed.nestedError ?? {}) };
	if (details["latest_state"] === null || details["latest_state"] === undefined) {
		return false;
	}
	const stallMs = details["chain_stall_ms"];
	if (typeof stallMs === "number" && stallMs >= PERMANENT_PREDECESSOR_GAP_MS) {
		return false;
	}
	return details["chain_epoch"] === row.chain_epoch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function responseErrorCode(body: string): string | undefined {
	return parseResponseBody(body)?.code;
}

/** The server's code lives in `error` (string) or `error.code`; `reason` is only a sub-reason. */
/** The server's code lives in `error` (string) or `error.code`; `reason` is only a sub-reason. */
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
		const candidates = [nestedError?.["code"], parsed["error"], parsed["code"], parsed["error_code"], parsed["reason"]];
		const code = candidates.find((value) => typeof value === "string" && value.length > 0);
		return { root: parsed, nestedError, code: typeof code === "string" ? code : undefined };
	} catch {
		return null;
	}
}

function retryRow(
	store: BufferStore,
	row: PendingRow,
	response: EventPostResult,
	route: Extract<ResponseRoute, { kind: "wait" }>,
): RowFlushResult {
	store.incrementAttempts(row.rowid);
	const effectiveRetryAfterMs = retryDelay(row, route.retryAfterMs);
	if (route.retryScope === "chain") {
		store.deferChainRetriesUntil(
			{ machineId: row.machine_id, agentId: row.agent_id, chainEpoch: row.chain_epoch },
			Date.now() + effectiveRetryAfterMs,
		);
	}
	const code = responseErrorCode(response.body);
	logger.warnRateLimited(`http:${row.event_id}:${response.status}:${code ?? route.message}`, "Sno Observe delivery deferred", {
		event_id: row.event_id,
		status: response.status,
		failure_code: code,
		retry_after_ms: effectiveRetryAfterMs,
	}, {
		event_name: "sno.observe.internal.flush.retryrow",
		file: "packages/observability/src/internal/flush.ts",
		function: "retryRow",
		site_id: "sno.observe.internal.flush.retryrow.9",
	});
	return {
		shipped: 0,
		terminal: 0,
		retryable: 1,
		retryAfterMs: effectiveRetryAfterMs,
		...(route.retryScope === undefined ? {} : { retryScope: route.retryScope }),
	};
}

function retryDelay(row: PendingRow, requested: number | undefined): number {
	const attempt = row.attempts + 1;
	const exponent = Math.min(Math.max(0, attempt - 1), 3);
	const attemptDelay = Math.min(5_000 * 2 ** exponent, MAX_RETRY_BACKOFF_MS);
	return Math.max(requested ?? attemptDelay, attemptDelay);
}

function jitterDelay(delayMs: number): number {
	const jitterWindowMs = Math.min(delayMs * 0.2, MAX_RETRY_BACKOFF_MS);
	return Math.ceil(delayMs + Math.random() * jitterWindowMs);
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : typeof error;
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
