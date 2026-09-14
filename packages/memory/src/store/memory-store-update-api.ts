/** @file memory-store-update-api.ts
 * @purpose Applies mutable field updates and chunk rewrites for existing memories.
 * @boundary Prototype-mounted MemoryStore methods; no constructor state ownership.
 */

import {
	allowedWriters,
	canExtractorWrite,
	type WriterAuthority,
} from "../engine/shared/memory-kind-policy";
import {
	type MemoryCategory,
	type MemoryMetadata,
	type MemoryTier,
	MEMORY_CATEGORIES,
	normalizeCategory,
} from "../engine/shared/types";
import {
	MemoryStore,
	StaleSupersedeTargetError,
	type MemoryStoreInternals,
} from "./memory-store-base";
import {
	sanitizeMemoryMetadataObject,
	sanitizeUpdateChanges,
} from "./content-sanitizer-bridge";
import {
	assertMetadataOnlyUpdatePreservesHashInput,
	clamp01,
	DEFAULT_IMPORTANCE,
	hashInputForEntry,
	log,
	type MemoryEntry,
	type MemoryRow,
	type ReflectionResolveOutcome,
	StorageError,
	stableHash,
	type UpdateChanges,
} from "./memory-store-shared";
import { recordTokenCounter, validateStoreWriteMetadata } from "./memory-store-write-validation";
import { parseInsightMetadata } from "../engine/extraction/memory-metadata-codec";

type MetadataRow = { id: string; category: MemoryCategory; metadata: string | null };

const LIFECYCLE_METADATA_KEYS = [
	"invalidated_at",
	"superseded_by",
	"supersedes",
	"fact_key",
	"section_name",
	"support_info",
	"active_task_status",
	"active_task_transitioned_at",
	"active_task_lifecycle",
] as const;

function valuesDiffer(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) !== JSON.stringify(right);
}

function changedLifecycleKeys(
	current: Record<string, unknown>,
	next: Record<string, unknown>,
): string[] {
	return LIFECYCLE_METADATA_KEYS.filter((key) => valuesDiffer(current[key], next[key]));
}

const STORAGE_AXIS_KEYS = ["kind", "memory_category", "state", "tier"] as const;
type StorageAxisMetadata = Partial<
	Record<(typeof STORAGE_AXIS_KEYS)[number], unknown>
>;

function assertStorageAxesUnchanged(
	current: StorageAxisMetadata,
	next: StorageAxisMetadata,
	operation: string,
): void {
	const changed = STORAGE_AXIS_KEYS.filter((key) => valuesDiffer(current[key], next[key]));
	if (changed.length === 0) return;
	throw new StorageError(
		`${operation}: storage axis mutations require offline-family authority (${changed.join(", ")})`,
	);
}

function assertNotLegacyTaskRow(current: unknown): void {
	if (
		typeof current !== "object" ||
		current === null ||
		!("active_task_kind" in current) ||
		current.active_task_kind !== "task"
	) {
		return;
	}
	throw new StorageError(
		"active-task metadata rows are read-only after the lifecycle hard cut",
	);
}

function assertWriterAuthority(
	category: MemoryCategory,
	writerAuthority: WriterAuthority,
	operation: string,
): void {
	const writers = allowedWriters(category);
	if (writers.includes(writerAuthority)) return;
	if (writers.length === 1 && writers[0] === "offline-family") {
		throw new StorageError(
			`${operation}: memory category "${category}" requires offline-family authority`,
		);
	}
	throw new StorageError(
		`${operation}: writer "${writerAuthority}" cannot mutate memory category "${category}"; allowed writers: ${writers.join(", ")}`,
	);
}

function assertGenericMetadataWriteAuthority(category: MemoryCategory, operation: string): void {
	if (canExtractorWrite(category)) return;
	assertWriterAuthority(category, "extraction", operation);
}

function assertActiveTaskUpdate(
	existingText: string,
	nextText: string,
	current: Record<string, unknown>,
	next: Record<string, unknown>,
): void {
	void existingText;
	void nextText;
	void next;
	assertNotLegacyTaskRow(current);
}

/**
 * Read existing metadata JSON for a row inside an open mutex. Returns the
 * parsed object plus the row id, or undefined when the row is missing.
 */
function readMetadataRow(
	internals: MemoryStoreInternals,
	id: string,
): { row: MetadataRow; current: MemoryMetadata } | undefined {
	const row = internals.sqlite
		.prepare("SELECT id, category, metadata FROM nodix_memories WHERE id = ? LIMIT 1")
		.get(id) as MetadataRow | undefined;
	if (!row) return undefined;
	let current: MemoryMetadata = {};
	if (row.metadata !== null && row.metadata !== "") {
		try {
			const parsed = JSON.parse(row.metadata) as unknown;
			if (typeof parsed === "object" && parsed !== null) {
				current = parsed as MemoryMetadata;
			}
		} catch {
			// Treat malformed JSON as empty so the writer can lazy-heal the row.
			current = {};
		}
	}
	return { row, current };
}

/**
 * Merge a metadata patch on top of the current metadata. Top-level keys are
 * shallow-merged; the `intrinsic` sub-object is deep-merged so callers can
 * patch confidence without dropping importance.
 */
function mergeMetadata(
	current: MemoryMetadata,
	patch: Partial<MemoryMetadata>,
): MemoryMetadata {
	const merged: MemoryMetadata = { ...current, ...patch };
	if (patch.intrinsic !== undefined) {
		merged.intrinsic = { ...(current.intrinsic ?? {}), ...patch.intrinsic };
	}
	return merged;
}

Object.assign(MemoryStore.prototype, {
	async update(
		this: MemoryStoreInternals,
		id: string,
		changes: UpdateChanges,
	): Promise<MemoryEntry | null> {
		const countRecordTokens = await recordTokenCounter(this.embedder);
		// Log operational context for storage without changing control flow.
		log.debug("updating memory", { memory_id: id }, {
			event_name: "sno_station_mem.memory-store-update-api.updating.memory",
			file: "packages/sno-station-mem/src/store/memory-store-update-api.ts",
			function: "update",
			site_id: "memory-store-update-api.update.31162cf4e4",
		});
		if (Object.keys(changes).length === 0) {
			return (await this.getById(id)) ?? null;
		}
		const safeChanges = sanitizeUpdateChanges(changes);
		if ((safeChanges.timestamp === undefined) !== (safeChanges.timezone === undefined)) {
			throw new StorageError("update: timestamp and timezone must change together");
		}
		const writerAuthority = safeChanges.writerAuthority ?? "extraction";
		if (safeChanges.text !== undefined) {
			const atomicRow = this.sqlite
				.prepare(
					"SELECT extractor_version AS extractorVersion FROM nodix_memories WHERE id = ? LIMIT 1",
				)
				.get(id) as { extractorVersion: string | null } | undefined;
			if (atomicRow?.extractorVersion) {
				throw new StorageError("Atomic memory text is immutable; create a new card");
			}
		}

		// When text is being changed, empty/whitespace text would leave the
		// row with zero chunks (no vec/FTS rows), breaking the
		// parent+chunks invariant. Metadata-only updates are unaffected.
		if (safeChanges.text !== undefined && safeChanges.text.trim().length === 0) {
			throw new StorageError("Cannot store memory with empty text");
		}

		// Round B-2: `changes.vector` is intentionally ignored for back-compat.
		// When `changes.text` is supplied the store re-chunks and re-embeds.

		// Pre-embed chunks for the new text BEFORE entering the synchronous
		// transaction. We don't yet know the existing row, but `changes.text`
		// being defined is what triggers chunk regeneration.
		const chunkRows =
			safeChanges.text !== undefined ? await this.prepareChunkInserts(id, safeChanges.text) : [];

		return this.writeMutex.runExclusive(() => {
			const existing = this.sqlite
				.prepare(
					"SELECT id, text, category, project_id AS projectId, importance, timestamp, timezone, metadata, content_hash, fact_id, lane, raw_candidate_json, disposition_reason, dispositioned_at_ms FROM nodix_memories WHERE id = ? LIMIT 1",
				)
				.get(id) as MemoryRow | undefined;
			if (!existing) return null;
			if (
				(safeChanges.expectedContentHash !== undefined &&
					existing.content_hash !== safeChanges.expectedContentHash) ||
				(safeChanges.expectedMetadata !== undefined &&
					existing.metadata !== safeChanges.expectedMetadata)
			) {
				const staleMetadata = this.parseMetadataObject(existing.metadata);
				if (
					staleMetadata.active_task_kind === "task" &&
					typeof staleMetadata.fact_key === "string"
				) {
					throw new StaleSupersedeTargetError(staleMetadata.fact_key, id);
				}
				throw new StorageError(`Cannot update changed memory '${id}'`);
			}

			const nextText = safeChanges.text ?? existing.text;
			const nextImportance = clamp01(
				safeChanges.importance ?? existing.importance,
				DEFAULT_IMPORTANCE,
			);
			const nextTimestamp = safeChanges.timestamp ?? existing.timestamp;
			const existingCategory = normalizeCategory(existing.category);
			if (!existingCategory) {
				throw new StorageError(`update: stored memory category "${existing.category}" is invalid`);
			}
			const currentMetadata = this.parseMetadataObject(existing.metadata);
			assertNotLegacyTaskRow(currentMetadata);
			assertWriterAuthority(existingCategory, writerAuthority, "update.existingCategory");
			const requestedCategory = safeChanges.category ?? existingCategory;
			const targetCategory = normalizeCategory(requestedCategory);
			if (!targetCategory) {
				throw new StorageError(
					`update: memory category must be one of ${MEMORY_CATEGORIES.join(", ")}`,
				);
			}
			assertWriterAuthority(targetCategory, writerAuthority, "update");
			const validated = validateStoreWriteMetadata(
				{
					text: nextText,
					category: targetCategory,
					metadata: safeChanges.metadata ?? existing.metadata ?? "{}",
					timestamp: nextTimestamp,
					timezone: safeChanges.timezone ?? existing.timezone,
					enforceWriteAuthority: false,
					offlineFamily: writerAuthority === "offline-family",
					lane:
						existing.lane === "parked" || existing.lane === "quarantined"
							? existing.lane
							: "active",
				},
				"update",
				countRecordTokens,
			);
			const nextCategory = validated.category;
			const nextMetadata = validated.metadata;
			const nextTimezone = validated.timezone;
			const nextMetadataObject = this.parseMetadataObject(nextMetadata);
			if (writerAuthority !== "offline-family") {
				// Compare the axes after the same normalization the next metadata went through: a row
				// whose stored JSON omits `state`/`tier` carries their defaults, and reading it raw made
				// every online metadata update on such a row look like an axis change and refuse.
				const currentAxes: StorageAxisMetadata = parseInsightMetadata(existing.metadata ?? undefined, {
					text: existing.text, category: existingCategory, timestamp: existing.timestamp,
					metadata: existing.metadata ?? undefined,
				});
				assertStorageAxesUnchanged(currentAxes, nextMetadataObject, "update");
			}
			assertActiveTaskUpdate(existing.text, nextText, currentMetadata, nextMetadataObject);
			// PRD §4.2 reflection v3: include mappedKind discriminator from metadata
			// in hash input so update() preserves the (projectId, content_hash, category)
			// dedup invariant established by store() / bulkStore(). Without this an
			// updated row could collide with rows of a different mappedKind that
			// happen to hash the same text body.
			const nextHash = stableHash(hashInputForEntry(nextText, nextMetadata));
			const topLevelChangedKeys: string[] = [];
			if (safeChanges.text !== undefined && nextText !== existing.text) {
				topLevelChangedKeys.push("text");
			}
			if (safeChanges.category !== undefined && nextCategory !== existing.category) {
				topLevelChangedKeys.push("category");
			}
			if (safeChanges.importance !== undefined && nextImportance !== existing.importance) {
				topLevelChangedKeys.push("importance");
			}
			if (nextTimestamp !== existing.timestamp) topLevelChangedKeys.push("timestamp");
			if (nextTimezone !== existing.timezone) topLevelChangedKeys.push("timezone");
			if (nextHash !== existing.content_hash) {
				topLevelChangedKeys.push("content_hash");
			}
			const lifecycleKeys = changedLifecycleKeys(currentMetadata, nextMetadataObject);
			const shouldEmitUpdate = topLevelChangedKeys.length > 0 || lifecycleKeys.length > 0;
			const factId = existing.fact_id ?? existing.id;

			// Guard against creating a duplicate (projectId, content_hash, category)
			// triple. PRD §4.2 — store/bulkStore intentionally allow the same
			// text-hash to coexist across distinct categories, so a category-
			// only update can collide with a sibling row even when nextHash
			// equals the stored hash. The collision check therefore runs when
			// EITHER the hash OR the category changes; otherwise the UPDATE
			// would fall through to the SQLite UNIQUE constraint and raise a
			// generic driver error instead of the typed StorageError.
			if (nextHash !== existing.content_hash || nextCategory !== existing.category) {
				const collision = this.sqlite
					.prepare(
						"SELECT id FROM nodix_memories WHERE project_id = ? AND content_hash = ? AND category = ? AND id != ? LIMIT 1",
					)
					.get(existing.projectId, nextHash, nextCategory, id) as {
					id: string;
				} | null;
				if (collision) {
					throw new StorageError(
						`Cannot update: another memory in projectId '${existing.projectId}' already has the same content (id: ${collision.id})`,
					);
				}
			}

			// Keep related table mutations in one transaction so side tables cannot drift.
			this.sqlite.transaction(() => {
				if (safeChanges.expectedAbsentFactKey !== undefined) {
					const activeTarget = this.sqlite
						.prepare(
							"SELECT id FROM nodix_memories WHERE lane = 'active' AND project_id = ? AND json_valid(metadata) AND json_extract(metadata, '$.fact_key') = ? AND json_extract(metadata, '$.invalidated_at') IS NULL LIMIT 1",
						)
						.get(existing.projectId, safeChanges.expectedAbsentFactKey) as
						| { id: string }
						| undefined;
					if (activeTarget) {
						throw new StaleSupersedeTargetError(safeChanges.expectedAbsentFactKey, null);
					}
				}
				const sourceEventId = this.telemetryEvents.readLatestReceiptEventId(factId);
				this.sqlite
					.prepare(
						"UPDATE nodix_memories SET text = ?, category = ?, importance = ?, timestamp = ?, timezone = ?, metadata = ?, content_hash = ? WHERE id = ?",
					)
					.run(
						nextText,
						nextCategory,
						nextImportance,
						nextTimestamp,
						nextTimezone,
						nextMetadata,
						nextHash,
						id,
					);

				if (safeChanges.text !== undefined) {
					this.deleteChunksByMemoryIdsSync([id]);
					this.writeChunkRowsSync(chunkRows, existing.projectId);
				}
				if (shouldEmitUpdate && topLevelChangedKeys.includes("content_hash")) {
					this.telemetryEvents.writeReceiptEvent({
						eventType: "update",
						factId,
						memoryKind: nextCategory,
						projectId: existing.projectId,
						sourceEventId,
						contentHash: nextHash,
						metadata: {
							changed_keys: topLevelChangedKeys,
							...(lifecycleKeys.length > 0 ? { changed_lifecycle_keys: lifecycleKeys } : {}),
							content_hash: nextHash,
						},
					});
				} else if (shouldEmitUpdate) {
					this.telemetryEvents.writeLifecycleEvent({
						eventType: "update",
						factId,
						memoryKind: nextCategory,
						projectId: existing.projectId,
						sourceEventId,
						...(typeof nextMetadataObject.active_task_transitioned_at === "number"
							? { timestampMs: nextMetadataObject.active_task_transitioned_at }
							: {}),
						metadata: {
							...(topLevelChangedKeys.length > 0 ? { changed_keys: topLevelChangedKeys } : {}),
							...(lifecycleKeys.length > 0 ? { changed_lifecycle_keys: lifecycleKeys } : {}),
						},
					});
				}
			}).immediate();

			return {
				id,
				text: nextText,
				category: nextCategory,
				projectId: existing.projectId,
				importance: nextImportance,
				timestamp: nextTimestamp,
				timezone: nextTimezone,
				metadata: nextMetadata,
				contentHash: nextHash,
				// Hand-built entry, so it does not inherit the codec's fact_id handling.
				// An update that dropped it made the updated row indistinguishable from a
				// row that never had one, and recall telemetry then discarded the event.
				...(existing.fact_id ? { factId: existing.fact_id } : {}),
				lane:
					existing.lane === "parked" || existing.lane === "quarantined"
						? existing.lane
						: "active",
				...(existing.raw_candidate_json
					? { rawCandidateJson: existing.raw_candidate_json }
					: {}),
				...(existing.disposition_reason
					? { dispositionReason: existing.disposition_reason }
					: {}),
				...(existing.dispositioned_at_ms === null || existing.dispositioned_at_ms === undefined
					? {}
					: { dispositionedAt: existing.dispositioned_at_ms }),
			};
		});
	},

	async updateTier(
		this: MemoryStoreInternals,
		memoryId: string,
		newTier: MemoryTier,
		options?: { writerAuthority?: "offline-family" },
	): Promise<void> {
		log.debug("updating tier", { memory_id: memoryId, tier: newTier }, {
			event_name: "sno_station_mem.memory-store-update-api.updating.tier",
			file: "packages/sno-station-mem/src/store/memory-store-update-api.ts",
			function: "updateTier",
			site_id: "memory-store-update-api.updateTier.feb5a5165b",
		});
		const writerAuthority = options?.writerAuthority;
		if (writerAuthority !== "offline-family") {
			throw new StorageError("updateTier: storage axis mutations require offline-family authority");
		}
		await this.writeMutex.runExclusive(() => {
			const read = readMetadataRow(this, memoryId);
			if (!read) return;
			assertNotLegacyTaskRow(read.current);
			assertWriterAuthority(read.row.category, writerAuthority, "updateTier");
			const next = sanitizeMemoryMetadataObject(mergeMetadata(read.current, { tier: newTier }));
			assertMetadataOnlyUpdatePreservesHashInput("updateTier", read.current, next);
			this.sqlite
				.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?")
				.run(JSON.stringify(next), memoryId);
		});
	},

	async updateMetadata(
		this: MemoryStoreInternals,
		memoryId: string,
		patch: Partial<MemoryMetadata>,
	): Promise<void> {
		log.debug("updating metadata", { memory_id: memoryId }, {
			event_name: "sno_station_mem.memory-store-update-api.updating.metadata",
			file: "packages/sno-station-mem/src/store/memory-store-update-api.ts",
			function: "updateMetadata",
			site_id: "memory-store-update-api.updateMetadata.6e33353e47",
		});
		await this.writeMutex.runExclusive(() => {
			const read = readMetadataRow(this, memoryId);
			if (!read) return;
			assertNotLegacyTaskRow(read.current);
			assertGenericMetadataWriteAuthority(read.row.category, "updateMetadata");
			const next = sanitizeMemoryMetadataObject(mergeMetadata(read.current, patch));
			assertStorageAxesUnchanged(read.current, next, "updateMetadata");
			assertMetadataOnlyUpdatePreservesHashInput("updateMetadata", read.current, next);
			this.sqlite
				.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?")
				.run(JSON.stringify(next), memoryId);
		});
	},

	async resolveReflectionItem(
		this: MemoryStoreInternals,
		memoryId: string,
		opts: {
			resolvedAt: number;
			resolvedBy?: string;
			note?: string;
			writerAuthority?: "offline-family";
		},
	): Promise<ReflectionResolveOutcome> {
		log.debug("resolving reflection item", { memory_id: memoryId }, {
			event_name: "sno_station_mem.memory-store-update-api.resolving.reflection.item",
			file: "packages/sno-station-mem/src/store/memory-store-update-api.ts",
			function: "resolveReflectionItem",
			site_id: "memory-store-update-api.resolveReflectionItem.f1d6aa0eab",
		});
		return this.writeMutex.runExclusive(() => {
			const read = readMetadataRow(this, memoryId);
			if (!read) return "not_found";
			const current: Record<string, unknown> = { ...read.current };
			assertNotLegacyTaskRow(current);
			if (current.type !== "memory-reflection-item") return "not_reflection_item";
			if (current.resolvedAt !== undefined) return "already_resolved";
			if (opts.writerAuthority !== "offline-family") {
				throw new StorageError(
					"resolveReflectionItem: reflection metadata requires offline-family authority",
				);
			}
			assertWriterAuthority(read.row.category, opts.writerAuthority, "resolveReflectionItem");
			// Only the three reflection-resolution fields are written — never
			// hash-significant keys such as `mappedKind`.
			const next: Record<string, unknown> = { ...current, resolvedAt: opts.resolvedAt };
			if (opts.resolvedBy) next.resolvedBy = opts.resolvedBy;
			if (opts.note) next.resolutionNote = opts.note;
			const sanitizedNext = sanitizeMemoryMetadataObject(next);
			assertMetadataOnlyUpdatePreservesHashInput(
				"resolveReflectionItem",
				current,
				sanitizedNext,
			);
			this.sqlite
				.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?")
				.run(JSON.stringify(sanitizedNext), memoryId);
			return "resolved";
		});
	},

	/**
	 * Batched sibling of applyMetadataDelta: ONE mutex acquisition + ONE IMMEDIATE
	 * transaction for the whole batch (the access tracker previously paid a
	 * mutex+transaction per recalled id). A deltaFn returning undefined skips its
	 * row (rate-limited or unchanged); missing rows are skipped silently.
	 */
	async applyMetadataDeltas(
		this: MemoryStoreInternals,
		entries: Array<{
			memoryId: string;
			deltaFn: (current: MemoryMetadata) => Partial<MemoryMetadata> | undefined;
		}>,
	): Promise<void> {
		if (entries.length === 0) return;
		log.debug("applying metadata deltas", { count: entries.length }, {
			event_name: "sno_station_mem.memory-store-update-api.applying.metadata.deltas",
			file: "packages/sno-station-mem/src/store/memory-store-update-api.ts",
			function: "applyMetadataDeltas",
			site_id: "memory-store-update-api.applyMetadataDeltas.49983b35b4",
		});
		await this.writeMutex.runExclusive(() => {
			this.sqlite
				.transaction(() => {
					for (const entry of entries) {
						const read = readMetadataRow(this, entry.memoryId);
						if (!read) continue;
						assertNotLegacyTaskRow(read.current);
						assertGenericMetadataWriteAuthority(read.row.category, "applyMetadataDeltas");
						const patch = entry.deltaFn(read.current);
						if (patch === undefined) continue;
						const next = sanitizeMemoryMetadataObject(mergeMetadata(read.current, patch));
						assertStorageAxesUnchanged(read.current, next, "applyMetadataDeltas");
						assertMetadataOnlyUpdatePreservesHashInput(
							"applyMetadataDeltas",
							read.current,
							next,
						);
						this.sqlite
							.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?")
							.run(JSON.stringify(next), entry.memoryId);
					}
				})
				.immediate();
		});
	},

	async applyMetadataDelta(
		this: MemoryStoreInternals,
		memoryId: string,
		deltaFn: (current: MemoryMetadata) => Partial<MemoryMetadata>,
	): Promise<void> {
		log.debug("applying metadata delta", { memory_id: memoryId }, {
			event_name: "sno_station_mem.memory-store-update-api.applying.metadata.delta",
			file: "packages/sno-station-mem/src/store/memory-store-update-api.ts",
			function: "applyMetadataDelta",
			site_id: "memory-store-update-api.applyMetadataDelta.6961c06549",
		});
		await this.writeMutex.runExclusive(() => {
			const read = readMetadataRow(this, memoryId);
			if (!read) return;
			assertNotLegacyTaskRow(read.current);
			assertGenericMetadataWriteAuthority(read.row.category, "applyMetadataDelta");
			// deltaFn must be synchronous — the lock is held across the call so a
			// returned Promise would not be awaited and concurrent callers could
			// lose updates. Any throw propagates to the caller after the mutex
			// releases (runExclusive's finally clause).
			const patch = deltaFn(read.current);
			const next = sanitizeMemoryMetadataObject(mergeMetadata(read.current, patch));
			assertStorageAxesUnchanged(read.current, next, "applyMetadataDelta");
			assertMetadataOnlyUpdatePreservesHashInput("applyMetadataDelta", read.current, next);
			this.sqlite
				.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?")
				.run(JSON.stringify(next), memoryId);
		});
	},

});
