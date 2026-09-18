import { FIXED_PROTOCOL_VALUE_73 } from "../model/signed-registry-constants";
/** @file memory-store-atomic-extraction-write-api.ts
 * @purpose Appends atomic extraction cards, relations, chunks, and ledger completion together.
 * @boundary Dark atomic-v3 storage door only; no model calls, suppression, or cutover activation.
 */

import { deriveRemWriteIdentity } from "../engine/rem/index.js";
import { ARRIVAL_RETIREMENT_CANDIDATE_CAP } from "../../config/index";
import {
	type AtomicExtractionWriteCard,
	type AtomicExtractionWriteInput,
	type AtomicExtractionWriteResult,
	MemoryStore,
	type MemoryStoreInternals,
} from "./memory-store-base";
import { randomUUID, stableHash, StorageError } from "./memory-store-shared";
import { hashMemorySuppressionContent } from "./memory-store-suppression-api";
import { assertRecordWithinTokenCeiling, recordTokenCounter, validateAtomicCardWrite } from "./memory-store-write-validation";
import {
	closeMemoryRow,
	sameSourceTurn,
	compareMemorySourceOrder,
	type MemorySourceOrder,
	readMemorySourceOrder,
	readMemorySourceOrderOrOldest,
} from "./memory-source-order";
import {
	atomicAttributeFamily,
	isKnownAtomicAttribute,
	isOneCardinalityAttribute,
} from "./atomic-attribute-cardinality";

export interface PreparedAtomicCard {
	id: string;
	card: AtomicExtractionWriteCard;
	metadata: string;
	contentHash: string;
	chunks: Awaited<ReturnType<MemoryStoreInternals["prepareChunkInserts"]>>;
}

function assertNonEmpty(value: string, name: string): void {
	if (!value.trim()) throw new StorageError(`${name} must not be empty`);
}

function assertOptionalTimestamp(value: number | null, name: string): void {
	if (value !== null && !Number.isSafeInteger(value)) {
		throw new StorageError(`${name} must be a safe integer or null`);
	}
}

function validateCard(
	card: AtomicExtractionWriteCard,
	countRecordTokens: (text: string) => number,
): void {
	validateAtomicCardWrite(card);
	assertRecordWithinTokenCeiling(card.text, countRecordTokens, "storeAtomicExtractionChunk");
	assertNonEmpty(card.idempotencyKey, "Atomic card idempotencyKey");
	if (!Number.isSafeInteger(card.globalTurnIndex) || card.globalTurnIndex < 0) {
		throw new StorageError("Atomic card globalTurnIndex must be a non-negative safe integer");
	}
	assertNonEmpty(card.text, "Atomic card text");
	assertNonEmpty(card.timezone, "Atomic card timezone");
	if (!Number.isFinite(card.importance) || card.importance < 0 || card.importance > 1) {
		throw new StorageError("Atomic card importance must be between 0 and 1");
	}
	// Signed on purpose: this is when the remembered thing happened, and a user stating a birth
	// year before 1970 is ordinary. A non-negative rule here would throw on that record and take
	// the whole chunk's unrelated memories down with it. `validFrom` next to it is signed too.
	if (!Number.isSafeInteger(card.timestamp)) {
		throw new StorageError("Atomic card timestamp must be a safe integer");
	}
	assertOptionalTimestamp(card.validFrom, "Atomic card validFrom");
	assertOptionalTimestamp(card.validUntil, "Atomic card validUntil");
	assertOptionalTimestamp(card.endedAt, "Atomic card endedAt");
	if (!card.endsCurrent && card.endedAt !== null) {
		throw new StorageError("Atomic card endedAt requires endsCurrent");
	}
	if (
		card.validFrom !== null &&
		card.validUntil !== null &&
		card.validUntil <= card.validFrom
	) {
		throw new StorageError("Atomic card validUntil must be greater than validFrom");
	}
	if ((card.lane === "active") !== (card.dispositionReason === null)) {
		throw new StorageError("Atomic card lane and dispositionReason disagree");
	}
	// Parked and replayable, or active and untouched — never one without the other. An absent
	// value counts as "no record": REM reads this column on active rows as substring evidence.
	if (card.lane === "parked") {
		assertNonEmpty(card.rawCandidateJson ?? "", "Atomic card rawCandidateJson");
	} else if (card.rawCandidateJson != null) {
		throw new StorageError("Atomic card rawCandidateJson must be empty on an active row");
	}
}

function buildMetadata(card: AtomicExtractionWriteCard): string {
	return JSON.stringify({ ...(card.metadata ?? {}), idempotency_key: card.idempotencyKey });
}

async function prepareCards(
	store: MemoryStoreInternals,
	input: AtomicExtractionWriteInput,
): Promise<PreparedAtomicCard[]> {
	return Promise.all(
		input.cards.map(async (card) => {
			validateCard(card, await recordTokenCounter(store.embedder));
			const id = randomUUID();
			const metadata = buildMetadata(card);
			const contentHash = stableHash(
				JSON.stringify([
					FIXED_PROTOCOL_VALUE_73,
					input.projectId,
					card.idempotencyKey,
					card.text,
					card.category,
				]),
			);
			return {
				id,
				card,
				metadata,
				contentHash,
				chunks: await store.prepareChunkInserts(id, card.text),
			};
		}),
	);
}

export async function prepareAtomicExtractionWrite(
	store: MemoryStoreInternals,
	input: AtomicExtractionWriteInput,
): Promise<PreparedAtomicCard[]> {
	assertNonEmpty(input.projectId, "Atomic extraction projectId");
	assertNonEmpty(input.extractorVersion, "Atomic extraction extractorVersion");
	if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
		throw new StorageError("Atomic extraction nowMs must be a non-negative safe integer");
	}
	return prepareCards(store, input);
}

/**
 * A key that already exists is an identity defect, never a replay: the ledger refuses a chunk it
 * has completed, and a chunk's rows and its `complete` flag commit in one transaction, so no
 * legitimate path presents a written key twice. Mapping the new card onto the old row used to
 * hide exactly that defect (2026-09-06: 28 records lost across five personas, each counted as
 * "skipped"). Throwing inside the transaction rolls the window back and fails the ingest loudly.
 */
function assertKeyUnwritten(
	store: MemoryStoreInternals,
	projectId: string,
	idempotencyKey: string,
): void {
	const existing = store.sqlite
		.prepare(
			"SELECT id FROM nodix_memories WHERE project_id = ? AND json_valid(metadata) AND json_extract(metadata, '$.idempotency_key') = ? LIMIT 1",
		)
		.get(projectId, idempotencyKey) as { id: string } | undefined;
	if (existing) {
		throw new StorageError(
			`Atomic extraction idempotency key already written by memory ${existing.id}`,
		);
	}
}

function suppressionReason(
	store: MemoryStoreInternals,
	projectId: string,
	card: AtomicExtractionWriteCard,
): "key-suppressed" | "content-suppressed" | undefined {
	if (card.subject && card.attribute) {
		const keyMatch = store.sqlite
			.prepare(
				"SELECT 1 FROM nodix_memory_suppressions WHERE project_id = ? AND subject = ? AND attribute = ? LIMIT 1",
			)
			.get(projectId, card.subject, card.attribute);
		if (keyMatch) return "key-suppressed";
	}
	const contentMatch = store.sqlite
		.prepare(
			"SELECT 1 FROM nodix_memory_suppressions WHERE project_id = ? AND content_hash = ? LIMIT 1",
		)
		.get(projectId, hashMemorySuppressionContent(card.text));
	return contentMatch ? "content-suppressed" : undefined;
}

function insertCard(
	store: MemoryStoreInternals,
	input: AtomicExtractionWriteInput,
	prepared: PreparedAtomicCard,
	sessionOrdinal: number,
): MemorySourceOrder {
	const { card } = prepared;
	store.sqlite
		.prepare(
			"INSERT INTO nodix_memories(id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id, lane, disposition_reason, dispositioned_at_ms, raw_candidate_json, subject, attribute, valid_from, valid_until, maturity, source, extractor_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'extracted', 'edge', ?)",
		)
		.run(
			prepared.id,
			card.text,
			card.category,
			input.projectId,
			card.importance,
			card.timestamp,
			card.timezone,
			prepared.metadata,
			prepared.contentHash,
			prepared.id,
			card.lane,
			card.dispositionReason,
			card.dispositionReason === null ? null : input.nowMs,
			card.rawCandidateJson,
			card.subject,
			card.attribute,
			card.validFrom,
			card.validUntil,
			input.extractorVersion,
		);
	const inserted = store.sqlite
		.prepare("SELECT rowid FROM nodix_memories WHERE id = ?")
		.get(prepared.id) as { rowid: number } | undefined;
	if (!inserted || !Number.isSafeInteger(inserted.rowid)) {
		throw new StorageError("Atomic card insert did not return a rowid");
	}
	const sourceOrder: MemorySourceOrder = {
		valid_from: card.validFrom,
		// The row's session moment: `valid_from` when the model resolved a date, else the session's
		// own time. `card.timestamp` already holds exactly that, and it is the order fallback the
		// comparator uses when `valid_from` is null.
		session_moment: card.timestamp,
		session_ordinal: sessionOrdinal,
		global_turn_index: card.globalTurnIndex,
		rowid: inserted.rowid,
		conversation_id: input.ledgerKey.conversationId,
	};
	const metadata = JSON.stringify({
		...(card.metadata ?? {}),
		idempotency_key: card.idempotencyKey,
		source_order: sourceOrder,
	});
	store.sqlite
		.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?")
		.run(metadata, prepared.id);
	store.sqlite
		.prepare("INSERT INTO nodix_rem_census_rows(row_id, write_identity_sha256) VALUES (?, ?)")
		.run(
			prepared.id,
			// The row's own timestamp, not the write clock: this identity names a row, and the
			// same row replayed from the same conversation must name itself the same way.
			deriveRemWriteIdentity({
				rowId: prepared.id,
				text: card.text,
				contentHash: prepared.contentHash,
				timestamp: card.timestamp,
			}),
		);
	store.writeChunkRowsSync(prepared.chunks, input.projectId);
	const insertRelation = store.sqlite.prepare(
		"INSERT INTO nodix_memory_relations(source_card_id, subject, predicate, object, created_at) VALUES (?, ?, ?, ?, ?)",
	);
	for (const relation of card.relations) {
		insertRelation.run(
			prepared.id,
			relation.subject,
			relation.predicate,
			relation.object,
			input.nowMs,
		);
	}
	return sourceOrder;
}

function journalRefusedAttribute(
	store: MemoryStoreInternals,
	input: AtomicExtractionWriteInput,
	prepared: PreparedAtomicCard,
): void {
	const refusedAttribute = prepared.card.refusedAttribute;
	if (refusedAttribute === undefined) return;
	store.sqlite
		.prepare(`
			INSERT INTO nodix_rem_journal(
				job_id, job_type, stage, outcome, row_id, actions_applied, reason, detail
			) VALUES (?, 'atomic-extraction', 'write', 'refused', ?, 0, ?, ?)
		`)
		.run(
			input.ledgerKey.conversationId,
			prepared.id,
			isKnownAtomicAttribute(refusedAttribute)
				? "attribute_not_allowed_for_subject_kind"
				: "attribute_not_in_vocabulary",
			JSON.stringify({ refusedAttribute }),
		);
}

function sessionOrdinal(store: MemoryStoreInternals, conversationId: string): number {
	const row = store.sqlite
		.prepare(`
			WITH conversation_first_write AS (
				SELECT conversation_id, MIN(created_at) AS first_created_at
				FROM nodix_atomic_extraction_ledger
				GROUP BY conversation_id
			), current_conversation AS (
				SELECT first_created_at
				FROM conversation_first_write
				WHERE conversation_id = ?
			)
			SELECT COUNT(*) AS count
			FROM conversation_first_write, current_conversation
			WHERE conversation_first_write.first_created_at < current_conversation.first_created_at
				OR (
					conversation_first_write.first_created_at = current_conversation.first_created_at
					AND conversation_first_write.conversation_id < ?
				)
		`)
		.get(conversationId, conversationId) as { count: number } | undefined;
	if (!row || !Number.isSafeInteger(row.count)) {
		throw new StorageError("Atomic extraction ledger has no conversation ordinal");
	}
	return row.count;
}

interface OpenGroupRow {
	id: string;
	metadata: string;
	validFrom: number | null;
}

function openGroupRows(
	store: MemoryStoreInternals,
	input: AtomicExtractionWriteInput,
	prepared: PreparedAtomicCard,
): OpenGroupRow[] {
	const { card } = prepared;
	if (card.lane !== "active" || card.subject === null || card.attribute === null) return [];
	const eventGuard = card.category === "episodic" ? " AND valid_from IS ?" : "";
	const parameters: unknown[] = [
		input.projectId,
		card.category,
		card.subject,
		card.attribute,
		prepared.id,
	];
	if (card.category === "episodic") parameters.push(card.validFrom);
	const rows = store.sqlite
		.prepare(`
			SELECT id, metadata, valid_from AS validFrom
			FROM nodix_memories
			WHERE project_id = ? AND category = ? AND subject = ? AND attribute = ?
				AND id != ? AND lane = 'active'${eventGuard}
		`)
		.all(...parameters) as OpenGroupRow[];
	return rows
		.filter((row) => {
			const metadata: unknown = JSON.parse(row.metadata);
			return (
				typeof metadata === "object" &&
				metadata !== null &&
				(!("superseded_by" in metadata) || metadata.superseded_by === null)
			);
		})
		.sort((left, right) =>
			compareMemorySourceOrder(
				readMemorySourceOrderOrOldest(right.metadata),
				readMemorySourceOrderOrOldest(left.metadata),
			),
		);
}

function journalCloseOnArrival(
	store: MemoryStoreInternals,
	input: AtomicExtractionWriteInput,
	prepared: PreparedAtomicCard,
	outcome: "done" | "no-action",
	actionsApplied: 0 | 1,
	reason: string,
): void {
	store.sqlite
		.prepare(`
			INSERT INTO nodix_rem_journal(
				job_id, job_type, stage, outcome, row_id, actions_applied, reason
			) VALUES (?, 'atomic-extraction', 'write', ?, ?, ?, ?)
		`)
		.run(
			input.ledgerKey.conversationId,
			outcome,
			prepared.id,
			actionsApplied,
			reason,
		);
}

function closeOlderOpenGroupRows(
	store: MemoryStoreInternals,
	input: AtomicExtractionWriteInput,
	prepared: PreparedAtomicCard,
	order: MemorySourceOrder,
	openRows: readonly OpenGroupRow[],
): number {
	let closedCount = 0;
	for (const current of openRows) {
		let changed = false;
		try {
			changed = closeMemoryRow(store.sqlite, {
				targetRowId: current.id,
				closingRowId: prepared.id,
				closingOrder: order,
				closingValidFrom: prepared.card.validFrom,
				supersededAt: input.nowMs,
			});
		} catch {
			changed = false;
		}
		if (changed) closedCount += 1;
		journalCloseOnArrival(
			store,
			input,
			prepared,
			changed ? "done" : "no-action",
			changed ? 1 : 0,
			`closed_on_arrival_forward:${current.id}`,
		);
	}
	return closedCount;
}

function isFreshEntityCard(prepared: PreparedAtomicCard): boolean {
	const metadata: unknown = JSON.parse(prepared.metadata);
	return (
		typeof metadata === "object" &&
		metadata !== null &&
		"entity_identity_new" in metadata &&
		metadata.entity_identity_new === true
	);
}

function closeOnArrival(
	store: MemoryStoreInternals,
	input: AtomicExtractionWriteInput,
	prepared: PreparedAtomicCard,
	order: MemorySourceOrder,
): void {
	if (prepared.card.endsCurrent) return;
	if (!isOneCardinalityAttribute(prepared.card.attribute)) return;
	// A sibling from the same turn is neither the newest row that would close this one nor an
	// older row this one closes: the facets of one statement stay live together.
	const openRows = openGroupRows(store, input, prepared).filter(
		(row) => !sameSourceTurn(order, readMemorySourceOrderOrOldest(row.metadata)),
	);
	const newest = openRows[0];
	if (!newest) return;
	const newestOrder = readMemorySourceOrderOrOldest(newest.metadata);
	const comparison = compareMemorySourceOrder(order, newestOrder);
	if (comparison < 0) {
		closeMemoryRow(store.sqlite, {
			targetRowId: prepared.id,
			closingRowId: newest.id,
			closingOrder: newestOrder,
			closingValidFrom: newest.validFrom,
			supersededAt: input.nowMs,
			validUntilMode: "clear",
		});
		journalCloseOnArrival(
			store,
			input,
			prepared,
			"done",
			1,
			`closed_on_arrival:${newest.id}`,
		);
		return;
	}
	if (comparison === 0) return;
	// REQ-9: a row written under an entity minted in this same batch closes nothing mechanically.
	if (isFreshEntityCard(prepared)) return;
	const closedCount = closeOlderOpenGroupRows(store, input, prepared, order, openRows);
	if (closedCount > 0) {
		journalCloseOnArrival(store, input, prepared, "no-action", 0, "cardinality_one");
	}
}

interface ArrivalRetirementRow {
	id: string;
	text: string;
	category: AtomicExtractionWriteCard["category"];
	subject: string | null;
	attribute: string | null;
	metadata: string;
	validFrom: number | null;
}

export interface AtomicArrivalRetirementCandidateSet {
	nominatedRow: { id: string; text: string };
	candidateRows: Array<{ id: string; text: string }>;
}

type AtomicArrivalRetirementStore = Pick<
	MemoryStoreInternals,
	"sqlite" | "embedder" | "getVectorsByIds" | "writeMutex"
>;

function isOpenRow(row: ArrivalRetirementRow): boolean {
	const metadata: unknown = JSON.parse(row.metadata);
	return (
		typeof metadata === "object" &&
		metadata !== null &&
		(!("superseded_by" in metadata) || metadata.superseded_by === null)
	);
}

function isSelfClosedRow(row: ArrivalRetirementRow): boolean {
	const metadata: unknown = JSON.parse(row.metadata);
	return (
		typeof metadata === "object" &&
		metadata !== null &&
		"superseded_by" in metadata &&
		metadata.superseded_by === row.id
	);
}

function arrivalRetirementAttributeRank(
	nominatedRow: ArrivalRetirementRow,
	candidate: ArrivalRetirementRow,
): number {
	if (nominatedRow.attribute !== null && nominatedRow.attribute === candidate.attribute) return 0;
	const nominatedFamily = atomicAttributeFamily(nominatedRow.attribute);
	const candidateFamily = atomicAttributeFamily(candidate.attribute);
	if (nominatedFamily !== undefined && nominatedFamily === candidateFamily) return 1;
	return candidate.attribute === null ? 2 : 3;
}

function appendArrivalRetirementJournal(
	store: AtomicArrivalRetirementStore,
	input: {
		jobId: string;
		nominatedRowId: string;
		outcome: "done" | "refused" | "no-action";
		reason: string | null;
		actionsApplied: number;
		detail: Readonly<Record<string, unknown>>;
	},
): void {
	store.sqlite
		.prepare(`
			INSERT INTO nodix_rem_journal(
				job_id, job_type, stage, outcome, row_id, actions_applied, reason, detail
			) VALUES (?, 'atomic-extraction', ?, ?, ?, ?, ?, ?)
		`)
		.run(
			input.jobId,
			`arrival-retirement-target:${input.nominatedRowId}`,
			input.outcome,
			input.nominatedRowId,
			input.actionsApplied,
			input.reason,
			JSON.stringify(input.detail),
		);
}

/** Euclidean distance, the metric the chunk vector table (`vec0`, default L2) ranks by. */
function euclideanDistance(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < a.length; i += 1) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		sum += d * d;
	}
	return Math.sqrt(sum);
}

/**
 * The similarity of each candidate to the nominated text, scored over the candidate's OWN chunk
 * vectors — never a project-wide search that other subjects can crowd out. A memory takes its best
 * (nearest) chunk, and the score is the `1 / (1 + distance)` the semantic search reports, so the
 * ranking below is unchanged for a candidate the search would have scored. A candidate with no
 * stored vector is left unscored and falls to the bottom of its attribute-rank group, as before.
 */
export function scoreCandidatesBySimilarity(
	store: Pick<MemoryStoreInternals, "sqlite" | "getVectorsByIds">,
	nominatedVector: Float32Array,
	candidateIds: readonly string[],
): Map<string, number> {
	const chunkRows = store.sqlite
		.prepare(
			`SELECT chunk_id AS chunkId, memory_id AS memoryId
			 FROM nodix_memory_chunks
			 WHERE memory_id IN (SELECT value FROM json_each(?))`,
		)
		.all(JSON.stringify(candidateIds)) as Array<{
		chunkId: string;
		memoryId: string;
	}>;
	const vectors = store.getVectorsByIds(chunkRows.map((row) => row.chunkId));
	const scoreById = new Map<string, number>();
	for (const { chunkId, memoryId } of chunkRows) {
		const vector = vectors.get(chunkId);
		if (!vector) continue;
		const score = 1 / (1 + euclideanDistance(nominatedVector, vector));
		const previous = scoreById.get(memoryId);
		if (previous === undefined || score > previous) scoreById.set(memoryId, score);
	}
	return scoreById;
}

export async function readAtomicArrivalRetirementCandidateSet(
	store: AtomicArrivalRetirementStore,
	input: { projectId: string; nominatedRowId: string; jobId: string },
): Promise<AtomicArrivalRetirementCandidateSet | undefined> {
	const nominatedRow = store.sqlite
		.prepare(
			`SELECT id, text, category, subject, attribute, metadata, valid_from AS validFrom
			 FROM nodix_memories
			 WHERE project_id = ? AND id = ? AND lane = 'active'`,
		)
		.get(input.projectId, input.nominatedRowId) as ArrivalRetirementRow | undefined;
	if (
		!nominatedRow ||
		nominatedRow.subject === null ||
		!(isSelfClosedRow(nominatedRow) || isOpenRow(nominatedRow))
	) {
		return undefined;
	}
	const metadata = JSON.parse(nominatedRow.metadata) as Record<string, unknown>;
	if (metadata.entity_identity_new === true) {
		return { nominatedRow, candidateRows: [] };
	}
	const nominatedOrder = readMemorySourceOrder(nominatedRow.metadata);
	const candidates = (
		store.sqlite
			.prepare(
				`SELECT id, text, category, subject, attribute, metadata,
					valid_from AS validFrom
				 FROM nodix_memories
				 WHERE project_id = ? AND category = ? AND subject = ? AND id != ?
					AND lane = 'active' AND json_valid(metadata)`,
			)
			.all(
				input.projectId,
				nominatedRow.category,
				nominatedRow.subject,
				nominatedRow.id,
			) as ArrivalRetirementRow[]
	).filter((candidate) => {
		// A row from the ending's own turn is its companion (the replacement it states), never a
		// state it ends.
		const candidateOrder = readMemorySourceOrderOrOldest(candidate.metadata);
		return (
			isOpenRow(candidate) &&
			!sameSourceTurn(candidateOrder, nominatedOrder) &&
			compareMemorySourceOrder(candidateOrder, nominatedOrder) < 0
		);
	});
	if (candidates.length === 0) return { nominatedRow, candidateRows: [] };
	// Score the candidates DIRECTLY, not through a whole-project semantic search. The vector search
	// takes the project's top-k chunks by distance and only then joins back to a memory, so when the
	// project holds same-category rows under OTHER subjects that are closer to the nominated text,
	// they fill every slot and the real candidates get no score at all — and the cap then keeps an
	// arbitrary slice. Reading each candidate's own chunk vectors keeps every candidate's real
	// similarity, using the same `1 / (1 + distance)` the search reports.
	const nominatedVector = await store.embedder.embed(nominatedRow.text);
	const scoreById = scoreCandidatesBySimilarity(
		store,
		nominatedVector,
		candidates.map(({ id }) => id),
	);
	const ranked = candidates.sort(
		(left, right) =>
			arrivalRetirementAttributeRank(nominatedRow, left) -
				arrivalRetirementAttributeRank(nominatedRow, right) ||
			(scoreById.get(right.id) ?? Number.NEGATIVE_INFINITY) -
				(scoreById.get(left.id) ?? Number.NEGATIVE_INFINITY) ||
			left.id.localeCompare(right.id),
	);
	if (ranked.length > ARRIVAL_RETIREMENT_CANDIDATE_CAP) {
		appendArrivalRetirementJournal(store, {
			jobId: input.jobId,
			nominatedRowId: nominatedRow.id,
			outcome: "no-action",
			reason: "candidate_cap_truncated",
			actionsApplied: 0,
			detail: {
				nominatedRowId: nominatedRow.id,
				omittedCount: ranked.length - ARRIVAL_RETIREMENT_CANDIDATE_CAP,
			},
		});
	}
	return {
		nominatedRow,
		candidateRows: ranked
			.slice(0, ARRIVAL_RETIREMENT_CANDIDATE_CAP)
			.map(({ id, text }) => ({ id, text })),
	};
}

export function journalAtomicArrivalRetirementRefusal(
	store: AtomicArrivalRetirementStore,
	input: {
		jobId: string;
		nominatedRowId: string;
		reason: string;
		candidateSetSize: number;
	},
): void {
	appendArrivalRetirementJournal(store, {
		...input,
		outcome: "refused",
		actionsApplied: 0,
		detail: {
			nominatedRowId: input.nominatedRowId,
			candidateSetSize: input.candidateSetSize,
		},
	});
}

export async function closeAtomicArrivalRetirementTargets(
	store: AtomicArrivalRetirementStore,
	input: {
		jobId: string;
		nominatedRowId: string;
		targetRowIds: readonly string[];
		supersededAt: number;
	},
): Promise<void> {
	await store.writeMutex.runExclusive(() => {
		const nominatedRow = store.sqlite
			.prepare(
				`SELECT id, text, category, subject, attribute, metadata,
					valid_from AS validFrom
				 FROM nodix_memories WHERE id = ?`,
			)
			.get(input.nominatedRowId) as ArrivalRetirementRow | undefined;
		if (!nominatedRow) throw new StorageError("Arrival retirement nominated row does not exist");
		const closingOrder = readMemorySourceOrder(nominatedRow.metadata);
		// Without this row, "the judgement never ran" and "the judgement named nothing" look the
		// same in the store, so a miss cannot be counted.
		//
		if (input.targetRowIds.length === 0) {
			appendArrivalRetirementJournal(store, {
				jobId: input.jobId,
				nominatedRowId: nominatedRow.id,
				outcome: "no-action",
				reason: "no_target_named",
				actionsApplied: 0,
				detail: { nominatedRowId: nominatedRow.id },
			});
			return;
		}
		for (const targetRowId of input.targetRowIds) {
			let changed = false;
			try {
				changed = closeMemoryRow(store.sqlite, {
					targetRowId,
					closingRowId: nominatedRow.id,
					closingOrder,
					closingValidFrom: nominatedRow.validFrom,
					supersededAt: input.supersededAt,
				});
			} catch (error) {
				// A target closed by another write since the candidates were read: skip it, keep
				// closing the rest, never abort the batch half-applied.
				appendArrivalRetirementJournal(store, {
					jobId: input.jobId,
					nominatedRowId: nominatedRow.id,
					outcome: "no-action",
					reason: "target_close_failed",
					actionsApplied: 0,
					detail: {
						nominatedRowId: nominatedRow.id,
						targetRowId,
						error: error instanceof Error ? error.message : String(error),
					},
				});
				continue;
			}
			if (!changed) continue;
			appendArrivalRetirementJournal(store, {
				jobId: input.jobId,
				nominatedRowId: nominatedRow.id,
				outcome: "done",
				reason: null,
				actionsApplied: 1,
				detail: { nominatedRowId: nominatedRow.id, targetRowId },
			});
		}
	});
}

/**
 * An ended standing claim that is not a to-do closure is the current state — "no longer likes X",
 * "used to dislike Y, now likes it", "the recipients no longer include Z" — and stays live; its
 * arrival judgement closes the predecessors. Only a to-do closure and an ended occurrence close
 * themselves at create. Measured 2026-09-06 on Memora run f: three "never retrieved" preference
 * questions held only self-closed rows about the person asked about, so recall served nothing.
 * Measured again the same night on the weekly track: a removal from an e-mail's recipients that
 * closed itself was hidden from recall while the old recipient row stayed live, and the document
 * questions' forgetting accuracy fell from 0.94 to 0.31 — the removal statement is what the
 * answer needs to see.
 */
function endedCardStaysLive(card: AtomicExtractionWriteCard): boolean {
	return (
		card.endsCurrent &&
		(card.category === "profile" || card.category === "state") &&
		card.metadata?.["todo"] === "none"
	);
}

/**
 * A live ended claim takes effect when the user says it did, not when they said it: its
 * `valid_from` is the ended time when that is earlier, and it is settled BEFORE the insert so the
 * column, the order key in metadata and the arrival judgement all read the same value.
 */
function effectiveFrom(prepared: PreparedAtomicCard): PreparedAtomicCard {
	const { card } = prepared;
	if (!endedCardStaysLive(card) || card.endedAt === null) return prepared;
	if (card.validFrom !== null && card.endedAt >= card.validFrom) return prepared;
	return { ...prepared, card: { ...card, validFrom: card.endedAt } };
}

function closeEndedCardAtCreate(
	store: MemoryStoreInternals,
	input: AtomicExtractionWriteInput,
	prepared: PreparedAtomicCard,
	order: MemorySourceOrder,
): void {
	const { card } = prepared;
	if (!card.endsCurrent) return;
	if (endedCardStaysLive(card)) {
		store.sqlite
			.prepare(`
				INSERT INTO nodix_rem_journal(
					job_id, job_type, stage, outcome, row_id, actions_applied, reason
				) VALUES (?, 'atomic-extraction', 'write', 'done', ?, 0, ?)
			`)
			.run(input.ledgerKey.conversationId, prepared.id, `ended_claim_live:${prepared.id}`);
		return;
	}
	const hasLaterEnding =
		card.validFrom !== null && card.endedAt !== null && card.endedAt > card.validFrom;
	closeMemoryRow(store.sqlite, {
		targetRowId: prepared.id,
		closingRowId: prepared.id,
		closingOrder: order,
		closingValidFrom: card.endedAt,
		supersededAt: input.nowMs,
		validUntilMode: hasLaterEnding ? "when-later" : "clear",
	});
	store.sqlite
		.prepare(`
			INSERT INTO nodix_rem_journal(
				job_id, job_type, stage, outcome, row_id, actions_applied, reason
			) VALUES (?, 'atomic-extraction', 'write', 'done', ?, 1, ?)
		`)
		.run(input.ledgerKey.conversationId, prepared.id, `closed_at_create:${prepared.id}`);
}

function insertEntities(
	store: MemoryStoreInternals,
	input: AtomicExtractionWriteInput,
): Map<string, string> {
	const remap = new Map<string, string>();
	const insert = store.sqlite.prepare(
		"INSERT OR IGNORE INTO nodix_memory_entities(project_id, entity_id, display_name, normalized_name, created_at) VALUES (?, ?, ?, ?, ?)",
	);
	const select = store.sqlite.prepare(
		"SELECT entity_id FROM nodix_memory_entities WHERE project_id = ? AND normalized_name = ?",
	);
	for (const entity of input.entities ?? []) {
		assertNonEmpty(entity.entityId, "Atomic entity entityId");
		assertNonEmpty(entity.displayName, "Atomic entity displayName");
		assertNonEmpty(entity.normalizedName, "Atomic entity normalizedName");
		insert.run(
			input.projectId,
			entity.entityId,
			entity.displayName,
			entity.normalizedName,
			input.nowMs,
		);
		// The insert or its name conflict guarantees a row inside this transaction.
		const stored = select.get(input.projectId, entity.normalizedName) as { entity_id: string };
		if (stored.entity_id !== entity.entityId) remap.set(entity.entityId, stored.entity_id);
	}
	return remap;
}

/**
 * Point a card at the entities that won the registration race. The subject is not the only
 * place a card names one: BOTH ends of every relation carry an entity id too, and a losing id
 * names a row that was never inserted, so an unmapped endpoint writes a relation pointing at
 * an entity that does not exist.
 *
 * Losing the race ON THE SUBJECT also means this is not a fresh entity's card: the flag that
 * spares a fresh entity's rows from the mechanical close would otherwise leave the older open
 * row and this one both current. A card that only mentions a remapped entity through a
 * relation is still its own subject's first card, so it keeps that flag.
 */
function joinExistingEntities(
	original: PreparedAtomicCard,
	remap: ReadonlyMap<string, string>,
): PreparedAtomicCard {
	const subject = original.card.subject === null ? undefined : remap.get(original.card.subject);
	const relations = original.card.relations.map((relation) => {
		const relationSubject = remap.get(relation.subject);
		const relationObject = remap.get(relation.object);
		return relationSubject === undefined && relationObject === undefined
			? relation
			: {
					...relation,
					subject: relationSubject ?? relation.subject,
					object: relationObject ?? relation.object,
				};
	});
	// The subject won its own race, so only the relation endpoints moved.
	if (subject === undefined) {
		return { ...original, card: { ...original.card, relations } };
	}
	const { entity_identity_new: _storedFlag, ...metadata } = JSON.parse(original.metadata) as Record<
		string,
		unknown
	>;
	const { entity_identity_new: _cardFlag, ...cardMetadata } = original.card.metadata ?? {};
	return {
		...original,
		metadata: JSON.stringify(metadata),
		card: { ...original.card, subject, relations, metadata: cardMetadata },
	};
}

export function commitPreparedAtomicExtractionWrite(
	store: MemoryStoreInternals,
	input: AtomicExtractionWriteInput,
	preparedCards: readonly PreparedAtomicCard[],
): AtomicExtractionWriteResult {
	const cardIds: string[] = [];
	let createdCount = 0;
	const suppressed: AtomicExtractionWriteResult["suppressed"] = [];
	const ledger = store.completeAtomicExtractionChunk(input.ledgerKey, input.nowMs, () => {
		const ordinal = sessionOrdinal(store, input.ledgerKey.conversationId);
		const remap = insertEntities(store, input);
		for (const original of preparedCards) {
			const prepared = remap.size === 0 ? original : joinExistingEntities(original, remap);
			const refusal = suppressionReason(store, input.projectId, prepared.card);
			if (refusal) {
				suppressed.push({
					idempotencyKey: prepared.card.idempotencyKey,
					reason: refusal,
				});
				continue;
			}
			assertKeyUnwritten(store, input.projectId, prepared.card.idempotencyKey);
			const settled = effectiveFrom(prepared);
			const order = insertCard(store, input, settled, ordinal);
			journalRefusedAttribute(store, input, settled);
			closeOnArrival(store, input, settled, order);
			closeEndedCardAtCreate(store, input, settled, order);
			cardIds.push(prepared.id);
			createdCount += 1;
		}
	});
	return { ledger, cardIds, createdCount, suppressed };
}

Object.assign(MemoryStore.prototype, {
	hasLiveEndedRowInGroup(
		this: MemoryStoreInternals,
		projectId: string,
		category: string,
		subject: string,
		attribute: string | null,
	): boolean {
		const row = this.sqlite
			.prepare(
				`SELECT 1 FROM nodix_memories
				 WHERE project_id = ? AND category = ? AND subject = ? AND lane = 'active'
					AND ((attribute IS NULL AND ? IS NULL) OR attribute = ?)
					AND json_valid(metadata)
					AND json_extract(metadata, '$.ends_current') = 1
					AND json_extract(metadata, '$.superseded_by') IS NULL
				 LIMIT 1`,
			)
			.get(projectId, category, subject, attribute, attribute);
		return row !== undefined;
	},
	async storeAtomicExtractionChunk(
		this: MemoryStoreInternals,
		input: AtomicExtractionWriteInput,
	): Promise<AtomicExtractionWriteResult> {
		const preparedCards = await prepareAtomicExtractionWrite(this, input);
		return this.writeMutex.runExclusive(() =>
			commitPreparedAtomicExtractionWrite(this, input, preparedCards),
		);
	},
});
