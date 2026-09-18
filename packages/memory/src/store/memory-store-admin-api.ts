/** @file memory-store-admin-api.ts
 * @purpose Deletes memory rows and closes underlying SQLite resources.
 * @boundary Prototype-mounted MemoryStore methods; no constructor state ownership.
 */

import { MemoryStore, type MemoryStoreInternals } from "./memory-store-base";
import {
	type BulkDeleteResult,
	DELETE_BATCH_SIZE,
	JSON_ID_BATCH_SIZE,
	log,
	type MemoryCategory,
	type MemoryDeleteOptions,
	StorageError,
} from "./memory-store-shared";
import { MEMORY_TELEMETRY_DELETE_REASONS } from "../engine/telemetry/memory-telemetry-types";

type DeleteEventRow = {
	id: string;
	fact_id: string | null;
	category: string;
	projectId: string;
};

function deleteReason(options: MemoryDeleteOptions | undefined): string {
	return options?.deleteReason ?? MEMORY_TELEMETRY_DELETE_REASONS.admin;
}

function writeDeleteEvents(
	internals: MemoryStoreInternals,
	rows: DeleteEventRow[],
	reason: string,
): void {
	for (const row of rows) {
		const factId = row.fact_id ?? row.id;
		const sourceEventId = internals.telemetryEvents.readLatestReceiptEventId(factId);
		internals.telemetryEvents.writeLifecycleEvent({
			eventType: "delete",
			factId,
			memoryKind: row.category,
			projectId: row.projectId,
			sourceEventId,
			metadata: {
				delete_reason: reason,
				...(sourceEventId === null ? {} : { source_event_id: sourceEventId }),
			},
		});
	}
}

Object.assign(MemoryStore.prototype, {
	async delete(
		this: MemoryStoreInternals,
		idOrPrefix: string,
		options?: MemoryDeleteOptions,
	): Promise<number> {
		log.info("deleting memories", { idOrPrefix }, {
			event_name: "sno_station_mem.memory-store-admin-api.deleting.memories",
			file: "packages/sno-station-mem/src/store/memory-store-admin-api.ts",
			function: "delete",
			site_id: "memory-store-admin-api.delete.5a8c32b1ed",
		});
		return this.writeMutex.runExclusive(() => {
			let ids: string[] = [];
			if (idOrPrefix.endsWith("*")) {
				const rawPrefix = idOrPrefix.slice(0, -1);
				if (rawPrefix.length < 4) {
					// Surface this invalid storage state as an explicit typed failure.
					throw new StorageError(`Wildcard delete prefix too short (min 4 chars): "${rawPrefix}*"`);
				}
				// Escape SQL LIKE wildcards so only the trailing * acts as a wildcard
				const escapedPrefix = rawPrefix.replace(/[\\%_]/g, "\\$&");
				const likePattern = `${escapedPrefix}%`;
				ids = (
					this.sqlite
						.prepare("SELECT id FROM nodix_memories WHERE id LIKE ? ESCAPE '\\'")
						.all(likePattern) as { id: string }[]
				).map((row) => row.id);
			} else {
				// Return 0 for missing IDs instead of reporting a successful delete.
				const exists = this.sqlite
					.prepare("SELECT 1 FROM nodix_memories WHERE id = ? LIMIT 1")
					.get(idOrPrefix);
				if (!exists) return 0;
				ids = [idOrPrefix];
			}
			if (ids.length === 0) return 0;

			this.deleteByIds(ids, options);
			return ids.length;
		});
	},

	async deleteMany(
		this: MemoryStoreInternals,
		ids: string[],
		options?: MemoryDeleteOptions,
	): Promise<number> {
		const uniqueIds = Array.from(new Set(ids));
		if (uniqueIds.length === 0) return 0;
		log.info("deleting many memories", { count: uniqueIds.length }, {
			event_name: "sno_station_mem.memory-store-admin-api.deleting.many.memories",
			file: "packages/sno-station-mem/src/store/memory-store-admin-api.ts",
			function: "deleteMany",
			site_id: "memory-store-admin-api.deleteMany.e73022fb31",
		});
		return this.writeMutex.runExclusive(() => {
			const existingIds: string[] = [];
			for (let i = 0; i < uniqueIds.length; i += JSON_ID_BATCH_SIZE) {
				const batch = uniqueIds.slice(i, i + JSON_ID_BATCH_SIZE);
				// Compute the normalized rows once so later persistence checks use one value.
				const rows = this.sqlite
					.prepare(
						"SELECT id FROM nodix_memories WHERE id IN (SELECT value FROM json_each(?))",
					)
					.all(JSON.stringify(batch)) as { id: string }[];
				for (const row of rows) {
					existingIds.push(row.id);
				}
			}
			if (existingIds.length === 0) return 0;
			this.deleteByIds(existingIds, options);
			return existingIds.length;
		});
	},

	deleteByIds(this: MemoryStoreInternals, ids: string[], options?: MemoryDeleteOptions): void {
		// Keep related table mutations in one transaction so side tables cannot drift.
		// `nodix_memory_chunk_vectors` is a vec0 virtual table and has no FK/trigger
		// linkage from `nodix_memory_chunks`, so chunks + their vec rows are deleted
		// explicitly first. The AFTER-DELETE trigger on `nodix_memory_chunks` cleans
		// `nodix_memory_chunks_fts`. The FK on `nodix_memory_chunks(memory_id)` itself uses
		// ON DELETE CASCADE, but we delete chunks explicitly to also clear
		// the vec rows in the same transaction.
		this.sqlite.transaction(() => {
			const rows: DeleteEventRow[] = [];
			for (let i = 0; i < ids.length; i += JSON_ID_BATCH_SIZE) {
				const batch = ids.slice(i, i + JSON_ID_BATCH_SIZE);
				rows.push(
					...(this.sqlite
						.prepare(
							"SELECT id, fact_id, category, project_id AS projectId FROM nodix_memories WHERE id IN (SELECT value FROM json_each(?))",
						)
						.all(JSON.stringify(batch)) as DeleteEventRow[]),
				);
			}
			writeDeleteEvents(this, rows, deleteReason(options));
			this.deleteChunksByMemoryIdsSync(ids);
			for (let i = 0; i < ids.length; i += JSON_ID_BATCH_SIZE) {
				const batch = ids.slice(i, i + JSON_ID_BATCH_SIZE);
				this.sqlite
					.prepare("DELETE FROM nodix_memories WHERE id IN (SELECT value FROM json_each(?))")
					.run(JSON.stringify(batch));
			}
		}).immediate();
	},

	async bulkDelete(
		this: MemoryStoreInternals,
		filter: {
			projectId?: string;
			category?: MemoryCategory;
		},
		options?: MemoryDeleteOptions,
	): Promise<BulkDeleteResult> {
		// Log operational context for storage without changing control flow.
		log.info("bulk delete", { projectId: filter.projectId, category: filter.category }, {
			event_name: "sno_station_mem.memory-store-admin-api.bulk.delete",
			file: "packages/sno-station-mem/src/store/memory-store-admin-api.ts",
			function: "bulkDelete",
			site_id: "memory-store-admin-api.bulkDelete.2631f303e5",
		});
		return this.writeMutex.runExclusive(() => {
			// Handle the absent-value case explicitly before the happy path depends on it.
			if (!filter.projectId && !filter.category) {
				// Compute the normalized row once so later persistence checks use one value.
				const rows = this.sqlite
					.prepare("SELECT id, fact_id, category, project_id AS projectId FROM nodix_memories")
					.all() as DeleteEventRow[];
				if (rows.length === 0) {
					// "No memories" no longer means "nothing to clear": preserved write
					// attempts hold user content and live in their own table.
					this.sqlite.prepare("DELETE FROM nodix_unplaced_memory_candidates").run();
					return { deleted: 0, truncated: false };
				}
				// Keep related table mutations in one transaction so side tables cannot drift.
				// `nodix_memory_chunk_vectors` is a vec0 virtual table — wipe it explicitly;
				// the FK CASCADE on `nodix_memory_chunks(memory_id)` cleans `nodix_memory_chunks`
				// when `nodix_memories` is wiped, and the AFTER-DELETE trigger
				// cleans `nodix_memory_chunks_fts`.
				this.sqlite.transaction(() => {
					writeDeleteEvents(this, rows, deleteReason(options));
					this.sqlite.prepare("DELETE FROM nodix_memory_chunk_vectors").run();
					this.sqlite.prepare("DELETE FROM nodix_memory_chunks").run();
					this.sqlite.prepare("DELETE FROM nodix_memories").run();
					// Preserved write attempts hold user content too. They used to live in
					// `nodix_memories` and were cleared with it; a clear that spares them
					// would leave content behind after the user asked for it to be gone.
					this.sqlite.prepare("DELETE FROM nodix_unplaced_memory_candidates").run();
				}).immediate();
				return { deleted: rows.length, truncated: false };
			}

			let selectSql = "SELECT id FROM nodix_memories";
			const params: string[] = [];
			const where: string[] = [];

			// Keep identity and boundary checks ahead of any privileged operation.
			if (filter.projectId) {
				// Append only after validation has accepted this value for the current branch.
				where.push("project_id = ?");
				// Append only after validation has accepted this value for the current branch.
				params.push(filter.projectId);
			}
			if (filter.category) {
				where.push("category = ?");
				params.push(filter.category);
			}
			if (where.length > 0) {
				selectSql += ` WHERE ${where.join(" AND ")}`;
			}
			selectSql += " LIMIT ?";
			const MAX_BULK_DELETE_ITERATIONS = 1000;
			let deleted = 0;
			let truncated = true;
			for (let iter = 0; iter < MAX_BULK_DELETE_ITERATIONS; iter++) {
				const ids = (
					this.sqlite.prepare(selectSql).all(...params, DELETE_BATCH_SIZE) as {
						id: string;
					}[]
				).map((row) => row.id);
				if (ids.length === 0) {
					truncated = false;
					break;
				}
				this.deleteByIds(ids, options);
				deleted += ids.length;
				if (ids.length < DELETE_BATCH_SIZE) {
					truncated = false;
					break;
				}
			}
			// Same reasoning as the unscoped wipe: clear the preserved write attempts
			// this filter covers, or user content outlives the delete that asked for it.
			const unplacedWhere: string[] = [];
			const unplacedParams: string[] = [];
			if (filter.projectId) {
				unplacedWhere.push("project_id = ?");
				unplacedParams.push(filter.projectId);
			}
			if (filter.category) {
				unplacedWhere.push("category = ?");
				unplacedParams.push(filter.category);
			}
			this.sqlite
				.prepare(
					`DELETE FROM nodix_unplaced_memory_candidates${
						unplacedWhere.length > 0 ? ` WHERE ${unplacedWhere.join(" AND ")}` : ""
					}`,
				)
				.run(...unplacedParams);
			if (truncated) {
				log.warn("bulk delete reached safety iteration cap", {
					projectId: filter.projectId,
					category: filter.category,
					deleted,
					maxIterations: MAX_BULK_DELETE_ITERATIONS,
					batchSize: DELETE_BATCH_SIZE,
				}, {
					event_name: "sno_station_mem.memory-store-admin-api.bulk.delete.reached.safety.iteration.cap",
					file: "packages/sno-station-mem/src/store/memory-store-admin-api.ts",
					function: "<anonymous callback>",
					site_id: "memory-store-admin-api.<anonymous callback>.130719fdd0",
				});
			}
			return { deleted, truncated };
		});
	},

	close(this: MemoryStoreInternals): Promise<void> {
		this.closed = true;
		this.cancelScheduledLegacyChunkBackfill();
		const backfillPromise = this.backfillPromise;
		if (!backfillPromise) {
			this.closeSqlite();
			return Promise.resolve();
		}
		return backfillPromise
			.catch(() => undefined)
			.then(() => {
				this.closeSqlite();
			});
	},

	closeSync(this: MemoryStoreInternals): void {
		this.closed = true;
		this.cancelScheduledLegacyChunkBackfill();
		// Background backfill observes `closed` before every SQLite boundary.
		this.closeSqlite();
	},

	closeSqlite(this: MemoryStoreInternals): void {
		if (this.sqliteClosed) return;
		this.sqliteClosed = true;
		try {
				// Bounded ANALYZE refresh so the planner's statistics track real data
				// shape; PRAGMA optimize only re-analyzes tables this connection queried.
				this.sqlite.exec("PRAGMA analysis_limit=400");
				this.sqlite.exec("PRAGMA optimize");
				this.sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		} catch (error) {
			log.warn("sqlite close-time maintenance failed", { error }, {
				event_name: "sno_station_mem.memory-store-admin-api.sqlite.close.time.maintenance.failed",
				file: "packages/sno-station-mem/src/store/memory-store-admin-api.ts",
				function: "closeSqlite",
				site_id: "memory-store-admin-api.closeSqlite.61a563b112",
			});
		} finally {
			// Close through the chokepoint wrapper: clears its statement cache and
			// closes the underlying raw connection.
			this.sqlite.close();
		}
	},
});
