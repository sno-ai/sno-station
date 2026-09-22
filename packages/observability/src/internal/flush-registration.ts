import type { BufferStore, PendingRow } from "./buffer-store.js";
import { SnoObserveError } from "./errors.js";
import { logger } from "./log.js";
import { registerMachine } from "./machine-registration.js";
import type { PathEnv } from "./paths.js";
import type { Identity } from "./types.js";

export interface MachineRegistrationCache {
	registered: boolean;
}

interface RegisterBeforeFlushOptions {
	baseUrl?: string;
	env?: PathEnv;
	fetch?: typeof fetch;
	identity: Identity;
	machineRegistrationCache?: MachineRegistrationCache;
	signal?: AbortSignal;
}

interface RegisterBeforeFlushResult {
	shipped: number;
	terminal: number;
	retryable: number;
	retryAfterMs?: number;
}

export async function registerBeforeFlush(
	store: BufferStore,
	rows: PendingRow[],
	options: RegisterBeforeFlushOptions,
): Promise<RegisterBeforeFlushResult | null> {
	if (options.machineRegistrationCache?.registered === true) {
		return null;
	}
	try {
		await registerMachine(options.identity, {
			...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
			...(options.env === undefined ? {} : { env: options.env }),
			...(options.fetch === undefined ? {} : { fetch: options.fetch }),
			...(options.signal === undefined ? {} : { signal: options.signal }),
		});
		if (options.machineRegistrationCache !== undefined) {
			options.machineRegistrationCache.registered = true;
		}
		return null;
	} catch (error) {
		if (isAlreadyRegistered(error)) {
			if (options.machineRegistrationCache !== undefined) {
				options.machineRegistrationCache.registered = true;
			}
			return null;
		}
		const firstRow = rows[0];
		if (firstRow !== undefined) {
			store.incrementAttempts(firstRow.rowid);
		}
		logger.errorRateLimited(`registration:${errorMessage(error)}`, "sno observe machine registration failed; will retry", {
			error,
		}, {
			event_name: "sno.observe.internal.flush.registration.registerbeforeflush",
			file: "packages/observability/src/internal/flush-registration.ts",
			function: "registerBeforeFlush",
			site_id: "sno.observe.internal.flush.registration.registerbeforeflush.2",
		});
		return {
			shipped: 0,
			terminal: 0,
			retryable: rows.length,
			retryAfterMs: registrationRetryDelay((firstRow?.attempts ?? 0) + 1),
		};
	}
}

function isAlreadyRegistered(error: unknown): boolean {
	return error instanceof SnoObserveError && error.code === "machine_already_registered";
}

function registrationRetryDelay(attempt: number): number {
	return Math.min(5_000 * 2 ** Math.min(Math.max(0, attempt - 1), 3), 30_000);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
