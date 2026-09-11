/** @file group-crud-maintenance.ts
 * @purpose Migrates existing memory rows to the persisted group-address shape.
 * @boundary One explicit, re-runnable store pass; no timer, model prompt, or recall routing.
 */

import { randomUUID } from "node:crypto";
import attributeDictionary from "../../../config/attribute-dictionary.json" with { type: "json" };
import stateVocabulary from "../../../config/state-vocabulary.json" with { type: "json" };
import {
	type AtomicKeyedRecord,
	type AtomicProfileKeyingTransport,
	runAtomicProfileKeying,
} from "../extraction/atomic-profile-keying";
import type { Embedder } from "../extraction/embedding-provider-client";
import {
	ENTITY_IDENTITY_CANDIDATE_LIMIT,
	rankAtomicMemoryEntityCandidates,
	recordAtomicEntityIdentityJournal,
} from "../../store/memory-store-atomic-entity-api";
import { applyEntityNameKeyMigration } from "../../store/entity-name-key-migration";
import { applyStateCategoryMigration } from "../../store/state-category-migration";
import type { SqliteDatabaseLike } from "../../store/sqlite-runtime";

const MIGRATION_ID = "group-crud-maintenance-v1";
const ENTITY_PREFIX = "entity:";
const KEYING_DECISION = "group_crud_maintenance_keying";
const STATE_KEYING_DECISION = "group_crud_maintenance_state_keying";
const IDENTITY_DECISION = "group_crud_maintenance_identity";
const stateSlugList = stateVocabulary.slugs.map(({ slug }) => slug);
const stateSlugs = new Set(stateSlugList);
const profileSlugs = new Set(attributeDictionary.slugs.map(({ slug }) => slug));

interface MemoryRow {
	rowid: number;
	id: string;
	text: string;
	category: string;
	projectId: string;
	importance: number;
	timestamp: number;
	timezone: string;
	metadata: string;
	rawCandidateJson: string | null;
	lane: string;
	subject: string | null;
	attribute: string | null;
	validFrom: number | null;
	validUntil: number | null;
}

interface EntityRow {
	projectId: string;
	entityId: string;
	displayName: string;
	normalizedName: string;
}

export interface GroupCrudEntityIdentityCandidate {
	entityId: string;
	displayName: string;
}

export type GroupCrudEntityIdentityAnswer =
	| { decision: "existing"; entityId: string }
	| { decision: "new" }
	| { decision: "undecided" };

export interface GroupCrudEntityIdentityJudgementPort {
	respond(input: {
		displayName: string;
		existingDisplayNames: readonly GroupCrudEntityIdentityCandidate[];
	}): Promise<GroupCrudEntityIdentityAnswer>;
}

export function createGroupCrudEntityIdentityJudgementPort(
	input: GroupCrudEntityIdentityJudgementPort,
): GroupCrudEntityIdentityJudgementPort {
	return input;
}

export interface GroupCrudStateKeyingJudgementPort {
	respond(input: {
		text: string;
		offeredSlugs: readonly string[];
	}): Promise<string | null>;
}

export function createGroupCrudStateKeyingJudgementPort(
	input: GroupCrudStateKeyingJudgementPort,
): GroupCrudStateKeyingJudgementPort {
	return input;
}

export interface GroupCrudMaintenanceReport {
	scanned: number;
	changed: number;
	undecided: number;
	rolledBack: number;
}

export interface RunGroupCrudMaintenancePassInput {
	database: SqliteDatabaseLike;
	embedder?: Pick<Embedder, "embed" | "embedMany">;
	identityJudgement?: GroupCrudEntityIdentityJudgementPort;
	stateKeying?: GroupCrudStateKeyingJudgementPort;
	profileKeying?: AtomicProfileKeyingTransport;
	nowMs?: number;
}

function readObject(json: string, label: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		throw new Error(`${label} is not valid JSON`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} is not a JSON object`);
	}
	return { ...value };
}

function readRows(database: SqliteDatabaseLike): MemoryRow[] {
	return database
		.prepare(`
			SELECT rowid, id, text, category, project_id AS projectId, importance, timestamp,
				timezone, metadata, raw_candidate_json AS rawCandidateJson, lane, subject,
				attribute, valid_from AS validFrom, valid_until AS validUntil
			FROM nodix_memories
			ORDER BY rowid
		`)
		.all() as MemoryRow[];
}

function validFromOrdinals(rows: readonly MemoryRow[]): Map<number | null, number> {
	const values = [...new Set(rows.map(({ validFrom }) => validFrom))].sort((left, right) => {
		if (left === right) return 0;
		if (left === null) return -1;
		if (right === null) return 1;
		return left - right;
	});
	return new Map(values.map((value, index) => [value, index]));
}

function sourceTurnIndex(metadata: Record<string, unknown>): number {
	const span = metadata["source_span"];
	if (typeof span !== "object" || span === null || Array.isArray(span)) return 0;
	const turnIndex = "turnIndex" in span ? span.turnIndex : undefined;
	return typeof turnIndex === "number" && Number.isSafeInteger(turnIndex) ? turnIndex : 0;
}

function hasSourceOrder(metadata: Record<string, unknown>): boolean {
	const order = metadata["source_order"];
	if (typeof order !== "object" || order === null || Array.isArray(order)) return false;
	const validFrom = "valid_from" in order ? order.valid_from : undefined;
	return (
		(validFrom === null || Number.isSafeInteger(validFrom)) &&
		Number.isSafeInteger("session_ordinal" in order ? order.session_ordinal : undefined) &&
		Number.isSafeInteger("global_turn_index" in order ? order.global_turn_index : undefined) &&
		Number.isSafeInteger("rowid" in order ? order.rowid : undefined)
	);
}

function backfillSourceOrder(
	database: SqliteDatabaseLike,
	rows: readonly MemoryRow[],
	changed: Set<string>,
): void {
	const ordinals = validFromOrdinals(rows);
	const update = database.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?");
	for (const row of rows) {
		const metadata = readObject(row.metadata, `Memory row '${row.id}' metadata`);
		if (hasSourceOrder(metadata)) continue;
		metadata["source_order"] = {
			valid_from: row.validFrom,
			// The order fallback for a row the model dated to nothing: its own session moment, which
			// is what `timestamp` already holds (`valid_from ?? sessionTimestampMs`, never the pass's
			// own run time).
			session_moment: row.timestamp,
			session_ordinal: ordinals.get(row.validFrom) ?? 0,
			global_turn_index: sourceTurnIndex(metadata),
			rowid: row.rowid,
		};
		update.run(JSON.stringify(metadata), row.id);
		changed.add(row.id);
	}
}

function recategorizeEntityProfiles(
	database: SqliteDatabaseLike,
	rows: readonly MemoryRow[],
	changed: Set<string>,
): void {
	const update = database.prepare(
		"UPDATE nodix_memories SET category = 'state', metadata = ? WHERE id = ?",
	);
	for (const row of rows) {
		if (row.category !== "profile" || !row.subject?.startsWith(ENTITY_PREFIX)) continue;
		const metadata = readObject(row.metadata, `Memory row '${row.id}' metadata`);
		if (metadata["event_at"] !== undefined && metadata["event_at"] !== null) continue;
		metadata["kind"] = "state";
		metadata["memory_category"] = "state";
		update.run(JSON.stringify(metadata), row.id);
		changed.add(row.id);
	}
}

function candidateStrings(row: MemoryRow, metadata: Record<string, unknown>): string[] {
	const values: unknown[] = [
		row.attribute,
		metadata["attribute"],
		metadata["topic"],
		metadata["section_name"],
	];
	if (row.rawCandidateJson) {
		const raw = readObject(row.rawCandidateJson, `Memory row '${row.id}' raw candidate`);
		values.push(raw["attribute"], raw["slug"]);
	}
	return values.filter((value): value is string => typeof value === "string");
}

function journalStateKeyingRefusal(
	database: SqliteDatabaseLike,
	row: MemoryRow,
	answer: string,
): void {
	database
		.prepare(`
			INSERT INTO nodix_rem_journal(
				job_id, job_type, stage, outcome, verdicts, actions_applied, reason, detail
			) VALUES (?, 'group-crud-maintenance', 'state-keying', 'refused', 1, 0, ?, ?)
		`)
		.run(
			randomUUID(),
			"state_keying_answer_outside_offered_set",
			JSON.stringify({ row_id: row.id, answered_slug: answer, offered_slugs: stateSlugList }),
		);
}

function markStateKeyingUndecided(
	database: SqliteDatabaseLike,
	row: MemoryRow,
	metadata: Record<string, unknown>,
	changed: Set<string>,
): void {
	metadata[STATE_KEYING_DECISION] = "undecided";
	database
		.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?")
		.run(JSON.stringify(metadata), row.id);
	changed.add(row.id);
}

async function keyStateRows(
	database: SqliteDatabaseLike,
	rows: readonly MemoryRow[],
	port: GroupCrudStateKeyingJudgementPort | undefined,
	changed: Set<string>,
	undecided: Set<string>,
	finalAttempt: boolean,
): Promise<void> {
	const update = database.prepare(
		"UPDATE nodix_memories SET attribute = ?, metadata = ? WHERE id = ?",
	);
	for (const row of rows) {
		if (row.category !== "state" || (row.attribute && stateSlugs.has(row.attribute))) continue;
		const metadata = readObject(row.metadata, `Memory row '${row.id}' metadata`);
		if (metadata[STATE_KEYING_DECISION] === "undecided") {
			undecided.add(row.id);
			continue;
		}
		let attribute = candidateStrings(row, metadata).find((value) => stateSlugs.has(value));
		if (!attribute && port) {
			const answer = await port.respond({ text: row.text, offeredSlugs: stateSlugList });
			if (answer !== null && !stateSlugs.has(answer)) {
				journalStateKeyingRefusal(database, row, answer);
			}
			if (answer === null || !stateSlugs.has(answer)) {
				undecided.add(row.id);
				// Persist the skip only on the final attempt, so a transient model failure on an
				// earlier attempt does not permanently block the row from being keyed on a later pass
				// — the same fail-open-until-final rule profile keying uses.
				if (finalAttempt) markStateKeyingUndecided(database, row, metadata, changed);
				continue;
			}
			attribute = answer;
		}
		if (!attribute) {
			undecided.add(row.id);
			continue;
		}
		metadata["topic"] = attribute;
		delete metadata["section_name"];
		delete metadata["keying_note"];
		delete metadata[STATE_KEYING_DECISION];
		update.run(attribute, JSON.stringify(metadata), row.id);
		changed.add(row.id);
		undecided.delete(row.id);
	}
}

function profileRecord(row: MemoryRow, metadata: Record<string, unknown>): AtomicKeyedRecord {
	const value = typeof metadata["value"] === "string" ? metadata["value"] : row.text;
	const storedSpan = metadata["source_span"];
	const quote =
		typeof storedSpan === "object" &&
		storedSpan !== null &&
		!Array.isArray(storedSpan) &&
		"quote" in storedSpan &&
		typeof storedSpan.quote === "string"
			? storedSpan.quote
			: row.text;
	return {
		category: "profile",
		kind: "standing",
		claimText: row.text,
		subject: "user",
		subjectKind: "user",
		attribute: null,
		value,
		temporalPhrase: null,
		time: { kind: "none" },
		endedTime: { kind: "none" },
		resolvedTime: null,
		endsCurrent: false,
	endedAtPhrase: null,
		endedAt: null,
		importance: "medium",
		changesCurrentState: false,
		todo: "none",
		closeReason: null,
		sourceSpan: { turnIndex: 0, quote, startOffset: 0, endOffset: quote.length },
		relations: [],
		singleClaim: true,
		lane: row.lane === "parked" ? "parked" : "active",
		dispositionReason: null,
		resplit: false,
	};
}

async function keyProfileRow(
	row: MemoryRow,
	metadata: Record<string, unknown>,
	transport: AtomicProfileKeyingTransport,
): Promise<string | null> {
	const record = profileRecord(row, metadata);
	const keyed = await runAtomicProfileKeying({
		baseRecords: [record],
		turns: [{ role: "user", content: record.sourceSpan?.quote ?? row.text }],
		projectId: row.projectId,
		transport,
	});
	const attribute = keyed[0]?.attribute;
	return typeof attribute === "string" && profileSlugs.has(attribute) ? attribute : null;
}

async function keyProfileRows(
	database: SqliteDatabaseLike,
	rows: readonly MemoryRow[],
	transport: AtomicProfileKeyingTransport | undefined,
	changed: Set<string>,
	undecided: Set<string>,
	finalAttempt: boolean,
): Promise<void> {
	const update = database.prepare(
		"UPDATE nodix_memories SET attribute = ?, metadata = ? WHERE id = ?",
	);
	for (const row of rows) {
		if (row.category !== "profile" || (row.attribute && profileSlugs.has(row.attribute))) continue;
		const metadata = readObject(row.metadata, `Memory row '${row.id}' metadata`);
		if (metadata[KEYING_DECISION] === "undecided") {
			undecided.add(row.id);
			continue;
		}
		if (row.subject !== "user" || !transport) {
			undecided.add(row.id);
			continue;
		}
		const attribute = await keyProfileRow(row, metadata, transport);
		if (!attribute) {
			undecided.add(row.id);
			if (finalAttempt) {
				metadata[KEYING_DECISION] = "undecided";
				update.run(null, JSON.stringify(metadata), row.id);
				changed.add(row.id);
			}
			continue;
		}
		metadata["section_name"] = attribute;
		delete metadata["keying_note"];
		delete metadata[KEYING_DECISION];
		update.run(attribute, JSON.stringify(metadata), row.id);
		changed.add(row.id);
		undecided.delete(row.id);
	}
}

function hasIdentityDecision(row: MemoryRow): boolean {
	const metadata = readObject(row.metadata, `Memory row '${row.id}' metadata`);
	const decision = metadata[IDENTITY_DECISION];
	return (
		decision === "new" ||
		(typeof metadata["merge_id"] === "string" && decision === metadata["merge_id"])
	);
}

function recordNewIdentityDecision(
	database: SqliteDatabaseLike,
	rows: readonly MemoryRow[],
	changed: Set<string>,
): void {
	const update = database.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?");
	for (const row of rows) {
		const metadata = readObject(row.metadata, `Memory row '${row.id}' metadata`);
		metadata[IDENTITY_DECISION] = "new";
		update.run(JSON.stringify(metadata), row.id);
		changed.add(row.id);
	}
}

function readEntities(database: SqliteDatabaseLike): EntityRow[] {
	return database
		.prepare(`
			SELECT project_id AS projectId, entity_id AS entityId, display_name AS displayName,
				normalized_name AS normalizedName
			FROM nodix_memory_entities
			ORDER BY project_id, created_at, entity_id
		`)
		.all() as EntityRow[];
}

function mergeRows(
	database: SqliteDatabaseLike,
	source: EntityRow,
	target: EntityRow,
	mergeId: string,
	changed: Set<string>,
): void {
	// Entity ids are unique per project, not globally: a merge in one project must not move
	// another project's rows.
	const rows = readRows(database).filter((row) => row.projectId === source.projectId);
	const sourceIds = new Set(
		rows.filter((row) => row.subject === source.entityId).map(({ id }) => id),
	);
	const update = database.prepare(
		"UPDATE nodix_memories SET subject = ?, metadata = ? WHERE id = ?",
	);
	for (const row of rows) {
		const metadata = readObject(row.metadata, `Memory row '${row.id}' metadata`);
		const sourceRow = row.subject === source.entityId;
		const sourceRowIsClosed = sourceRow && typeof metadata["superseded_by"] === "string";
		const closedBySource =
			typeof metadata["superseded_by"] === "string" && sourceIds.has(metadata["superseded_by"]);
		if (!sourceRow && !closedBySource) continue;
		if (sourceRow) {
			metadata["merge_id"] = mergeId;
			metadata[IDENTITY_DECISION] = mergeId;
		}
		if (sourceRowIsClosed || closedBySource) {
			metadata["close_merge_id"] = mergeId;
		}
		update.run(sourceRow ? target.entityId : row.subject, JSON.stringify(metadata), row.id);
		changed.add(row.id);
	}
	// Move the names, not only the rows written under them. `resolveAtomicMemoryEntity` answers
	// from this table by exact then normalized name and never re-asks the identity judgment, so a
	// merge that leaves a name pointing at the emptied entity is undone by the next write under
	// that name. EVERY name on the source moves, not just the one that was judged: an earlier
	// merge may already have aliased other names onto it, and leaving those behind points them at
	// an entity that now holds nothing. The table is keyed `(project_id, normalized_name)` and
	// `entity_id` is deliberately not unique — it exists so several names identify one entity.
	database
		.prepare(
			"UPDATE nodix_memory_entities SET entity_id = ? WHERE project_id = ? AND entity_id = ?",
		)
		.run(target.entityId, source.projectId, source.entityId);
}

function journalMerge(
	database: SqliteDatabaseLike,
	mergeId: string,
	source: EntityRow,
	target: EntityRow,
	offeredEntityIds: readonly string[],
): void {
	recordAtomicEntityIdentityJournal(database, {
		jobId: mergeId,
		outcome: "done",
		detail: {
			project_id: source.projectId,
			display_name: source.displayName,
			normalized_name: source.normalizedName,
			entity_id: target.entityId,
			merge_id: mergeId,
			offered_entity_ids: offeredEntityIds,
		},
	});
}

async function mergeSplitEntities(
	database: SqliteDatabaseLike,
	port: GroupCrudEntityIdentityJudgementPort | undefined,
	embedder: Pick<Embedder, "embed" | "embedMany"> | undefined,
	changed: Set<string>,
	undecided: Set<string>,
): Promise<number> {
	const entities = readEntities(database);
	// The candidate list comes from one snapshot read before the first judgment, so an entity this
	// pass has already emptied would keep being offered as somewhere to merge INTO. Answering with
	// one is a legal answer, and it moves the rows straight back out of the entity they were just
	// merged into: the two names then point at each other and the next write under either splits
	// the entity again. An emptied entity stops being offered.
	const mergedAway = new Set<string>();
	// An entity that has RECEIVED a merge this pass now holds rows that were re-subjected a moment
	// ago. It does not give a merge in the same pass; its own onward merge waits for the next run,
	// where its rows carry a settled identity.
	const mergedInto = new Set<string>();
	const entityKey = (entity: EntityRow): string => `${entity.projectId}\u0000${entity.entityId}`;
	for (const source of entities) {
		if (mergedAway.has(entityKey(source)) || mergedInto.has(entityKey(source))) continue;
		const sourceRows = readRows(database).filter(
			(row) => row.projectId === source.projectId && row.subject === source.entityId,
		);
		if (sourceRows.length === 0) continue;
		if (sourceRows.every(hasIdentityDecision)) continue;
		const candidates = entities.filter(
			(candidate) =>
				candidate.projectId === source.projectId &&
				candidate.entityId !== source.entityId &&
				!mergedAway.has(entityKey(candidate)),
		);
		if (candidates.length === 0) continue;
		if (!port) {
			for (const row of sourceRows) undecided.add(row.id);
			continue;
		}
		let offered = candidates;
		if (candidates.length > ENTITY_IDENTITY_CANDIDATE_LIMIT) {
			if (embedder === undefined) {
				throw new Error(
					`Entity identity judgement for '${source.displayName}' has ${candidates.length} candidates and no embedder to rank them`,
				);
			}
			offered = await rankAtomicMemoryEntityCandidates(embedder, source.displayName, candidates);
		}
		const answer = await port.respond({
			displayName: source.displayName,
			existingDisplayNames: offered,
		});
		if (answer.decision === "undecided") {
			for (const row of sourceRows) undecided.add(row.id);
			continue;
		}
		if (answer.decision === "new") {
			recordNewIdentityDecision(database, sourceRows, changed);
			continue;
		}
		const target = offered.find(({ entityId }) => entityId === answer.entityId);
		if (!target) throw new Error("Entity identity answer named an entity outside the offered set");
		const mergeId = randomUUID();
		const apply = database.transaction(() => {
			mergeRows(database, source, target, mergeId, changed);
			journalMerge(
				database,
				mergeId,
				source,
				target,
				offered.map(({ entityId }) => entityId),
			);
		});
		apply.immediate();
		mergedAway.add(entityKey(source));
		mergedInto.add(entityKey(target));
	}
	return 0;
}

function writeReceipt(
	database: SqliteDatabaseLike,
	beforeCount: number,
	afterCount: number,
	nowMs: number,
): void {
	database
		.prepare(`
			INSERT OR IGNORE INTO nodix_todo_migration_receipts(
				migration_id, before_count, after_count, migrated_at
			) VALUES (?, ?, ?, ?)
		`)
		.run(MIGRATION_ID, beforeCount, afterCount, nowMs);
}

export async function runGroupCrudMaintenancePass(
	input: RunGroupCrudMaintenancePassInput,
): Promise<GroupCrudMaintenanceReport> {
	applyStateCategoryMigration(input.database);
	// The maintenance command opens the store with the raw opener, so the startup chain that
	// re-keys the entity table by name has not run; a merge on the old (project_id, entity_id)
	// key would collide on the target's own row.
	applyEntityNameKeyMigration(input.database);
	const initialRows = readRows(input.database);
	const changed = new Set<string>();
	const undecided = new Set<string>();
	backfillSourceOrder(input.database, initialRows, changed);
	recategorizeEntityProfiles(input.database, readRows(input.database), changed);
	await keyStateRows(
		input.database,
		readRows(input.database),
		input.stateKeying,
		changed,
		undecided,
		false,
	);
	await keyProfileRows(
		input.database,
		readRows(input.database),
		input.profileKeying,
		changed,
		undecided,
		false,
	);
	const rolledBack = await mergeSplitEntities(
		input.database,
		input.identityJudgement,
		input.embedder,
		changed,
		undecided,
	);
	await keyProfileRows(
		input.database,
		readRows(input.database),
		input.profileKeying,
		changed,
		undecided,
		true,
	);
	// The final state-keying attempt of the pass: a row that failed keying the first time gets one
	// more try, and only now is a genuine failure persisted so a later pass skips it (REQ-11's
	// "a second full run reports zero changes").
	await keyStateRows(
		input.database,
		readRows(input.database),
		input.stateKeying,
		changed,
		undecided,
		true,
	);
	writeReceipt(
		input.database,
		initialRows.length,
		readRows(input.database).length,
		input.nowMs ?? Date.now(),
	);
	return {
		scanned: initialRows.length,
		changed: changed.size,
		undecided: undecided.size,
		rolledBack,
	};
}
