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

/**
 * Registration is bookkeeping, never a gate: a failed registration is logged and the events are
 * sent anyway (the website keeps what it receives and attributes it later).
 */
export async function registerBeforeFlush(options: RegisterBeforeFlushOptions): Promise<void> {
	if (options.machineRegistrationCache?.registered === true) {
		return;
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
	} catch (error) {
		if (isAlreadyRegistered(error)) {
			if (options.machineRegistrationCache !== undefined) {
				options.machineRegistrationCache.registered = true;
			}
			return;
		}
		logger.errorRateLimited(`registration:${errorMessage(error)}`, "sno observe machine registration failed; sending anyway", {
			error,
		}, {
			event_name: "sno.observe.internal.flush.registration.registerbeforeflush",
			file: "packages/observability/src/internal/flush-registration.ts",
			function: "registerBeforeFlush",
			site_id: "sno.observe.internal.flush.registration.registerbeforeflush.2",
		});
	}
}

function isAlreadyRegistered(error: unknown): boolean {
	return error instanceof SnoObserveError && error.code === "machine_already_registered";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
