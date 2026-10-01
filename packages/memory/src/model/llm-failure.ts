/** @file llm-failure.ts
 * @purpose The one place that decides what a failed LLM / host-model call means.
 * @boundary Every caller that sees an HTTP status or error message from a model endpoint
 * classifies it here; no other module compares status codes or error text itself.
 */

export type LlmFailureCategory =
	| "auth"
	| "credential-expired"
	| "credential-revoked"
	| "exhausted"
	| "throttle"
	| "transport"
	| "unknown";

export interface LlmFailure {
	category: LlmFailureCategory;
	/** Retrying the same endpoint with the same credential cannot succeed. */
	terminal: boolean;
	/** The endpoint itself is gone or refuses the caller; a fallback tier may not substitute. */
	endpointRefused: boolean;
}

const CREDENTIAL_CATEGORIES: ReadonlySet<LlmFailureCategory> = new Set(["auth", "credential-expired", "credential-revoked"]);
const TERMINAL_CATEGORIES: ReadonlySet<LlmFailureCategory> = new Set([...CREDENTIAL_CATEGORIES, "exhausted"]);

export function readErrorStatus(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	if ("status" in error && typeof error.status === "number") return error.status;
	if ("statusCode" in error && typeof error.statusCode === "number") return error.statusCode;
	return undefined;
}

export function readErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
	return String(error);
}

function isCredentialRevokedMessage(message: string): boolean {
	return /oauth token refresh failed for openai:.*\binvalid_grant\b.*\btoken revoked\b/i.test(message);
}

function isCredentialExpiredMessage(message: string): boolean {
	return /\bexpired access token\b/i.test(message);
}

function isAuthMessage(message: string): boolean {
	return (
		/\b(?:401|403)\b/.test(message) ||
		/unauthori[sz]ed/i.test(message) ||
		/no api key found/i.test(message) ||
		/(?:invalid|incorrect) api[- ]?key/i.test(message) ||
		/(?:invalid|expired) (?:access |oauth )?token/i.test(message) ||
		/(?:api[- ]?key|token).*(?:invalid|expired|rejected)/i.test(message) ||
		/credential (?:is )?(?:invalid|expired|rejected)/i.test(message) ||
		/no (?:valid )?credential (?:found|available|configured)/i.test(message) ||
		/re-?authenticate/i.test(message) ||
		/no authentication configured/i.test(message)
	);
}

function isExhaustedMessage(message: string): boolean {
	return /you(?:'|’)ve reached your codex subscription usage limit/i.test(message);
}

function isThrottleMessage(message: string): boolean {
	return /\b429\b/.test(message) || /rate.?limit/i.test(message) || /quota/i.test(message);
}

function categoryOf(status: number | undefined, message: string): LlmFailureCategory {
	if (isCredentialRevokedMessage(message)) return "credential-revoked";
	if (isCredentialExpiredMessage(message)) return "credential-expired";
	if (status === 401 || status === 403 || isAuthMessage(message)) return "auth";
	if (isExhaustedMessage(message)) return "exhausted";
	if (status === 429 || isThrottleMessage(message)) return "throttle";
	if (status !== undefined && (status === 404 || status === 408 || status >= 500)) return "transport";
	return "unknown";
}

/** Classifies one failed model call from whatever the transport surfaced: a status, a message, or both. */
export function classifyLlmFailure(input: { status?: number; message?: string }): LlmFailure {
	const category = categoryOf(input.status, input.message ?? "");
	const terminal = TERMINAL_CATEGORIES.has(category);
	return { category, terminal, endpointRefused: terminal || input.status === 404 || input.status === 503 };
}

export function isCredentialFailure(category: LlmFailureCategory): boolean {
	return CREDENTIAL_CATEGORIES.has(category);
}

export function isTerminalLlmFailure(category: LlmFailureCategory): boolean {
	return TERMINAL_CATEGORIES.has(category);
}

/** A status worth one more attempt against the same endpoint. */
export function isTransientLlmStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}
