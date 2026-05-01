import { v7 as uuidv7 } from "uuid";
import { type BufferStore, decodeEnvelope, type PendingRow } from "./buffer-store.js";
import { type EventPostResult, postEvent } from "./http.js";
import { logger } from "./log.js";
import type { PathEnv } from "./paths.js";
import { TokenStore } from "./token-state.js";
import { type Identity, SDK_VERSION } from "./types.js";

export interface FlushOptions {
	baseUrl?: string;
	env?: PathEnv;
	fetch?: typeof fetch;
	force?: boolean;
	identity: Identity;
}

export interface FlushResult {
	shipped: number;
	terminal: number;
	retryable: number;
	retryAfterMs?: number;
}

export class FlushEngine {
	private state: "idle" | "scheduled" | "flushing" = "idle";
	private timer: ReturnType<typeof setTimeout> | null = null;
	private beforeExitInstalled = false;
	private beforeExitHandler: (() => void) | null = null;
	private activeFlush: Promise<FlushResult> | null = null;
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

	async drain(): Promise<void> {
		// Wait for any in-flight flush (and any chained flushes triggered while we waited).
		while (this.activeFlush !== null) {
			try {
				await this.activeFlush;
			} catch {
				// drain swallows errors; the engine logs them per-row already.
			}
		}
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

interface RowResult extends FlushResult {
	// True only when the request never reached the server (network/timeout).
	// Any HTTP response — including 401/403/5xx — sets this false because the
	// server has already seen the bearer and consumed it server-side.
	transportErrored: boolean;
}

export async function flushPending(
	store: BufferStore,
	options: FlushOptions,
): Promise<FlushResult> {
	const rows = store.getPending(100);
	const tokenStore = new TokenStore(options.env);
	// Claim-before-use: atomically flips access_token_consumed=true under a
	// file lock so two concurrent host processes can't both grab the same
	// one-shot bearer. claimAccessToken() returns the token to exactly one
	// caller; others get null and ship without bearer. Skip claiming when
	// there's nothing to ship — otherwise an idle scheduler tick on an empty
	// buffer would burn the bearer.
	let bearer: string | undefined;
	const bearerClaimed =
		options.identity.claimed && rows.length > 0 ? tokenStore.claimAccessToken() : null;
	if (bearerClaimed !== null) {
		bearer = bearerClaimed;
	}
	let bearerOutcome: "unused" | "delivered" | "transport_failed" = "unused";

	let shipped = 0;
	let terminal = 0;
	let retryable = 0;
	let retryAfterMs: number | undefined;
	for (const row of rows) {
		const usedBearerOnThisRow = bearer !== undefined;
		const result = await flushRow(store, row, options, bearer);
		shipped += result.shipped;
		terminal += result.terminal;
		retryable += result.retryable;
		retryAfterMs = minDefined(retryAfterMs, result.retryAfterMs);
		if (usedBearerOnThisRow) {
			bearerOutcome = result.transportErrored ? "transport_failed" : "delivered";
			// Don't reuse the bearer on subsequent rows; the server consumes
			// it on first claim regardless of the per-row outcome here.
			bearer = undefined;
		}
		if (result.retryable > 0) {
			break;
		}
	}
	// Revert ONLY when the request never reached the server. Any HTTP response
	// (including 401/403/5xx) means the server has already seen and consumed
	// the bearer; reverting in that case re-issues a known-dead token on the
	// next flush and creates a permanent head-of-line block.
	if (bearerClaimed !== null && bearerOutcome === "transport_failed") {
		tokenStore.revertClaim();
	}
	store.pruneRetention();
	return withOptionalRetryAfter({ shipped, terminal, retryable }, retryAfterMs);
}

async function flushRow(
	store: BufferStore,
	row: PendingRow,
	options: FlushOptions,
	bearer?: string,
): Promise<RowResult> {
	try {
		const response = await postEvent(
			options.baseUrl ?? "https://www.sno.ai",
			row.payload.toString("utf8"),
			bearer,
			options.fetch,
		);
		return { ...handlePostResult(store, row, response), transportErrored: false };
	} catch (error) {
		store.incrementAttempts(row.rowid);
		logger.warn("sno observe network error", {
			event_id: row.event_id,
			error: error instanceof Error ? error.message : "unknown",
		});
		return { shipped: 0, terminal: 0, retryable: 1, transportErrored: true };
	}
}

type ResponseRoute =
	| { kind: "shipped" }
	| { kind: "invalid" }
	| { kind: "chain" }
	| { kind: "retry"; message: string; retryAfterMs?: number; error?: boolean };

function handlePostResult(
	store: BufferStore,
	row: PendingRow,
	response: EventPostResult,
): FlushResult {
	const route = routeResponse(response);
	switch (route.kind) {
		case "shipped":
			store.markShipped(row.rowid);
			return { shipped: 1, terminal: 0, retryable: 0 };
		case "invalid":
			store.quarantine(row, response.status, response.body);
			logger.error("sno observe event rejected as invalid", {
				event_id: row.event_id,
				status: response.status,
			});
			return { shipped: 0, terminal: 1, retryable: 0 };
		case "chain":
			store.quarantine(row, response.status, response.body);
			reseedChain(store, row);
			logChainRejection(row, response.status);
			return { shipped: 0, terminal: 1, retryable: 0 };
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
			return { kind: "chain" };
		case 401:
			return { kind: "retry", message: "sno observe unauthorized; will retry" };
		case 403:
			return {
				kind: "retry",
				message: "sno observe bearer required or invalid",
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
		eventId: uuidv7(),
		eventType: "agent.identify",
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
