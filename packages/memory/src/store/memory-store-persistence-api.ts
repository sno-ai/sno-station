/** @file memory-store-persistence-api.ts
 * @purpose Stores new memories in single-entry, bulk, and atomic-supersede write paths.
 * @boundary Prototype-mounted MemoryStore methods; no constructor state ownership.
 */

import {
	MemoryStore,
	type ActiveTaskProjectionGuard,
	type MemoryStoreInternals,
	type ProfileRecoveryWrite,
	StaleSupersedeTargetError,
	type SupersedeActiveFactGuard,
	type SupersedeClose,
	type SupersedePreserveExisting,
} from "./memory-store-base";
import { deriveRemWriteIdentity } from "../engine/rem/index.js";
import {
	sanitizeMemoryMetadataString,
	sanitizeStoreInput,
} from "./content-sanitizer-bridge";
import {
	clamp01,
	DEFAULT_IMPORTANCE,
	hashInputForEntry,
	log,
	type MemoryEntry,
	type MemoryRow,
	type QuarantinedStoreInput,
	randomUUID,
	StorageError,
	type StoreInput,
	type StoreResult,
	stableHash,
	withStoreWriteOutcome,
} from "./memory-store-shared";
import { recordTokenCounter, validateStoreWriteMetadata } from "./memory-store-write-validation";

/**
 * The memory table holds memories. These create paths omit `lane` from their
 * INSERT, so a non-active request would land as an ACTIVE row — rejected content
 * entering retrieval as trusted recall, which is worse than a rejection. Guarded
 * at every entry point, not only `store()` and `bulkStore()`.
 */
function assertPlaceableMemory(entry: { lane?: string }, method: string): void {
	if ((entry.lane ?? "active") !== "active") {
		throw new StorageError(`${method}() accepts only the active memory table`);
	}
}

function assertProfileRecoveryWrite(recovery: ProfileRecoveryWrite | undefined): void {
	if (!recovery) return;
	if (!recovery.mutationAttemptId.trim()) {
		throw new StorageError("Profile recovery requires a mutation attempt identifier");
	}
	if (!recovery.sectionName.trim()) {
		throw new StorageError("Profile recovery requires a section name");
	}
	if (!Number.isFinite(recovery.removedAtMs)) {
		throw new StorageError("Profile recovery requires a finite removal timestamp");
	}
}

function appendProfileRecoveryEntries(
	sqlite: MemoryStoreInternals["sqlite"],
	closeRows: ReadonlyArray<{
		row: { id: string; text: string; category: string; projectId: string; metadata: string };
	}>,
	profileFactId: string,
	recovery: ProfileRecoveryWrite | undefined,
): void {
	if (!recovery) return;
	if (closeRows.length === 0) {
		throw new StorageError("Profile recovery requires at least one removed row");
	}
	for (const { row } of closeRows) {
		if (row.category !== "profile") {
			throw new StorageError("Profile recovery accepts only removed profile rows");
		}
		const profileMetadata = (() => {
			try {
				return JSON.parse(row.metadata) as Record<string, unknown>;
			} catch {
				return {};
			}
		})();
		const removedValue =
			typeof profileMetadata["l2_content"] === "string"
				? profileMetadata["l2_content"]
				: row.text;
		const sectionName =
			typeof profileMetadata["section_name"] === "string"
				? profileMetadata["section_name"]
				: recovery.sectionName;
		sqlite
			.prepare(
				"INSERT INTO nodix_profile_recovery_entries(entry_id, mutation_attempt_id, removed_row_id, project_id, profile_fact_id, section_name, removed_value, removed_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				`${recovery.mutationAttemptId}:${row.id}`,
				recovery.mutationAttemptId,
				row.id,
				row.projectId,
				profileFactId,
				sectionName,
				removedValue,
				recovery.removedAtMs,
			);
	}
}

Object.assign(MemoryStore.prototype, {
	async store(this: MemoryStoreInternals, entry: StoreInput): Promise<StoreResult> {
		const safeEntry = sanitizeStoreInput(entry);
		const lane = safeEntry.lane ?? "active";
		// Log operational context for storage without changing control flow.
		log.debug("storing memory", {
			category: safeEntry.category,
			projectId: safeEntry.projectId,
		}, {
			event_name: "sno_station_mem.memory-store-persistence-api.storing.memory",
			file: "packages/sno-station-mem/src/store/memory-store-persistence-api.ts",
			function: "store",
			site_id: "memory-store-persistence-api.store.8fd6a993e7",
		});
		// Empty text yields zero chunks → parent row would be inserted
		// without any chunks/vec/FTS rows, breaking the parent+chunks
		// invariant. Reject at the boundary.
		if (safeEntry.text.trim().length === 0) {
			throw new StorageError("Cannot store memory with empty text");
		}
		// A write attempt the extraction path could not place is not a memory and no
		// longer lives in this table. Rejected ahead of category, authority, and
		// metadata validation: what the table holds is more fundamental than whether
		// this caller may hold it.
		if (lane !== "active") {
			throw new StorageError("store() accepts only the active memory table");
		}
		// Round B-2: caller-provided `entry.vector` is intentionally ignored for
		// back-compat. Chunk embeddings are derived from `entry.text` below.
		const entryTimestamp = safeEntry.timestamp;
		const timestamp =
			entryTimestamp !== undefined && Number.isFinite(entryTimestamp) ? entryTimestamp : Date.now();
		const validated = validateStoreWriteMetadata(
			{
				text: safeEntry.text,
				category: safeEntry.category,
				metadata: safeEntry.metadata,
				timestamp,
				timezone: safeEntry.timezone,
				trusted: safeEntry.trusted,
				system: safeEntry.system,
				offlineFamily: safeEntry.offlineFamily,
				enforceWriteAuthority: true,
				lane,
			},
			"store",
			await recordTokenCounter(this.embedder),
		);
		const importance = clamp01(safeEntry.importance ?? DEFAULT_IMPORTANCE, DEFAULT_IMPORTANCE);
		// Snapshot caller-owned fields before entering the mutex/transaction. Without
		// this, a caller mutating entry.text between hash compute and SQL write
		// would persist data that disagrees with the validated content_hash.
		// See host review 2026-04-26 M1.
		const text = safeEntry.text;
		const projectId = safeEntry.projectId;
		const category = validated.category;
		const metadata = validated.metadata;
		const timezone = validated.timezone;
		const rawCandidateJson = safeEntry.rawCandidateJson;
		const dispositionReason = safeEntry.dispositionReason;
		const dispositionedAt = safeEntry.dispositionedAt;
		const hash = stableHash(hashInputForEntry(safeEntry.text, validated.metadata));
		const canRevive = (row: MemoryRow): boolean => {
			const rowMetadata = this.parseMetadataObject(row.metadata);
			return (
				(row.lane ?? "active") === "active" &&
				rowMetadata.invalidated_at !== undefined &&
				rowMetadata.invalidated_at !== null &&
				row.text === text
			);
		};
		// Write identity is asked BEFORE content identity, and they are separate questions.
		// The key answers "is this exact write already persisted" precisely; the hash answers
		// "is this text already stored" coarsely. Letting the coarse answer come first lets an
		// unrelated same-text row masquerade as a completed retry. Active rows only, matching
		// `findByExtractionIdempotencyKey`: a non-active row is a preserved failure, not a
		// completed write, and answering with one makes the retry skip the write that could
		// finally succeed.
		const writeIdentity = readIdempotencyKey(validated.metadata);
		if (writeIdentity) {
			const alreadyWritten = this.findByExtractionIdempotencyKey(projectId, writeIdentity);
			if (alreadyWritten) {
				log.debug("idempotency key match, skipping store", {
					projectId,
					memory_id: alreadyWritten.id,
				}, {
					event_name: "sno_station_mem.memory-store-persistence-api.idempotency.key.match.skipping.store",
					file: "packages/sno-station-mem/src/store/memory-store-persistence-api.ts",
					function: "store",
					site_id: "memory-store-persistence-api.store.2f479e68bf",
				});
				return withStoreWriteOutcome(alreadyWritten, "existing");
			}
		}

		// Best-effort dedup probe outside the mutex so we don't pay the chunk
		// embed cost for the common ambient-learning duplicate path. The mutex
		// section below re-checks under lock, so this can race safely.
		const earlyDup = this.readExistingByHash(projectId, hash, category);
		if (earlyDup && !canRevive(earlyDup)) {
			log.debug("content hash match, skipping store", {
				projectId,
				memory_id: earlyDup.id,
			}, {
				event_name: "sno_station_mem.memory-store-persistence-api.content.hash.match.skipping.store",
				file: "packages/sno-station-mem/src/store/memory-store-persistence-api.ts",
				function: "store",
				site_id: "memory-store-persistence-api.store.14bfc8e321",
			});
			return withStoreWriteOutcome(this.toEntry(earlyDup), "existing");
		}

		// Allocate the parent id up front so chunk IDs hash against a stable value.
		const id = randomUUID();
		const chunkRows = await this.prepareChunkInserts(id, text);

		return this.writeMutex.runExclusive(() => {
			// Re-check under lock; another writer may have inserted while we
			// were embedding chunks. Same order as the probe above: write identity first.
			if (writeIdentity) {
				const alreadyWritten = this.findByExtractionIdempotencyKey(projectId, writeIdentity);
				if (alreadyWritten) {
					log.debug("idempotency key match, skipping store", {
						projectId,
						memory_id: alreadyWritten.id,
					}, {
						event_name: "sno_station_mem.memory-store-persistence-api.idempotency.key.match.skipping.store",
						file: "packages/sno-station-mem/src/store/memory-store-persistence-api.ts",
						function: "<anonymous callback>",
						site_id: "memory-store-persistence-api.<anonymous callback>.b07cd1be28",
					});
					return withStoreWriteOutcome(alreadyWritten, "existing");
				}
			}
			const existing = this.readExistingByHash(projectId, hash, category);
			if (existing && !canRevive(existing)) {
				log.debug("content hash match, skipping store", {
					projectId,
					memory_id: existing.id,
				}, {
					event_name: "sno_station_mem.memory-store-persistence-api.content.hash.match.skipping.store",
					file: "packages/sno-station-mem/src/store/memory-store-persistence-api.ts",
					function: "<anonymous callback>",
					site_id: "memory-store-persistence-api.<anonymous callback>.087a18a049",
				});
				return withStoreWriteOutcome(this.toEntry(existing), "existing");
			}
			if (existing) {
				const factId = existing.fact_id ?? existing.id;
				this.sqlite.transaction(() => {
					this.sqlite
						.prepare(
							"UPDATE nodix_memories SET text = ?, category = ?, importance = ?, timestamp = ?, timezone = ?, metadata = ?, content_hash = ?, fact_id = ?, lane = 'active', raw_candidate_json = ?, disposition_reason = ?, dispositioned_at_ms = ? WHERE id = ? AND project_id = ?",
						)
						.run(
							text,
							category,
							importance,
							timestamp,
							timezone,
							metadata,
							hash,
							factId,
							rawCandidateJson ?? null,
							dispositionReason ?? null,
							dispositionedAt ?? null,
							existing.id,
							projectId,
						);
					this.telemetryEvents.writeReceiptEvent({
						eventType: "create",
						factId,
						memoryKind: category,
						projectId,
						contentHash: hash,
						timestampMs: timestamp,
						metadata: {
							operation_source: "store",
							content_hash: hash,
							receipt_status: "signed",
						},
					});
				}).immediate();
				const revived = this.getById(existing.id);
				if (!revived) throw new StorageError("Revived content-hash row disappeared after write");
				return withStoreWriteOutcome(revived, "created");
			}

			// Keep related table mutations in one transaction so side tables cannot drift.
			this.sqlite.transaction(() => {
				this.sqlite
					.prepare(
						`INSERT INTO nodix_memories(
							id, text, category, project_id, importance, timestamp, timezone, metadata,
							content_hash, fact_id, lane, raw_candidate_json, disposition_reason,
							dispositioned_at_ms, maturity, source, extractor_version
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'extracted', 'manual', 'memory-store')`,
					)
					.run(
						id,
						text,
						category,
						projectId,
						importance,
						timestamp,
						timezone,
						metadata,
						hash,
						id,
						lane,
						rawCandidateJson,
						dispositionReason,
						dispositionedAt,
					);
				this.sqlite
					.prepare(
						"INSERT INTO nodix_rem_census_rows(row_id, write_identity_sha256) VALUES (?, ?)",
					)
					.run(
						id,
						deriveRemWriteIdentity({ rowId: id, text, contentHash: hash, timestamp }),
					);
				this.writeChunkRowsSync(chunkRows, projectId);
				this.telemetryEvents.writeReceiptEvent({
					eventType: "create",
					factId: id,
					memoryKind: category,
					projectId: projectId,
					contentHash: hash,
					metadata: {
						operation_source: "store",
						content_hash: hash,
						receipt_status: "signed",
					},
				});
			}).immediate();

			return withStoreWriteOutcome(
				{
					id,
					text,
					category,
					projectId,
					importance,
					timestamp,
					timezone,
					metadata,
					contentHash: hash,
					lane,
					...(rawCandidateJson ? { rawCandidateJson } : {}),
					...(dispositionReason ? { dispositionReason } : {}),
					...(dispositionedAt === undefined ? {} : { dispositionedAt }),
				},
				"created",
			);
		});
	},

	async storeQuarantinedCandidate(
		this: MemoryStoreInternals,
		entry: QuarantinedStoreInput,
	): Promise<StoreResult> {
		const safeEntry = sanitizeStoreInput(entry) as QuarantinedStoreInput;
		if (safeEntry.text.trim().length === 0) {
			throw new StorageError("Cannot store quarantined candidate with empty text");
		}
		if (safeEntry.trusted !== true || safeEntry.lane !== "quarantined") {
			throw new StorageError(
				"storeQuarantinedCandidate() requires trusted quarantined authority",
			);
		}
		if (
			safeEntry.dispositionReason !== "candidate_not_grounded" &&
			safeEntry.dispositionReason !== "absorbed_occurrence" &&
			safeEntry.dispositionReason !== "subject_not_user"
		) {
			throw new StorageError("storeQuarantinedCandidate() received an unsupported disposition");
		}
		if (!Number.isFinite(safeEntry.dispositionedAt)) {
			throw new StorageError("storeQuarantinedCandidate() requires a finite disposition time");
		}
		try {
			const raw = JSON.parse(safeEntry.rawCandidateJson) as unknown;
			if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
				throw new Error("raw candidate must be a JSON object");
			}
		} catch (error) {
			throw new StorageError(
				`storeQuarantinedCandidate() requires reconstructable JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		const entryTimestamp = safeEntry.timestamp;
		const timestamp =
			entryTimestamp !== undefined && Number.isFinite(entryTimestamp) ? entryTimestamp : Date.now();
		const validated = validateStoreWriteMetadata(
			{
				text: safeEntry.text,
				category: safeEntry.category,
				metadata: safeEntry.metadata,
				timestamp,
				timezone: safeEntry.timezone,
				trusted: true,
				offlineFamily: true,
				enforceWriteAuthority: true,
				lane: "quarantined",
			},
			"storeQuarantinedCandidate",
			await recordTokenCounter(this.embedder),
		);
		const importance = clamp01(safeEntry.importance ?? DEFAULT_IMPORTANCE, DEFAULT_IMPORTANCE);
		const text = safeEntry.text;
		const projectId = safeEntry.projectId;
		const category = validated.category;
		const metadata = validated.metadata;
		const timezone = validated.timezone;
		const rawCandidateJson = safeEntry.rawCandidateJson;
		const dispositionReason = safeEntry.dispositionReason;
		const dispositionedAt = safeEntry.dispositionedAt;
		const hash = stableHash(
			JSON.stringify({
				v: 1,
				lane: "quarantined",
				text,
				metadata,
				rawCandidateJson,
				dispositionReason,
			}),
		);
		const earlyDup = this.readExistingByHash(projectId, hash, category);
		if (earlyDup) return withStoreWriteOutcome(this.toEntry(earlyDup), "existing");

		const id = randomUUID();
		const chunkRows = await this.prepareChunkInserts(id, text);
		return this.writeMutex.runExclusive(() => {
			const existing = this.readExistingByHash(projectId, hash, category);
			if (existing) return withStoreWriteOutcome(this.toEntry(existing), "existing");

			this.sqlite.transaction(() => {
				this.sqlite
					.prepare(
						`INSERT INTO nodix_memories(
							id, text, category, project_id, importance, timestamp, timezone, metadata,
							content_hash, fact_id, lane, raw_candidate_json, disposition_reason,
							dispositioned_at_ms, maturity, source, extractor_version
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'extracted', 'edge', 'memory-store')`,
					)
					.run(
						id,
						text,
						category,
						projectId,
						importance,
						timestamp,
						timezone,
						metadata,
						hash,
						id,
						"quarantined",
						rawCandidateJson,
						dispositionReason,
						dispositionedAt,
					);
				this.writeChunkRowsSync(chunkRows, projectId);
				this.telemetryEvents.writeReceiptEvent({
					eventType: "create",
					factId: id,
					memoryKind: category,
					projectId,
					contentHash: hash,
					metadata: {
						operation_source: "storeQuarantinedCandidate",
						content_hash: hash,
						receipt_status: "signed",
					},
				});
			}).immediate();

			return withStoreWriteOutcome(
				{
					id,
					text,
					category,
					projectId,
					importance,
					timestamp,
					timezone,
					metadata,
					contentHash: hash,
					lane: "quarantined",
					rawCandidateJson,
					dispositionReason,
					dispositionedAt,
				},
				"created",
			);
		});
	},

	async bulkStore(
		this: MemoryStoreInternals,
		entries: Array<StoreInput | null | undefined>,
	): Promise<StoreResult[]> {
		const countRecordTokens = await recordTokenCounter(this.embedder);
		// Runtime guard: callers (ambient-learning pipeline, future insight-distill
		// batching) can produce malformed entries — sparse-array slots, missing
		// text/vector fields. Mirror upstream a8bb8ec's defensive filter shape
		// exactly so we don't crash on `entry.text.length` when the caller
		// passed a partial object.
		// Mirror `store()`'s whitespace-only rejection: empty/whitespace text
		// yields zero chunks, which would create an unretrievable parent row
		// (host 2026-04-29 H1). Trim before length check.
		const validEntries = entries
			.filter(
				(entry): entry is StoreInput =>
					entry != null && typeof entry.text === "string" && entry.text.trim().length > 0,
			)
			.map((entry) => sanitizeStoreInput(entry))
			.filter((entry) => entry.text.trim().length > 0);
		if (validEntries.length === 0) return [];
		// Round B-2: caller-provided vectors are intentionally ignored for
		// back-compat. Each entry is chunked and embedded from text below.

		// Snapshot every persisted field per entry before entering the mutex. A
		// caller mutating entry.text between hash compute and SQL write would
		// otherwise persist data that disagrees with the validated content_hash.
		// See host review 2026-04-26 M1. Allocate parent ids up front so chunk
		// id hashing is stable across retries.
		const prepared = validEntries.map((entry) => {
			const entryTimestamp = entry.timestamp;
			const timestamp =
				entryTimestamp !== undefined && Number.isFinite(entryTimestamp)
					? entryTimestamp
					: Date.now();
			const lane = entry.lane ?? "active";
			const validated = validateStoreWriteMetadata(
				{
					text: entry.text,
					category: entry.category,
					metadata: entry.metadata,
					timestamp,
					timezone: entry.timezone,
					trusted: entry.trusted,
					system: entry.system,
					offlineFamily: entry.offlineFamily,
					enforceWriteAuthority: true,
					lane,
				},
				"bulkStore",
				countRecordTokens,
			);
			// Same boundary as store(): this table holds memories only. Closing it
			// here too, or bulkStore stays a way around the single-write guard.
			if (lane !== "active") {
				throw new StorageError("bulkStore() accepts only the active memory table");
			}
			const hash = stableHash(hashInputForEntry(entry.text, validated.metadata));
			const projectId = entry.projectId;
			return {
				id: randomUUID(),
				text: entry.text,
				projectId,
				category: validated.category,
				metadata: validated.metadata,
				hash,
				lane,
				rawCandidateJson: undefined,
				dispositionReason: undefined,
				dispositionedAt: undefined,
				// PRD §4.2 — include category so identical text under distinct
				// categories (e.g. decision vs lesson) is NOT collapsed.
				dedupKey: `${projectId}:${validated.category}:${hash}`,
				importance: clamp01(entry.importance ?? DEFAULT_IMPORTANCE, DEFAULT_IMPORTANCE),
				timestamp,
				timezone: validated.timezone,
			};
		});

		// Match `store()`'s cheap pre-embed dedup probe: rows already present
		// do not need chunking/embedding, and later duplicates in the same
		// batch can reuse the first pending insert.
		const earlyExistingByIndex = new Map<number, MemoryEntry>();
		const firstPendingIndexByHash = new Map<string, number>();
		for (let i = 0; i < prepared.length; i++) {
			const snap = prepared[i];
			if (!snap) continue;
			const existing = this.readExistingByHash(snap.projectId, snap.hash, snap.category);
			if (existing) {
				earlyExistingByIndex.set(i, this.toEntry(existing));
				continue;
			}
			if (!firstPendingIndexByHash.has(snap.dedupKey)) {
				firstPendingIndexByHash.set(snap.dedupKey, i);
			}
		}

		// Chunk + embed only entries that may insert BEFORE entering the
		// synchronous transaction. `prepareChunkInserts` is async (embedder
		// calls); the transaction callback below must stay sync.
		const chunkRowsByEntry = await Promise.all(
			prepared.map((p, i) => {
				if (earlyExistingByIndex.has(i)) return Promise.resolve([]);
				if (firstPendingIndexByHash.get(p.dedupKey) !== i) {
					return Promise.resolve([]);
				}
				return this.prepareChunkInserts(p.id, p.text);
			}),
		);

		return this.writeMutex.runExclusive(() => {
			const results: StoreResult[] = [];
			// Track entries inserted earlier in THIS batch so a duplicate later in
			// the same batch dedups against the in-flight insert.
			const inBatchByHash = new Map<string, MemoryEntry>();
			// Keep related table mutations in one transaction so side tables cannot drift.
			// LH: better-sqlite3 transaction() wraps in BEGIN/COMMIT and rolls
			// back on any throw — first failure aborts the entire batch (all-or-nothing).
			this.sqlite.transaction(() => {
				for (let i = 0; i < prepared.length; i++) {
					const snap = prepared[i];
					if (!snap) continue;
					const earlyExisting = earlyExistingByIndex.get(i);
					if (earlyExisting) {
						const existing = this.readExistingByHash(snap.projectId, snap.hash, snap.category);
						if (!existing) {
							throw new StorageError(
								"Bulk dedup row disappeared before write; retry bulkStore to re-embed the missing entry",
							);
						}
						const existingEntry = withStoreWriteOutcome(this.toEntry(existing), "existing");
						results.push(existingEntry);
						inBatchByHash.set(snap.dedupKey, existingEntry);
						continue;
					}
					const existing = this.readExistingByHash(snap.projectId, snap.hash, snap.category);
					if (existing) {
					const existingEntry = withStoreWriteOutcome(this.toEntry(existing), "existing");
						results.push(existingEntry);
						inBatchByHash.set(snap.dedupKey, existingEntry);
						continue;
					}
					const inBatchHit = inBatchByHash.get(snap.dedupKey);
					if (inBatchHit) {
						results.push(withStoreWriteOutcome({ ...inBatchHit }, "existing"));
						continue;
					}
					const chunkRows = chunkRowsByEntry[i] ?? [];
					if (chunkRows.length === 0) {
						throw new StorageError(
							"Bulk store prepared no chunks for new memory; retry bulkStore to re-embed the missing entry",
						);
					}
					this.sqlite
						.prepare(
							`INSERT INTO nodix_memories(
								id, text, category, project_id, importance, timestamp, timezone, metadata,
								content_hash, fact_id, maturity, source, extractor_version
							) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'extracted', 'edge', 'memory-store')`,
						)
						.run(
							snap.id,
							snap.text,
							snap.category,
							snap.projectId,
							snap.importance,
							snap.timestamp,
							snap.timezone,
							snap.metadata,
							snap.hash,
							snap.id,
						);
					this.writeChunkRowsSync(chunkRows, snap.projectId);
					this.telemetryEvents.writeReceiptEvent({
						eventType: "create",
						factId: snap.id,
						memoryKind: snap.category,
						projectId: snap.projectId,
						contentHash: snap.hash,
						metadata: {
							operation_source: "bulkStore",
							content_hash: snap.hash,
							receipt_status: "signed",
						},
					});
					const newEntry = withStoreWriteOutcome(
						{
							id: snap.id,
							text: snap.text,
							category: snap.category,
							projectId: snap.projectId,
							importance: snap.importance,
							timestamp: snap.timestamp,
							timezone: snap.timezone,
							metadata: snap.metadata,
							contentHash: snap.hash,
							lane: snap.lane,
							...(snap.rawCandidateJson ? { rawCandidateJson: snap.rawCandidateJson } : {}),
							...(snap.dispositionReason
								? { dispositionReason: snap.dispositionReason }
								: {}),
							...(snap.dispositionedAt === undefined
								? {}
								: { dispositionedAt: snap.dispositionedAt }),
						},
						"created",
					);
					results.push(newEntry);
					inBatchByHash.set(snap.dedupKey, newEntry);
				}
			}).immediate();
			return results;
		});
	},

	/**
	 * Atomic create-plus-close. Inserts one new memory and closes one or more
	 * existing rows inside a SINGLE mutex + transaction, so a crash cannot
	 * leave the new row stored while the closed rows stay live (the
	 * partial-write bug of doing `store()` then a separate `update()`).
	 *
	 * Each close supplies a `buildMetadata(createdId)` callback rather than a
	 * literal metadata string: the closure metadata (`superseded_by`, etc.)
	 * depends on the id of the row this call actually produces. That id is the
	 * freshly-allocated id on a normal insert, or — when `create.text` is a
	 * content-hash duplicate of an existing row — the existing row's id. The
	 * callback receives whichever id was used so the close stamps the live
	 * row, matching the pre-atomic behavior exactly.
	 *
	 * Close UPDATEs are metadata-only and run as raw SQL inside the shared
	 * transaction; `update()` is not called because it would open its own
	 * mutex + transaction and break atomicity.
	 */
	async supersede(
		this: MemoryStoreInternals,
		args: {
			create: StoreInput;
			closes: SupersedeClose[];
			activeFactGuard?: SupersedeActiveFactGuard;
			activeTaskProjectionGuard?: ActiveTaskProjectionGuard;
			preserveExisting?: SupersedePreserveExisting;
			reviveInvalidatedExisting?: boolean;
			profileRecovery?: ProfileRecoveryWrite;
		},
	): Promise<StoreResult> {
		assertPlaceableMemory(args.create, "supersede");
		assertProfileRecoveryWrite(args.profileRecovery);
		const {
			activeFactGuard,
			activeTaskProjectionGuard,
			closes,
			preserveExisting,
			reviveInvalidatedExisting,
		} = args;
		const create = sanitizeStoreInput(args.create);
		log.debug("supersede write", {
			category: create.category,
			projectId: create.projectId,
			closes: closes.length,
		}, {
			event_name: "sno_station_mem.memory-store-persistence-api.supersede.write",
			file: "packages/sno-station-mem/src/store/memory-store-persistence-api.ts",
			function: "supersede",
			site_id: "memory-store-persistence-api.supersede.77de7ddab1",
		});
		// Mirror store(): empty text yields zero chunks and an unretrievable
		// parent row. Reject at the boundary.
		if (create.text.trim().length === 0) {
			throw new StorageError("Cannot store memory with empty text");
		}
		const entryTimestamp = create.timestamp;
		const timestamp =
			entryTimestamp !== undefined && Number.isFinite(entryTimestamp) ? entryTimestamp : Date.now();
		const validated = validateStoreWriteMetadata(
			{
				text: create.text,
				category: create.category,
				metadata: create.metadata,
				timestamp,
				timezone: create.timezone,
				trusted: create.trusted,
				system: create.system,
				offlineFamily: create.offlineFamily,
				enforceWriteAuthority: true,
				lane: create.lane ?? "active",
			},
			"supersede",
			await recordTokenCounter(this.embedder),
		);
		const hash = stableHash(hashInputForEntry(create.text, validated.metadata));
		const importance = clamp01(create.importance ?? DEFAULT_IMPORTANCE, DEFAULT_IMPORTANCE);
		// Snapshot caller-owned fields before the mutex (see store()'s host M1 note).
		const text = create.text;
		const projectId = create.projectId;
		const category = validated.category;
		const metadata = validated.metadata;
		const timezone = validated.timezone;

		// A dedup hit against a row this call is about to close must never be
		// treated as "the replacement already exists" — that would make the
		// row supersede itself, discard the caller's replacement metadata, and
		// silently drop the fact from active recall (host adversarial review
		// 2026-07-13).
		const closingIds = new Set(closes.map((close) => close.id));
		const dedupCandidate = (row: MemoryRow | undefined): MemoryRow | undefined =>
			row && !closingIds.has(row.id) ? row : undefined;

		// Cheap dedup probe outside the mutex so the common path skips chunk
		// embedding; re-checked under lock below.
		const earlyDup = dedupCandidate(this.readExistingByHash(projectId, hash, category));
		// Allocate the parent id up front so chunk IDs hash against a stable value.
		const id = randomUUID();
		// Only embed chunks when the probe says we may insert. On a dup the
		// INSERT is skipped, so the chunk work would be discarded.
		const chunkRows = earlyDup ? [] : await this.prepareChunkInserts(id, text);

		return this.writeMutex.runExclusive(() => {
			// Re-check under lock; another writer may have inserted while we
			// were embedding chunks.
			const existing = dedupCandidate(this.readExistingByHash(projectId, hash, category));
			if (earlyDup && !existing) {
				throw new StorageError(
					"Supersede dedup row disappeared before write; retry supersede to re-embed the missing entry",
				);
			}
			let reviveExisting = false;
			if (existing) {
				const existingMetadata = this.parseMetadataObject(existing.metadata);
				const invalidatedAt = existingMetadata.invalidated_at;
				reviveExisting =
					reviveInvalidatedExisting === true &&
					(existing.lane ?? "active") === "active" &&
					invalidatedAt !== undefined &&
					invalidatedAt !== null &&
					existing.text === text;
				if (
					(existing.lane ?? "active") !== "active" ||
					(invalidatedAt !== undefined && invalidatedAt !== null && !reviveExisting)
				) {
					throw new StorageError("Cannot supersede with an inactive content-hash match");
				}
			}
			if (reviveExisting && preserveExisting) {
				throw new StorageError("Cannot revive and preserve the same supersede target");
			}
			if (preserveExisting) {
				if (
					!existing ||
					existing.id !== preserveExisting.id ||
					existing.content_hash !== preserveExisting.expectedContentHash ||
					existing.metadata !== preserveExisting.expectedMetadata ||
					existing.text !== text
				) {
					throw new StorageError(
						`Cannot preserve changed memory '${preserveExisting.id}' during supersede`,
					);
				}
			}
			const closeRows = closes.map((close) => {
				const row = this.sqlite
					.prepare(
						"SELECT id, text, category, project_id AS projectId, metadata, content_hash AS contentHash, fact_id FROM nodix_memories WHERE id = ? LIMIT 1",
					)
					.get(close.id) as
					| {
							id: string;
							text: string;
							category: string;
							projectId: string;
							metadata: string;
							contentHash: string;
							fact_id: string | null;
					  }
					| undefined;
				if (!row) {
					throw new StorageError(`Cannot close missing memory '${close.id}'`);
				}
				if (row.projectId !== projectId) {
					throw new StorageError("Cannot supersede memory from different projectId");
				}
				if (
					(close.expectedContentHash !== undefined &&
						row.contentHash !== close.expectedContentHash) ||
					(close.expectedMetadata !== undefined && row.metadata !== close.expectedMetadata)
				) {
					throw new StorageError(`Cannot close changed memory '${close.id}'`);
				}
				return { close, row, factId: row.fact_id ?? row.id };
			});
			const inheritedFactId =
				closeRows.length === 1
					? closeRows[0]?.factId
					: reviveExisting && existing
						? (existing.fact_id ?? existing.id)
						: id;
			if (!inheritedFactId) {
				throw new StorageError("Supersede could not determine replacement fact_id");
			}
			const derivedFrom =
				closeRows.length > 1 ? Array.from(new Set(closeRows.map((close) => close.factId))) : null;
			const existingEntry = existing ? this.toEntry(existing) : undefined;
			const created: MemoryEntry =
				reviveExisting && existingEntry
					? {
							...existingEntry,
							text,
							category,
							projectId,
							importance,
							timestamp,
							timezone,
							metadata,
							contentHash: hash,
							factId: inheritedFactId,
							lane: "active",
						}
					: existingEntry
						? preserveExisting
					? { ...existingEntry, metadata, contentHash: hash }
					: existingEntry
						: {
								id,
								text,
								category,
								projectId,
								importance,
								timestamp,
								timezone,
								metadata,
								contentHash: hash,
								lane: "active",
							};

			// Single transaction: the new INSERT (when not a dup) plus every
			// close UPDATE. A throw rolls all of them back together.
			this.sqlite.transaction(() => {
				if (activeTaskProjectionGuard) {
					const expectedTaskIds = [...activeTaskProjectionGuard.taskIds];
					const projectionMetadata = this.parseMetadataObject(metadata);
					const projectedTaskIds = projectionMetadata.active_task_ids;
					if (
						!Array.isArray(projectedTaskIds) ||
						projectedTaskIds.some((taskId) => typeof taskId !== "string") ||
						projectedTaskIds.length !== expectedTaskIds.length ||
						projectedTaskIds.some((taskId, index) => taskId !== expectedTaskIds[index])
					) {
						throw new StorageError(
							"Active-task projection metadata does not match its transaction guard",
						);
					}
					const queryLimit =
						expectedTaskIds.length >= activeTaskProjectionGuard.maxItems
							? activeTaskProjectionGuard.maxItems
							: expectedTaskIds.length + 1;
					const activeTaskRows = this.sqlite
						.prepare(
							"SELECT json_extract(metadata, '$.active_task_id') AS taskId FROM nodix_memories WHERE lane = 'active' AND project_id = ? AND category = 'profile' AND json_valid(metadata) AND json_extract(metadata, '$.section_name') = 'active_tasks' AND json_extract(metadata, '$.active_task_kind') = 'task' AND json_extract(metadata, '$.active_task_status') = 'active' AND json_extract(metadata, '$.invalidated_at') IS NULL ORDER BY json_extract(metadata, '$.active_task_created_at'), json_extract(metadata, '$.active_task_id'), id LIMIT ?",
						)
						.all(projectId, Math.max(1, queryLimit)) as Array<{ taskId: string }>;
					const actualTaskIds = activeTaskRows.map((row) => row.taskId);
					if (
						actualTaskIds.length !== expectedTaskIds.length ||
						actualTaskIds.some((taskId, index) => taskId !== expectedTaskIds[index])
					) {
						throw new StaleSupersedeTargetError("profile:active_tasks", null);
					}
				}
				if (activeFactGuard) {
					if (existing && existing.id !== preserveExisting?.id) {
						const guardedExisting = this.sqlite
							.prepare(
								"SELECT id FROM nodix_memories WHERE id = ? AND project_id = ? AND json_valid(metadata) AND json_extract(metadata, '$.fact_key') = ? LIMIT 1",
							)
							.get(existing.id, projectId, activeFactGuard.factKey) as
							| { id: string }
							| undefined;
						if (!guardedExisting) {
							throw new StorageError(
								"Cannot supersede with a content-hash match from another fact",
							);
						}
					}
					const expectedIds =
						activeFactGuard.expectedIds === undefined
							? activeFactGuard.expectedId === null
								? []
								: [activeFactGuard.expectedId]
							: [...activeFactGuard.expectedIds].sort();
					const activeRows = this.sqlite
						.prepare(
							"SELECT id FROM nodix_memories WHERE lane = 'active' AND project_id = ? AND json_valid(metadata) AND json_extract(metadata, '$.fact_key') = ? AND json_extract(metadata, '$.invalidated_at') IS NULL ORDER BY id LIMIT ?",
						)
						.all(projectId, activeFactGuard.factKey, expectedIds.length + 1) as Array<{
						id: string;
					}>;
					const actualIds = activeRows.map((row) => row.id).sort();
					const targetMatches =
						actualIds.length === expectedIds.length &&
						actualIds.every((id, index) => id === expectedIds[index]);
					if (!targetMatches) {
						throw new StaleSupersedeTargetError(
							activeFactGuard.factKey,
							activeFactGuard.expectedId ?? null,
							activeFactGuard.expectedIds,
						);
					}
				}
				if (preserveExisting) {
					this.sqlite
						.prepare(
							"UPDATE nodix_memories SET metadata = ?, content_hash = ? WHERE id = ? AND project_id = ?",
						)
						.run(metadata, hash, preserveExisting.id, projectId);
				}
				if (reviveExisting && existing) {
					this.sqlite
						.prepare(
							"UPDATE nodix_memories SET text = ?, category = ?, importance = ?, timestamp = ?, timezone = ?, metadata = ?, content_hash = ?, fact_id = ?, derived_from = ? WHERE id = ? AND project_id = ?",
						)
						.run(
							text,
							category,
							importance,
							timestamp,
							timezone,
							metadata,
							hash,
							inheritedFactId,
							derivedFrom ? JSON.stringify(derivedFrom) : null,
							existing.id,
							projectId,
						);
				}
				if (!existing) {
					this.sqlite
						.prepare(
							`INSERT INTO nodix_memories(
								id, text, category, project_id, importance, timestamp, timezone, metadata,
								content_hash, fact_id, derived_from, maturity, source, extractor_version
							) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'extracted', 'edge', 'memory-store')`,
						)
						.run(
							id,
							text,
							category,
							projectId,
							importance,
							timestamp,
							timezone,
							metadata,
							hash,
							inheritedFactId,
							derivedFrom ? JSON.stringify(derivedFrom) : null,
						);
					this.writeChunkRowsSync(chunkRows, projectId);
				}
				appendProfileRecoveryEntries(
					this.sqlite,
					closeRows,
					inheritedFactId,
					args.profileRecovery,
				);
				// Every close's sourceEventId is resolved to the pre-supersede
				// latest receipt for the row it closes BEFORE the replacement's own
				// receipt is written below — the replacement can share fact_id with
				// a 1:1 close (preserved fact identity), and writing its receipt
				// first would make the close event point at itself instead of the
				// content it actually supersedes (host adversarial review
				// 2026-07-13).
				for (const closeRow of closeRows) {
					const closeMetadata = sanitizeMemoryMetadataString(
						closeRow.close.buildMetadata(created.id),
					);
					this.sqlite
						.prepare(
							"UPDATE nodix_memories SET metadata = ? WHERE id = ? AND project_id = ?",
						)
						.run(closeMetadata ?? "{}", closeRow.row.id, projectId);
					const sourceEventId = this.telemetryEvents.readLatestReceiptEventId(closeRow.factId);
					this.telemetryEvents.writeLifecycleEvent({
						eventType: "supersede",
						factId: closeRow.factId,
						memoryKind: closeRow.row.category,
						projectId: closeRow.row.projectId,
						sourceEventId,
						metadata: {
							superseded_by: created.id,
							supersedes: closeRow.row.id,
							supersede_mode: closeRows.length === 1 ? "one_to_one" : "merge",
							...(sourceEventId === null ? {} : { source_event_id: sourceEventId }),
						},
					});
				}
				if (!existing || reviveExisting) {
					this.telemetryEvents.writeReceiptEvent({
						eventType: "create",
						factId: inheritedFactId,
						memoryKind: category,
						projectId,
						contentHash: hash,
						timestampMs: timestamp,
						derivedFrom,
						metadata: {
							operation_source: "supersede",
							content_hash: hash,
							receipt_status: "signed",
						},
					});
				}
			}).immediate();

				return withStoreWriteOutcome(
					created,
					existing && !reviveExisting ? "existing" : "created",
				);
		});
	},

	async createMergeWithRawLineage(
		this: MemoryStoreInternals,
		args: {
			rawSource: StoreInput;
			merged:
				| StoreInput
				| ((ids: { rawSourceId: string; mergedId: string }) => StoreInput);
			closeExisting: Array<{
				id: string;
				buildMetadata: (ids: { rawSourceId: string; mergedId: string }) => string;
			}>;
			buildRawSourceMetadata: (ids: { rawSourceId: string; mergedId: string }) => string;
		},
	): Promise<{ rawSource: MemoryEntry; merged: MemoryEntry }> {
		const countRecordTokens = await recordTokenCounter(this.embedder);
		assertPlaceableMemory(args.rawSource, "createMergeWithRawLineage");
		const rawSourceId = randomUUID();
		const mergedId = randomUUID();
		const ids = { rawSourceId, mergedId };
		const rawSource = sanitizeStoreInput(args.rawSource);
		const mergedInput = sanitizeStoreInput(
			typeof args.merged === "function" ? args.merged(ids) : args.merged,
		);
		assertPlaceableMemory(mergedInput, "createMergeWithRawLineage");

		if (rawSource.text.trim().length === 0 || mergedInput.text.trim().length === 0) {
			throw new StorageError("Cannot store memory with empty text");
		}

		const rawTimestamp =
			rawSource.timestamp !== undefined && Number.isFinite(rawSource.timestamp)
				? rawSource.timestamp
				: Date.now();
		const rawValidated = validateStoreWriteMetadata(
			{
				text: rawSource.text,
				category: rawSource.category,
				metadata: rawSource.metadata,
				timestamp: rawTimestamp,
				timezone: rawSource.timezone,
				trusted: rawSource.trusted,
				system: rawSource.system,
				enforceWriteAuthority: true,
			},
			"createMergeWithRawLineage.rawSource",
			countRecordTokens,
		);
		const rawText = rawSource.text;
		const rawProjectId = rawSource.projectId;
		const rawImportance = clamp01(rawSource.importance ?? DEFAULT_IMPORTANCE, DEFAULT_IMPORTANCE);
		const rawHash = stableHash(hashInputForEntry(rawText, rawValidated.metadata));

		const mergedTimestamp =
			mergedInput.timestamp !== undefined && Number.isFinite(mergedInput.timestamp)
				? mergedInput.timestamp
				: Date.now();
		const mergedValidated = validateStoreWriteMetadata(
			{
				text: mergedInput.text,
				category: mergedInput.category,
				metadata: mergedInput.metadata,
				timestamp: mergedTimestamp,
				timezone: mergedInput.timezone,
				trusted: mergedInput.trusted,
				system: mergedInput.system,
				enforceWriteAuthority: true,
			},
			"createMergeWithRawLineage.merged",
			countRecordTokens,
		);
		const mergedText = mergedInput.text;
		const mergedProjectId = mergedInput.projectId;
		const mergedImportance = clamp01(mergedInput.importance ?? DEFAULT_IMPORTANCE, DEFAULT_IMPORTANCE);
		const mergedHash = stableHash(hashInputForEntry(mergedText, mergedValidated.metadata));
		if (rawProjectId !== mergedProjectId) {
			throw new StorageError("Cannot merge memories across projectId boundaries");
		}

		const rawClosed = validateStoreWriteMetadata(
			{
				text: rawText,
				category: rawValidated.category,
				metadata: sanitizeMemoryMetadataString(args.buildRawSourceMetadata(ids)),
				timestamp: rawTimestamp,
			},
			"createMergeWithRawLineage.rawSourceClose",
			countRecordTokens,
		);

		const rawChunkRows = await this.prepareChunkInserts(rawSourceId, rawText);
		const mergedChunkRows = await this.prepareChunkInserts(mergedId, mergedText);
		if (rawChunkRows.length === 0 || mergedChunkRows.length === 0) {
			throw new StorageError("Merge-with-raw-lineage prepared no chunks for new memory");
		}

		return this.writeMutex.runExclusive(() => {
			if (
				rawProjectId === mergedProjectId &&
				rawValidated.category === mergedValidated.category &&
				rawHash === mergedHash
			) {
				throw new StorageError("Cannot merge: raw source and merged memory have duplicate content");
			}
			const rawCollision = this.readExistingByHash(
				rawProjectId,
				rawHash,
				rawValidated.category,
			);
			if (rawCollision) {
				throw new StorageError(
					`Cannot merge: another memory in projectId '${rawProjectId}' already has the same raw source content (id: ${rawCollision.id})`,
				);
			}
			const mergedCollision = this.readExistingByHash(
				mergedProjectId,
				mergedHash,
				mergedValidated.category,
			);
			if (mergedCollision) {
				throw new StorageError(
					`Cannot merge: another memory in projectId '${mergedProjectId}' already has the same merged content (id: ${mergedCollision.id})`,
				);
			}
			const closeRows = args.closeExisting.map((close) => {
				const row = this.sqlite
					.prepare(
						"SELECT id, text, category, project_id AS projectId, importance, timestamp, metadata, content_hash, fact_id FROM nodix_memories WHERE id = ? LIMIT 1",
					)
					.get(close.id) as MemoryRow | undefined;
				if (!row) {
					throw new StorageError(`Cannot close missing memory '${close.id}'`);
				}
				if (row.projectId !== mergedProjectId) {
					throw new StorageError("Cannot merge memory from different projectId");
				}
				const validated = validateStoreWriteMetadata(
					{
						text: row.text,
						category: row.category,
						metadata: sanitizeMemoryMetadataString(close.buildMetadata(ids)),
						timestamp: row.timestamp,
					},
					"createMergeWithRawLineage.closeExisting",
					countRecordTokens,
				);
				return {
					id: close.id,
					factId: row.fact_id ?? row.id,
					category: row.category,
					projectId: row.projectId,
					metadata: validated.metadata,
				};
			});
			const mergedDerivedFrom = Array.from(
				new Set([rawSourceId, ...closeRows.map((close) => close.factId)]),
			);

			this.sqlite.transaction(() => {
				this.sqlite
					.prepare(
						`INSERT INTO nodix_memories(
							id, text, category, project_id, importance, timestamp, timezone, metadata,
							content_hash, fact_id, maturity, source, extractor_version
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'extracted', 'edge', 'memory-store')`,
					)
					.run(
						rawSourceId,
						rawText,
						rawValidated.category,
						rawProjectId,
						rawImportance,
						rawTimestamp,
						rawValidated.timezone,
						rawValidated.metadata,
						rawHash,
						rawSourceId,
					);
				this.writeChunkRowsSync(rawChunkRows, rawProjectId);
				this.telemetryEvents.writeReceiptEvent({
					eventType: "create",
					factId: rawSourceId,
					memoryKind: rawValidated.category,
					projectId: rawProjectId,
					contentHash: rawHash,
					metadata: {
						operation_source: "createMergeWithRawLineage.rawSource",
						content_hash: rawHash,
						receipt_status: "signed",
					},
				});

				this.sqlite
					.prepare(
						`INSERT INTO nodix_memories(
							id, text, category, project_id, importance, timestamp, timezone, metadata,
							content_hash, fact_id, derived_from, maturity, source, extractor_version
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'extracted', 'edge', 'memory-store')`,
					)
					.run(
						mergedId,
						mergedText,
						mergedValidated.category,
						mergedProjectId,
						mergedImportance,
						mergedTimestamp,
						mergedValidated.timezone,
						mergedValidated.metadata,
						mergedHash,
						mergedId,
						JSON.stringify(mergedDerivedFrom),
					);
				this.writeChunkRowsSync(mergedChunkRows, mergedProjectId);
				this.telemetryEvents.writeReceiptEvent({
					eventType: "create",
					factId: mergedId,
					memoryKind: mergedValidated.category,
					projectId: mergedProjectId,
					contentHash: mergedHash,
					derivedFrom: mergedDerivedFrom,
					metadata: {
						operation_source: "createMergeWithRawLineage.merged",
						content_hash: mergedHash,
						receipt_status: "signed",
					},
				});

				this.sqlite
					.prepare(
						"UPDATE nodix_memories SET metadata = ? WHERE id = ? AND project_id = ?",
					)
					.run(rawClosed.metadata, rawSourceId, rawProjectId);
				const rawSourceEventId = this.telemetryEvents.readLatestReceiptEventId(rawSourceId);
				this.telemetryEvents.writeLifecycleEvent({
					eventType: "supersede",
					factId: rawSourceId,
					memoryKind: rawValidated.category,
					projectId: rawProjectId,
					sourceEventId: rawSourceEventId,
					metadata: {
						superseded_by: mergedId,
						supersedes: rawSourceId,
						supersede_mode: "merge",
						...(rawSourceEventId === null ? {} : { source_event_id: rawSourceEventId }),
					},
				});
				for (const close of closeRows) {
					this.sqlite
						.prepare(
							"UPDATE nodix_memories SET metadata = ? WHERE id = ? AND project_id = ?",
						)
						.run(close.metadata, close.id, mergedProjectId);
					const sourceEventId = this.telemetryEvents.readLatestReceiptEventId(close.factId);
					this.telemetryEvents.writeLifecycleEvent({
						eventType: "supersede",
						factId: close.factId,
						memoryKind: close.category,
						projectId: close.projectId,
						sourceEventId,
						metadata: {
							superseded_by: mergedId,
							supersedes: close.id,
							supersede_mode: "merge",
							...(sourceEventId === null ? {} : { source_event_id: sourceEventId }),
						},
					});
				}
			}).immediate();

			return {
				rawSource: {
					id: rawSourceId,
					text: rawText,
					category: rawValidated.category,
					projectId: rawProjectId,
					importance: rawImportance,
						timestamp: rawTimestamp,
						timezone: rawValidated.timezone,
						metadata: rawClosed.metadata,
					contentHash: rawHash,
					lane: "active",
				},
				merged: {
					id: mergedId,
					text: mergedText,
					category: mergedValidated.category,
					projectId: mergedProjectId,
					importance: mergedImportance,
						timestamp: mergedTimestamp,
						timezone: mergedValidated.timezone,
						metadata: mergedValidated.metadata,
					contentHash: mergedHash,
					lane: "active",
				},
			};
		});
	},

	async createEventAndSupersede(
		this: MemoryStoreInternals,
		args: {
			event: StoreInput;
			replacement: StoreInput;
			closeExisting: Array<{
				id: string;
				buildMetadata: (ids: { eventId: string; replacementId: string }) => string;
			}>;
			profileRecovery?: ProfileRecoveryWrite;
		},
	): Promise<{ event: MemoryEntry; replacement: MemoryEntry }> {
		const countRecordTokens = await recordTokenCounter(this.embedder);
		assertPlaceableMemory(args.event, "createEventAndSupersede");
		assertPlaceableMemory(args.replacement, "createEventAndSupersede");
		assertProfileRecoveryWrite(args.profileRecovery);
		const eventId = randomUUID();
		const replacementId = randomUUID();
		const ids = { eventId, replacementId };
		const event = sanitizeStoreInput(args.event);
		const replacement = sanitizeStoreInput(args.replacement);

		if (event.text.trim().length === 0 || replacement.text.trim().length === 0) {
			throw new StorageError("Cannot store memory with empty text");
		}

		const eventTimestamp =
			event.timestamp !== undefined && Number.isFinite(event.timestamp)
				? event.timestamp
				: Date.now();
		const eventValidated = validateStoreWriteMetadata(
			{
				text: event.text,
				category: event.category,
				metadata: event.metadata,
				timestamp: eventTimestamp,
				timezone: event.timezone,
				trusted: event.trusted,
				system: event.system,
				enforceWriteAuthority: true,
			},
			"createEventAndSupersede.event",
			countRecordTokens,
		);
		const eventText = event.text;
		const eventProjectId = event.projectId;
		const eventImportance = clamp01(event.importance ?? DEFAULT_IMPORTANCE, DEFAULT_IMPORTANCE);
		const eventHash = stableHash(hashInputForEntry(eventText, eventValidated.metadata));

		const replacementTimestamp =
			replacement.timestamp !== undefined && Number.isFinite(replacement.timestamp)
				? replacement.timestamp
				: Date.now();
		const replacementValidated = validateStoreWriteMetadata(
			{
				text: replacement.text,
				category: replacement.category,
				metadata: replacement.metadata,
				timestamp: replacementTimestamp,
				timezone: replacement.timezone,
				trusted: replacement.trusted,
				system: replacement.system,
				enforceWriteAuthority: true,
			},
			"createEventAndSupersede.replacement",
			countRecordTokens,
		);
		const replacementText = replacement.text;
		const replacementProjectId = replacement.projectId;
		const replacementImportance = clamp01(
			replacement.importance ?? DEFAULT_IMPORTANCE,
			DEFAULT_IMPORTANCE,
		);
		const replacementHash = stableHash(
			hashInputForEntry(replacementText, replacementValidated.metadata),
		);
		const activeFactGuard = readActiveFactGuard(replacementValidated.metadata);
		if (eventProjectId !== replacementProjectId) {
			throw new StorageError("Cannot event-supersede memories across projectId boundaries");
		}

		const eventIdempotencyKey = readIdempotencyKey(eventValidated.metadata);
		const eventChunkRows = await this.prepareChunkInserts(eventId, eventText);
		const replacementChunkRows = await this.prepareChunkInserts(replacementId, replacementText);
		if (eventChunkRows.length === 0 || replacementChunkRows.length === 0) {
			throw new StorageError("Event-plus-supersede prepared no chunks for new memory");
		}

		return this.writeMutex.runExclusive(() => {
			if (eventIdempotencyKey) {
				const duplicate = this.sqlite
					.prepare(
						"SELECT id FROM nodix_memories WHERE project_id = ? AND category = ? AND json_valid(metadata) AND json_extract(metadata, '$.idempotency_key') = ? LIMIT 1",
					)
					.get(eventProjectId, eventValidated.category, eventIdempotencyKey) as
					| { id: string }
					| undefined;
				if (duplicate) {
					throw new StorageError(
						`Cannot create duplicate idempotent event '${eventIdempotencyKey}' (existing id: ${duplicate.id})`,
					);
				}
			}
			if (
				eventProjectId === replacementProjectId &&
				eventValidated.category === replacementValidated.category &&
				eventHash === replacementHash
			) {
				throw new StorageError("Cannot event-supersede: event and replacement have duplicate content");
			}
			const eventCollision = this.readExistingByHash(
				eventProjectId,
				eventHash,
				eventValidated.category,
			);
			if (eventCollision) {
				throw new StorageError(
					`Cannot event-supersede: another memory in projectId '${eventProjectId}' already has the same event content (id: ${eventCollision.id})`,
				);
			}
			const replacementCollision = this.readExistingByHash(
				replacementProjectId,
				replacementHash,
				replacementValidated.category,
			);
			if (replacementCollision) {
				throw new StorageError(
					`Cannot event-supersede: another memory in projectId '${replacementProjectId}' already has the same replacement content (id: ${replacementCollision.id})`,
				);
			}
			const closeRows = args.closeExisting.map((close) => {
				const row = this.sqlite
					.prepare(
						"SELECT id, text, category, project_id AS projectId, importance, timestamp, metadata, content_hash, fact_id FROM nodix_memories WHERE id = ? LIMIT 1",
					)
					.get(close.id) as MemoryRow | undefined;
				if (!row) {
					throw new StorageError(`Cannot close missing memory '${close.id}'`);
				}
				if (row.projectId !== replacementProjectId) {
					throw new StorageError("Cannot event-supersede memory from different projectId");
				}
				const factId = row.fact_id ?? row.id;
				const sourceEventId = this.telemetryEvents.readLatestReceiptEventId(factId);
				const closed = validateStoreWriteMetadata(
					{
						text: row.text,
						category: row.category,
						metadata: sanitizeMemoryMetadataString(close.buildMetadata(ids)),
						timestamp: row.timestamp,
					},
					"createEventAndSupersede.closeExisting",
					countRecordTokens,
				);
				return {
					id: close.id,
					factId,
					row: {
						id: row.id,
						text: row.text,
						category: row.category,
						projectId: row.projectId,
						metadata: row.metadata ?? "{}",
					},
					category: row.category,
					projectId: row.projectId,
					metadata: closed.metadata,
					sourceEventId,
				};
			});
			const replacementFactId =
				closeRows.length === 1 ? (closeRows[0]?.factId ?? replacementId) : replacementId;
			const replacementDerivedFrom =
				closeRows.length > 1
					? Array.from(new Set(closeRows.map((close) => close.factId)))
					: null;

			this.sqlite.transaction(() => {
				if (activeFactGuard) {
					const activeRows = this.sqlite
						.prepare(
								"SELECT id FROM nodix_memories WHERE lane = 'active' AND project_id = ? AND json_valid(metadata) AND json_extract(metadata, '$.fact_key') = ? AND json_extract(metadata, '$.invalidated_at') IS NULL ORDER BY timestamp DESC, id DESC LIMIT 2",
						)
						.all(replacementProjectId, activeFactGuard.factKey) as Array<{ id: string }>;
					if (
						activeRows.length !== 1 ||
						activeRows[0]?.id !== activeFactGuard.expectedId
					) {
						throw new StaleSupersedeTargetError(
							activeFactGuard.factKey,
							activeFactGuard.expectedId,
						);
					}
				}
				this.sqlite
					.prepare(
						`INSERT INTO nodix_memories(
							id, text, category, project_id, importance, timestamp, timezone, metadata,
							content_hash, fact_id, maturity, source, extractor_version
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'extracted', 'edge', 'memory-store')`,
					)
					.run(
						eventId,
						eventText,
						eventValidated.category,
						eventProjectId,
						eventImportance,
						eventTimestamp,
						eventValidated.timezone,
						eventValidated.metadata,
						eventHash,
						eventId,
					);
				this.writeChunkRowsSync(eventChunkRows, eventProjectId);
				this.telemetryEvents.writeReceiptEvent({
					eventType: "create",
					factId: eventId,
					memoryKind: eventValidated.category,
					projectId: eventProjectId,
					contentHash: eventHash,
					metadata: {
						operation_source: "createEventAndSupersede.event",
						content_hash: eventHash,
						receipt_status: "signed",
					},
				});

				this.sqlite
					.prepare(
						`INSERT INTO nodix_memories(
							id, text, category, project_id, importance, timestamp, timezone, metadata,
							content_hash, fact_id, derived_from, maturity, source, extractor_version
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'extracted', 'edge', 'memory-store')`,
					)
					.run(
						replacementId,
						replacementText,
						replacementValidated.category,
						replacementProjectId,
						replacementImportance,
						replacementTimestamp,
						replacementValidated.timezone,
						replacementValidated.metadata,
						replacementHash,
						replacementFactId,
						replacementDerivedFrom ? JSON.stringify(replacementDerivedFrom) : null,
					);
				this.writeChunkRowsSync(replacementChunkRows, replacementProjectId);
				this.telemetryEvents.writeReceiptEvent({
					eventType: "create",
					factId: replacementFactId,
					memoryKind: replacementValidated.category,
					projectId: replacementProjectId,
					sourceEventId: closeRows.length === 1 ? (closeRows[0]?.sourceEventId ?? null) : null,
					derivedFrom: replacementDerivedFrom,
					contentHash: replacementHash,
					metadata: {
						operation_source: "createEventAndSupersede.replacement",
						content_hash: replacementHash,
						receipt_status: "signed",
					},
				});
				appendProfileRecoveryEntries(
					this.sqlite,
					closeRows,
					replacementFactId,
					args.profileRecovery,
				);

				for (const close of closeRows) {
					this.sqlite
						.prepare(
							"UPDATE nodix_memories SET metadata = ? WHERE id = ? AND project_id = ?",
						)
						.run(close.metadata, close.id, replacementProjectId);
					this.telemetryEvents.writeLifecycleEvent({
						eventType: "supersede",
						factId: close.factId,
						memoryKind: close.category,
						projectId: close.projectId,
						sourceEventId: close.sourceEventId,
						metadata: {
							superseded_by: replacementId,
							supersedes: close.id,
							supersede_mode: closeRows.length === 1 ? "one_to_one" : "merge",
							...(close.sourceEventId === null
								? {}
								: { source_event_id: close.sourceEventId }),
						},
					});
				}
			}).immediate();

			return {
				event: {
					id: eventId,
					text: eventText,
					category: eventValidated.category,
					projectId: eventProjectId,
					importance: eventImportance,
						timestamp: eventTimestamp,
						timezone: eventValidated.timezone,
						metadata: eventValidated.metadata,
					contentHash: eventHash,
					lane: "active",
				},
				replacement: {
					id: replacementId,
					text: replacementText,
					category: replacementValidated.category,
					projectId: replacementProjectId,
					importance: replacementImportance,
						timestamp: replacementTimestamp,
						timezone: replacementValidated.timezone,
						metadata: replacementValidated.metadata,
					contentHash: replacementHash,
					lane: "active",
				},
			};
		});
	},
});

function readIdempotencyKey(metadata: string): string | undefined {
	try {
		const parsed = JSON.parse(metadata) as { idempotency_key?: unknown };
		return typeof parsed.idempotency_key === "string" && parsed.idempotency_key.trim()
			? parsed.idempotency_key
			: undefined;
	} catch {
		return undefined;
	}
}

function readActiveFactGuard(
	metadata: string,
): { factKey: string; expectedId: string } | undefined {
	try {
		const parsed = JSON.parse(metadata) as { fact_key?: unknown; supersedes?: unknown };
		return typeof parsed.fact_key === "string" && typeof parsed.supersedes === "string"
			? { factKey: parsed.fact_key, expectedId: parsed.supersedes }
			: undefined;
	} catch {
		return undefined;
	}
}
