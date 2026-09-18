/** @file rem-consumer-retrieval.ts
 * @purpose Shares the two production retrieval calls with REM close-safety checks.
 * @boundary Context construction only.
 *
 * Manual recall keeps retired rows unless current-only is explicit. Automatic recall serves
 * open rows. A maintained store also expands subject groups before packing.
 */

import type { MemoryRetriever } from "./retriever";
import {
	packRecallRows,
	type PackedRecallRows,
} from "./recall-token-packer";
import type { AggregationQuery, MemoryCategory, RetrievalResult } from "../shared/types";
import {
	compareMemorySourceOrder,
	readMemorySourceOrderOrOldest,
} from "../../store/memory-source-order";
import type { RemFacetPolicy } from "../rem/index.js";

const GROUP_CRUD_MAINTENANCE_RECEIPT = "group-crud-maintenance-v1";

export interface RecallFilterDiagnostics {
	retired_closed_removed_count?: number;
	post_filter_input_count?: number;
	post_filter_output_count?: number;
}

interface RecallGroupRow {
	id: string;
	projectId: string;
	category: string;
	subject: string | null;
	attribute: string | null;
	metadata: string;
}

function parseRecallMetadata(metadata: unknown): Record<string, unknown> | undefined {
	if (typeof metadata === "string") {
		try {
			return parseRecallMetadata(JSON.parse(metadata));
		} catch {
			return undefined;
		}
	}
	if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
		return undefined;
	}
	return metadata as Record<string, unknown>;
}

export function isOpenRecallMetadata(metadata: unknown): boolean {
	return typeof parseRecallMetadata(metadata)?.["superseded_by"] !== "string";
}

function recallGroupKey(
	row: Pick<RecallGroupRow, "projectId" | "category" | "subject" | "attribute">,
): string {
	return JSON.stringify([row.projectId, row.category, row.subject, row.attribute]);
}

function hasGroupCrudMaintenanceReceipt(retriever: MemoryRetriever): boolean {
	return retriever.store.sqlite
		.prepare(
			"SELECT 1 FROM nodix_todo_migration_receipts WHERE migration_id = ? LIMIT 1",
		)
		.get(GROUP_CRUD_MAINTENANCE_RECEIPT) !== undefined;
}

function readRetrievedGroupRows(
	retriever: MemoryRetriever,
	rows: readonly RetrievalResult[],
): RecallGroupRow[] {
	return retriever.store.sqlite
		.prepare(`
			SELECT id, project_id AS projectId, category, subject, attribute, metadata
			FROM nodix_memories
			WHERE id IN (SELECT value FROM json_each(?))
				AND attribute IS NOT NULL
				AND category != 'episodic'
		`)
		.all(JSON.stringify(rows.map((row) => row.entry.id))) as RecallGroupRow[];
}

/**
 * What the caller's own query already excluded. A group member is pulled in beside the row that
 * was retrieved, so it never passes through the search: without these, an expansion re-admits a
 * row the query had ruled out — an expired one, a refused one, or one of another category — and
 * the exclusion the caller asked for silently stops holding.
 */
interface RecallGroupVisibility {
	category?: MemoryCategory;
	includeRefused: boolean;
	excludeInvalidatedBefore: number;
}

function readOpenGroupRows(
	retriever: MemoryRetriever,
	groups: readonly RecallGroupRow[],
	visibility: RecallGroupVisibility,
): RecallGroupRow[] {
	const identities = groups.map((group) => [
		group.projectId,
		group.subject,
		group.attribute,
		group.category,
	]);
	const params: Array<string | number> = [JSON.stringify(identities)];
	let sql = `
			WITH wanted AS (
				SELECT
					json_extract(value, '$[0]') AS project_id,
					json_extract(value, '$[1]') AS subject,
					json_extract(value, '$[2]') AS attribute,
					json_extract(value, '$[3]') AS category
				FROM json_each(?)
			)
			SELECT DISTINCT
				m.id,
				m.project_id AS projectId,
				m.category,
				m.subject,
				m.attribute,
				m.metadata
			FROM nodix_memories m
			JOIN wanted w
				ON m.project_id = w.project_id
				AND m.subject = w.subject
				AND m.attribute IS w.attribute
				AND m.category = w.category
			WHERE m.lane = 'active'
		`;
	if (visibility.category !== undefined) {
		sql += " AND m.category = ?";
		params.push(visibility.category);
	}
	if (!visibility.includeRefused) sql += " AND m.disposition_reason IS NULL";
	sql +=
		" AND (NOT json_valid(m.metadata) OR json_extract(m.metadata, '$.invalidated_at') IS NULL OR json_extract(m.metadata, '$.invalidated_at') > ?)";
	params.push(visibility.excludeInvalidatedBefore);
	const rows = retriever.store.sqlite.prepare(sql).all(...params) as RecallGroupRow[];
	return rows.filter((row) => isOpenRecallMetadata(row.metadata));
}

function groupRowsNewestFirst(rows: readonly RecallGroupRow[]): Map<string, RecallGroupRow[]> {
	const grouped = new Map<string, RecallGroupRow[]>();
	for (const row of rows) {
		const key = recallGroupKey(row);
		const group = grouped.get(key) ?? [];
		group.push(row);
		grouped.set(key, group);
	}
	for (const group of grouped.values()) {
		group.sort(
			(left, right) =>
				compareMemorySourceOrder(
					readMemorySourceOrderOrOldest(right.metadata),
					readMemorySourceOrderOrOldest(left.metadata),
				) || right.id.localeCompare(left.id),
		);
	}
	return grouped;
}

function retrievalResultForGroupRow(
	retriever: MemoryRetriever,
	row: RecallGroupRow,
	anchor: RetrievalResult,
	retrievedById: ReadonlyMap<string, RetrievalResult>,
): RetrievalResult | undefined {
	const retrieved = retrievedById.get(row.id);
	if (retrieved) return retrieved;
	const entry = retriever.store.getById(row.id);
	if (!entry) return undefined;
	return { entry, score: anchor.score, sources: anchor.sources };
}

function orderExpandedRecallRows(
	rows: readonly RetrievalResult[],
	hitById: ReadonlyMap<string, RecallGroupRow>,
	resultsByGroup: ReadonlyMap<string, RetrievalResult[]>,
): RetrievalResult[] {
	const served: RetrievalResult[] = [];
	const servedIds = new Set<string>();
	const append = (row: RetrievalResult): void => {
		if (servedIds.has(row.entry.id)) return;
		servedIds.add(row.entry.id);
		served.push(row);
	};
	// A group is served at its first hit's rank, newest row first, so a weak hit's group never
	// jumps ahead of stronger hits.
	const expandedGroups = new Set<string>();
	for (const row of rows) {
		const hit = hitById.get(row.entry.id);
		if (!hit) {
			append(row);
			continue;
		}
		const key = recallGroupKey(hit);
		if (expandedGroups.has(key)) continue;
		expandedGroups.add(key);
		for (const member of resultsByGroup.get(key) ?? []) append(member);
	}
	return served;
}

function serveRecallGroups(
	retriever: MemoryRetriever,
	rows: readonly RetrievalResult[],
	visibility: RecallGroupVisibility,
): RetrievalResult[] {
	const hitRows = readRetrievedGroupRows(retriever, rows).filter(
		(row) => row.subject !== null && isOpenRecallMetadata(row.metadata),
	);
	const hitById = new Map(hitRows.map((row) => [row.id, row]));
	const anchors = new Map<string, RetrievalResult>();
	const groups = new Map<string, RecallGroupRow>();
	for (const row of rows) {
		const hit = hitById.get(row.entry.id);
		if (!hit) continue;
		const key = recallGroupKey(hit);
		if (anchors.has(key)) continue;
		anchors.set(key, row);
		groups.set(key, hit);
	}
	if (groups.size === 0) return [...rows];

	const groupRows = groupRowsNewestFirst(
		readOpenGroupRows(retriever, [...groups.values()], visibility),
	);
	const retrievedById = new Map(rows.map((row) => [row.entry.id, row]));
	const resultsByGroup = new Map<string, RetrievalResult[]>();
	for (const [key, members] of groupRows) {
		const anchor = anchors.get(key);
		if (!anchor) continue;
		const results = members.flatMap((member) => {
			const result = retrievalResultForGroupRow(retriever, member, anchor, retrievedById);
			// Tag every served group member with its group, so the token packer keeps the group's
			// newest member with it instead of serving an older sibling alone under a tight budget.
			return result ? [{ ...result, recallGroupKey: key }] : [];
		});
		resultsByGroup.set(key, results);
	}
	return orderExpandedRecallRows(rows, hitById, resultsByGroup);
}

export async function retrieveForAutoRecall(
	retriever: MemoryRetriever,
	input: {
		diagnostics?: RecallFilterDiagnostics;
		query: string;
		limit: number;
		scopeFilter: string[];
		signal?: AbortSignal;
		sessionId?: string;
		nowMs: number;
	},
): Promise<RetrievalResult[]> {
	// A group-CRUD close records `superseded_by` and, for a same-day or undated replacement, leaves
	// `valid_until` alone; nothing else in this path reads that, so without this filter the fact the
	// close retired keeps being injected beside the fact that replaced it, every turn.
	const retrieved = await retriever.retrieve({
		query: input.query,
		limit: input.limit,
		scopeFilter: input.scopeFilter,
		...(input.signal === undefined ? {} : { signal: input.signal }),
		...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
		source: "auto-recall",
		facetPolicy: "current-only",
		includeRefused: true,
		excludeInvalidatedBefore: input.nowMs,
		excludeSuperseded: true,
	});
	// The store already dropped them. This is the second reading of the same rule, for a row whose
	// metadata the SQL predicate could not parse.
	const openRows = retrieved.filter((row) => isOpenRecallMetadata(row.entry.metadata));
	if (input.diagnostics) {
		input.diagnostics.retired_closed_removed_count = retrieved.length - openRows.length;
		input.diagnostics.post_filter_input_count = retrieved.length;
		input.diagnostics.post_filter_output_count = openRows.length;
	}
	return openRows;
}

export async function retrieveForMemoryRecallOrEval(
	retriever: MemoryRetriever,
	input: {
		diagnostics?: RecallFilterDiagnostics;
		signal?: AbortSignal;
		query: string;
		limit: number;
		scopeFilter: string[];
		category?: MemoryCategory;
		includeRefused?: boolean;
		aggregation?: AggregationQuery;
		explicitLocale?: string;
		facetPolicy?: RemFacetPolicy;
		nowMs: number;
	},
): Promise<RetrievalResult[]> {
	const retrieved = await retriever.retrieve({
		query: input.query,
		signal: input.signal,
		limit: input.limit,
		scopeFilter: input.scopeFilter,
		...(input.category === undefined ? {} : { category: input.category }),
		...(input.includeRefused === undefined ? {} : { includeRefused: input.includeRefused }),
		...(input.aggregation === undefined ? {} : { aggregation: input.aggregation }),
		...(input.explicitLocale === undefined ? {} : { explicitLocale: input.explicitLocale }),
		source: "manual",
		...(input.facetPolicy === undefined ? {} : { facetPolicy: input.facetPolicy }),
		allowAggregation: true,
		excludeInvalidatedBefore: input.nowMs,
		// Filter before the search limit only when the caller explicitly requests current rows.
		excludeSuperseded: input.facetPolicy === "current-only",
	});
	const openRows =
		input.facetPolicy === "current-only"
			? retrieved.filter((row) => isOpenRecallMetadata(row.entry.metadata))
			: retrieved;
	if (input.diagnostics) {
		input.diagnostics.retired_closed_removed_count = retrieved.length - openRows.length;
		input.diagnostics.post_filter_input_count = retrieved.length;
		input.diagnostics.post_filter_output_count = openRows.length;
	}
	// A structured aggregation is not a group read. Storage has already chosen the population and,
	// for `count`/`first`/`last`, reduced it to the single row that answers the question, and it
	// carries `scopeRowCount` on that row. Expanding it into its subject group would answer with
	// rows the aggregation's own terms never matched, reorder the reduction, and hand the caller
	// members that carry no population figure at all.
	if (input.aggregation !== undefined) return openRows;
	if (!hasGroupCrudMaintenanceReceipt(retriever)) return openRows;
	return serveRecallGroups(retriever, openRows, {
		...(input.category === undefined ? {} : { category: input.category }),
		includeRefused: input.includeRefused ?? true,
		excludeInvalidatedBefore: input.nowMs,
	});
}

export function packManualRecallRows(
	rows: readonly RetrievalResult[],
	tokenBudget?: number,
): PackedRecallRows<RetrievalResult> {
	return packRecallRows(
		rows,
		(row) => row.snippet?.trim() || row.entry.text,
		tokenBudget,
		(row) => row.recallGroupKey,
	);
}
