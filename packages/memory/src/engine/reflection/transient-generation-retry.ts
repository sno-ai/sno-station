/** @file transient-generation-retry.ts
 * @purpose Classifies transient reflection failures and controls retry timing.
 * @boundary LLM/provider errors, runtime resilience, and event logging.
 * @see daily-log-generator.ts, llm-client.ts, event-payload-builder.ts.
 */

export type RetryClassifierInput = {
	inReflectionScope: boolean;
	retryCount: number;
	usefulOutputChars: number;
	error: unknown;
};

export type RetryClassifierResult = {
	retryable: boolean;
	reason:
		| "not_reflection_scope"
		| "retry_already_used"
		| "useful_output_present"
		| "non_retry_error"
		| "non_transient_error"
		| "transient_upstream_failure";
	normalizedError: string;
};

export type RetryState = { count: number };

export type RetryRunnerParams<T> = {
	scope: "reflection" | "distiller";
	runner: "embedded" | "cli";
	retryState: RetryState;
	execute: () => Promise<T>;
	usefulOutputChars?: () => number;
	onLog?: (level: "info" | "warn", message: string) => void;
	random?: () => number;
	sleep?: (ms: number) => Promise<void>;
};

type ErrorFacts = {
	message: string;
	normalizedError: string;
	transientCategory: string | null;
	nonRetryCategory: string | null;
};

type ErrorPolicyCatalog = Record<string, readonly RegExp[]>;

const TRANSIENT_POLICIES: ErrorPolicyCatalog = {
	transportReset: [
		/unexpected eof/i,
		/\beconnreset\b/i,
		/\beconnaborted\b/i,
		/\bepipe\b/i,
		/connection reset/i,
		/socket hang up/i,
		/socket (?:closed|disconnected)/i,
		/connection (?:closed|aborted|dropped)/i,
		/early close/i,
		/stream (?:ended|closed) unexpectedly/i,
		/\bund_err_(?:socket|headers_timeout|body_timeout)\b/i,
	],
	timeout: [/\betimedout\b/i, /\btimed out\b/i, /\btimeout\b/i],
	upstreamUnavailable: [
		/temporar(?:y|ily).*unavailable/i,
		/upstream.*unavailable/i,
		/service unavailable/i,
		/bad gateway/i,
		/gateway timeout/i,
		/\b(?:http|status)\s*(?:502|503|504)\b/i,
	],
	network: [/network error/i, /fetch failed/i],
};

const NON_RETRY_POLICIES: ErrorPolicyCatalog = {
	auth: [
		/\b401\b/i,
		/\bunauthorized\b/i,
		/invalid api key/i,
		/invalid[_ -]?token/i,
		/\bauth(?:entication)?_?unavailable\b/i,
	],
	billingOrQuota: [
		/insufficient (?:credit|credits|balance)/i,
		/\bbilling\b/i,
		/\bquota exceeded\b/i,
		/payment required/i,
	],
	modelOrContext: [
		/model .*not found/i,
		/no such model/i,
		/unknown model/i,
		/context length/i,
		/context window/i,
		/request too large/i,
		/payload too large/i,
		/too many tokens/i,
		/token limit/i,
		/prompt too long/i,
	],
	sessionOrPolicy: [
		/session expired/i,
		/invalid session/i,
		/refusal/i,
		/content policy/i,
		/safety policy/i,
		/content filter/i,
		/disallowed/i,
	],
};

/** Implements default sleep as the local reflection retry policy operation. */
const DEFAULT_SLEEP = (ms: number): Promise<void> =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

const CLIP_MAX_LEN = 260;
const BASE_DELAY_MS = 1000;
const JITTER_RANGE_MS = 2000;

/** Converts error message into the transport shape expected by reflection retry policy. */
function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		const msg = `${error.name}: ${error.message}`.trim();
		return msg || "Error";
	}
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

/** Implements clip single line as the local reflection retry policy operation. */
function clipSingleLine(text: string, maxLen = CLIP_MAX_LEN): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length <= maxLen) return oneLine;
	return `${oneLine.slice(0, maxLen - 3)}...`;
}

function readErrorFacts(error: unknown): ErrorFacts {
	const message = toErrorMessage(error);
	return {
		message,
		normalizedError: clipSingleLine(message),
		transientCategory: matchPolicyCategory(TRANSIENT_POLICIES, message),
		nonRetryCategory: matchPolicyCategory(NON_RETRY_POLICIES, message),
	};
}

function matchPolicyCategory(policies: ErrorPolicyCatalog, message: string): string | null {
	for (const [category, patterns] of Object.entries(policies)) {
		if (patterns.some((pattern) => pattern.test(message))) return category;
	}
	return null;
}

function isRetryScope(scope: RetryRunnerParams<unknown>["scope"]): boolean {
	return scope === "reflection" || scope === "distiller";
}

function logRetryExhausted<T>(params: RetryRunnerParams<T>, retryError: unknown): void {
	params.onLog?.(
		"warn",
		`memory-${params.scope}: retry exhausted (${params.runner}). ` +
			`error=${clipSingleLine(toErrorMessage(retryError))}`,
	);
}

function readUsefulOutputChars<T>(params: RetryRunnerParams<T>): number {
	return params.usefulOutputChars?.() ?? 0;
}

/**
 * Tests whether is transient reflection upstream error without mutating reflection retry policy
 * state.
 */
export function isTransientReflectionUpstreamError(error: unknown): boolean {
	return readErrorFacts(error).transientCategory !== null;
}

/**
 * Tests whether is reflection non retry error without mutating reflection retry policy state.
 */
export function isReflectionNonRetryError(error: unknown): boolean {
	return readErrorFacts(error).nonRetryCategory !== null;
}

/** Implements classify reflection retry as the local reflection retry policy operation. */
export function classifyReflectionRetry(input: RetryClassifierInput): RetryClassifierResult {
	const facts = readErrorFacts(input.error);
	const { normalizedError } = facts;

	if (!input.inReflectionScope) {
		return {
			retryable: false,
			reason: "not_reflection_scope",
			normalizedError,
		};
	}
	if (input.retryCount > 0) {
		return { retryable: false, reason: "retry_already_used", normalizedError };
	}
	if (input.usefulOutputChars > 0) {
		return {
			retryable: false,
			reason: "useful_output_present",
			normalizedError,
		};
	}
	if (facts.nonRetryCategory !== null) {
		return { retryable: false, reason: "non_retry_error", normalizedError };
	}
	if (facts.transientCategory !== null) {
		return {
			retryable: true,
			reason: "transient_upstream_failure",
			normalizedError,
		};
	}
	return { retryable: false, reason: "non_transient_error", normalizedError };
}

/** Computes reflection retry delay ms as a side-effect-free reflection retry policy value. */
export function computeReflectionRetryDelayMs(random: () => number = Math.random): number {
	const raw = random();
	const clamped = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
	return BASE_DELAY_MS + Math.floor(clamped * JITTER_RANGE_MS);
}

/**
 * Implements run with reflection transient retry once as the local reflection retry policy
 * operation.
 */
export async function runWithReflectionTransientRetryOnce<T>(
	params: RetryRunnerParams<T>,
): Promise<T> {
	try {
		return await params.execute();
	} catch (error) {
		const decision = classifyReflectionRetry({
			inReflectionScope: isRetryScope(params.scope),
			retryCount: params.retryState.count,
			usefulOutputChars: readUsefulOutputChars(params),
			error,
		});
		if (!decision.retryable) throw error;

		const delayMs = computeReflectionRetryDelayMs(params.random);
		params.retryState.count += 1;
		params.onLog?.(
			"warn",
			`memory-${params.scope}: transient upstream failure detected (${params.runner}); ` +
				`retrying once in ${delayMs}ms (${decision.reason}). error=${decision.normalizedError}`,
		);
		await (params.sleep ?? DEFAULT_SLEEP)(delayMs);

		try {
			const result = await params.execute();
			params.onLog?.("info", `memory-${params.scope}: retry succeeded (${params.runner})`);
			return result;
		} catch (retryError) {
			logRetryExhausted(params, retryError);
			throw retryError;
		}
	}
}
