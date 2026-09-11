/** @file memory-source-order.ts
 * @purpose Compares persisted extraction order and stores memory-row closure metadata.
 * @boundary Mechanical ordering and close persistence only; no candidate selection or judgement.
 */

import type { SqliteDatabaseLike } from "./sqlite-runtime";

export interface MemorySourceOrder {
	valid_from: number | null;
	/**
	 * The row's own session moment, standing in for `valid_from` as the order fallback when the
	 * model resolved no event date. Equals the `nodix_memories.timestamp` written for the row
	 * (`valid_from ?? sessionTimestampMs`). Absent on a row written before this field existed or on
	 * a hand-written key; such a row sorts oldest.
	 */
	session_moment?: number;
	session_ordinal: number;
	global_turn_index: number;
	rowid: number;
	/**
	 * The conversation the row was written from. `session_ordinal` is computed at write time from
	 * the ledger's order, so a conversation that arrives later with an earlier first write shifts
	 * the numbers and two rows of DIFFERENT conversations can end up carrying the same stored
	 * ordinal; only this identity settles "one turn". Absent on rows written before 2026-09-07,
	 * which are therefore never same-turn with anything.
	 */
	conversation_id?: string;
}

export interface CloseMemoryRowInput {
	targetRowId: string;
	closingRowId: string;
	closingOrder: MemorySourceOrder;
	closingValidFrom: number | null;
	supersededAt: number | string;
	validUntilMode?: "clear" | "when-later";
}

interface ClosableMemoryRow {
	id: string;
	metadata: string;
	validFrom: number | null;
	validUntil: number | null;
}

function compareNumber(left: number, right: number): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/**
 * The one number a row is ordered by. `valid_from` is the event time; when the model resolved
 * none, the row's own session moment stands in for it — exactly as the write sets
 * `timestamp = valid_from ?? sessionTimestampMs`. Folding both into a single monotone number is
 * what makes the comparison transitive: comparing `valid_from` only when both sides carried one
 * left mixed dated/undated rows able to form a cycle. A row with neither (written before this
 * field, or a hand-written key) sorts oldest.
 */
function orderTime(order: MemorySourceOrder): number {
	return order.valid_from ?? order.session_moment ?? Number.NEGATIVE_INFINITY;
}

export function compareMemorySourceOrder(
	left: MemorySourceOrder,
	right: MemorySourceOrder,
): number {
	// An undated statement is ordered by its session moment, not dropped to a 0 tie on the date.
	return (
		compareNumber(orderTime(left), orderTime(right)) ||
		compareNumber(left.session_ordinal, right.session_ordinal) ||
		compareNumber(left.global_turn_index, right.global_turn_index) ||
		compareNumber(left.rowid, right.rowid)
	);
}

/**
 * Two rows born from one conversation turn: at arrival neither is older than the other. One
 * statement is extracted as several rows — a timeline and its phases, an ending and its
 * replacement — and the `rowid` tie-break below read them as successive, so a one-cardinality
 * attribute closed every facet but the last and an ending was offered its own replacement to
 * retire (measured 2026-09-07: 23 and 3 rows of one six-persona run). A same-turn revision is
 * the model's `ends_current` job, not an ordering question. The sentinel of a row with no
 * `source_order` never matches another sentinel.
 */
export function sameSourceTurn(left: MemorySourceOrder, right: MemorySourceOrder): boolean {
	return (
		left.conversation_id !== undefined &&
		left.conversation_id === right.conversation_id &&
		Number.isFinite(left.session_ordinal) &&
		left.session_ordinal === right.session_ordinal &&
		left.global_turn_index === right.global_turn_index
	);
}

function isSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * The order key a row carries, or the one a row written before this change is treated as having.
 *
 * A row from before REQ-2 has no `source_order` until the maintenance pass backfills it, and an
 * ordinary wave must keep running over such a store rather than throwing. Those rows are older
 * than everything written since — that is what "written before" means — so they read as the
 * lowest possible key: anything may close them, and they may close nothing.
 */
export function readMemorySourceOrderOrOldest(metadata: string): MemorySourceOrder {
	try {
		return readMemorySourceOrder(metadata);
	} catch {
		return {
			valid_from: null,
			session_ordinal: Number.NEGATIVE_INFINITY,
			global_turn_index: Number.NEGATIVE_INFINITY,
			rowid: Number.NEGATIVE_INFINITY,
		};
	}
}

export function readMemorySourceOrder(metadata: string): MemorySourceOrder {
	const parsed: unknown = JSON.parse(metadata);
	if (typeof parsed !== "object" || parsed === null || !("source_order" in parsed)) {
		throw new Error("Memory row has no source_order");
	}
	const sourceOrder: unknown = parsed.source_order;
	if (typeof sourceOrder !== "object" || sourceOrder === null) {
		throw new Error("Memory row has invalid source_order");
	}
	const validFrom = "valid_from" in sourceOrder ? sourceOrder.valid_from : undefined;
	const sessionMoment = "session_moment" in sourceOrder ? sourceOrder.session_moment : undefined;
	const sessionOrdinal =
		"session_ordinal" in sourceOrder ? sourceOrder.session_ordinal : undefined;
	const globalTurnIndex =
		"global_turn_index" in sourceOrder ? sourceOrder.global_turn_index : undefined;
	const rowid = "rowid" in sourceOrder ? sourceOrder.rowid : undefined;
	const conversationId =
		"conversation_id" in sourceOrder && typeof sourceOrder.conversation_id === "string"
			? sourceOrder.conversation_id
			: undefined;
	if (
		(validFrom !== null && !isSafeInteger(validFrom)) ||
		(sessionMoment !== undefined && !isSafeInteger(sessionMoment)) ||
		!isSafeInteger(sessionOrdinal) ||
		!isSafeInteger(globalTurnIndex) ||
		!isSafeInteger(rowid)
	) {
		throw new Error("Memory row has invalid source_order");
	}
	return {
		valid_from: validFrom,
		...(sessionMoment === undefined ? {} : { session_moment: sessionMoment }),
		session_ordinal: sessionOrdinal,
		global_turn_index: globalTurnIndex,
		rowid,
		...(conversationId === undefined ? {} : { conversation_id: conversationId }),
	};
}

function readMetadata(metadata: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(metadata);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Memory row has invalid metadata");
	}
	return { ...parsed };
}

function activeMergeId(metadata: Record<string, unknown>): string | undefined {
	return typeof metadata.merge_id === "string"
		? metadata.merge_id
		: undefined;
}

function readClosableRow(database: SqliteDatabaseLike, rowId: string): ClosableMemoryRow {
	const row = database
		.prepare(
			"SELECT id, metadata, valid_from AS validFrom, valid_until AS validUntil FROM nodix_memories WHERE id = ?",
		)
		.get(rowId) as ClosableMemoryRow | undefined;
	if (!row) throw new Error(`Memory row '${rowId}' does not exist`);
	return row;
}

export function closeMemoryRow(
	database: SqliteDatabaseLike,
	input: CloseMemoryRowInput,
): boolean {
	const row = readClosableRow(database, input.targetRowId);
	const metadata = readMetadata(row.metadata);
	if (metadata.superseded_by === input.closingRowId) return false;
	if (metadata.superseded_by !== undefined && metadata.superseded_by !== null) {
		throw new Error(`Memory row '${input.targetRowId}' is already closed`);
	}
	if (
		input.targetRowId !== input.closingRowId &&
		compareMemorySourceOrder(input.closingOrder, readMemorySourceOrderOrOldest(row.metadata)) < 0
	) {
		throw new Error("Closing row source_order must be strictly greater than target source_order");
	}
	const validUntil =
		input.validUntilMode === "clear"
			? null
			: row.validFrom !== null &&
				input.closingValidFrom !== null &&
				input.closingValidFrom > row.validFrom
				? input.closingValidFrom
				: row.validUntil;
	const closingMetadata =
		input.targetRowId === input.closingRowId
			? metadata
			: readMetadata(readClosableRow(database, input.closingRowId).metadata);
	const mergeId = activeMergeId(metadata) ?? activeMergeId(closingMetadata);
	database
		.prepare("UPDATE nodix_memories SET metadata = ?, valid_until = ? WHERE id = ?")
		.run(
			JSON.stringify({
				...metadata,
				superseded_by: input.closingRowId,
				superseded_at: input.supersededAt,
				...(mergeId === undefined
					? {}
					: {
							close_merge_id: mergeId,
						}),
			}),
			validUntil,
			input.targetRowId,
		);
	return true;
}
