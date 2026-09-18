export const REM_OPERATION_TYPES = [
	"rem-update",
	"rem-replace",
	"rem-distill",
	"rem-retire",
] as const;
export const REM_BUILT_OPERATION_TYPES = ["rem-update", "rem-replace"] as const;
export type RemOperationType = (typeof REM_OPERATION_TYPES)[number];
export type RemBuiltOperationType = (typeof REM_BUILT_OPERATION_TYPES)[number];

export function parseRemOperationType(value: string): RemOperationType | undefined {
	for (const operation of REM_OPERATION_TYPES) {
		if (value === operation) return operation;
	}
	return undefined;
}

export const REM_JOB_STATES = ["queued", "running", "done", "failed"] as const;
export type RemJobState = (typeof REM_JOB_STATES)[number];

export const REM_ROW_STATES = [
	"transition",
	"stale-current",
	"pure-negation",
	"ambiguous",
] as const;
export type RemRowState = (typeof REM_ROW_STATES)[number];
export type RemOwner = "restate" | "verdict" | "none";

export interface RemStatementLike {
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
	run(...params: unknown[]): unknown;
}

export interface RemTransactionLike {
	(...args: unknown[]): unknown;
	immediate(...args: unknown[]): unknown;
}

export interface RemDatabaseLike {
	prepare(sql: string): RemStatementLike;
	exec(sql: string): unknown;
	transaction(fn: (...args: never[]) => unknown): RemTransactionLike;
}

export interface RemClockPort {
	now(): string;
}

export interface RemLlmRequest {
	prompt: string;
	signal?: AbortSignal;
}

export interface RemLlmResponse {
	text: string;
	usage?: {
		inputTokens: number;
		outputTokens: number;
	};
}

export interface RemLlmPort {
	complete(request: RemLlmRequest): Promise<RemLlmResponse>;
}

export interface MoveLaneInput {
	rowId: string;
	plannedContentHash: string;
	targetLane: "active" | "parked" | "quarantined";
	reason: string;
	timestamp: string;
}

export interface WriteTextVersionInput {
	rowId: string;
	plannedContentHash: string;
	/**
	 * The invoking job, required so the journal row this write produces can name it. Callers never
	 * supply these two: `RemWriterOperation` omits them exactly as it omits `rowId`, and the mutation
	 * executor fills all four from the attempt it was opened with. That is the point — an identity a
	 * caller cannot pass is an identity a caller cannot pass wrongly, and one the executor must pass
	 * is one nobody can forget.
	 */
	jobId: string;
	jobType: RemOperationType;
	/**
	 * The verified-write attempt this write belongs to. Filled by the mutation executor from the
	 * attempt it opened, never by a caller, for the same reason `jobId` and `jobType` are: the
	 * write transaction stamps the content hash it produced onto this attempt so crash recovery can
	 * tell a committed write from a lost one.
	 */
	attemptId: string;
	replacementText: string;
	historyText?: string;
	supersededItems?: readonly string[];
	sourceVersion?: string;
	rewriteConfig?: RemUpdateRewriteConfig;
	idempotencyKey?: string;
	reason: string;
	timestamp: string;
}

export interface RemUpdateRewriteConfig {
	implementationVersion: string;
	memoryKind: "profile" | "episodic" | "state";
	locale: string;
	localeResource: Readonly<{
		valuePrefix: string;
		listPrefix: string;
		listSeparator: string;
		spanSeparator: string;
		anchorMode: "capitalized-sequence" | "explicit-script";
	}>;
}

export interface SoftCloseInput {
	rowId: string;
	successorId: string;
	plannedContentHash: string;
	plannedSuccessorContentHash: string;
	reason: string;
	timestamp: string;
}

export type RemMutationRefusalReason =
	| "content_changed"
	| "already_applied"
	| "missing"
	| "target_changed"
	| "target_missing";

export type RemMutationResult =
	| { applied: true; contentHash: string; recoveryHandle: string }
	| { applied: false; reason: RemMutationRefusalReason };

export interface RemConflictPort {
	softClose(input: SoftCloseInput): Promise<RemMutationResult>;
	writeTextVersion(input: WriteTextVersionInput): Promise<RemMutationResult>;
}

export interface RemForgetPort {
	moveLane(input: MoveLaneInput): Promise<RemMutationResult>;
}

export interface RemPorts {
	clock: RemClockPort;
	conflict: RemConflictPort;
	forget: RemForgetPort;
	llm: RemLlmPort;
}

export interface RemEnableGateArtifact {
	schema_version: number;
	job_type: RemBuiltOperationType;
	implementation_version: string;
	corpus_sha256: string;
	baseline_sha256: string;
	result: "pass" | "fail";
	evaluated_at: string;
	expires_at: string;
}

export type RemVerdictCheckpoint =
	| "before_llm"
	| "cancellation_requested"
	| "verdict_recorded"
	| "action_applied";

export interface RemConfig {
	stages: Readonly<Record<string, boolean>>;
}

/**
 * Refuses a write whose audit identity is not real. A required `string` is not proof of one:
 * TypeScript accepts `""`, the journal's `job_id`/`job_type` columns are `NOT NULL` but not
 * non-blank, and a JavaScript caller can omit the field entirely.
 *
 * No valid identity, no write — the whole operation is refused before any transaction opens. This
 * does not rescue the write; it refuses it, which is the intended trade: an unattributable row in
 * the audit ledger is worse than a refused operation the caller can see and retry.
 *
 * The accepted set is `REM_OPERATION_TYPES` itself, so the runtime check and the type cannot drift.
 */
export function assertJobIdentity(jobId: string, jobType: string): void {
	// `typeof` first, not `jobId.trim()`. The callers this guard exists for are the ones the compiler
	// cannot see — child processes and JavaScript entry points — and those pass `undefined`, which
	// made the check itself die with "Cannot read properties of undefined" instead of naming the
	// problem. A guard that fails less clearly than the bug it catches is not a guard.
	if (typeof jobId !== "string" || jobId.trim().length === 0) {
		throw new Error(`REM write requires a non-blank job id, got: ${String(jobId)}`);
	}
	if (typeof jobType !== "string" || parseRemOperationType(jobType) === undefined) {
		throw new Error(`REM write requires a known job type, got: ${String(jobType)}`);
	}
}
