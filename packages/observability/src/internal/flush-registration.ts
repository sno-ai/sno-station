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

const TERMINAL_REGISTRATION_CODES = new Set([
	"claimed_user_requires_auth",
	"invalid_request",
	"machine_already_registered",
	"machine_registration_identity_mismatch",
	"machine_secret_conflict",
	"machine_secret_mismatch",
]);

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
		const terminalCode = terminalRegistrationCode(error);
		if (terminalCode !== undefined) {
			const terminal = quarantineRows(store, rows, terminalCode, error);
			logger.error("sno observe machine registration failed permanently", {
				error: errorMessage(error),
				code: terminalCode,
				terminal,
			});
			return { shipped: 0, terminal, retryable: 0 };
		}
		logger.warn("sno observe machine registration failed; will retry", {
			error: errorMessage(error),
		});
		return { shipped: 0, terminal: 0, retryable: rows.length, retryAfterMs: 5_000 };
	}
}

function terminalRegistrationCode(error: unknown): string | undefined {
	if (!(error instanceof SnoObserveError)) {
		return undefined;
	}
	return TERMINAL_REGISTRATION_CODES.has(error.code) ? error.code : undefined;
}

function quarantineRows(
	store: BufferStore,
	rows: PendingRow[],
	code: string,
	error: unknown,
): number {
	const body = JSON.stringify({ error: code, message: errorMessage(error) });
	let terminal = 0;
	for (const row of rows) {
		terminal += store.quarantineEpochSuffix(row, 409, body);
	}
	return terminal;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
