/** @file memory-store-task-lifecycle-migration-api.ts
 * @purpose Builds and atomically applies deterministic legacy active-task migration manifests.
 * @boundary Explicit one-time migration only; runtime extraction never calls this module.
 */

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	buildActiveTaskProjection,
	type ActiveTaskProjectionSource,
} from "../engine/extraction/active-task-projection";
import { hashLengthPrefixedTuple } from "../engine/extraction/task-lifecycle-assertion";
import {
	buildInsightMetadata,
	stringifyInsightMetadata,
} from "../engine/extraction/memory-metadata-codec";
import {
	MemoryStore,
	type MemoryStoreInternals,
	type TaskLifecycleMigrationApplyResult,
	type TaskLifecycleMigrationCensusRow,
	type TaskLifecycleMigrationManifest,
	type TaskLifecycleMigrationManifestRow,
	type TaskLifecycleMigrationSourceRow,
} from "./memory-store-base";
import {
	hashInputForEntry,
	StorageError,
	stableHash,
} from "./memory-store-shared";
import {
	hostTimezone,
	recordTokenCounter,
	validateStoreWriteMetadata,
} from "./memory-store-write-validation";

const digestPattern = /^[0-9a-f]{64}$/u;

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function assertDigest(label: string, value: string): void {
	if (!digestPattern.test(value)) throw new StorageError(`${label} must be a SHA-256 digest`);
}

function descriptionFor(
	row: TaskLifecycleMigrationSourceRow,
	descriptions: ReadonlyMap<string, string>,
): string {
	const description = descriptions.get(row.legacy_row_locator);
	if (!description) {
		throw new StorageError(`Migration source '${row.legacy_row_locator}' has no persisted text`);
	}
	return description;
}

function verifyCensusIdentity(
	sourceByLocator: ReadonlyMap<string, TaskLifecycleMigrationSourceRow>,
	row: TaskLifecycleMigrationCensusRow,
): void {
	const source = sourceByLocator.get(row.legacy_row_locator);
	if (!source || source.project_id !== row.project_id || source.legacy_status !== row.legacy_status) {
		throw new StorageError(`Migration census row '${row.legacy_row_locator}' mismatches its source`);
	}
	if (
		source.created_at_ms !== row.preserved_created_at_ms ||
		source.transitioned_at_ms !== row.preserved_transitioned_at_ms
	) {
		throw new StorageError(`Migration census times mismatch for '${row.legacy_row_locator}'`);
	}
	if (hashLengthPrefixedTuple(row.migration_group_tuple) !== row.migration_group_key) {
		throw new StorageError(`Migration group identity mismatch for '${row.legacy_row_locator}'`);
	}
	if (`ati_${hashLengthPrefixedTuple(row.migration_instance_tuple)}` !== row.active_task_id) {
		throw new StorageError(`Migration instance identity mismatch for '${row.legacy_row_locator}'`);
	}
	if (row.source_command_tuple === null) {
		if (row.command_id !== null || row.legacy_command_binding !== "preserved_unbound") {
			throw new StorageError(`Unbound migration row '${row.legacy_row_locator}' has a command`);
		}
	} else if (
		row.command_id !== hashLengthPrefixedTuple(row.source_command_tuple) ||
		row.legacy_command_binding !== "bound"
	) {
		throw new StorageError(`Bound migration command mismatch for '${row.legacy_row_locator}'`);
	}
	if (row.migration_revision_tuple === null) {
		if (row.active_task_revision_id !== null || row.revision_role !== "evidence_only") {
			throw new StorageError(`Evidence-only migration row '${row.legacy_row_locator}' has a revision`);
		}
	} else if (
		row.active_task_revision_id !==
		`atr_${hashLengthPrefixedTuple(row.migration_revision_tuple)}`
	) {
		throw new StorageError(`Migration revision identity mismatch for '${row.legacy_row_locator}'`);
	}
}

function verifyGrouping(
	sourceByLocator: ReadonlyMap<string, TaskLifecycleMigrationSourceRow>,
	rows: readonly TaskLifecycleMigrationCensusRow[],
): void {
	const groups = new Map<string, TaskLifecycleMigrationCensusRow[]>();
	for (const row of rows) {
		const group = groups.get(row.active_task_id) ?? [];
		group.push(row);
		groups.set(row.active_task_id, group);
	}
	for (const group of groups.values()) {
		if (group.length === 1) continue;
		const locators = new Set(group.map((row) => row.legacy_row_locator));
		const anchors = group.map((row) => {
			const provenance = sourceByLocator.get(row.legacy_row_locator)?.provenance;
			return typeof provenance?.explicit_occurrence_id === "string"
				? provenance.explicit_occurrence_id
				: undefined;
		});
		const anchor = anchors[0];
		const linked = group.every((row, index) => {
			const provenance = sourceByLocator.get(row.legacy_row_locator)?.provenance;
			const link =
				typeof provenance?.lifecycle_link === "string"
					? provenance.lifecycle_link
					: undefined;
			return index === 0 || (anchor !== undefined && anchors[index] === anchor && !!link && locators.has(link));
		});
		if (!linked) {
			throw new StorageError(
				`Migration group '${group[0]?.migration_group_key ?? "unknown"}' lacks exact occurrence linkage`,
			);
		}
	}
}

export function buildTaskLifecycleMigrationManifest(input: {
	manifestId: string;
	sourceRows: readonly TaskLifecycleMigrationSourceRow[];
	censusRows: readonly TaskLifecycleMigrationCensusRow[];
	inputStoreHash: string;
}): TaskLifecycleMigrationManifest {
	if (!input.manifestId.trim()) throw new StorageError("Migration manifest id is required");
	assertDigest("Migration input-store hash", input.inputStoreHash);
	if (sha256(JSON.stringify(input.sourceRows)) !== input.inputStoreHash) {
		throw new StorageError("Migration source rows do not match the declared input-store hash");
	}
	const sourceByLocator = new Map(
		input.sourceRows.map((row) => [row.legacy_row_locator, row] as const),
	);
	if (
		sourceByLocator.size !== input.sourceRows.length ||
		input.censusRows.length !== input.sourceRows.length
	) {
		throw new StorageError("Migration source and census must have one unique row per locator");
	}
	for (const row of input.censusRows) verifyCensusIdentity(sourceByLocator, row);
	verifyGrouping(sourceByLocator, input.censusRows);
	const rows = input.censusRows.map((census) => ({
		source: sourceByLocator.get(census.legacy_row_locator) as TaskLifecycleMigrationSourceRow,
		census,
	}));
	const payload = {
		schemaVersion: 1 as const,
		manifestId: input.manifestId,
		inputStoreHash: input.inputStoreHash,
		rows,
	};
	return { ...payload, manifestHash: sha256(JSON.stringify(payload)) };
}

function verifyManifest(manifest: TaskLifecycleMigrationManifest): void {
	const rebuilt = buildTaskLifecycleMigrationManifest({
		manifestId: manifest.manifestId,
		sourceRows: manifest.rows.map((row) => row.source),
		censusRows: manifest.rows.map((row) => row.census),
		inputStoreHash: manifest.inputStoreHash,
	});
	if (rebuilt.manifestHash !== manifest.manifestHash) {
		throw new StorageError("Migration manifest hash mismatch");
	}
}

function normalizeSourceLifecycle(events: readonly unknown[]): readonly unknown[] {
	return events.map((event) => {
		if (!event || typeof event !== "object") return event;
		const value = event as Record<string, unknown>;
		return {
			from: value.from,
			to: value.to,
			at: value.at ?? value.at_ms,
			source_id: value.source_id,
		};
	});
}

function verifySourceMetadata(
	source: TaskLifecycleMigrationSourceRow,
	metadata: Record<string, unknown>,
): void {
	const expected = {
		active_task_kind: "task",
		active_task_status: source.legacy_status,
		active_task_created_at: source.created_at_ms,
		active_task_transitioned_at: source.transitioned_at_ms,
		active_task_lifecycle: normalizeSourceLifecycle(source.ordered_lifecycle_events),
	};
	for (const [field, value] of Object.entries(expected)) {
		if (!isDeepStrictEqual(metadata[field], value)) {
			throw new StorageError(
				`Migration source row '${source.legacy_row_locator}' ${field} changed`,
			);
		}
	}

	const provenanceFields: Readonly<Record<string, string>> = {
		source_session: "source_session",
		session_key: "source_session",
		source_message_id: "source_message_id",
		replay_identity: "source_message_id",
		assertion_ordinal: "assertion_ordinal",
		legacy_idempotency_key: "idempotency_key",
		legacy_active_task_id: "active_task_id",
		active_task_origin: "active_task_origin",
		explicit_occurrence_id: "explicit_occurrence_id",
		lifecycle_link: "lifecycle_link",
	};
	for (const [sourceField, value] of Object.entries(source.provenance)) {
		if (sourceField === "binding_evidence") continue;
		const metadataField = provenanceFields[sourceField];
		if (!metadataField) {
			throw new StorageError(
				`Migration source row '${source.legacy_row_locator}' has unsupported provenance '${sourceField}'`,
			);
		}
		if (!isDeepStrictEqual(metadata[metadataField], value)) {
			throw new StorageError(
				`Migration source row '${source.legacy_row_locator}' ${metadataField} changed`,
			);
		}
	}
}

function readInputStoreHash(
	store: MemoryStoreInternals,
	manifest: TaskLifecycleMigrationManifest,
): { inputStoreHash: string; descriptions: Map<string, string> } {
	const descriptions = new Map<string, string>();
	const rows = manifest.rows.map(({ source }) => {
		const persisted = store.sqlite
			.prepare(
				`SELECT project_id AS projectId, text, metadata
				FROM nodix_memories
				WHERE id = ?`,
			)
			.get(source.legacy_row_locator) as
			| { projectId: string; text: string; metadata: string }
			| undefined;
		if (!persisted || persisted.projectId !== source.project_id) {
			throw new StorageError(`Migration source row '${source.legacy_row_locator}' is missing`);
		}
		if (
			(source.description !== undefined && persisted.text !== source.description) ||
			(source.description_sha256 !== undefined &&
				sha256(persisted.text) !== source.description_sha256)
		) {
			throw new StorageError(`Migration source row '${source.legacy_row_locator}' text changed`);
		}
		descriptions.set(source.legacy_row_locator, persisted.text);
		const metadata = store.parseMetadataObject(persisted.metadata);
		verifySourceMetadata(source, metadata);
		const sourceRowId = (
			source as TaskLifecycleMigrationSourceRow & { row_id?: unknown }
		).row_id;
		if (sourceRowId !== undefined && sourceRowId !== source.legacy_row_locator) {
			throw new StorageError(
				`Migration source row '${source.legacy_row_locator}' row id changed`,
			);
		}
		return source;
	});
	return { inputStoreHash: sha256(JSON.stringify(rows)), descriptions };
}

interface PreparedMigrationProjection {
	projectId: string;
	id: string;
	text: string;
	metadata: string;
	contentHash: string;
	chunks: Awaited<ReturnType<MemoryStoreInternals["prepareChunkInserts"]>>;
}

async function prepareProjections(
	store: MemoryStoreInternals,
	manifest: TaskLifecycleMigrationManifest,
	descriptions: ReadonlyMap<string, string>,
): Promise<PreparedMigrationProjection[]> {
	// An instance can carry several rows, and reading only the active ones puts a finished task
	// back on the active list: its completed or removed row is passed over and the stale active
	// one decides. The instance's own outcome wins, and it is read here exactly as the instance
	// write below reads it — any row of the instance that is not active settles it — so the list
	// this projects and the status that write records can never disagree.
	const settled = new Map<string, Set<string>>();
	for (const { source, census } of manifest.rows) {
		if (source.legacy_status === "active") continue;
		const byProject = settled.get(source.project_id) ?? new Set<string>();
		byProject.add(census.active_task_id);
		settled.set(source.project_id, byProject);
	}
	// Every project in the manifest gets a projection, including one the filter above empties.
	// `replaceProjections` invalidates a project's old projection only when a new one is built
	// for it, so a project whose last task settles here would otherwise keep serving the stale
	// active list that still names the finished task — the very thing this filter exists to stop.
	// An empty list is a projection like any other ("Active tasks: none").
	const sources = new Map<string, Map<string, ActiveTaskProjectionSource>>();
	for (const { source } of manifest.rows) {
		if (!sources.has(source.project_id)) sources.set(source.project_id, new Map());
	}
	for (const { source, census } of manifest.rows) {
		if (source.legacy_status !== "active" || census.revision_role !== "current") continue;
		if (settled.get(source.project_id)?.has(census.active_task_id)) continue;
		const byInstance = sources.get(source.project_id) ?? new Map();
		if (!byInstance.has(census.active_task_id)) {
			byInstance.set(census.active_task_id, {
				id: census.active_task_id,
				description: descriptionFor(source, descriptions),
				status: "active",
				createdAt: source.created_at_ms,
			});
		}
		sources.set(source.project_id, byInstance);
	}
	const prepared: PreparedMigrationProjection[] = [];
	for (const [projectId, byInstance] of sources) {
		const projection = buildActiveTaskProjection([...byInstance.values()]);
		const id = `atp_${hashLengthPrefixedTuple([
			"active-task-migration-projection-v1",
			projectId,
			manifest.manifestHash,
		])}`;
		const at = Math.max(
			...manifest.rows
				.filter((row) => row.source.project_id === projectId)
				.map((row) => row.source.transitioned_at_ms),
		);
		const metadata = stringifyInsightMetadata(
			buildInsightMetadata(
				{ text: projection.text, category: "profile", timestamp: at },
				{
					l0_abstract: "Active tasks",
					l1_overview: projection.text,
					l2_content: projection.text,
					tier: "core",
					access_count: 0,
					confidence: 0.85,
					last_accessed_at: at,
					asserted_at: at,
					valid_from: at,
					state: "confirmed",
					source: "legacy",
					injected_count: 0,
					bad_recall_count: 0,
					suppressed_until_turn: 0,
					section_name: "active_tasks",
					active_task_kind: "projection",
					active_task_ids: projection.taskIds,
					active_task_titles: projection.titles,
					idempotency_key: `task_lifecycle_migration_projection_${manifest.manifestHash}`,
					content_identity_key: `task_lifecycle_migration_projection_${manifest.manifestHash}`,
				},
			),
		);
		const validated = validateStoreWriteMetadata(
			{
				text: projection.text,
				category: "profile",
				metadata,
				timestamp: at,
				trusted: true,
				enforceWriteAuthority: true,
				lane: "active",
			},
			"task-lifecycle-migration-projection",
			await recordTokenCounter(store.embedder),
		);
		prepared.push({
			projectId,
			id,
			text: projection.text,
			metadata: validated.metadata,
			contentHash: stableHash(hashInputForEntry(projection.text, validated.metadata)),
			chunks: await store.prepareChunkInserts(id, projection.text),
		});
	}
	return prepared;
}

function insertBoundCommand(
	store: MemoryStoreInternals,
	source: TaskLifecycleMigrationSourceRow,
	census: TaskLifecycleMigrationCensusRow,
): void {
	if (!census.command_id || !census.source_command_tuple) return;
	store.sqlite
		.prepare(
			`INSERT INTO nodix_task_lifecycle_commands(
				project_id, command_id, canonical_tuple_json, identity_json, action,
				source_assertion_json, effective_at_ms, time_source, result,
				active_task_id, active_task_revision_id, diagnostics_json, created_at_ms
			) VALUES (?, ?, ?, ?, 'open_or_refine', ?, ?, 'first_resolution', ?, ?, ?, ?, ?)`,
		)
		.run(
			source.project_id,
			census.command_id,
			JSON.stringify(census.source_command_tuple),
			JSON.stringify({ kind: "authorized_untraced", canonicalTuple: census.source_command_tuple }),
			JSON.stringify(source),
			source.created_at_ms,
			census.revision_role === "evidence_only" ? "evidence_only" : "created_instance",
			census.active_task_id,
			census.active_task_revision_id,
			JSON.stringify({ migration: true, legacyRowLocator: source.legacy_row_locator }),
			source.created_at_ms,
		);
}

function applyRows(
	store: MemoryStoreInternals,
	manifest: TaskLifecycleMigrationManifest,
	descriptions: ReadonlyMap<string, string>,
): void {
	const byInstance = new Map<string, TaskLifecycleMigrationManifestRow[]>();
	for (const row of manifest.rows) {
		const key = `${row.source.project_id}\0${row.census.active_task_id}`;
		const group = byInstance.get(key) ?? [];
		group.push(row);
		byInstance.set(key, group);
		insertBoundCommand(store, row.source, row.census);
	}
	for (const group of byInstance.values()) {
		const first = group[0];
		if (!first) continue;
		const revisionRow = group.find((row) => row.census.active_task_revision_id !== null);
		const openingCommand = revisionRow?.census.command_id ?? null;
		const terminal = group.find((row) => row.source.legacy_status !== "active");
		store.sqlite
			.prepare(
				`INSERT INTO nodix_active_task_instances(
					project_id, active_task_id, opening_command_id, canonical_tuple_json,
					identity_state, status, created_at_ms, terminal_at_ms,
					legacy_row_locators_json, preserved_lifecycle_events_json,
					provenance_json, binding_evidence_json
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				first.source.project_id,
				first.census.active_task_id,
				openingCommand,
				JSON.stringify(first.census.migration_instance_tuple),
				group.some((row) => row.census.legacy_command_binding === "preserved_unbound")
					? "unresolved"
					: "normal",
				terminal?.source.legacy_status ?? "active",
				Math.min(...group.map((row) => row.source.created_at_ms)),
				terminal
					? Math.max(...group.map((row) => row.source.transitioned_at_ms))
					: null,
				JSON.stringify(group.map((row) => row.source.legacy_row_locator)),
				JSON.stringify(
					group.flatMap((row) => row.source.ordered_lifecycle_events ?? []),
				),
				JSON.stringify(group.map((row) => row.source.provenance ?? null)),
				JSON.stringify(group.map((row) => row.source.binding_evidence ?? null)),
			);
	}
	for (const { source, census } of manifest.rows) {
		if (census.active_task_revision_id && census.migration_revision_tuple) {
			const explicitOccurrenceId =
				typeof source.provenance?.explicit_occurrence_id === "string"
					? source.provenance.explicit_occurrence_id
					: undefined;
			store.sqlite
				.prepare(
					`INSERT INTO nodix_active_task_revisions(
						project_id, active_task_revision_id, active_task_id, creating_command_id,
						canonical_tuple_json, description, occurrence_anchors_json,
						revision_details_json, created_at_ms, is_current, legacy_row_locator
					) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
				)
				.run(
					source.project_id,
					census.active_task_revision_id,
					census.active_task_id,
					census.command_id,
					JSON.stringify(census.migration_revision_tuple),
					descriptionFor(source, descriptions),
					JSON.stringify(explicitOccurrenceId ? { explicitOccurrenceId } : {}),
					source.created_at_ms,
					Number(census.revision_role === "current"),
					source.legacy_row_locator,
				);
		}
		store.sqlite
			.prepare(
				`INSERT INTO nodix_active_task_migration_evidence(
					project_id, legacy_row_locator, active_task_id, command_id,
					source_row_json, revision_role, preserved_unbound
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				source.project_id,
				source.legacy_row_locator,
				census.active_task_id,
				census.command_id,
				JSON.stringify(source),
				census.revision_role,
				Number(census.legacy_command_binding === "preserved_unbound"),
			);
		const persisted = store.sqlite
			.prepare("SELECT metadata FROM nodix_memories WHERE id = ?")
			.get(source.legacy_row_locator) as { metadata: string };
		const metadata = store.parseMetadataObject(persisted.metadata);
		store.sqlite
			.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?")
			.run(
				JSON.stringify({
					...metadata,
					invalidated_at: source.transitioned_at_ms,
					task_lifecycle_migrated_to: census.active_task_id,
				}),
				source.legacy_row_locator,
			);
	}
}

function replaceProjections(
	store: MemoryStoreInternals,
	manifest: TaskLifecycleMigrationManifest,
	projections: readonly PreparedMigrationProjection[],
): void {
	const invalidatedAt = Math.max(...manifest.rows.map((row) => row.source.transitioned_at_ms));
	for (const projection of projections) {
		const current = store.sqlite
			.prepare(
				`SELECT id, metadata FROM nodix_memories
				WHERE project_id = ? AND category = 'profile' AND json_valid(metadata)
					AND json_extract(metadata, '$.active_task_kind') = 'projection'
					AND json_extract(metadata, '$.invalidated_at') IS NULL`,
			)
			.all(projection.projectId) as Array<{ id: string; metadata: string }>;
		for (const row of current) {
			store.sqlite
				.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?")
				.run(
					JSON.stringify({
						...store.parseMetadataObject(row.metadata),
						invalidated_at: invalidatedAt,
						superseded_by: projection.id,
					}),
					row.id,
				);
		}
		store.sqlite
			.prepare(
				`INSERT INTO nodix_memories(
					id, text, category, project_id, importance, timestamp, timezone, metadata,
					content_hash, fact_id, maturity, source, extractor_version
				) VALUES (?, ?, 'profile', ?, 0.7, ?, ?, ?, ?, ?,
					'extracted', 'manual', 'task-lifecycle-migration')`,
			)
			.run(
				projection.id,
				projection.text,
				projection.projectId,
				Math.max(
					...manifest.rows
						.filter((row) => row.source.project_id === projection.projectId)
						.map((row) => row.source.transitioned_at_ms),
				),
				hostTimezone(),
				projection.metadata,
				projection.contentHash,
				projection.id,
			);
		store.writeChunkRowsSync(projection.chunks, projection.projectId);
	}
}

function migrationStateHash(store: MemoryStoreInternals, manifest: TaskLifecycleMigrationManifest): string {
	const projects = [...new Set(manifest.rows.map((row) => row.source.project_id))].toSorted();
	const state = projects.map((projectId) => ({
		projectId,
		instances: store.sqlite
			.prepare(
				"SELECT * FROM nodix_active_task_instances WHERE project_id = ? ORDER BY active_task_id",
			)
			.all(projectId),
		revisions: store.sqlite
			.prepare(
				"SELECT * FROM nodix_active_task_revisions WHERE project_id = ? ORDER BY active_task_revision_id",
			)
			.all(projectId),
		evidence: store.sqlite
			.prepare(
				"SELECT * FROM nodix_active_task_migration_evidence WHERE project_id = ? ORDER BY legacy_row_locator",
			)
			.all(projectId),
		projections: store.sqlite
			.prepare(
				`SELECT id, text, metadata FROM nodix_memories
				WHERE project_id = ? AND json_valid(metadata)
					AND json_extract(metadata, '$.active_task_kind') = 'projection'
					AND json_extract(metadata, '$.invalidated_at') IS NULL
				ORDER BY id`,
			)
			.all(projectId),
	}));
	return sha256(JSON.stringify(state));
}

function readPersistedMigration(
	store: MemoryStoreInternals,
	manifest: TaskLifecycleMigrationManifest,
): TaskLifecycleMigrationApplyResult | undefined {
	const existing = store.sqlite
		.prepare(
			"SELECT manifest_hash AS manifestHash, input_store_hash AS inputStoreHash, state_hash AS stateHash FROM nodix_active_task_migration_manifests WHERE manifest_id = ?",
		)
		.get(manifest.manifestId) as
		| { manifestHash: string; inputStoreHash: string; stateHash: string }
		| undefined;
	if (!existing) return undefined;
	if (
		existing.manifestHash !== manifest.manifestHash ||
		existing.inputStoreHash !== manifest.inputStoreHash
	) {
		throw new StorageError("Migration manifest id is already bound to different input");
	}
	return {
		manifestHash: manifest.manifestHash,
		stateHash: existing.stateHash,
		rowCount: manifest.rows.length,
		replayed: true,
	};
}

Object.assign(MemoryStore.prototype, {
	async applyTaskLifecycleMigration(
		this: MemoryStoreInternals,
		manifest: TaskLifecycleMigrationManifest,
	): Promise<TaskLifecycleMigrationApplyResult> {
		verifyManifest(manifest);
		const existing = readPersistedMigration(this, manifest);
		if (existing) return existing;
		const preparedInput = readInputStoreHash(this, manifest);
		if (preparedInput.inputStoreHash !== manifest.inputStoreHash) {
			throw new StorageError("Migration input-store hash changed; generate a new manifest");
		}
		const projections = await prepareProjections(this, manifest, preparedInput.descriptions);
		return this.writeMutex.runExclusive(() => {
			const concurrentReplay = readPersistedMigration(this, manifest);
			if (concurrentReplay) return concurrentReplay;
			const transactionInput = readInputStoreHash(this, manifest);
			if (transactionInput.inputStoreHash !== manifest.inputStoreHash) {
				throw new StorageError("Migration input-store hash changed; generate a new manifest");
			}
			const transaction = this.sqlite.transaction(() => {
				applyRows(this, manifest, transactionInput.descriptions);
				replaceProjections(this, manifest, projections);
				const stateHash = migrationStateHash(this, manifest);
				this.sqlite
					.prepare(
						"INSERT INTO nodix_active_task_migration_manifests(manifest_id, manifest_hash, input_store_hash, state_hash, applied_at_ms) VALUES (?, ?, ?, ?, ?)",
					)
					.run(
						manifest.manifestId,
						manifest.manifestHash,
						manifest.inputStoreHash,
						stateHash,
						Date.now(),
					);
				return stateHash;
			});
			const stateHash = transaction.immediate() as string;
			return {
				manifestHash: manifest.manifestHash,
				stateHash,
				rowCount: manifest.rows.length,
				replayed: false,
			};
		});
	},
});
