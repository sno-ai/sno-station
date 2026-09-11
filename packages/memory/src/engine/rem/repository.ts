import { readFileSync } from "node:fs";

import { assertJobIdentity } from "./types.js";
import type {
	RemDatabaseLike,
	RemOperationType,
	RemOwner,
	RemRowState,
	RemVerdictCheckpoint,
} from "./types.js";

const bootIdPath = "/proc/sys/kernel/random/boot_id";

interface RunResult {
	changes: number;
}

interface LedgerRow {
	content_hash: string;
	owner: RemOwner;
}

interface RowClaimRow {
	content_hash: string;
	owner: Exclude<RemOwner, "none">;
	claim_token: string;
	holder_pid: number;
	holder_process_start: string;
	holder_boot_id: string | null;
	state: "active" | "completed";
}

interface MemoryHashRow {
	content_hash: string;
}

interface GenerationRow {
	generation_id: string;
	corpus_snapshot_hash: string;
	pairing_config_hash: string;
	max_llm_calls: number;
	max_tokens: number;
	llm_calls_used: number;
	tokens_used: number;
	pending_stages_json: string;
}

interface PairRow {
	pair_id: string;
	left_row_id: string;
	right_row_id: string;
	sort_key: string;
	claim_state: "unvisited" | "claimed" | "done";
	invocation_id: string | null;
	checkpoint: RemVerdictCheckpoint | null;
	verdict: string | null;
	actions_applied: number;
	budget_reserved: number;
	budget_invocation_id: string | null;
	reserved_tokens: number;
	attempt_count: number;
	progress_state: "pending" | "refused" | "closed" | "exhausted";
	refusal_reason: string | null;
	inherited_from_generation_id: string | null;
}

interface InvocationRow {
	llm_calls_used: number;
	tokens_used: number;
}

interface PairClaimRow {
	claim_token: string;
	holder_pid: number;
	holder_process_start: string;
	holder_boot_id: string | null;
	state: "active" | "completed";
}

type BudgetReservation =
	| { status: "reserved"; tokens: number; idempotencyKey: string }
	| { status: "pending"; reason: "invocation_row_missing" | "tokenizer_unavailable" };

type RowClaimRefusalReason =
	| "claim_changed"
	| "content_changed"
	| "content_changed_released"
	| "holder_alive"
	| "inconsistent_state"
	| "missing";

export interface CreateVerdictGenerationInput {
	generationId: string;
	corpusSnapshotHash: string;
	pairingConfigHash: string;
	maxLlmCalls: number;
	maxTokens: number;
	pairs: ReadonlyArray<{
		pairId: string;
		leftRowId: string;
		rightRowId: string;
		sortKey: string;
	}>;
	inheritedRefusalsFromGenerationId?: string;
}

export interface VerdictGenerationRef {
	generationId: string;
	corpusSnapshotHash: string;
}

export interface VerdictPairQueueItem {
	pairId: string;
	leftRowId: string;
	rightRowId: string;
	sortKey: string;
	claimState: "unvisited" | "claimed" | "done";
	invocationId: string | null;
}

export interface JournalEntry {
	stage: string;
	outcome: "done" | "failed" | "disabled" | "pending" | "refused" | "no-action";
	pairsScanned: number;
	verdicts: number;
	actionsApplied: number;
	reason?: string;
	/**
	 * Which condition produced this row, as its own value rather than folded into `reason`. PRD 50
	 * ACC-27 requires the persisted refusal to carry the failing condition as a FIELD: a reader
	 * asking "which condition" must not have to parse a string, and `reason` must stay groupable —
	 * `topRefusalReasons` counts distinct `reason` values, so a detail concatenated into it would
	 * give every refusal its own bucket and destroy the statistic.
	 */
	detail?: string;
	rowId?: string;
	pairId?: string;
}

export interface RemRepository {
	recordClassification(input: {
		rowId: string;
		contentHash: string;
		state: RemRowState;
		classifiedAt: string;
	}): void;
	claimRow(input: {
		rowId: string;
		contentHash: string;
		owner: Exclude<RemOwner, "none">;
		claimToken: string;
		claimTs: string;
		holderPid: number;
	}):
		| { claimed: true }
		| { claimed: false; reason: "content_changed" | "missing" }
		| { claimed: false; reason: "already_claimed"; claimToken: string };
	recoverRowClaim(input: {
		rowId: string;
		contentHash: string;
		owner: Exclude<RemOwner, "none">;
		expectedClaimToken: string;
		claimToken: string;
		claimTs: string;
		holderPid: number;
	}): { recovered: true } | { recovered: false; reason: RowClaimRefusalReason };
	completeRowClaim(input: {
		rowId: string;
		contentHash: string;
		currentContentHash: string;
		owner: Exclude<RemOwner, "none">;
		claimToken: string;
		completedAt: string;
		jobId: string;
		jobType: RemOperationType;
	}): { completed: true } | { completed: false; reason: Exclude<RowClaimRefusalReason, "holder_alive"> };
	releaseRowClaim(input: {
		rowId: string;
		contentHash: string;
		owner: Exclude<RemOwner, "none">;
		claimToken: string;
	}): { released: true } | { released: false; reason: Exclude<RowClaimRefusalReason, "holder_alive"> };
	createVerdictGeneration(input: CreateVerdictGenerationInput): void;
	findOpenVerdictGeneration(input: {
		corpusSnapshotHash: string;
		pairingConfigHash: string;
	}): VerdictGenerationRef | undefined;
	listVerdictPairs(generationId: string): VerdictPairQueueItem[];
	claimNextPair(input: {
		generationId: string;
		invocationId: string;
		claimedAt: string;
		holderPid: number;
	}):
		| {
				pairId: string;
				leftRowId: string;
				rightRowId: string;
		  }
		| undefined;
	completePair(input: {
		generationId: string;
		pairId: string;
		invocationId: string;
	}): void;
	refusePair(input: {
		generationId: string;
		pairId: string;
		invocationId: string;
		reason: string;
		jobId: string;
		jobType: RemOperationType;
	}): { state: "refused" | "exhausted"; attemptCount: number };
	reserveLlmBudget(input: {
		generationId: string;
		pairId: string;
		invocationId: string;
		stage: string;
		prompt: string;
		outputTokenCap: number;
		providerUsage?: { inputTokens: number; outputTokens: number };
		countTokens?: (text: string) => number;
	}): BudgetReservation;
	readGeneration(generationId: string): {
		generationId: string;
		pendingStages: string[];
		llmCallsUsed: number;
		tokensUsed: number;
	};
	readInvocation(input: { generationId: string; invocationId: string }): {
		llmCallsUsed: number;
		tokensUsed: number;
	};
	appendJournal(jobId: string, jobType: RemOperationType, entry: JournalEntry): void;
	listJournal(jobId: string, jobType?: RemOperationType): JournalEntry[];
	recordVerdictCheckpoint(input: {
		generationId: string;
		pairId: string;
		invocationId: string;
		checkpoint: RemVerdictCheckpoint;
		recordedAt: string;
		verdict?: string;
	}): void;
	resumeVerdictPair(input: {
		generationId: string;
		pairId: string;
		expectedInvocationId: string;
		invocationId: string;
		resumedAt: string;
		holderPid: number;
	}):
		| { next: "call_llm"; claimToken: string }
		| { next: "apply_action"; verdict: string; claimToken: string }
		| { next: "complete"; claimToken: string }
		| { next: "refused"; reason: "holder_alive" };
	readVerdictPair(generationId: string, pairId: string): {
		checkpoint: RemVerdictCheckpoint | null;
		actionsApplied: number;
	};
}

export function createRemRepository(database: RemDatabaseLike): RemRepository {
	return {
		recordClassification: (input) => recordClassification(database, input),
		claimRow: (input) => claimRow(database, input),
		recoverRowClaim: (input) => recoverRowClaim(database, input),
		completeRowClaim: (input) => completeRowClaim(database, input),
		releaseRowClaim: (input) => releaseRowClaim(database, input),
		createVerdictGeneration: (input) => createVerdictGeneration(database, input),
		findOpenVerdictGeneration: (input) => findOpenVerdictGeneration(database, input),
		listVerdictPairs: (generationId) => listVerdictPairs(database, generationId),
		claimNextPair: (input) => claimNextPair(database, input),
		completePair: (input) => completePair(database, input),
		refusePair: (input) => refusePair(database, input),
		reserveLlmBudget: (input) => reserveLlmBudget(database, input),
		readGeneration: (generationId) => readGeneration(database, generationId),
		readInvocation: (input) => readInvocation(database, input),
		appendJournal: (jobId, jobType, entry) =>
			appendJournal(database, jobId, jobType, entry),
		listJournal: (jobId, jobType) => listJournal(database, jobId, jobType),
		recordVerdictCheckpoint: (input) => recordVerdictCheckpoint(database, input),
		resumeVerdictPair: (input) => resumeVerdictPair(database, input),
		readVerdictPair: (generationId, pairId) =>
			readVerdictPair(database, generationId, pairId),
	};
}

function recordClassification(
	database: RemDatabaseLike,
	input: {
		rowId: string;
		contentHash: string;
		state: RemRowState;
		classifiedAt: string;
	},
): void {
	database
		.prepare(
			`INSERT INTO nodix_rem_relation_ledger(
				row_id, content_hash, state, owner, claim_ts, classified_at
			) VALUES (?, ?, ?, 'none', NULL, ?)
			ON CONFLICT(row_id) DO UPDATE SET
				content_hash = excluded.content_hash,
				state = excluded.state,
				classified_at = excluded.classified_at
			WHERE nodix_rem_relation_ledger.owner = 'none'`,
		)
		.run(input.rowId, input.contentHash, input.state, input.classifiedAt);
}

function claimRow(
	database: RemDatabaseLike,
	input: {
		rowId: string;
		contentHash: string;
		owner: Exclude<RemOwner, "none">;
		claimToken: string;
		claimTs: string;
		holderPid: number;
	},
): ReturnType<RemRepository["claimRow"]> {
	const holderProcessStart = requireProcessStart(input.holderPid);
	const holderBootId = requireBootId();
	return database.transaction(() => {
		const result = asRunResult(
			database
				.prepare(
					`UPDATE nodix_rem_relation_ledger
					SET owner = ?, claim_ts = ?
					WHERE row_id = ? AND owner = 'none' AND content_hash = ?
						AND EXISTS (
							SELECT 1 FROM nodix_memories
							WHERE id = nodix_rem_relation_ledger.row_id
								AND content_hash = nodix_rem_relation_ledger.content_hash
						)`,
				)
				.run(input.owner, input.claimTs, input.rowId, input.contentHash),
		);
		if (result.changes === 1) {
			database
				.prepare(
					`INSERT INTO nodix_rem_row_claims(
						row_id, content_hash, owner, claim_token, holder_pid,
						holder_process_start, holder_boot_id, claimed_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					input.rowId,
					input.contentHash,
					input.owner,
					input.claimToken,
					input.holderPid,
					holderProcessStart,
					holderBootId,
					input.claimTs,
				);
			return { claimed: true };
		}
		const ledger = database
			.prepare("SELECT content_hash, owner FROM nodix_rem_relation_ledger WHERE row_id = ?")
			.get(input.rowId) as LedgerRow | undefined;
		const memory = database
			.prepare("SELECT content_hash FROM nodix_memories WHERE id = ?")
			.get(input.rowId) as MemoryHashRow | undefined;
		if (!ledger || !memory) return { claimed: false, reason: "missing" };
		if (ledger.content_hash !== input.contentHash || memory.content_hash !== input.contentHash) {
			return { claimed: false, reason: "content_changed" };
		}
		const claim = database
			.prepare("SELECT claim_token FROM nodix_rem_row_claims WHERE row_id = ?")
			.get(input.rowId) as Pick<RowClaimRow, "claim_token"> | undefined;
		if (!claim) throw new Error("row claim has inconsistent durable state");
		return { claimed: false, reason: "already_claimed", claimToken: claim.claim_token };
	}).immediate() as ReturnType<RemRepository["claimRow"]>;
}

function recoverRowClaim(
	database: RemDatabaseLike,
	input: {
		rowId: string;
		contentHash: string;
		owner: Exclude<RemOwner, "none">;
		expectedClaimToken: string;
		claimToken: string;
		claimTs: string;
		holderPid: number;
	},
): ReturnType<RemRepository["recoverRowClaim"]> {
	const holderProcessStart = requireProcessStart(input.holderPid);
	const holderBootId = requireBootId();
	const refusal = inspectRowClaimOwnership(database, input);
	if (refusal) return { recovered: false, reason: refusal };
	const prior = getRowClaim(database, input.rowId);
	const callerIsHolder =
		prior.holder_pid === input.holderPid &&
		prior.holder_process_start === holderProcessStart &&
		prior.holder_boot_id === holderBootId;
	if (
		!callerIsHolder &&
		isExactProcessAlive(
			prior.holder_pid,
			prior.holder_process_start,
			prior.holder_boot_id,
			holderBootId,
		)
	) {
		return { recovered: false, reason: "holder_alive" };
	}
	return database.transaction(() => {
		const currentRefusal = inspectRowClaimOwnership(database, input);
		if (currentRefusal) return { recovered: false, reason: currentRefusal };
		const memory = database
			.prepare("SELECT content_hash FROM nodix_memories WHERE id = ?")
			.get(input.rowId) as MemoryHashRow | undefined;
		if (!memory) return { recovered: false, reason: "missing" };
		if (memory.content_hash !== input.contentHash) {
			const lifecycle = asRunResult(
				database
					.prepare(
						`DELETE FROM nodix_rem_row_claims
						WHERE row_id = ? AND content_hash = ? AND owner = ? AND state = 'active'
							AND claim_token = ? AND holder_pid = ? AND holder_process_start = ?
							AND holder_boot_id IS ?`,
					)
					.run(
						input.rowId,
						input.contentHash,
						input.owner,
						input.expectedClaimToken,
						prior.holder_pid,
						prior.holder_process_start,
						prior.holder_boot_id,
					),
			);
			if (lifecycle.changes !== 1) return { recovered: false, reason: "claim_changed" };
			const ledger = asRunResult(
				database
					.prepare(
						`UPDATE nodix_rem_relation_ledger SET owner = 'none', claim_ts = NULL
						WHERE row_id = ? AND content_hash = ? AND owner = ?`,
					)
					.run(input.rowId, input.contentHash, input.owner),
			);
			if (ledger.changes !== 1) throw new Error("row claim has inconsistent durable state");
			return { recovered: false, reason: "content_changed_released" };
		}
		const lifecycle = asRunResult(
			database
				.prepare(
					`UPDATE nodix_rem_row_claims SET
						claim_token = ?, holder_pid = ?, holder_process_start = ?,
						holder_boot_id = ?, claimed_at = ?
					WHERE row_id = ? AND content_hash = ? AND owner = ? AND state = 'active'
						AND claim_token = ? AND holder_pid = ? AND holder_process_start = ?
						AND holder_boot_id IS ?`,
				)
				.run(
					input.claimToken,
					input.holderPid,
					holderProcessStart,
					holderBootId,
					input.claimTs,
					input.rowId,
					input.contentHash,
					input.owner,
					input.expectedClaimToken,
					prior.holder_pid,
					prior.holder_process_start,
					prior.holder_boot_id,
				),
		);
		if (lifecycle.changes !== 1) return { recovered: false, reason: "claim_changed" };
		const ledger = asRunResult(
			database
				.prepare(
					`UPDATE nodix_rem_relation_ledger SET claim_ts = ?
					WHERE row_id = ? AND content_hash = ? AND owner = ?
						AND EXISTS (
							SELECT 1 FROM nodix_memories
							WHERE id = nodix_rem_relation_ledger.row_id
								AND content_hash = nodix_rem_relation_ledger.content_hash
						)`,
				)
				.run(input.claimTs, input.rowId, input.contentHash, input.owner),
		);
		if (ledger.changes !== 1) throw new Error("row claim has inconsistent durable state");
		return { recovered: true };
	}).immediate() as ReturnType<RemRepository["recoverRowClaim"]>;
}

function completeRowClaim(
	database: RemDatabaseLike,
	input: {
		rowId: string;
		contentHash: string;
		currentContentHash: string;
		owner: Exclude<RemOwner, "none">;
		claimToken: string;
		completedAt: string;
		jobId: string;
		jobType: RemOperationType;
	},
): ReturnType<RemRepository["completeRowClaim"]> {
	assertJobIdentity(input.jobId, input.jobType);
	return database.transaction(() => {
		const prior = getRowClaim(database, input.rowId);
		if (prior.state === "completed") {
			const ledger = database
				.prepare("SELECT content_hash, owner FROM nodix_rem_relation_ledger WHERE row_id = ?")
				.get(input.rowId) as LedgerRow | undefined;
			const memory = database
				.prepare("SELECT content_hash FROM nodix_memories WHERE id = ?")
				.get(input.rowId) as MemoryHashRow | undefined;
			if (
				prior.claim_token === input.claimToken &&
				prior.content_hash === input.contentHash &&
				prior.owner === input.owner &&
				ledger?.content_hash === input.contentHash &&
				ledger.owner === input.owner &&
				memory?.content_hash === input.currentContentHash
			) {
				return { completed: true };
			}
		}
		const refusal = inspectRowClaim(database, {
			...input,
			expectedClaimToken: input.claimToken,
			expectedMemoryContentHash: input.currentContentHash,
		});
		if (refusal) {
			// The reason filter stays: REQ-23 names the stale-hash refusal, and `content_changed` is
			// it. `missing`, `inconsistent_state` and `claim_changed` are ownership and ledger
			// failures — still loud, since the caller throws on any refusal, and still not durable.
			// That gap is recorded rather than widened here.
			if (refusal === "content_changed") {
				appendJournal(database, input.jobId, input.jobType, {
					stage: `row-claim:${input.rowId}`,
					outcome: "refused",
					pairsScanned: 0,
					verdicts: 0,
					actionsApplied: 0,
					reason: refusal,
					rowId: input.rowId,
				});
			}
			return { completed: false, reason: refusal };
		}
		const lifecycle = asRunResult(
			database
				.prepare(
					`UPDATE nodix_rem_row_claims SET state = 'completed', completed_at = ?
					WHERE row_id = ? AND content_hash = ? AND owner = ?
						AND claim_token = ? AND state = 'active'`,
				)
				.run(
					input.completedAt,
					input.rowId,
					input.contentHash,
					input.owner,
					input.claimToken,
				),
		);
		if (lifecycle.changes !== 1) return { completed: false, reason: "claim_changed" };
		const ledger = asRunResult(
			database
				.prepare(
					`UPDATE nodix_rem_relation_ledger SET claim_ts = NULL
					WHERE row_id = ? AND content_hash = ? AND owner = ?`,
				)
				.run(input.rowId, input.contentHash, input.owner),
		);
		if (ledger.changes !== 1) throw new Error("row claim has inconsistent durable state");
		return { completed: true };
	}).immediate() as ReturnType<RemRepository["completeRowClaim"]>;
}

function releaseRowClaim(
	database: RemDatabaseLike,
	input: {
		rowId: string;
		contentHash: string;
		owner: Exclude<RemOwner, "none">;
		claimToken: string;
	},
): ReturnType<RemRepository["releaseRowClaim"]> {
	return database.transaction(() => {
		const refusal = inspectRowClaimOwnership(database, {
			...input,
			expectedClaimToken: input.claimToken,
		});
		if (refusal) return { released: false, reason: refusal };
		const lifecycle = asRunResult(
			database
				.prepare(
					`DELETE FROM nodix_rem_row_claims
					WHERE row_id = ? AND content_hash = ? AND owner = ?
						AND claim_token = ? AND state = 'active'`,
				)
				.run(input.rowId, input.contentHash, input.owner, input.claimToken),
		);
		if (lifecycle.changes !== 1) return { released: false, reason: "claim_changed" };
		const ledger = asRunResult(
			database
				.prepare(
					`UPDATE nodix_rem_relation_ledger SET owner = 'none', claim_ts = NULL
					WHERE row_id = ? AND content_hash = ? AND owner = ?`,
				)
				.run(input.rowId, input.contentHash, input.owner),
		);
		if (ledger.changes !== 1) throw new Error("row claim has inconsistent durable state");
		return { released: true };
	}).immediate() as ReturnType<RemRepository["releaseRowClaim"]>;
}

function createVerdictGeneration(
	database: RemDatabaseLike,
	input: CreateVerdictGenerationInput,
): void {
	database.transaction(() => {
		database
			.prepare(
				`INSERT INTO nodix_rem_scan_generations(
					generation_id, corpus_snapshot_hash, pairing_config_hash, max_llm_calls, max_tokens
				) VALUES (?, ?, ?, ?, ?)`,
			)
			.run(
				input.generationId,
				input.corpusSnapshotHash,
				input.pairingConfigHash,
				input.maxLlmCalls,
				input.maxTokens,
			);
		const insertPair = database.prepare(
			`INSERT INTO nodix_rem_scan_pairs(
				generation_id, pair_id, left_row_id, right_row_id, sort_key,
				claim_state, attempt_count, progress_state, refusal_reason, inherited_from_generation_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const inheritedRefusal = input.inheritedRefusalsFromGenerationId
			? database.prepare(
				`SELECT attempt_count, refusal_reason FROM nodix_rem_scan_pairs
				WHERE generation_id = ? AND pair_id = ? AND progress_state = 'refused'
					AND refusal_reason IN ('content_changed', 'target_changed')`,
			)
			: undefined;
		for (const pair of input.pairs) {
			const inherited = inheritedRefusal?.get(
				input.inheritedRefusalsFromGenerationId,
				pair.pairId,
			) as Pick<PairRow, "attempt_count" | "refusal_reason"> | undefined;
			insertPair.run(
				input.generationId,
				pair.pairId,
				pair.leftRowId,
				pair.rightRowId,
				pair.sortKey,
				"unvisited",
				inherited?.attempt_count ?? 0,
				inherited ? "refused" : "pending",
				inherited?.refusal_reason ?? null,
				inherited ? input.inheritedRefusalsFromGenerationId : null,
			);
		}
	}).immediate();
}

function findOpenVerdictGeneration(
	database: RemDatabaseLike,
	input: { corpusSnapshotHash: string; pairingConfigHash: string },
): VerdictGenerationRef | undefined {
	const row = database
		.prepare(
			`SELECT generation_id, corpus_snapshot_hash
			FROM nodix_rem_scan_generations AS generation
			WHERE corpus_snapshot_hash = ? AND pairing_config_hash = ?
				AND EXISTS (
					SELECT 1 FROM nodix_rem_scan_pairs AS pair
					WHERE pair.generation_id = generation.generation_id
						AND pair.claim_state != 'done'
				)
			ORDER BY rowid
			LIMIT 1`,
		)
		.get(input.corpusSnapshotHash, input.pairingConfigHash) as
		| { generation_id: string; corpus_snapshot_hash: string }
		| undefined;
	return row === undefined
		? undefined
		: { generationId: row.generation_id, corpusSnapshotHash: row.corpus_snapshot_hash };
}

function listVerdictPairs(
	database: RemDatabaseLike,
	generationId: string,
): VerdictPairQueueItem[] {
	const rows = database
		.prepare(
			`SELECT pair_id, left_row_id, right_row_id, sort_key, claim_state, invocation_id
			FROM nodix_rem_scan_pairs
			WHERE generation_id = ?
			ORDER BY sort_key, pair_id`,
		)
		.all(generationId) as Array<{
		pair_id: string;
		left_row_id: string;
		right_row_id: string;
		sort_key: string;
		claim_state: VerdictPairQueueItem["claimState"];
		invocation_id: string | null;
	}>;
	return rows.map((row) => ({
		pairId: row.pair_id,
		leftRowId: row.left_row_id,
		rightRowId: row.right_row_id,
		sortKey: row.sort_key,
		claimState: row.claim_state,
		invocationId: row.invocation_id,
	}));
}

function claimNextPair(
	database: RemDatabaseLike,
	input: {
		generationId: string;
		invocationId: string;
		claimedAt: string;
		holderPid: number;
	},
): { pairId: string; leftRowId: string; rightRowId: string } | undefined {
	const holderProcessStart = requireProcessStart(input.holderPid);
	const holderBootId = requireBootId();
	return database.transaction(() => {
		ensureInvocation(database, input.generationId, input.invocationId, input.claimedAt);
		const pair = database
			.prepare(
				`SELECT pair_id, left_row_id, right_row_id, sort_key, checkpoint, verdict,
					actions_applied, claim_state, invocation_id, budget_reserved, budget_invocation_id,
					reserved_tokens, attempt_count, progress_state, refusal_reason, inherited_from_generation_id
				FROM nodix_rem_scan_pairs
				WHERE generation_id = ? AND claim_state = 'unvisited'
				ORDER BY CASE progress_state WHEN 'refused' THEN 0 ELSE 1 END, sort_key, pair_id
				LIMIT 1`,
			)
			.get(input.generationId) as PairRow | undefined;
		if (!pair) return undefined;
		const result = asRunResult(
			database
				.prepare(
					`UPDATE nodix_rem_scan_pairs SET
						claim_state = 'claimed', invocation_id = ?, claimed_at = ?,
						attempt_count = attempt_count + 1, progress_state = 'pending', refusal_reason = NULL
					WHERE generation_id = ? AND pair_id = ? AND claim_state = 'unvisited'`,
				)
				.run(
					input.invocationId,
					input.claimedAt,
					input.generationId,
					pair.pair_id,
				),
		);
		if (result.changes !== 1) return undefined;
		database
			.prepare(
				`INSERT INTO nodix_rem_pair_claims(
					generation_id, pair_id, claim_token, holder_pid, holder_process_start,
					holder_boot_id, claimed_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.generationId,
				pair.pair_id,
				input.invocationId,
				input.holderPid,
				holderProcessStart,
				holderBootId,
				input.claimedAt,
			);
		return {
			pairId: pair.pair_id,
			leftRowId: pair.left_row_id,
			rightRowId: pair.right_row_id,
		};
	}).immediate() as ReturnType<RemRepository["claimNextPair"]>;
}

function completePair(
	database: RemDatabaseLike,
	input: { generationId: string; pairId: string; invocationId: string },
): void {
	database.transaction(() => {
		const result = asRunResult(
			database
				.prepare(
					`UPDATE nodix_rem_scan_pairs SET claim_state = 'done', progress_state = 'closed'
					WHERE generation_id = ? AND pair_id = ? AND claim_state = 'claimed'
						AND invocation_id = ?`,
				)
				.run(input.generationId, input.pairId, input.invocationId),
		);
		if (result.changes !== 1) throw new Error("pair is not owned by invocation");
		const lifecycle = asRunResult(
			database
				.prepare(
					`UPDATE nodix_rem_pair_claims SET state = 'completed', completed_at = CURRENT_TIMESTAMP
					WHERE generation_id = ? AND pair_id = ? AND claim_token = ? AND state = 'active'`,
				)
				.run(input.generationId, input.pairId, input.invocationId),
		);
		if (lifecycle.changes !== 1) throw new Error("pair claim has inconsistent durable state");
	}).immediate();
}

function refusePair(
	database: RemDatabaseLike,
	input: {
		generationId: string;
		pairId: string;
		invocationId: string;
		reason: string;
		jobId: string;
		jobType: RemOperationType;
	},
): { state: "refused" | "exhausted"; attemptCount: number } {
	if (input.reason.trim().length === 0) throw new Error("pair refusal requires a reason");
	assertJobIdentity(input.jobId, input.jobType);
	return database.transaction(() => {
		const pair = getPairRow(database, input.generationId, input.pairId);
		if (pair.claim_state !== "claimed" || pair.invocation_id !== input.invocationId) {
			throw new Error("pair is not owned by invocation");
		}
		const state = pair.attempt_count >= 3 ? "exhausted" : "refused";
		const update = asRunResult(
			database
				.prepare(
					`UPDATE nodix_rem_scan_pairs SET claim_state = 'done', progress_state = ?, refusal_reason = ?
					WHERE generation_id = ? AND pair_id = ? AND claim_state = 'claimed'
						AND invocation_id = ?`,
				)
				.run(state, input.reason, input.generationId, input.pairId, input.invocationId),
		);
		if (update.changes !== 1) throw new Error("pair is not owned by invocation");
		const lifecycle = asRunResult(
			database
				.prepare(
					`UPDATE nodix_rem_pair_claims SET state = 'completed', completed_at = CURRENT_TIMESTAMP
					WHERE generation_id = ? AND pair_id = ? AND claim_token = ? AND state = 'active'`,
				)
				.run(input.generationId, input.pairId, input.invocationId),
		);
		if (lifecycle.changes !== 1) throw new Error("pair claim has inconsistent durable state");
		// Unconditional. This append used to depend on a caller remembering two optional arguments,
		// and the one call site that forgot them handled the contention refusals — so the only
		// refusals with no ledger row were the ones that meant a write had been abandoned.
		appendJournal(database, input.jobId, input.jobType, {
			stage: `replace-pair:${input.pairId}`,
			outcome: "refused",
			pairsScanned: 1,
			verdicts: 1,
			actionsApplied: 0,
			reason: input.reason,
			pairId: input.pairId,
		});
		return { state, attemptCount: pair.attempt_count };
	}).immediate() as ReturnType<RemRepository["refusePair"]>;
}

function reserveLlmBudget(
	database: RemDatabaseLike,
	input: {
		generationId: string;
		pairId: string;
		invocationId: string;
		stage: string;
		prompt: string;
		outputTokenCap: number;
		providerUsage?: { inputTokens: number; outputTokens: number };
		countTokens?: (text: string) => number;
	},
): BudgetReservation {
	const result = database.transaction((): BudgetReservation => {
		const pair = getPairRow(database, input.generationId, input.pairId);
		if (pair.claim_state !== "claimed" || pair.invocation_id !== input.invocationId) {
			throw new Error("budget pair is not owned by invocation");
		}
		const holder = getPairClaim(database, input.generationId, input.pairId);
		if (holder.state !== "active" || holder.claim_token !== input.invocationId) {
			throw new Error("budget pair has inconsistent durable claim");
		}
		const existingStage = database
			.prepare(
				`SELECT reserved_tokens, idempotency_key FROM nodix_rem_pair_stage_budgets
				WHERE generation_id = ? AND pair_id = ? AND stage = ?`,
			)
			.get(input.generationId, input.pairId, input.stage) as
			| { reserved_tokens: number; idempotency_key: string }
			| undefined;
		if (existingStage !== undefined) {
			return {
				status: "reserved",
				tokens: existingStage.reserved_tokens,
				idempotencyKey: existingStage.idempotency_key,
			};
		}
		if (!Number.isSafeInteger(input.outputTokenCap) || input.outputTokenCap < 0) {
			throw new Error("output token cap must be a non-negative safe integer");
		}
		let tokens: number;
		if (input.providerUsage) {
			tokens = input.providerUsage.inputTokens + input.providerUsage.outputTokens;
		} else if (input.countTokens) {
			tokens = input.countTokens(input.prompt) + input.outputTokenCap;
		} else {
			persistPendingStage(database, input.generationId, input.stage);
			return { status: "pending", reason: "tokenizer_unavailable" };
		}
		// Accounting, not a gate. The two ceilings this statement used to test against
		// (`max_llm_calls`, `max_tokens`) were guessed, and the token one refused the very first
		// call of every wave, because a reservation costs a fixed output allowance larger than the
		// whole configured budget. The counters stay — they are what the wave reports — and the
		// generation columns now record what a wave was expected to need rather than capping it.
		const reservation = asRunResult(
			database
				.prepare(
					`UPDATE nodix_rem_scan_invocations
					SET llm_calls_used = llm_calls_used + 1, tokens_used = tokens_used + ?
					WHERE generation_id = ? AND invocation_id = ?`,
				)
				.run(tokens, input.generationId, input.invocationId),
		);
		if (reservation.changes === 1) {
			database
				.prepare(
					`UPDATE nodix_rem_scan_generations
					SET llm_calls_used = llm_calls_used + 1, tokens_used = tokens_used + ?
					WHERE generation_id = ?`,
				)
				.run(tokens, input.generationId);
			const idempotencyKey = `${holder.claim_token}:${input.stage}`;
			database.prepare(
				`INSERT INTO nodix_rem_pair_stage_budgets(
					generation_id, pair_id, stage, invocation_id, reserved_tokens, idempotency_key
				) VALUES (?, ?, ?, ?, ?, ?)`,
			).run(
				input.generationId,
				input.pairId,
				input.stage,
				input.invocationId,
				tokens,
				idempotencyKey,
			);
			return { status: "reserved", tokens, idempotencyKey };
		}
		// The statement above no longer tests any ceiling, so the only way it updates nothing is a
		// missing invocation row — a real failure, and one worth naming as itself rather than as a
		// budget that was not consulted.
		persistPendingStage(database, input.generationId, input.stage);
		return { status: "pending", reason: "invocation_row_missing" };
	}).immediate();
	return parseBudgetReservation(result);
}

function readGeneration(
	database: RemDatabaseLike,
	generationId: string,
): {
	generationId: string;
	pendingStages: string[];
	llmCallsUsed: number;
	tokensUsed: number;
} {
	const row = getGenerationRow(database, generationId);
	return {
		generationId: row.generation_id,
		pendingStages: parsePendingStages(row.pending_stages_json),
		llmCallsUsed: row.llm_calls_used,
		tokensUsed: row.tokens_used,
	};
}

function readInvocation(
	database: RemDatabaseLike,
	input: { generationId: string; invocationId: string },
): { llmCallsUsed: number; tokensUsed: number } {
	const row = getInvocationRow(database, input.generationId, input.invocationId);
	return { llmCallsUsed: row.llm_calls_used, tokensUsed: row.tokens_used };
}

function appendJournal(
	database: RemDatabaseLike,
	jobId: string,
	jobType: RemOperationType,
	entry: JournalEntry,
): void {
	database
		.prepare(
			`INSERT INTO nodix_rem_journal(
				job_id, job_type, stage, outcome, pairs_scanned, verdicts, actions_applied, reason,
				detail, row_id, pair_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			jobId,
			jobType,
			entry.stage,
			entry.outcome,
			entry.pairsScanned,
			entry.verdicts,
			entry.actionsApplied,
			entry.reason ?? null,
			entry.detail ?? null,
			entry.rowId ?? null,
			entry.pairId ?? null,
		);
}

function listJournal(
	database: RemDatabaseLike,
	jobId: string,
	jobType?: RemOperationType,
): JournalEntry[] {
	const operationFilter = jobType === undefined ? "" : " AND job_type = ?";
	const parameters = jobType === undefined ? [jobId] : [jobId, jobType];
	const rows = database
		.prepare(
			`SELECT stage, outcome, pairs_scanned, verdicts, actions_applied, reason, detail,
				row_id, pair_id
			FROM nodix_rem_journal WHERE job_id = ?${operationFilter} ORDER BY sequence`,
		)
		.all(...parameters) as Array<{
		stage: string;
		outcome: JournalEntry["outcome"];
		pairs_scanned: number;
		verdicts: number;
		actions_applied: number;
		reason: string | null;
		detail: string | null;
		row_id: string | null;
		pair_id: string | null;
	}>;
	return rows.map((row) => ({
		stage: row.stage,
		outcome: row.outcome,
		pairsScanned: row.pairs_scanned,
		verdicts: row.verdicts,
		actionsApplied: row.actions_applied,
		...(row.reason === null ? {} : { reason: row.reason }),
		...(row.detail === null ? {} : { detail: row.detail }),
		...(row.row_id === null ? {} : { rowId: row.row_id }),
		...(row.pair_id === null ? {} : { pairId: row.pair_id }),
	}));
}

function recordVerdictCheckpoint(
	database: RemDatabaseLike,
	input: {
		generationId: string;
		pairId: string;
		invocationId: string;
		checkpoint: RemVerdictCheckpoint;
		recordedAt: string;
		verdict?: string;
	},
): void {
	if (
		input.verdict !== undefined &&
		input.verdict !== "keep" &&
		input.verdict !== "replacement" &&
		input.verdict !== "uncertain"
	) {
		throw new Error("verdict must be keep, replacement, or uncertain");
	}
	const result = asRunResult(
		database
			.prepare(
				`UPDATE nodix_rem_scan_pairs SET
					claimed_at = ?,
					checkpoint = ?,
					verdict = COALESCE(?, verdict),
					actions_applied = CASE
						WHEN ? = 'action_applied' THEN 1
						ELSE actions_applied
					END
				WHERE generation_id = ? AND pair_id = ? AND claim_state = 'claimed'
					AND invocation_id = ?
					AND CASE checkpoint
						WHEN 'action_applied' THEN 3
						WHEN 'verdict_recorded' THEN 2
						WHEN 'before_llm' THEN 1
						ELSE 0
					END <= CASE ?
						WHEN 'action_applied' THEN 3
						WHEN 'verdict_recorded' THEN 2
						WHEN 'before_llm' THEN 1
						ELSE 0
					END`,
			)
			.run(
				input.recordedAt,
				input.checkpoint,
				input.verdict ?? null,
				input.checkpoint,
				input.generationId,
				input.pairId,
				input.invocationId,
				input.checkpoint,
			),
	);
	if (result.changes !== 1) throw new Error("verdict pair is not owned by invocation");
}

function resumeVerdictPair(
	database: RemDatabaseLike,
	input: {
		generationId: string;
		pairId: string;
		expectedInvocationId: string;
		invocationId: string;
		resumedAt: string;
		holderPid: number;
	},
): ReturnType<RemRepository["resumeVerdictPair"]> {
	const holderProcessStart = requireProcessStart(input.holderPid);
	const holderBootId = requireBootId();
	const pair = getPairRow(database, input.generationId, input.pairId);
	const holder = getPairClaim(database, input.generationId, input.pairId);
	if (
		pair.claim_state !== "claimed" ||
		pair.invocation_id !== input.expectedInvocationId ||
		holder.state !== "active" ||
		holder.claim_token !== input.expectedInvocationId
	) {
		throw new Error("verdict pair is not owned by invocation");
	}
	const callerIsHolder =
		holder.holder_pid === input.holderPid &&
		holder.holder_process_start === holderProcessStart &&
		holder.holder_boot_id === holderBootId;
	if (
		!callerIsHolder &&
		isExactProcessAlive(
			holder.holder_pid,
			holder.holder_process_start,
			holder.holder_boot_id,
			holderBootId,
		)
	) {
		return { next: "refused", reason: "holder_alive" };
	}
	const claimToken = input.invocationId;
	return database.transaction(() => {
		ensureInvocation(database, input.generationId, claimToken, input.resumedAt);
		const pairUpdate = asRunResult(
			database
				.prepare(
					`UPDATE nodix_rem_scan_pairs SET invocation_id = ?, claimed_at = ?
					WHERE generation_id = ? AND pair_id = ? AND claim_state = 'claimed'
						AND invocation_id = ?`,
				)
				.run(
					claimToken,
					input.resumedAt,
					input.generationId,
					input.pairId,
					input.expectedInvocationId,
				),
		);
		if (pairUpdate.changes !== 1) throw new Error("verdict pair is not owned by invocation");
		const holderUpdate = asRunResult(
			database
				.prepare(
					`UPDATE nodix_rem_pair_claims SET
						claim_token = ?, holder_pid = ?, holder_process_start = ?,
						holder_boot_id = ?, claimed_at = ?
					WHERE generation_id = ? AND pair_id = ? AND state = 'active'
						AND claim_token = ? AND holder_pid = ? AND holder_process_start = ?
						AND holder_boot_id IS ?`,
				)
				.run(
					claimToken,
					input.holderPid,
					holderProcessStart,
					holderBootId,
					input.resumedAt,
					input.generationId,
					input.pairId,
					input.expectedInvocationId,
					holder.holder_pid,
					holder.holder_process_start,
					holder.holder_boot_id,
				),
		);
		if (holderUpdate.changes !== 1) {
			throw new Error("verdict pair has inconsistent durable claim");
		}
		const resumed = getPairRow(database, input.generationId, input.pairId);
		if (resumed.checkpoint === "action_applied") return { next: "complete", claimToken };
		if (resumed.checkpoint === "verdict_recorded") {
			if (!resumed.verdict) throw new Error("recorded verdict is missing");
			return { next: "apply_action", verdict: resumed.verdict, claimToken };
		}
		return { next: "call_llm", claimToken };
	}).immediate() as ReturnType<RemRepository["resumeVerdictPair"]>;
}

function readVerdictPair(
	database: RemDatabaseLike,
	generationId: string,
	pairId: string,
): { checkpoint: RemVerdictCheckpoint | null; actionsApplied: number } {
	const pair = getPairRow(database, generationId, pairId);
	return { checkpoint: pair.checkpoint, actionsApplied: pair.actions_applied };
}

function getGenerationRow(database: RemDatabaseLike, generationId: string): GenerationRow {
	const row = database
		.prepare("SELECT * FROM nodix_rem_scan_generations WHERE generation_id = ?")
		.get(generationId) as GenerationRow | undefined;
	if (!row) throw new Error("scan generation not found");
	return row;
}

function ensureInvocation(
	database: RemDatabaseLike,
	generationId: string,
	invocationId: string,
	createdAt: string,
): void {
	database
		.prepare(
			`INSERT INTO nodix_rem_scan_invocations(generation_id, invocation_id, created_at)
			VALUES (?, ?, ?) ON CONFLICT(generation_id, invocation_id) DO NOTHING`,
		)
		.run(generationId, invocationId, createdAt);
}

function getInvocationRow(
	database: RemDatabaseLike,
	generationId: string,
	invocationId: string,
): InvocationRow {
	const row = database
		.prepare(
			`SELECT llm_calls_used, tokens_used FROM nodix_rem_scan_invocations
			WHERE generation_id = ? AND invocation_id = ?`,
		)
		.get(generationId, invocationId) as InvocationRow | undefined;
	if (!row) throw new Error("scan invocation not found");
	return row;
}

function getPairRow(
	database: RemDatabaseLike,
	generationId: string,
	pairId: string,
): PairRow {
	const row = database
		.prepare(
			`SELECT pair_id, left_row_id, right_row_id, sort_key, checkpoint, verdict,
				actions_applied, claim_state, invocation_id, budget_reserved, budget_invocation_id,
				reserved_tokens, attempt_count, progress_state, refusal_reason, inherited_from_generation_id
			FROM nodix_rem_scan_pairs WHERE generation_id = ? AND pair_id = ?`,
		)
		.get(generationId, pairId) as PairRow | undefined;
	if (!row) throw new Error("verdict pair not found");
	return row;
}

function getPairClaim(
	database: RemDatabaseLike,
	generationId: string,
	pairId: string,
): PairClaimRow {
	const row = database
		.prepare(
			`SELECT claim_token, holder_pid, holder_process_start, holder_boot_id, state
			FROM nodix_rem_pair_claims WHERE generation_id = ? AND pair_id = ?`,
		)
		.get(generationId, pairId) as PairClaimRow | undefined;
	if (!row) throw new Error("verdict pair has inconsistent durable claim");
	return row;
}

function getRowClaim(database: RemDatabaseLike, rowId: string): RowClaimRow {
	const row = database
		.prepare(
			`SELECT content_hash, owner, claim_token, holder_pid, holder_process_start,
				holder_boot_id, state
			FROM nodix_rem_row_claims WHERE row_id = ?`,
		)
		.get(rowId) as RowClaimRow | undefined;
	if (!row) throw new Error("row claim has inconsistent durable state");
	return row;
}

function inspectRowClaim(
	database: RemDatabaseLike,
	input: {
		rowId: string;
		contentHash: string;
		owner: Exclude<RemOwner, "none">;
		expectedClaimToken: string;
		expectedMemoryContentHash?: string;
	},
): Exclude<RowClaimRefusalReason, "holder_alive"> | undefined {
	const ownershipRefusal = inspectRowClaimOwnership(database, input);
	if (ownershipRefusal) return ownershipRefusal;
	const memory = database
		.prepare("SELECT content_hash FROM nodix_memories WHERE id = ?")
		.get(input.rowId) as MemoryHashRow | undefined;
	if (!memory) return "missing";
	if (memory.content_hash !== (input.expectedMemoryContentHash ?? input.contentHash)) {
		return "content_changed";
	}
	return undefined;
}

function inspectRowClaimOwnership(
	database: RemDatabaseLike,
	input: {
		rowId: string;
		contentHash: string;
		owner: Exclude<RemOwner, "none">;
		expectedClaimToken: string;
	},
): Exclude<RowClaimRefusalReason, "content_changed" | "content_changed_released" | "holder_alive"> | undefined {
	const ledger = database
		.prepare("SELECT content_hash, owner FROM nodix_rem_relation_ledger WHERE row_id = ?")
		.get(input.rowId) as LedgerRow | undefined;
	if (!ledger) return "missing";
	if (ledger.content_hash !== input.contentHash) return "inconsistent_state";
	const claim = database
		.prepare(
			`SELECT content_hash, owner, claim_token, holder_pid, holder_process_start,
				holder_boot_id, state
			FROM nodix_rem_row_claims WHERE row_id = ?`,
		)
		.get(input.rowId) as RowClaimRow | undefined;
	if (!claim) return ledger.owner === "none" ? "claim_changed" : "inconsistent_state";
	if (
		claim.claim_token !== input.expectedClaimToken ||
		claim.content_hash !== input.contentHash ||
		claim.owner !== input.owner ||
		claim.state !== "active"
	) {
		return "claim_changed";
	}
	if (ledger.owner !== input.owner) return "inconsistent_state";
	return undefined;
}

function requireProcessStart(pid: number): string {
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("holder pid must be positive");
	const marker = readProcessStart(pid);
	if (!marker) throw new Error("holder process is not running");
	return marker;
}

function isExactProcessAlive(
	pid: number,
	expectedStart: string,
	expectedBootId: string | null,
	currentBootId: string,
): boolean {
	if (expectedBootId !== currentBootId) return false;
	const processStat = readProcessStat(pid);
	return (
		processStat !== undefined &&
		processStat.start === expectedStart &&
		processStat.state !== "Z" &&
		processStat.state !== "X" &&
		processStat.state !== "x"
	);
}

function readProcessStart(pid: number): string | undefined {
	return readProcessStat(pid)?.start;
}

function readProcessStat(pid: number): { state: string; start: string } | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
		const state = fields[0];
		const start = fields[19];
		if (!state) throw new Error(`process ${pid} stat is missing its state`);
		if (!start) throw new Error(`process ${pid} stat is missing its start marker`);
		return { state, start };
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "ESRCH")
		) {
			return undefined;
		}
		throw error;
	}
}

function requireBootId(): string {
	const bootId = readFileSync(bootIdPath, "utf8").trim();
	if (!bootId) throw new Error("kernel boot id is empty");
	return bootId;
}

function persistPendingStage(
	database: RemDatabaseLike,
	generationId: string,
	stage: string,
): void {
	const row = getGenerationRow(database, generationId);
	const pending = new Set(parsePendingStages(row.pending_stages_json));
	pending.add(stage);
	database
		.prepare(
			"UPDATE nodix_rem_scan_generations SET pending_stages_json = ? WHERE generation_id = ?",
		)
		.run(JSON.stringify(Array.from(pending)), generationId);
}

function parsePendingStages(value: string): string[] {
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
		throw new Error("invalid pending stage record");
	}
	return parsed;
}

function asRunResult(value: unknown): RunResult {
	if (
		typeof value !== "object" ||
		value === null ||
		!("changes" in value) ||
		typeof value.changes !== "number"
	) {
		throw new Error("database run result is missing changes");
	}
	return { changes: value.changes };
}

function parseBudgetReservation(value: unknown): BudgetReservation {
	if (typeof value !== "object" || value === null || !("status" in value)) {
		throw new Error("budget transaction returned an invalid result");
	}
	if (
		value.status === "reserved" &&
		"tokens" in value &&
		typeof value.tokens === "number" &&
		"idempotencyKey" in value &&
		typeof value.idempotencyKey === "string"
	) {
		return {
			status: "reserved",
			tokens: value.tokens,
			idempotencyKey: value.idempotencyKey,
		};
	}
	if (
		value.status === "pending" &&
		"reason" in value &&
		(value.reason === "invocation_row_missing" || value.reason === "tokenizer_unavailable")
	) {
		return { status: "pending", reason: value.reason };
	}
	throw new Error("budget transaction returned an invalid result");
}
