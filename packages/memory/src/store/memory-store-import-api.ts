/** @file memory-store-import-api.ts
 * @purpose Imports existing memory entries and checks identifier presence.
 * @boundary Prototype-mounted MemoryStore methods; no constructor state ownership.
 */

import { MemoryStore, type MemoryStoreInternals } from "./memory-store-base";
import { sanitizeStoreInput } from "./content-sanitizer-bridge";
import {
	clamp01,
	DEFAULT_IMPORTANCE,
	hashInputForEntry,
	type MemoryEntry,
	StorageError,
	stableHash,
} from "./memory-store-shared";
import { validateStoreWriteMetadata } from "./memory-store-write-validation";

Object.assign(MemoryStore.prototype, {
	async importEntry(
		this: MemoryStoreInternals,
		entry: Omit<MemoryEntry, "timezone"> & {
			timezone?: string;
			vector?: Float32Array;
			trusted?: boolean;
			system?: boolean;
			offlineFamily?: boolean;
		},
	): Promise<MemoryEntry> {
		const safeEntry = sanitizeStoreInput(entry);
		// Mirror `store()`'s whitespace-only rejection: empty text would
		// produce a chunkless parent row, breaking the parent+chunks
		// invariant for restore/migration paths (host 2026-04-29 M1).
		if (safeEntry.text.trim().length === 0) {
			throw new StorageError("Cannot import memory with empty text");
		}
		// Round B-2: caller-provided `entry.vector` is intentionally ignored for
		// back-compat. Caller-supplied parent id is preserved on
		// `nodix_memories.id`; chunk ids are deterministic from text.
		const importance = clamp01(safeEntry.importance ?? entry.importance, DEFAULT_IMPORTANCE);
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
			},
			"importEntry",
		);
		const category = validated.category;
		const metadata = validated.metadata;
		const timezone = validated.timezone;
		const hash = stableHash(hashInputForEntry(safeEntry.text, metadata));

		const chunkRows = await this.prepareChunkInserts(entry.id, safeEntry.text);

		return this.writeMutex.runExclusive(() => {
			// Keep related table mutations in one transaction so side tables cannot drift.
			this.sqlite.transaction(() => {
				const existing = this.sqlite
					.prepare("SELECT fact_id, content_hash FROM nodix_memories WHERE id = ? LIMIT 1")
					.get(entry.id) as { fact_id: string | null; content_hash: string } | undefined;
				const factId = existing?.fact_id ?? entry.id;
				const collision = this.sqlite
					.prepare(
						"SELECT id FROM nodix_memories WHERE project_id = ? AND content_hash = ? AND category = ? AND id != ? LIMIT 1",
					)
						.get(safeEntry.projectId, hash, category, entry.id) as { id: string } | undefined;
				if (collision) {
					throw new StorageError(
							`Cannot import: another memory in projectId '${safeEntry.projectId}' already has the same content (id: ${collision.id})`,
					);
				}

				// Delete prior chunks + their vec rows before updating this id.
				// `nodix_memory_chunk_vectors` is a vec0 table with no FK linkage, so parent
				// replacement must never rely on SQLite delete cascades alone.
				this.deleteChunksByMemoryIdsSync([entry.id]);
				this.sqlite
					.prepare(
						`INSERT INTO nodix_memories(
							id, text, category, project_id, importance, timestamp, timezone, metadata,
							content_hash, fact_id, maturity, source, extractor_version
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'extracted', 'manual', 'memory-import')
						ON CONFLICT(id) DO UPDATE SET text = excluded.text, category = excluded.category,
							project_id = excluded.project_id, importance = excluded.importance,
							timestamp = excluded.timestamp, timezone = excluded.timezone,
							metadata = excluded.metadata, content_hash = excluded.content_hash,
							fact_id = excluded.fact_id, maturity = excluded.maturity,
							source = excluded.source, extractor_version = excluded.extractor_version`,
					)
					.run(
							entry.id,
							safeEntry.text,
							category,
							safeEntry.projectId,
						importance,
						timestamp,
						timezone,
						metadata,
						hash,
						factId,
					);
				this.writeChunkRowsSync(chunkRows, safeEntry.projectId);
				this.telemetryEvents.writeReceiptEvent({
					eventType: existing ? "update" : "create",
					factId,
					memoryKind: category,
						projectId: safeEntry.projectId,
					contentHash: hash,
					metadata: existing
						? {
								changed_keys: ["text", "content_hash"],
								content_hash: hash,
							}
						: {
								operation_source: "importEntry",
								content_hash: hash,
								receipt_status: "signed",
							},
				});
			}).immediate();

			return {
					...entry,
					text: safeEntry.text,
					category,
					projectId: safeEntry.projectId,
				importance,
				timestamp,
				timezone,
				metadata,
				contentHash: hash,
			};
		});
	},

	async hasId(this: MemoryStoreInternals, id: string): Promise<boolean> {
		// Compute the normalized row once so later persistence checks use one value.
		const row = this.sqlite
			.prepare("SELECT 1 as has_value FROM nodix_memories WHERE id = ? LIMIT 1")
			.get(id) as { has_value?: number } | null;
		return row?.has_value === 1;
	},
});
