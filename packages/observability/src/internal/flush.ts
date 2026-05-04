import { createUUIDv7 } from "@snoai/common-core";
import { type BufferStore, decodeEnvelope, type PendingRow } from "./buffer-store.js";
import { type EventPostResult, postEvent } from "./http.js";
import { logger } from "./log.js";
import { registerMachine } from "./machine-registration.js";
import type { PathEnv } from "./paths.js";
import { type Identity, SDK_VERSION } from "./types.js";

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
	stopBatch?: boolean;
}

export interface DrainResult {
	flushedCount: number;
	failedCount: number;
	lastError?: string;
}

export interface MachineRegistrationCache {
	registered: boolean;
}

export class FlushEngine {
	private state: "idle" | "scheduled" | "flushing" = "idle";
	private timer: ReturnType<typeof setTimeout> | null = null;
	private beforeExitInstalled = false;
	private beforeExitHandler: (() => void) | null = null;
	private activeFlush: Promise<FlushResult> | null = null;
	private readonly machineRegistrationCache: MachineRegistrationCache = { registered: false };
	private disposed = false;
	private emittedDuringFlush = false;
	private backoffMs = 5_000;

	constructor(
		private readonly store: BufferStore,
		private readonly identityProvider: () => Identity,
		private readonly baseUrlProvider: () => string,
		private readonly envProvider: () => PathEnv = () => process.env,
	) {}

	schedule(delayMs: number): void {
		if (this.disposed) {
			return;
		}
		if (this.state === "flushing") {
			this.emittedDuringFlush = true;
			return;
		}
		if (this.state !== "idle") {
			return;
		}
		this.state = "scheduled";
		this.timer = setTimeout(() => {
			this.timer = null;
			if (this.disposed) {
				return;
			}
			void this.flush({ identity: this.identityProvider(), env: this.envProvider() });
		}, delayMs);
		this.timer.unref?.();
		this.installBeforeExit();
	}

	async flush(options: Omit<FlushOptions, "baseUrl">): Promise<FlushResult> {
		if (this.disposed) {
			return { shipped: 0, terminal: 0, retryable: 0 };
		}
		if (this.state === "flushing") {
			this.emittedDuringFlush = true;
			return this.activeFlush ?? { shipped: 0, terminal: 0, retryable: 0 };
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
		}
		this.state = "flushing";
		this.emittedDuringFlush = false;
		try {
			const result = await flushPending(this.store, {
				...options,
				baseUrl: this.baseUrlProvider(),
				machineRegistrationCache: this.machineRegistrationCache,
			});
			if (result.shipped > 0 && result.retryable === 0) {
				this.backoffMs = 5_000;
			}
			if (result.retryable > 0 && options.force !== true) {
				this.state = "idle";
				const delayMs = result.retryAfterMs ?? this.backoffMs;
				this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
				this.schedule(delayMs);
			} else if (this.emittedDuringFlush && this.store.countPending() > 0) {
				this.state = "idle";
				this.schedule(60_000);
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
		let failedCount = 0;
		let lastError: string | undefined;
		// Wait for any in-flight flush (and any chained flushes triggered while we waited).
		while (this.activeFlush !== null) {
			try {
				const result = await this.activeFlush;
				flushedCount += result.shipped;
				failedCount += result.retryable + result.terminal;
			} catch (error) {
				failedCount += this.store.countPending();
				lastError = error instanceof Error ? error.message : String(error);
				logger.error("sno observe drain failed", { error: lastError });
			}
		}
		return { flushedCount, failedCount, ...(lastError === undefined ? {} : { lastError }) };
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
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
			if (this.disposed) {
				return;
			}
			void this.flush({
				identity: this.identityProvider(),
				env: this.envProvider(),
				force: true,
			});
		};
		process.once("beforeExit", this.beforeExitHandler);
	}
}

export async function flushPending(
	store: BufferStore,
	options: FlushOptions,
): Promise<FlushResult> {
	const rows = store.getPending(100);
	if (rows.length === 0) {
		store.pruneRetention();
		return { shipped: 0, terminal: 0, retryable: 0 };
	}
	const registrationFailure = await registerBeforeFlush(options, rows.length);
	if (registrationFailure !== null) {
		store.pruneRetention();
		return registrationFailure;
	}

	let shipped = 0;
	let terminal = 0;
	let retryable = 0;
	let retryAfterMs: number | undefined;
	for (const row of rows) {
		const result = await flushRow(store, row, options);
		shipped += result.shipped;
		terminal += result.terminal;
		retryable += result.retryable;
		retryAfterMs = minDefined(retryAfterMs, result.retryAfterMs);
		if (result.retryable > 0 || result.stopBatch === true) {
			break;
		}
	}
	store.pruneRetention();
	return withOptionalRetryAfter({ shipped, terminal, retryable }, retryAfterMs);
}

async function registerBeforeFlush(
	options: FlushOptions,
	pendingCount: number,
): Promise<FlushResult | null> {
	if (options.machineRegistrationCache?.registered === true) {
		return null;
	}
	try {
		const registerOptions = {
			...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
			...(options.env === undefined ? {} : { env: options.env }),
			...(options.fetch === undefined ? {} : { fetch: options.fetch }),
			...(options.signal === undefined ? {} : { signal: options.signal }),
		};
		await registerMachine(options.identity, registerOptions);
		if (options.machineRegistrationCache !== undefined) {
			options.machineRegistrationCache.registered = true;
		}
		return null;
	} catch (error) {
		logger.warn("sno observe machine registration failed; will retry", {
			error: error instanceof Error ? error.message : String(error),
		});
		return { shipped: 0, terminal: 0, retryable: pendingCount, retryAfterMs: 5_000 };
	}
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
		logger.warn("sno observe network error", {
			event_id: row.event_id,
			error: error instanceof Error ? error.message : "unknown",
		});
		return { shipped: 0, terminal: 0, retryable: 1 };
	}
}

type ResponseRoute =
	| { kind: "shipped" }
	| { kind: "invalid" }
	| { kind: "chain" }
	| { kind: "retry"; message: string; retryAfterMs?: number; error?: boolean };

const ACCEPTED_DUPLICATE_CODES = new Set([
	"duplicate_event",
	"event_already_accepted",
	"event_already_exists",
	"already_accepted",
	"idempotent_replay",
]);

const CHAIN_REJECTION_CODES = new Set([
	"payload_conflict",
	"chain_seed_required",
	"prev_hash_mismatch",
	"self_hash_mismatch",
]);

function handlePostResult(
	store: BufferStore,
	row: PendingRow,
	response: EventPostResult,
): RowFlushResult {
	const route = routeResponse(response);
	switch (route.kind) {
		case "shipped":
			store.markShipped(row.rowid);
			return { shipped: 1, terminal: 0, retryable: 0 };
		case "invalid": {
			const terminal = store.quarantineEpochSuffix(row, response.status, response.body);
			reseedChain(store, row);
			logger.error("sno observe event rejected as invalid", {
				event_id: row.event_id,
				status: response.status,
			});
			return { shipped: 0, terminal, retryable: 0, stopBatch: true };
		}
		case "chain": {
			const terminal = store.quarantineEpochSuffix(row, response.status, response.body);
			reseedChain(store, row);
			logChainRejection(row, response.status);
			return { shipped: 0, terminal, retryable: 0, stopBatch: true };
		}
		case "retry":
			return retryRow(store, row, response.status, route.message, route.retryAfterMs, route.error);
	}
}

function routeResponse(response: EventPostResult): ResponseRoute {
	switch (response.status) {
		case 200:
		case 202:
			return { kind: "shipped" };
		case 400:
			return { kind: "invalid" };
		case 409:
		case 422:
			return routeConflict(response);
		case 401:
			return { kind: "retry", message: "sno observe unauthorized; will retry" };
		case 403:
			return {
				kind: "retry",
				message: "sno observe machine bearer required or invalid",
				error: true,
			};
		case 429:
			return retryRoute(response.retryAfterMs ?? 3_600_000);
		case 503:
			return retryRoute(response.retryAfterMs ?? 5_000);
		default:
			return response.status >= 500
				? retryRoute(response.retryAfterMs ?? undefined)
				: { kind: "retry", message: "sno observe transport will retry" };
	}
}

function routeConflict(response: EventPostResult): ResponseRoute {
	const code = responseErrorCode(response.body);
	if (code !== undefined && ACCEPTED_DUPLICATE_CODES.has(code)) {
		return { kind: "shipped" };
	}
	if (code === "chain_predecessor_not_ready") {
		return retryRoute(response.retryAfterMs ?? 5_000);
	}
	if (code !== undefined && CHAIN_REJECTION_CODES.has(code)) {
		return { kind: "chain" };
	}
	return {
		kind: "retry",
		message: "sno observe conflict response is not terminal; will retry",
		retryAfterMs: response.retryAfterMs ?? 5_000,
	};
}

function responseErrorCode(body: string): string | undefined {
	if (body.length === 0) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(body) as unknown;
		if (typeof parsed !== "object" || parsed === null) {
			return undefined;
		}
		const record = parsed as Record<string, unknown>;
		for (const key of ["reason", "error", "code", "error_code"]) {
			const value = record[key];
			if (typeof value === "string" && value.length > 0) {
				return value;
			}
		}
	} catch {}
	return undefined;
}

function retryRoute(retryAfterMs?: number): ResponseRoute {
	if (retryAfterMs === undefined) {
		return { kind: "retry", message: "sno observe transport will retry" };
	}
	return {
		kind: "retry",
		message: "sno observe transport will retry",
		retryAfterMs,
	};
}

function logChainRejection(row: PendingRow, status: number): void {
	const envelope = decodeEnvelope(row.payload);
	logger.error("sno observe chain rejected", {
		event_id: envelope.event_id,
		status,
		agent_id: envelope.scope.agent_id,
	});
}

function retryRow(
	store: BufferStore,
	row: PendingRow,
	status: number,
	message: string,
	retryAfterMs?: number,
	error = false,
): FlushResult {
	store.incrementAttempts(row.rowid);
	const context = { event_id: row.event_id, status, retry_after_ms: retryAfterMs };
	if (error) {
		logger.error(message, context);
	} else {
		logger.warn(message, context);
	}
	return withOptionalRetryAfter({ shipped: 0, terminal: 0, retryable: 1 }, retryAfterMs);
}

function reseedChain(store: BufferStore, row: PendingRow): void {
	const envelope = decodeEnvelope(row.payload);
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

function minDefined(left: number | undefined, right: number | undefined): number | undefined {
	if (left === undefined) {
		return right;
	}
	if (right === undefined) {
		return left;
	}
	return Math.min(left, right);
}

function withOptionalRetryAfter(
	result: FlushResult,
	retryAfterMs: number | undefined,
): FlushResult {
	if (retryAfterMs === undefined) {
		return result;
	}
	return { ...result, retryAfterMs };
}
