/** @file store-cleanup-cli.ts
 * @purpose One-off cleanup of redundant and stale rows in an existing memory store.
 * @boundary Reads and rewrites one store file; no model calls, no network.
 */

import { createEmbedder } from "../engine/extraction/embedding-provider-client";
import { getSnoStationMemStateDir } from "../engine/operations/runtime-audit-log";
import { JSON_SYSTEM_CONTENT } from "../model/llm-client";
import { stableHash } from "../engine/shared/utils";
import { hashInputForEntry } from "./memory-store-shared";
import {
	initSqliteRuntime,
	openSqliteDatabase,
	type SqliteDatabaseLike,
} from "./sqlite-runtime";
import { MemoryStore, type MemoryStoreInternals } from "./store";
import { MEMORY_TELEMETRY_DELETE_REASONS } from "../engine/telemetry/memory-telemetry-types";

/**
 * Three passes, in this order, over one store.
 *
 * They are mechanical on purpose: each one is decided by a field the row already carries, so
 * nothing here reads a sentence and judges what it means. Whether a sentence is worth keeping
 * at all is a different question and is not asked here.
 *
 * 1. STAMP a row that names a successor but was never marked invalid. Recall filters on the
 *    invalidation stamp, so an unstamped superseded row is still served as current.
 * 2. DROP a serialized internal JSON extraction request. It must have both the exact internal
 *    system message prefix and a matching generated fence pair.
 * 3. COLLAPSE active rows that have one content identity in the same project and category.
 *    Non-active rows and rows the store identifies as distinct content are left alone.
 */

const PROMPT_FENCE_MARKER = "<<<BEGIN_UNTRUSTED[";
const STORED_PROMPT_PREFIX = `user: ${JSON_SYSTEM_CONTENT}\n`;

interface Row {
	id: string;
	projectId: string;
	category: string;
	text: string;
	timestamp: number;
	metadata: string;
	lane: string;
}

type CleanupStoreReader = Pick<MemoryStoreInternals, "sqlite">;
type CleanupTarget =
	| { apply: false; store: CleanupStoreReader }
	| { apply: true; store: MemoryStoreInternals };

function parseMetadata(raw: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function sqliteOf(store: CleanupStoreReader): {
	prepare: (sql: string) => {
		all: (...params: unknown[]) => unknown;
		run: (...params: unknown[]) => unknown;
	};
} {
	return store.sqlite;
}

function readAllRows(store: CleanupStoreReader): Row[] {
	return sqliteOf(store)
		.prepare(
			"SELECT id, project_id AS projectId, category, text, timestamp, metadata, lane FROM nodix_memories ORDER BY timestamp, id",
		)
		.all() as Row[];
}

function isInvalidated(metadata: Record<string, unknown>): boolean {
	return metadata.invalidated_at !== undefined && metadata.invalidated_at !== null;
}

function stampSupersededRows(
	rows: Row[],
	metadataById: Map<string, Record<string, unknown>>,
	changedIds: Set<string>,
): number {
	const byId = new Map(rows.map((row) => [row.id, row]));
	let stamped = 0;
	for (const row of rows) {
		const metadata = metadataById.get(row.id) ?? {};
		const successorId = metadata.superseded_by;
		if (typeof successorId !== "string" || successorId.length === 0) continue;
		if (isInvalidated(metadata)) continue;
		const successor = byId.get(successorId);
		if (!successor) continue;
		const stamp = successor.timestamp;
		console.log(
			`  stamp ${row.id.slice(0, 8)} invalid at ${stamp} (superseded by ${successorId.slice(0, 8)}) ${JSON.stringify(row.text.slice(0, 70))}`,
		);
		metadataById.set(row.id, { ...metadata, invalidated_at: stamp });
		changedIds.add(row.id);
		stamped += 1;
	}
	return stamped;
}

function findStoredPrompts(rows: Row[]): string[] {
	const ids: string[] = [];
	for (const row of rows) {
		if (!isStoredExtractionPrompt(row.text)) continue;
		console.log(
			`  drop ${row.id.slice(0, 8)} own prompt stored as a memory ${JSON.stringify(row.text.slice(0, 70))}`,
		);
		ids.push(row.id);
	}
	return ids;
}

function isStoredExtractionPrompt(text: string): boolean {
	if (!text.startsWith(STORED_PROMPT_PREFIX)) return false;
	const markerIndex = text.indexOf(PROMPT_FENCE_MARKER, STORED_PROMPT_PREFIX.length);
	if (markerIndex < 0) return false;
	const descriptorStart = markerIndex + PROMPT_FENCE_MARKER.length;
	const descriptorEnd = text.indexOf(">>>", descriptorStart);
	if (descriptorEnd < 0) return false;
	const descriptor = text.slice(descriptorStart, descriptorEnd);
	const labelSeparator = descriptor.indexOf("]:");
	if (labelSeparator <= 0 || labelSeparator === descriptor.length - 2) return false;
	return text.includes(`<<<END_UNTRUSTED[${descriptor}>>>`, descriptorEnd + 3);
}

interface RedundantCopies {
	droppedIds: string[];
	survivorById: Map<string, string>;
}

function findRedundantCopies(
	rows: Row[],
	metadataById: Map<string, Record<string, unknown>>,
	alreadyDropped: Set<string>,
): RedundantCopies {
	const groups = new Map<string, Row[]>();
	for (const row of rows) {
		if (row.lane !== "active" || alreadyDropped.has(row.id)) continue;
		const contentIdentity = stableHash(hashInputForEntry(row.text, row.metadata));
		const key = JSON.stringify([
			row.projectId,
			row.category,
			contentIdentity,
			legacyContentAddress(metadataById.get(row.id) ?? {}),
		]);
		groups.set(key, [...(groups.get(key) ?? []), row]);
	}
	const droppedIds: string[] = [];
	const survivorById = new Map<string, string>();
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		// The survivor is the one recall can still serve: a row that carries no invalidation
		// stamp wins over one that does, and the earliest wins among equals.
		const ranked = [...group].sort((left, right) => {
			const leftInvalid = isInvalidated(metadataById.get(left.id) ?? {}) ? 1 : 0;
			const rightInvalid = isInvalidated(metadataById.get(right.id) ?? {}) ? 1 : 0;
			if (leftInvalid !== rightInvalid) return leftInvalid - rightInvalid;
			if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
			return left.id.localeCompare(right.id);
		});
		const survivor = ranked[0] as Row;
		console.log(
			`  keep ${survivor.id.slice(0, 8)} of ${group.length} copies: ${JSON.stringify(survivor.text.slice(0, 70))}`,
		);
		for (const row of ranked.slice(1)) {
			console.log(`    drop ${row.id.slice(0, 8)}`);
			droppedIds.push(row.id);
			survivorById.set(row.id, survivor.id);
		}
	}
	return { droppedIds, survivorById };
}

function legacyContentAddress(metadata: Record<string, unknown>): string {
	const stringValue = (key: string): string | null => {
		const value = metadata[key];
		return typeof value === "string" ? value : null;
	};
	const childrenIds = Array.isArray(metadata.children_ids)
		? metadata.children_ids.filter((id): id is string => typeof id === "string")
		: null;
	const relations = Array.isArray(metadata.relations)
		? metadata.relations
				.filter(
					(relation): relation is Record<string, unknown> =>
						typeof relation === "object" && relation !== null && !Array.isArray(relation),
				)
				.map((relation) => [
					typeof relation.source === "string" ? relation.source : null,
					typeof relation.type === "string" ? relation.type : null,
					typeof relation.targetId === "string"
						? relation.targetId
						: typeof relation.target === "string"
							? relation.target
							: null,
				])
				.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
		: null;
	return JSON.stringify([
		stringValue("l0_abstract"),
		stringValue("l1_overview"),
		stringValue("l2_content"),
		stringValue("fact_key"),
		stringValue("section_name"),
		stringValue("rawTopicPhrase"),
		stringValue("anti_pattern_signature"),
		childrenIds,
		typeof metadata.depth === "number" ? metadata.depth : null,
		typeof metadata.event_at === "string" || typeof metadata.event_at === "number"
			? metadata.event_at
			: null,
		stringValue("temporal_phrase"),
		stringValue("entity_kind"),
		relations,
	]);
}

function repointSupersessions(
	rows: Row[],
	metadataById: Map<string, Record<string, unknown>>,
	droppedIds: Set<string>,
	survivorById: Map<string, string>,
	changedIds: Set<string>,
): number {
	let repointed = 0;
	for (const row of rows) {
		if (droppedIds.has(row.id)) continue;
		const metadata = metadataById.get(row.id) ?? {};
		const successorId = metadata.superseded_by;
		if (typeof successorId !== "string" || !droppedIds.has(successorId)) continue;
		const survivor = resolveDroppedSuccessor(
			row.id,
			successorId,
			metadataById,
			droppedIds,
			survivorById,
		);
		if (survivor) {
			console.log(
				`  repoint ${row.id.slice(0, 8)} -> ${survivor.slice(0, 8)} (was ${successorId.slice(0, 8)}, dropped)`,
			);
			metadataById.set(row.id, { ...metadata, superseded_by: survivor });
		} else {
			console.log(
				`  restore ${row.id.slice(0, 8)} (successor ${successorId.slice(0, 8)} dropped without replacement)`,
			);
			const restored = { ...metadata };
			delete restored.superseded_by;
			delete restored.invalidated_at;
			metadataById.set(row.id, restored);
		}
		changedIds.add(row.id);
		repointed += 1;
	}
	return repointed;
}

function resolveDroppedSuccessor(
	rowId: string,
	successorId: string,
	metadataById: Map<string, Record<string, unknown>>,
	droppedIds: Set<string>,
	survivorById: Map<string, string>,
): string | undefined {
	const visited = new Set([rowId]);
	let candidateId = successorId;
	while (droppedIds.has(candidateId)) {
		if (visited.has(candidateId)) return undefined;
		visited.add(candidateId);
		const survivor = survivorById.get(candidateId);
		if (survivor && !visited.has(survivor)) return survivor;
		const nextId = metadataById.get(candidateId)?.superseded_by;
		if (typeof nextId !== "string" || nextId.length === 0) return undefined;
		candidateId = nextId;
	}
	return metadataById.has(candidateId) && !visited.has(candidateId) ? candidateId : undefined;
}

function writeChangedMetadata(
	store: CleanupStoreReader,
	metadataById: Map<string, Record<string, unknown>>,
	changedIds: Set<string>,
): void {
	const update = sqliteOf(store).prepare(
		"UPDATE nodix_memories SET metadata = ? WHERE id = ?",
	);
	for (const id of changedIds) {
		const metadata = metadataById.get(id);
		if (metadata) update.run(JSON.stringify(metadata), id);
	}
}

export interface StoreCleanupResult {
	rowsBefore: number;
	rowsAfter: number;
	stamped: number;
	promptRows: number;
	redundantCopies: number;
	repointed: number;
}

function cleanStoreInTransaction(target: CleanupTarget, label?: string): StoreCleanupResult {
	const { apply, store } = target;
	{
		const rows = readAllRows(store);
		const metadataById = new Map(rows.map((row) => [row.id, parseMetadata(row.metadata)]));
		const changedMetadataIds = new Set<string>();
		console.log(`store ${label ?? "(in process)"}`);
		console.log(`${rows.length} row(s), ${new Set(rows.map((row) => row.text)).size} distinct text(s)`);
		console.log(apply ? "mode: APPLY" : "mode: dry run (pass --apply to write)");

		console.log("\npass 1 — superseded rows never marked invalid");
		const stamped = stampSupersededRows(rows, metadataById, changedMetadataIds);
		console.log(`  ${stamped} row(s)`);

		console.log("\npass 2 — our own prompt stored as a memory");
		const promptIds = findStoredPrompts(rows);
		console.log(`  ${promptIds.length} row(s)`);

		console.log("\npass 3 — content-identical copies");
		const { droppedIds: duplicateIds, survivorById } = findRedundantCopies(
			rows,
			metadataById,
			new Set(promptIds),
		);
		console.log(`  ${duplicateIds.length} row(s)`);

		const allDropped = new Set([...promptIds, ...duplicateIds]);
		console.log("\npass 4 — pointers that named a dropped row");
		const repointed = repointSupersessions(
			rows,
			metadataById,
			allDropped,
			survivorById,
			changedMetadataIds,
		);
		console.log(`  ${repointed} row(s)`);

		if (target.apply) writeChangedMetadata(target.store, metadataById, changedMetadataIds);
		if (target.apply && allDropped.size > 0) {
			target.store.deleteByIds([...allDropped], {
				deleteReason: MEMORY_TELEMETRY_DELETE_REASONS.cli,
			});
			console.log(`\ndeleted ${allDropped.size} row(s)`);
		}
		const after = readAllRows(store);
		console.log(
			`\ndone. stamped=${stamped} dropped=${apply ? allDropped.size : 0} repointed=${repointed} rows=${after.length}`,
		);
		return {
			rowsBefore: rows.length,
			rowsAfter: after.length,
			stamped,
			promptRows: promptIds.length,
			redundantCopies: duplicateIds.length,
			repointed,
		};
	}
}

export async function cleanStore(
	store: MemoryStore,
	options: { apply: boolean; label?: string },
): Promise<StoreCleanupResult> {
	const internals = store as unknown as MemoryStoreInternals;
	return internals.writeMutex.runExclusive(() => {
		const target: CleanupTarget = options.apply
			? { apply: true, store: internals }
			: { apply: false, store: internals };
		const transaction = internals.sqlite.transaction(() =>
			cleanStoreInTransaction(target, options.label),
		);
		const result = options.apply ? transaction.immediate() : transaction.deferred();
		// The SQLite wrapper cannot express the synchronous callback's return type.
		return result as StoreCleanupResult;
	});
}

function inspectStoreReadonly(sqlite: SqliteDatabaseLike, label: string): StoreCleanupResult {
	const transaction = sqlite.transaction(() =>
		cleanStoreInTransaction({ apply: false, store: { sqlite } }, label),
	);
	// The SQLite wrapper cannot express the synchronous callback's return type.
	return transaction.deferred() as StoreCleanupResult;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const apply = args.includes("--apply");
	const dbPath = args.find((arg) => !arg.startsWith("--"));
	if (!dbPath) {
		console.error(
			"usage: npm run store:clean -- <db-path> [--apply]\n" +
				"       without --apply nothing is written; the passes are printed only.",
		);
		process.exitCode = 2;
		return;
	}
	await initSqliteRuntime();
	if (!apply) {
		const handle = openSqliteDatabase(dbPath, { readonly: true, fileMustExist: true });
		try {
			inspectStoreReadonly(handle.db, dbPath);
		} finally {
			handle.db.close();
		}
		return;
	}
	const embedder = createEmbedder({}, getSnoStationMemStateDir());
	const store = new MemoryStore({ dbPath, vectorDim: embedder.dimensions, embedder });
	try {
		await cleanStore(store, { apply, label: dbPath });
	} finally {
		await store.close();
	}
}

if (process.argv[1]?.endsWith("store-cleanup-cli.ts")) void main();
