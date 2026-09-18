/** @file rem-sqlite-adapter.ts
 * @purpose Binds capability-safe REM mutation and recovery ports to encrypted sno-station-mem SQLite.
 * @boundary Additive REM tables and recoverable memory-row updates; no deletion or compaction.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { createLogger } from "@snoai/utils/logger";
import type {
	MoveLaneInput,
	RemLlmRequest,
	RemLlmResponse,
	RemMutationResult,
	RemOperationType,
	RemPorts,
	RemConflictPort,
	RemReplaceCarrierPort,
	RemReplaceCarrierState,
	ReplaceCoverageDecision,
	SoftCloseInput,
	WriteTextVersionInput,
} from "../engine/rem/index";
import {
	hashRemMemoryRow,
	REM_ROW_HASH_VERSION,
	REM_ROW_HASH_VERSION_LEGACY,
} from "../engine/rem/index.js";
import type {
	RawSqliteDatabase,
	SqliteDatabaseLike,
} from "./sqlite-runtime";
import type { LlmClient } from "../model/llm-client";
import { stableHash } from "../engine/shared/utils";
import { hashInputForEntry } from "./memory-store-shared";
import type { MemoryStore } from "./store";

const log = createLogger("sno-station-mem:rem-sqlite-adapter");

interface MemoryRow {
	id: string;
	text: string;
	category: string;
	project_id: string;
	importance: number;
	timestamp: number;
	timezone: string;
	metadata: string;
	content_hash: string;
	fact_id: string;
	derived_from: string | null;
	consolidation_epoch_id: string | null;
	confidence_source: string | null;
	lane: "active" | "parked" | "quarantined";
	raw_candidate_json: string | null;
	disposition_reason: string | null;
	dispositioned_at_ms: number | null;
}

interface RecoveryRow {
	recovery_handle: string;
	row_id: string;
	operation_kind: "lane" | "text-version" | "mark";
	prior_row_image: string;
	expected_post_hash: string;
	row_hash_version: number;
	restored_at: string | null;
}

interface MemoryFacetRow {
	facet: "current" | "history";
	text: string;
	updated_at_ms: number;
}

interface ChunkFacetRow {
	chunk_id: string;
	facet: "current" | "history";
	chunk_index?: number;
}

interface FacetState {
	facets: MemoryFacetRow[];
	chunkFacets: ChunkFacetRow[];
}

interface FacetRecoveryRow {
	prior_facets_json: string;
	prior_chunk_facets_json: string;
	expected_facets_json: string;
	expected_chunk_facets_json: string;
}

export interface SnoStationMemRemPortOptions {
	database: SqliteDatabaseLike;
	llmClient: LlmClient;
	memoryStore?: MemoryStore;
}

export interface SnoStationMemRemRecovery {
	restoreLane(recoveryHandle: string): void;
	restoreTextVersion(recoveryHandle: string): void;
	restoreMark(recoveryHandle: string): void;
}

export type RemMutationWriter =
	| "moveLane"
	| "writeTextVersion"
	| "softClose"
	| "restoreLane"
	| "restoreTextVersion"
	| "restoreMark"
	| "applyRemTextVersion";

export interface RemWriteAuthorization {
	rowId: string;
	preWriteContentSha256: string;
	proposedTextSha256: string;
	evidenceId: string;
	configurationSha256: string;
}

export type RemWriterOperation =
	| { kind: "moveLane"; targetLane: "active" | "parked" | "quarantined"; reason: string; timestamp: string }
	| ({ kind: "writeTextVersion" | "applyRemTextVersion" } & Omit<
			WriteTextVersionInput,
			"rowId" | "plannedContentHash" | "jobId" | "jobType" | "attemptId"
	  >)
	| { kind: "softClose"; successorId: string; reason: string; timestamp: string }
	| { kind: "restoreLane" | "restoreTextVersion" | "restoreMark"; recoveryHandle: string };

export interface RemWriteAttemptHandle {
	attemptId: string;
}

export interface RemMutationResolution {
	applied: boolean;
	attemptOrdinal: number;
	reasonCode: string | null;
}

export interface RemWriteAttemptOutcome extends RemMutationResolution {
	attemptId: string;
	outcome: "succeeded" | "failed" | "refused" | "degraded";
	preWriteContentSha256: string;
	postWriteContentSha256: string | null;
}

const verifiedWriteAuthorizationBrand: unique symbol = Symbol("verifiedWriteAuthorization");

export type RemWriteVerificationToken = {
	readonly attemptId: string;
	readonly rowId: string;
	readonly writer: RemMutationWriter;
	readonly softCloseSuccessorId: string | null;
	readonly [verifiedWriteAuthorizationBrand]: true;
};

type VerifiedWriteAuthorization = RemWriteVerificationToken;

type WriteAttemptValidation =
	| { allowed: false; reasonCode: string }
	| { allowed: true; authorization: VerifiedWriteAuthorization };

const verifiedWriteAuthorization = new AsyncLocalStorage<VerifiedWriteAuthorization>();

const replaceCoverageAllowBrand: unique symbol = Symbol("replaceCoverageAllow");

export type ReplaceCoverageDecisionForPair<PairId extends string> = ReplaceCoverageDecision & {
	readonly pairId: PairId;
};

type ReplaceCoverageAllowDecision<PairId extends string> = Extract<
	ReplaceCoverageDecisionForPair<PairId>,
	{ decision: "allow" }
>;

export type ReplaceCoverageAllowToken<PairId extends string> = {
	readonly coverageDecision: ReplaceCoverageAllowDecision<PairId>;
	readonly [replaceCoverageAllowBrand]: true;
};

export function issueReplaceCoverageAllow<PairId extends string>(
	coverageDecision: ReplaceCoverageAllowDecision<PairId>,
): ReplaceCoverageAllowToken<PairId> {
	return Object.freeze({
		coverageDecision,
		[replaceCoverageAllowBrand]: true as const,
	});
}

export function createCoverageGatedConflictPort(conflict?: RemConflictPort): {
	softClose<PairId extends string>(input: SoftCloseInput & {
		pairId: PairId;
		coverageAllow: ReplaceCoverageAllowToken<PairId>;
	}): Promise<RemMutationResult>;
} {
	return {
		async softClose(input) {
			if (input.coverageAllow[replaceCoverageAllowBrand] !== true) {
				throw new Error("coverage allow token was not issued by the coverage gate");
			}
			if (input.coverageAllow.coverageDecision.pairId !== input.pairId) {
				throw new Error("coverage allow token belongs to a different pair");
			}
			if (input.coverageAllow.coverageDecision.decision !== "allow") {
				throw new Error("coverage allow token is not backed by an allow decision");
			}
			const authorization = verifiedWriteAuthorization.getStore();
			if (
				authorization === undefined ||
				authorization.writer !== "softClose" ||
				authorization.rowId !== input.rowId ||
				authorization.softCloseSuccessorId !== input.successorId
			) {
				throw new Error("soft close requires verified write authorization");
			}
			if (conflict === undefined) throw new Error("REM conflict port is required");
			return conflict.softClose(input);
		},
	};
}

/**
 * Answers 40-rem-replace-prd.md:566 about the row that carries the event forward once `loserRowId`
 * is closed. Every predicate mirrors one the aggregation-completeness query applies
 * (`memory-store-search-api.ts`), so a `retained` verdict means that query still returns the
 * carrier afterwards. Soft close only ever demotes the LOSER's chunks to the history facet, so the
 * carrier's own facet state is unaffected by this close and can be read now.
 */
export function createRemReplaceCarrierPort(input: {
	database: SqliteDatabaseLike;
	winnerRowId: string;
	loserRowId: string;
	loserProjectId: string;
	loserCategory: string;
}): RemReplaceCarrierPort {
	return {
		async carrierState(): Promise<RemReplaceCarrierState> {
			const row = input.database
				.prepare("SELECT lane, metadata, project_id, category FROM nodix_memories WHERE id = ?")
				.get(input.winnerRowId) as
				| { lane: string; metadata: string; project_id: string; category: string }
				| undefined;
			if (row === undefined) return { retained: false, fault: "carrier_missing" };
			if (row.lane !== "active") return { retained: false, fault: "carrier_inactive" };
			if (parseMetadata(row.metadata)["superseded_by"] !== undefined) {
				return { retained: false, fault: "carrier_superseded" };
			}
			if (row.project_id !== input.loserProjectId || row.category !== input.loserCategory) {
				return { retained: false, fault: "carrier_out_of_aggregation_scope" };
			}
			const current = input.database
				.prepare("SELECT 1 AS present FROM nodix_memory_chunks WHERE memory_id = ? AND facet = 'current' LIMIT 1")
				.get(input.winnerRowId) as { present: number } | undefined;
			if (current === undefined) return { retained: false, fault: "carrier_not_on_current_facet" };
			const stale = input.database
				.prepare("SELECT 1 AS present FROM nodix_memory_chunks WHERE memory_id = ? AND facet != 'current' LIMIT 1")
				.get(input.winnerRowId) as { present: number } | undefined;
			if (stale !== undefined) return { retained: false, fault: "carrier_not_on_current_facet" };
			return { retained: true };
		},
	};
}

export type SnoStationMemRemPorts = Omit<RemPorts, "conflict"> & {
	conflict: {
		softClose(input: SoftCloseInput): Promise<RemMutationResult>;
		writeTextVersion(
			input: WriteTextVersionInput & { verification: RemWriteVerificationToken },
		): Promise<RemMutationResult>;
	};
};

export function createSnoStationMemRemPorts(options: SnoStationMemRemPortOptions): SnoStationMemRemPorts {
	return {
		clock: {
			now: () => new Date().toISOString(),
		},
		conflict: {
			softClose: async (input) => softClose(options.database, input),
			writeTextVersion: async ({ verification, ...write }) => {
				assertVerifiedTextWrite(verification, write.rowId);
				return options.memoryStore === undefined
					? writeTextVersion(options.database, write)
					: options.memoryStore.applyRemTextVersion(write);
			},
		},
		forget: {
			moveLane: async (input) => moveLane(options.database, input),
		},
		llm: {
			complete: (request) => completeWithClient(options.llmClient, request),
		},
	};
}

function assertVerifiedTextWrite(verification: RemWriteVerificationToken, rowId: string): void {
	const active = verifiedWriteAuthorization.getStore();
	if (
		verification === undefined ||
		verification[verifiedWriteAuthorizationBrand] !== true ||
		active !== verification ||
		verification.rowId !== rowId ||
		(verification.writer !== "writeTextVersion" && verification.writer !== "applyRemTextVersion")
	) {
		throw new Error("text version write requires verified write authorization");
	}
}

export function createSnoStationMemRemRecovery(
	database: SqliteDatabaseLike,
): SnoStationMemRemRecovery {
	return {
		restoreLane: (recoveryHandle) =>
			restore(database, recoveryHandle, "lane"),
		restoreTextVersion: (recoveryHandle) =>
			restore(database, recoveryHandle, "text-version"),
		restoreMark: (recoveryHandle) =>
			restore(database, recoveryHandle, "mark"),
	};
}

interface WriteAttemptRow {
	attempt_id: string;
	job_id: string;
	row_id: string;
	writer: RemMutationWriter;
	attempt_ordinal: number;
	outcome: "pending" | RemWriteAttemptOutcome["outcome"];
	pre_write_content_sha256: string;
	proposed_text_sha256: string;
	expected_post_content_sha256: string | null;
	evidence_id: string;
	configuration_sha256: string;
	reason_code: string | null;
	post_write_content_sha256: string | null;
}

interface WriteVerdictRow {
	winner_row_id: string;
	loser_row_id: string;
	target_row_id: string;
	retired_fact_atoms_json: string;
}

export function createSnoStationMemRemMutationExecutor(input: {
	database: SqliteDatabaseLike;
	/**
	 * The job every attempt this executor opens belongs to. It lives here, not on `openAttempt`,
	 * because a job type is a property of the job: putting it on the attempt would let two attempts
	 * inside one job claim different types, and the journal rows they wrote would disagree about
	 * what ran. It is also never parsed out of `stage` — that field is free-form and reading a type
	 * out of it mints plausible-but-wrong audit rows.
	 */
	jobType: RemOperationType;
	configurationSha256: string;
	liveContentionRetries: number;
	modelResponse?: { kind: "absent" | "invalid"; value?: string | undefined } | undefined;
	recovery?: SnoStationMemRemRecovery;
	applyTextVersion?: (
		input: WriteTextVersionInput,
		verification: RemWriteVerificationToken,
	) => Promise<RemMutationResult>;
	applySoftClose?: (input: SoftCloseInput) => Promise<RemMutationResult>;
}): {
	openAttempt(attempt: {
		jobId: string;
		stage: string;
		rowId: string;
		writer: RemMutationWriter;
		authorization: RemWriteAuthorization;
	}): Promise<RemWriteAttemptHandle>;
	mutateAttempt(
		handle: RemWriteAttemptHandle,
		operation: RemWriterOperation,
	): Promise<RemMutationResolution>;
	closeAttempt(
		handle: RemWriteAttemptHandle,
		resolution: RemMutationResolution,
	): Promise<RemWriteAttemptOutcome>;
	recoverPendingAttempts(): Promise<RemWriteAttemptOutcome[]>;
} {
	if (!Number.isSafeInteger(input.liveContentionRetries) || input.liveContentionRetries < 0) {
		throw new Error("liveContentionRetries must be a non-negative safe integer");
	}
	return {
		async openAttempt(attempt) {
			if (attempt.rowId !== attempt.authorization.rowId) {
				throw new Error("write authorization belongs to a different row");
			}
			const attemptId = hashAttemptId(attempt);
			input.database
				.prepare(
					`INSERT INTO nodix_rem_write_attempts(
						attempt_id, job_id, stage, row_id, writer, attempt_ordinal, outcome,
						pre_write_content_sha256, proposed_text_sha256, evidence_id,
						configuration_sha256, opened_at
					) VALUES (?, ?, ?, ?, ?, 1, 'pending', ?, ?, ?, ?, ?)`,
				)
				.run(
					attemptId,
					attempt.jobId,
					attempt.stage,
					attempt.rowId,
					attempt.writer,
					attempt.authorization.preWriteContentSha256,
					attempt.authorization.proposedTextSha256,
					attempt.authorization.evidenceId,
					attempt.authorization.configurationSha256,
					new Date().toISOString(),
				);
			return { attemptId };
		},
		async mutateAttempt(handle, operation) {
			const attempt = readPendingAttempt(input.database, handle.attemptId);
			if (attempt.writer !== operation.kind) throw new Error("writer operation does not match attempt");
			for (let ordinal = 1; ordinal <= input.liveContentionRetries + 1; ordinal += 1) {
				if (ordinal !== attempt.attempt_ordinal) {
					input.database
						.prepare("UPDATE nodix_rem_write_attempts SET attempt_ordinal = ? WHERE attempt_id = ?")
						.run(ordinal, attempt.attempt_id);
				}
				if (input.modelResponse !== undefined) {
					return {
						applied: false,
						attemptOrdinal: ordinal,
						reasonCode: "model_response_invalid",
					};
				}
				const validation = validateWriteAttempt(
					input.database,
					attempt,
					operation,
					input.configurationSha256,
				);
				if (
					!validation.allowed &&
					validation.reasonCode === "hash_mismatch" &&
					ordinal <= input.liveContentionRetries
				) {
					continue;
				}
				if (!validation.allowed) {
					return {
						applied: false,
						attemptOrdinal: ordinal,
						// The reason names the CAUSE, never the response to it. Reporting
						// "retry_exhausted" here cost the caller the one fact it routes on: the
						// executor carries a refusal into the next generation only when the row
						// moved under the write, so a renamed hash mismatch silently dropped the
						// carry and the next generation applied the write against changed content.
						// That retries happened is already recorded in attemptOrdinal, so nothing
						// is lost. `content_changed` is the name the rest of REM uses for this.
						reasonCode:
							validation.reasonCode === "hash_mismatch"
								? "content_changed"
								: validation.reasonCode,
					};
				}
				try {
					const mutation = await verifiedWriteAuthorization.run(
						validation.authorization,
						async () => {
							const result = await applyWriterOperation(
								input.database,
								attempt,
								operation,
								input.recovery,
								input.applyTextVersion,
								input.applySoftClose,
								input.jobType,
							);
							if (result.applied && readAttempt(input.database, attempt.attempt_id).outcome === "pending") {
								recordVerifiedCommittedMutation(input.database, result);
							}
							return result;
						},
					);
					return {
						applied: mutation.applied,
						attemptOrdinal: ordinal,
						reasonCode: mutation.applied ? null : "mutation_refused",
					};
				} catch (error) {
					log.warn("rem mutation failed", {
						attempt_id: attempt.attempt_id,
						attemptOrdinal: ordinal,
						error,
						reason_code: "mutation_failed",
						writer: attempt.writer,
					}, {
						event_name: "sno_station_mem.rem-sqlite-adapter.rem.mutation.failed",
						file: "packages/sno-station-mem/src/store/rem-sqlite-adapter.ts",
						function: "mutateAttempt",
						site_id: "rem-sqlite-adapter.mutateAttempt.4c4b5764ca",
					});
					return { applied: false, attemptOrdinal: ordinal, reasonCode: "mutation_failed" };
				}
			}
			throw new Error("unreachable REM retry state");
		},
		async closeAttempt(handle, resolution) {
			const attempt = readAttempt(input.database, handle.attemptId);
			if (attempt.outcome === "succeeded") {
				return {
					applied: true,
					attemptId: handle.attemptId,
					attemptOrdinal: attempt.attempt_ordinal,
					outcome: "succeeded",
					preWriteContentSha256: attempt.pre_write_content_sha256,
					postWriteContentSha256: attempt.post_write_content_sha256,
					reasonCode: null,
				};
			}
			if (attempt.outcome !== "pending") throw new Error("write attempt is already closed");
			const outcome = classifyAttemptOutcome(resolution);
			const reasonCode = resolution.applied ? "mutation_not_committed" : resolution.reasonCode;
			const postWriteContentSha256 = null;
			input.database
				.prepare(
					`UPDATE nodix_rem_write_attempts SET
						outcome = ?, reason_code = ?, attempt_ordinal = ?,
						post_write_content_sha256 = ?, closed_at = ?
					WHERE attempt_id = ? AND outcome = 'pending'`,
				)
				.run(
					outcome,
					reasonCode,
					resolution.attemptOrdinal,
					postWriteContentSha256,
					new Date().toISOString(),
					handle.attemptId,
				);
			return {
				applied: false,
				attemptOrdinal: resolution.attemptOrdinal,
				reasonCode,
				attemptId: handle.attemptId,
				outcome,
				preWriteContentSha256: attempt.pre_write_content_sha256,
				postWriteContentSha256,
			};
		},
		async recoverPendingAttempts() {
			const pending = input.database
				.prepare("SELECT * FROM nodix_rem_write_attempts WHERE outcome = 'pending' ORDER BY opened_at, attempt_id")
				.all() as WriteAttemptRow[];
			const outcomes: RemWriteAttemptOutcome[] = [];
			for (const attempt of pending) {
				const current = readMemory(input.database, attempt.row_id);
				// `proposed_text_sha256` hashes the text alone; `content_hash` hashes text AND
				// metadata, and a REM update always writes rem_update_* metadata. Comparing them
				// recorded every committed write as failed. The write transaction now stamps the
				// content hash it produced onto this attempt row, so the comparison is between two
				// values of the same kind, and a crash cannot leave them disagreeing because the
				// stamp and the write commit together.
				const committedTextWrite =
					(attempt.writer === "writeTextVersion" || attempt.writer === "applyRemTextVersion") &&
					attempt.expected_post_content_sha256 !== null &&
					current?.content_hash === attempt.expected_post_content_sha256;
				const resolution = {
					applied: committedTextWrite,
					attemptOrdinal: attempt.attempt_ordinal,
					reasonCode: committedTextWrite ? null : "crash_before_close",
				};
				input.database
					.prepare(
						`UPDATE nodix_rem_write_attempts SET outcome = ?, reason_code = ?,
						post_write_content_sha256 = ?, closed_at = ?
						WHERE attempt_id = ? AND outcome = 'pending'`,
					)
					.run(
						committedTextWrite ? "succeeded" : "failed",
						resolution.reasonCode,
						committedTextWrite ? attempt.expected_post_content_sha256 : null,
						new Date().toISOString(),
						attempt.attempt_id,
					);
				outcomes.push({
					...resolution,
					attemptId: attempt.attempt_id,
					outcome: committedTextWrite ? "succeeded" : "failed",
					preWriteContentSha256: attempt.pre_write_content_sha256,
					postWriteContentSha256: committedTextWrite ? attempt.expected_post_content_sha256 : null,
				});
			}
			return outcomes;
		},
	};
}

function readPendingAttempt(database: SqliteDatabaseLike, attemptId: string): WriteAttemptRow {
	const attempt = readAttempt(database, attemptId);
	if (attempt.outcome !== "pending") throw new Error("write attempt is already closed");
	return attempt;
}

function readAttempt(database: SqliteDatabaseLike, attemptId: string): WriteAttemptRow {
	const attempt = database
		.prepare("SELECT * FROM nodix_rem_write_attempts WHERE attempt_id = ?")
		.get(attemptId) as WriteAttemptRow | undefined;
	if (attempt === undefined) throw new Error("write attempt not found");
	return attempt;
}

function hashAttemptId(input: {
	jobId: string;
	stage: string;
	rowId: string;
	writer: RemMutationWriter;
}): string {
	return createHash("sha256")
		.update([input.jobId, input.stage, input.rowId, input.writer].join("\0"))
		.digest("hex");
}

function validateWriteAttempt(
	database: SqliteDatabaseLike,
	attempt: WriteAttemptRow,
	operation: RemWriterOperation,
	configurationSha256: string,
): WriteAttemptValidation {
	const row = readMemory(database, attempt.row_id);
	if (row === undefined) return { allowed: false, reasonCode: "row_missing" };
	if (typeof parseMetadata(row.metadata)["rem_retired_section"] === "string") {
		return { allowed: false, reasonCode: "scope_mismatch" };
	}
	if (attempt.configuration_sha256 !== configurationSha256) {
		return { allowed: false, reasonCode: "configuration_drift" };
	}
	const verdict = database
		.prepare(
			`SELECT winner_row_id, loser_row_id, target_row_id, retired_fact_atoms_json
			FROM nodix_rem_write_verdicts WHERE evidence_id = ?`,
		)
		.get(attempt.evidence_id) as WriteVerdictRow | undefined;
	if (verdict === undefined) return { allowed: false, reasonCode: "verdict_absent" };
	if (verdict.target_row_id !== attempt.row_id || verdict.loser_row_id !== attempt.row_id) {
		return { allowed: false, reasonCode: "verdict_evidence_mismatch" };
	}
	if (operation.kind === "softClose" && verdict.winner_row_id !== operation.successorId) {
		return { allowed: false, reasonCode: "verdict_successor_mismatch" };
	}
	if (row.content_hash !== attempt.pre_write_content_sha256) {
		return { allowed: false, reasonCode: "hash_mismatch" };
	}
	if (hashText(proposedText(database, operation, row.text)) !== attempt.proposed_text_sha256) {
		return { allowed: false, reasonCode: "proposed_text_mismatch" };
	}
	return {
		allowed: true,
		authorization: Object.freeze({
			attemptId: attempt.attempt_id,
			rowId: attempt.row_id,
			writer: attempt.writer,
			softCloseSuccessorId: operation.kind === "softClose" ? operation.successorId : null,
			[verifiedWriteAuthorizationBrand]: true as const,
		}),
	};
}

function proposedText(
	database: SqliteDatabaseLike,
	operation: RemWriterOperation,
	currentText: string,
): string {
	if (operation.kind === "writeTextVersion" || operation.kind === "applyRemTextVersion") {
		return operation.replacementText;
	}
	if (operation.kind !== "restoreTextVersion") return currentText;
	const recovery = database
		.prepare(
			`SELECT prior_row_image FROM nodix_rem_recovery_history
			WHERE recovery_handle = ? AND operation_kind = 'text-version'`,
		)
		.get(operation.recoveryHandle) as { prior_row_image: string } | undefined;
	if (recovery === undefined) throw new Error("text-version recovery handle not found");
	return parsePriorRow(recovery.prior_row_image).text;
}

async function applyWriterOperation(
	database: SqliteDatabaseLike,
	attempt: WriteAttemptRow,
	operation: RemWriterOperation,
	recovery: SnoStationMemRemRecovery | undefined,
	applyTextVersion:
		| ((
				input: WriteTextVersionInput,
				verification: RemWriteVerificationToken,
		  ) => Promise<RemMutationResult>)
		| undefined,
	applySoftClose: ((input: SoftCloseInput) => Promise<RemMutationResult>) | undefined,
	jobType: RemOperationType,
): Promise<RemMutationResult> {
	const verification = verifiedWriteAuthorization.getStore();
	if (verification === undefined) throw new Error("writer operation requires verified authorization");
	switch (operation.kind) {
		case "moveLane":
			return moveLane(database, {
				rowId: attempt.row_id,
				plannedContentHash: attempt.pre_write_content_sha256,
				...operation,
			});
		case "writeTextVersion":
			return applyTextVersion === undefined
				? writeTextVersion(database, {
						...operation,
						rowId: attempt.row_id,
						plannedContentHash: attempt.pre_write_content_sha256,
						jobId: attempt.job_id,
						jobType,
						attemptId: attempt.attempt_id,
					})
				: await applyTextVersion(
					{
						...operation,
						rowId: attempt.row_id,
						plannedContentHash: attempt.pre_write_content_sha256,
						jobId: attempt.job_id,
						jobType,
						attemptId: attempt.attempt_id,
					},
					verification,
				);
		case "softClose": {
			const successor = readMemory(database, operation.successorId);
			if (successor === undefined) return { applied: false, reason: "target_missing" };
			const write = {
				rowId: attempt.row_id,
				plannedContentHash: attempt.pre_write_content_sha256,
				plannedSuccessorContentHash: successor.content_hash,
				...operation,
			};
			return applySoftClose === undefined ? softClose(database, write) : await applySoftClose(write);
		}
		case "restoreLane":
			if (recovery !== undefined) {
				recovery.restoreLane(operation.recoveryHandle);
				return restoredMutationResult(database, attempt.row_id, operation.recoveryHandle);
			}
			restoreInMutationTransaction(database, operation.recoveryHandle, "lane");
			return restoredMutationResult(database, attempt.row_id, operation.recoveryHandle);
		case "restoreTextVersion":
			if (recovery !== undefined) {
				recovery.restoreTextVersion(operation.recoveryHandle);
				return restoredMutationResult(database, attempt.row_id, operation.recoveryHandle);
			}
			restoreInMutationTransaction(database, operation.recoveryHandle, "text-version");
			return restoredMutationResult(database, attempt.row_id, operation.recoveryHandle);
		case "restoreMark":
			if (recovery !== undefined) {
				recovery.restoreMark(operation.recoveryHandle);
				return restoredMutationResult(database, attempt.row_id, operation.recoveryHandle);
			}
			restoreInMutationTransaction(database, operation.recoveryHandle, "mark");
			return restoredMutationResult(database, attempt.row_id, operation.recoveryHandle);
		case "applyRemTextVersion":
			return applyTextVersion === undefined
				? writeTextVersion(database, {
						...operation,
						rowId: attempt.row_id,
						plannedContentHash: attempt.pre_write_content_sha256,
						jobId: attempt.job_id,
						jobType,
						attemptId: attempt.attempt_id,
					})
				: await applyTextVersion(
					{
						...operation,
						rowId: attempt.row_id,
						plannedContentHash: attempt.pre_write_content_sha256,
						jobId: attempt.job_id,
						jobType,
						attemptId: attempt.attempt_id,
					},
					verification,
				);
	}
}

function restoredMutationResult(
	database: SqliteDatabaseLike,
	rowId: string,
	recoveryHandle: string,
): RemMutationResult {
	const row = readMemory(database, rowId);
	if (row === undefined) throw new Error("restored row is missing");
	return { applied: true, contentHash: row.content_hash, recoveryHandle };
}

function classifyAttemptOutcome(
	resolution: RemMutationResolution,
): RemWriteAttemptOutcome["outcome"] {
	if (resolution.applied) return "failed";
	if (resolution.reasonCode === "mutation_failed" || resolution.reasonCode === "crash_before_close") {
		return "failed";
	}
	return "refused";
}

function moveLane(database: SqliteDatabaseLike, input: MoveLaneInput): RemMutationResult {
	assertReason(input.reason);
	return database.transaction(() => {
		const row = readMemory(database, input.rowId);
		if (!row) return { applied: false, reason: "missing" };
		if (row.content_hash !== input.plannedContentHash) {
			return { applied: false, reason: "content_changed" };
		}
		if (row.lane === input.targetLane) {
			return { applied: false, reason: "already_applied" };
		}
		// Parking a row makes it the migration's problem, and that migration aborts on a non-active
		// row with no replayable record — measured 2026-09-04, it took a whole evaluation down.
		// A row parked here was written active and so carries none; write one from the row itself.
		const parkedRecord =
			input.targetLane !== "active" && !row.raw_candidate_json
				? JSON.stringify({
						text: row.text,
						category: row.category,
						contentHash: row.content_hash,
						parkedBy: "rem-move-lane",
						reason: input.reason,
					})
				: row.raw_candidate_json;
		const handle = appendRecovery(
			database,
			row,
			"lane",
			hashMemoryRow({ ...row, lane: input.targetLane, raw_candidate_json: parkedRecord }),
			input.reason,
			input.timestamp,
		);
		database
			.prepare("UPDATE nodix_memories SET lane = ?, raw_candidate_json = ? WHERE id = ?")
			.run(input.targetLane, parkedRecord, input.rowId);
		commitVerifiedAttempt(database, input.rowId, row.content_hash);
		return { applied: true, contentHash: row.content_hash, recoveryHandle: handle };
	}).immediate() as RemMutationResult;
}

function writeTextVersion(
	database: SqliteDatabaseLike,
	input: WriteTextVersionInput,
): RemMutationResult {
	assertReason(input.reason);
	const nextHash = hashText(input.replacementText);
	return database.transaction(() => {
		const row = readMemory(database, input.rowId);
		if (!row) return { applied: false, reason: "missing" };
		if (row.content_hash !== input.plannedContentHash) {
			return { applied: false, reason: "content_changed" };
		}
		if (row.text === input.replacementText) {
			return { applied: false, reason: "already_applied" };
		}
		const handle = appendRecovery(
			database,
			row,
			"text-version",
			hashMemoryRow({
				...row,
				text: input.replacementText,
				content_hash: nextHash,
			}),
			input.reason,
			input.timestamp,
		);
		database
			.prepare("UPDATE nodix_memories SET text = ?, content_hash = ? WHERE id = ?")
			.run(input.replacementText, nextHash, input.rowId);
		stampExpectedPostContentHash(database, input.attemptId, nextHash);
		commitVerifiedAttempt(database, input.rowId, nextHash);
		return { applied: true, contentHash: nextHash, recoveryHandle: handle };
	}).immediate() as RemMutationResult;
}

function softClose(database: SqliteDatabaseLike, input: SoftCloseInput): RemMutationResult {
	assertReason(input.reason);
	return database.transaction(() => {
		const row = readMemory(database, input.rowId);
		if (!row) return { applied: false, reason: "missing" };
		if (row.content_hash !== input.plannedContentHash) {
			return { applied: false, reason: "content_changed" };
		}
		const successor = readMemory(database, input.successorId);
		if (!successor) return { applied: false, reason: "target_missing" };
		if (successor.content_hash !== input.plannedSuccessorContentHash) {
			return { applied: false, reason: "target_changed" };
		}
		const metadata = parseMetadata(row.metadata);
		if (metadata["superseded_by"] === input.successorId) {
			return { applied: false, reason: "already_applied" };
		}
		const nextMetadata = JSON.stringify({
			...metadata,
			superseded_by: input.successorId,
			superseded_at: input.timestamp,
			supersede_reason: input.reason,
		});
		const nextContentHash = stableHash(hashInputForEntry(row.text, nextMetadata));
		const priorFacetState = readFacetState(database, input.rowId);
		const expectedFacetState = buildClosedFacetState(row, priorFacetState, input.timestamp);
		const handle = appendRecovery(
			database,
			row,
			"mark",
			hashMemoryRow({ ...row, metadata: nextMetadata, content_hash: nextContentHash }),
			input.reason,
			input.timestamp,
		);
		appendFacetRecovery(database, handle, priorFacetState, expectedFacetState);
		database
			.prepare("UPDATE nodix_memories SET metadata = ?, content_hash = ? WHERE id = ?")
			.run(nextMetadata, nextContentHash, input.rowId);
		writeFacetState(database, input.rowId, expectedFacetState);
		commitVerifiedAttempt(database, input.rowId, nextContentHash);
		return { applied: true, contentHash: nextContentHash, recoveryHandle: handle };
	}).immediate() as RemMutationResult;
}

function appendRecovery(
	database: SqliteDatabaseLike,
	row: MemoryRow,
	operationKind: RecoveryRow["operation_kind"],
	expectedPostHash: string,
	reason: string,
	mutationTs: string,
): string {
	const recoveryHandle = randomUUID();
	database
		.prepare(
			`INSERT INTO nodix_rem_recovery_history(
				recovery_handle, row_id, operation_kind, prior_row_image, prior_content_hash,
				expected_post_hash, row_hash_version, reason, mutation_ts
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			recoveryHandle,
			row.id,
			operationKind,
			JSON.stringify(row),
			row.content_hash,
			expectedPostHash,
			REM_ROW_HASH_VERSION,
			reason,
			mutationTs,
		);
	return recoveryHandle;
}

function restore(
	database: SqliteDatabaseLike,
	recoveryHandle: string,
	operationKind: RecoveryRow["operation_kind"],
): void {
	database.runRecoveryOperation((raw) =>
		raw.transaction(() => restoreTransactionBody(raw, recoveryHandle, operationKind)).immediate(),
	);
}

function restoreInMutationTransaction(
	database: SqliteDatabaseLike,
	recoveryHandle: string,
	operationKind: RecoveryRow["operation_kind"],
): void {
	database
		.transaction(() => restoreTransactionBody(database, recoveryHandle, operationKind))
		.immediate();
}

function restoreTransactionBody(
	database: SqliteDatabaseLike | RawSqliteDatabase,
	recoveryHandle: string,
	operationKind: RecoveryRow["operation_kind"],
): void {
	const history = database
		.prepare(
			`SELECT recovery_handle, row_id, operation_kind, prior_row_image,
				expected_post_hash, row_hash_version, restored_at
			FROM nodix_rem_recovery_history WHERE recovery_handle = ?`,
		)
		.get(recoveryHandle) as RecoveryRow | undefined;
	if (!history) throw new Error("recovery handle not found");
	if (history.operation_kind !== operationKind) throw new Error("recovery operation kind mismatch");
	if (history.restored_at !== null) throw new Error("recovery already applied");
	const current = readMemoryFromConnection(database, history.row_id);
	if (!current) throw new Error("recoverable row is missing");
	// A version-1 record was written before the hashed field list was pinned and its value cannot
	// be recomputed. Restore refuses it: declining to roll back cannot lose data, whereas rolling
	// back over a row that moved since the mutation would.
	if (history.row_hash_version !== REM_ROW_HASH_VERSION) {
		throw new Error("recovery record predates the pinned row-hash shape");
	}
	if (hashMemoryRow(current) !== history.expected_post_hash) {
		throw new Error("recoverable row changed after mutation");
	}
	const facetRecovery = readFacetRecovery(database, recoveryHandle);
	if (facetRecovery) {
		const expectedFacetState = parseFacetState(
			facetRecovery.expected_facets_json,
			facetRecovery.expected_chunk_facets_json,
		);
		if (!facetStatesEqual(readFacetState(database, history.row_id), expectedFacetState)) {
			throw new Error("recoverable facets changed after mutation");
		}
	}
	const prior = parsePriorRow(history.prior_row_image);
	restoreRawRow(database, prior);
	if (facetRecovery) {
		const priorFacetState = parseFacetState(
			facetRecovery.prior_facets_json,
			facetRecovery.prior_chunk_facets_json,
		);
		removeMutationChunks(database, history.row_id, priorFacetState);
		writeFacetState(database, history.row_id, priorFacetState);
	}
	database
		.prepare("UPDATE nodix_rem_recovery_history SET restored_at = ? WHERE recovery_handle = ?")
		.run(new Date().toISOString(), recoveryHandle);
	commitVerifiedAttempt(database, prior.id, prior.content_hash);
}

/**
 * Records, inside the write transaction, the content hash the write produced. Crash recovery reads
 * it to tell a committed write from a lost one; because it commits with the write, the two cannot
 * disagree. Without it recovery compared a text hash against a content hash and marked every
 * committed write failed.
 */
function stampExpectedPostContentHash(
	database: SqliteDatabaseLike | RawSqliteDatabase,
	attemptId: string,
	contentHash: string,
): void {
	database
		.prepare(
			`UPDATE nodix_rem_write_attempts SET expected_post_content_sha256 = ?
			WHERE attempt_id = ? AND outcome = 'pending'`,
		)
		.run(contentHash, attemptId);
}

function commitVerifiedAttempt(
	database: SqliteDatabaseLike | RawSqliteDatabase,
	rowId: string,
	postWriteContentSha256: string,
): void {
	const authorization = verifiedWriteAuthorization.getStore();
	if (authorization === undefined) return;
	if (authorization.rowId !== rowId) throw new Error("verified write authorization row mismatch");
	const result = database
		.prepare(
			`UPDATE nodix_rem_write_attempts SET outcome = 'succeeded', reason_code = NULL,
				post_write_content_sha256 = ?, closed_at = ?
			WHERE attempt_id = ? AND outcome = 'pending'`,
		)
		.run(postWriteContentSha256, new Date().toISOString(), authorization.attemptId) as {
		changes?: number;
	};
	if (result.changes !== 1) throw new Error("verified write attempt is no longer pending");
}

function recordVerifiedCommittedMutation(
	database: SqliteDatabaseLike,
	mutation: Extract<RemMutationResult, { applied: true }>,
): void {
	const authorization = verifiedWriteAuthorization.getStore();
	if (authorization === undefined) throw new Error("committed mutation lacks verified authorization");
	const row = readMemory(database, authorization.rowId);
	if (row === undefined || row.content_hash !== mutation.contentHash) {
		throw new Error("committed mutation does not match the stored row");
	}
	const recovery = database
		.prepare(
			`SELECT row_id, expected_post_hash, row_hash_version, restored_at
			FROM nodix_rem_recovery_history WHERE recovery_handle = ?`,
		)
		.get(mutation.recoveryHandle) as
		| {
				row_id: string;
				expected_post_hash: string;
				row_hash_version: number;
				restored_at: string | null;
		  }
		| undefined;
	if (
		recovery === undefined ||
		recovery.row_id !== authorization.rowId ||
		recovery.restored_at !== null
	) {
		throw new Error("committed mutation lacks matching recovery state");
	}
	// The write is already committed by the time this runs, so throwing here does not undo it — it
	// only tells the caller a lie. A version-1 record predates the pinned field list and its hash
	// cannot be recomputed by any build; comparing against it refused every write, which is the
	// defect this branch exists to end. The checks that do not depend on the hash shape still run
	// above, and the row identity check below still runs.
	if (
		recovery.row_hash_version !== REM_ROW_HASH_VERSION_LEGACY &&
		recovery.expected_post_hash !== hashStoredMemoryRow(database, authorization.rowId)
	) {
		throw new Error("committed mutation lacks matching recovery state");
	}
	commitVerifiedAttempt(database, authorization.rowId, mutation.contentHash);
}

function hashStoredMemoryRow(database: SqliteDatabaseLike, rowId: string): string {
	const row = readMemory(database, rowId);
	if (row === undefined) throw new Error("committed mutation row is missing");
	return hashMemoryRow(row);
}

function removeMutationChunks(
	raw: SqliteDatabaseLike | RawSqliteDatabase,
	rowId: string,
	prior: FacetState,
): void {
	const priorIds = new Set(prior.chunkFacets.map((chunk) => chunk.chunk_id));
	const currentIds = (
		raw.prepare("SELECT chunk_id FROM nodix_memory_chunks WHERE memory_id = ?").all(rowId) as Array<{
			chunk_id: string;
		}>
	).map((row) => row.chunk_id);
	const deleteVector = raw.prepare("DELETE FROM nodix_memory_chunk_vectors WHERE id = ?");
	const deleteChunk = raw.prepare("DELETE FROM nodix_memory_chunks WHERE chunk_id = ?");
	for (const chunkId of currentIds) {
		if (priorIds.has(chunkId)) continue;
		deleteVector.run(chunkId);
		deleteChunk.run(chunkId);
	}
}

function appendFacetRecovery(
	database: SqliteDatabaseLike,
	recoveryHandle: string,
	prior: FacetState,
	expected: FacetState,
): void {
	database
		.prepare(
			`INSERT INTO nodix_rem_facet_recovery(
				recovery_handle, prior_facets_json, prior_chunk_facets_json,
				expected_facets_json, expected_chunk_facets_json
			) VALUES (?, ?, ?, ?, ?)`,
		)
		.run(
			recoveryHandle,
			JSON.stringify(prior.facets),
			JSON.stringify(prior.chunkFacets),
			JSON.stringify(expected.facets),
			JSON.stringify(expected.chunkFacets),
		);
}

function readFacetRecovery(
	database: SqliteDatabaseLike | RawSqliteDatabase,
	recoveryHandle: string,
): FacetRecoveryRow | undefined {
	return database
		.prepare(
			`SELECT prior_facets_json, prior_chunk_facets_json,
				expected_facets_json, expected_chunk_facets_json
			FROM nodix_rem_facet_recovery WHERE recovery_handle = ?`,
		)
		.get(recoveryHandle) as FacetRecoveryRow | undefined;
}

function buildClosedFacetState(
	row: MemoryRow,
	prior: FacetState,
	mutationTs: string,
): FacetState {
	const updatedAt = Date.parse(mutationTs);
	if (!Number.isFinite(updatedAt)) throw new Error("mutation timestamp is invalid");
	const historyEnd = prior.chunkFacets.reduce((last, chunk) =>
		chunk.facet === "history" ? Math.max(last, chunk.chunk_index ?? -1) : last, -1);
	return {
		facets: [{ facet: "history", text: row.text, updated_at_ms: updatedAt }],
		chunkFacets: prior.chunkFacets.map((chunk) => chunk.facet === "history" ? chunk : {
			...chunk, facet: "history", chunk_index: historyEnd + 1 + (chunk.chunk_index ?? 0),
		}),
	};
}

function readFacetState(
	database: SqliteDatabaseLike | RawSqliteDatabase,
	rowId: string,
): FacetState {
	return {
		facets: database
			.prepare(
				"SELECT facet, text, updated_at_ms FROM nodix_rem_memory_facets WHERE memory_id = ? ORDER BY facet",
			)
			.all(rowId) as MemoryFacetRow[],
		chunkFacets: database
			.prepare(
				"SELECT chunk_id, facet, chunk_index FROM nodix_memory_chunks WHERE memory_id = ? ORDER BY chunk_id",
			)
			.all(rowId) as ChunkFacetRow[],
	};
}

function writeFacetState(
	database: SqliteDatabaseLike | RawSqliteDatabase,
	rowId: string,
	state: FacetState,
): void {
	database.prepare("DELETE FROM nodix_rem_memory_facets WHERE memory_id = ?").run(rowId);
	const insertFacet = database.prepare(
		"INSERT INTO nodix_rem_memory_facets(memory_id, facet, text, updated_at_ms) VALUES (?, ?, ?, ?)",
	);
	for (const facet of state.facets) {
		insertFacet.run(rowId, facet.facet, facet.text, facet.updated_at_ms);
	}
	const updateChunkFacet = database.prepare(
		"UPDATE nodix_memory_chunks SET facet = ?, chunk_index = COALESCE(?, chunk_index) WHERE chunk_id = ? AND memory_id = ?",
	);
	for (const chunk of state.chunkFacets) {
		updateChunkFacet.run(chunk.facet, chunk.chunk_index ?? null, chunk.chunk_id, rowId);
	}
}

function parseFacetState(facetsJson: string, chunkFacetsJson: string): FacetState {
	const facets: unknown = JSON.parse(facetsJson);
	const chunkFacets: unknown = JSON.parse(chunkFacetsJson);
	if (!Array.isArray(facets) || !Array.isArray(chunkFacets)) {
		throw new Error("facet recovery state is invalid");
	}
	if (
		!facets.every(
			(facet) =>
				typeof facet === "object" &&
				facet !== null &&
				((facet as MemoryFacetRow).facet === "current" ||
					(facet as MemoryFacetRow).facet === "history") &&
				typeof (facet as MemoryFacetRow).text === "string" &&
				Number.isFinite((facet as MemoryFacetRow).updated_at_ms),
		) ||
		!chunkFacets.every(
			(chunk) =>
				typeof chunk === "object" &&
				chunk !== null &&
				typeof (chunk as ChunkFacetRow).chunk_id === "string" &&
				((chunk as ChunkFacetRow).facet === "current" ||
					(chunk as ChunkFacetRow).facet === "history") &&
				((chunk as ChunkFacetRow).chunk_index === undefined ||
					Number.isSafeInteger((chunk as ChunkFacetRow).chunk_index)),
		)
	) {
		throw new Error("facet recovery state is invalid");
	}
	return {
		facets: facets as MemoryFacetRow[],
		chunkFacets: chunkFacets as ChunkFacetRow[],
	};
}

function facetStatesEqual(left: FacetState, right: FacetState): boolean {
	const comparableLeftChunks = right.chunkFacets.every((chunk) => chunk.chunk_index === undefined)
		? left.chunkFacets.map(({ chunk_id, facet }) => ({ chunk_id, facet }))
		: left.chunkFacets;
	return (
		JSON.stringify(left.facets) === JSON.stringify(right.facets) &&
		JSON.stringify(comparableLeftChunks) === JSON.stringify(right.chunkFacets)
	);
}

function restoreRawRow(raw: SqliteDatabaseLike | RawSqliteDatabase, row: MemoryRow): void {
	raw.prepare(
		`UPDATE nodix_memories SET
			text = ?, category = ?, project_id = ?, importance = ?, timestamp = ?, timezone = ?, metadata = ?,
			content_hash = ?, fact_id = ?, derived_from = ?, consolidation_epoch_id = ?,
			confidence_source = ?, lane = ?, raw_candidate_json = ?, disposition_reason = ?,
			dispositioned_at_ms = ?
		WHERE id = ?`,
	).run(
		row.text,
		row.category,
		row.project_id,
		row.importance,
		row.timestamp,
		row.timezone,
		row.metadata,
		row.content_hash,
		row.fact_id,
		row.derived_from,
		row.consolidation_epoch_id,
		row.confidence_source,
		row.lane,
		row.raw_candidate_json,
		row.disposition_reason,
		row.dispositioned_at_ms,
		row.id,
	);
}

function readMemory(database: SqliteDatabaseLike, rowId: string): MemoryRow | undefined {
	return database.prepare(memorySelectSql()).get(rowId) as MemoryRow | undefined;
}

function readMemoryFromConnection(
	raw: SqliteDatabaseLike | RawSqliteDatabase,
	rowId: string,
): MemoryRow | undefined {
	return raw.prepare(memorySelectSql()).get(rowId) as MemoryRow | undefined;
}

function memorySelectSql(): string {
	return `SELECT id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash,
		fact_id, derived_from, consolidation_epoch_id, confidence_source, lane, raw_candidate_json,
		disposition_reason, dispositioned_at_ms
		FROM nodix_memories WHERE id = ?`;
}

function parseMetadata(value: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(value);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("memory metadata must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

function parsePriorRow(value: string): MemoryRow {
	const parsed: unknown = JSON.parse(value);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("recovery before-image is invalid");
	}
	const row = parsed as Partial<MemoryRow>;
	if (
		typeof row.id !== "string" ||
		typeof row.text !== "string" ||
		typeof row.content_hash !== "string" ||
		typeof row.metadata !== "string"
	) {
		throw new Error("recovery before-image is incomplete");
	}
	return row as MemoryRow;
}

function assertReason(reason: string): void {
	if (reason.trim().length === 0) throw new Error("mutation reason is required");
}

function hashText(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function hashMemoryRow(row: MemoryRow): string {
	// One definition, shared with the producer in `packages/rem-core`. When these were two
	// definitions they drifted, and a write that had already committed was reported as failed.
	return hashRemMemoryRow(row as unknown as Record<string, unknown>);
}

async function completeWithClient(
	client: LlmClient,
	request: RemLlmRequest,
): Promise<RemLlmResponse> {
	const text = await client.completeText({
		prompt: request.prompt,
		callLabel: "rem-batch",
		adapterSlot: "conflict-adjudication",
		...(request.signal === undefined ? {} : { signal: request.signal }),
	});
	if (text === null) throw new Error("REM LLM request returned no text");
	const usage = client.getLastUsage();
	if (!usage) return { text };
	return {
		text,
		usage: {
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
		},
	};
}
