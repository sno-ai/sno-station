/** @file memory-store-backfill.ts
 * @purpose Backfills legacy memories that are missing chunk rows.
 * @boundary Prototype-mounted MemoryStore methods; no constructor state ownership.
 */

import { MemoryStore, type MemoryStoreInternals } from "./memory-store-base";
import {
	CHUNK_BACKFILL_BATCH_SIZE,
	CHUNK_BACKFILL_FAILURE_RESET_MS,
	CHUNK_BACKFILL_MAX_ATTEMPTS,
	CHUNK_BACKFILL_RETRY_BASE_MS,
	log,
	type PreparedChunkRow,
	StorageError,
} from "./memory-store-shared";

Object.assign(MemoryStore.prototype, {
	async backfillMissingChunks(this: MemoryStoreInternals): Promise<number> {
		let total = 0;
		while (true) {
			if (this.closed) return total;
			const rows = this.readChunklessMemoryRows(CHUNK_BACKFILL_BATCH_SIZE);
			if (rows.length === 0) return total;

			const prepared: { memoryId: string; projectId: string; chunkRows: PreparedChunkRow[] }[] = [];
			let failedRows = 0;
			let firstFailure: Error | undefined;
			for (const row of rows) {
				try {
					prepared.push({
						memoryId: row.id,
						projectId: row.projectId,
						chunkRows: await this.prepareChunkInserts(row.id, row.text),
					});
				} catch (error) {
					failedRows++;
					if (firstFailure === undefined && error instanceof Error) {
						firstFailure = error;
					}
					log.warn("legacy memory chunk backfill skipped row", {
						memory_id: row.id,
						error,
					}, {
						event_name: "sno_station_mem.memory-store-backfill.legacy.memory.chunk.backfill.skipped.row",
						file: "packages/sno-station-mem/src/store/memory-store-backfill.ts",
						function: "backfillMissingChunks",
						site_id: "memory-store-backfill.backfillMissingChunks.7094298b4a",
					});
				}
			}
			if (prepared.length === 0 && failedRows > 0) {
				throw new StorageError(
					"Legacy memory chunk backfill failed for every row in the batch",
					firstFailure,
				);
			}
			if (this.closed) return total;

			const inserted = await this.writeMutex.runExclusive(() => {
				if (this.closed) return 0;
				let count = 0;
				this.sqlite.transaction(() => {
					for (const item of prepared) {
						if (item.chunkRows.length === 0) continue;
						if (!this.memoryExists(item.memoryId)) continue;
						if (this.memoryHasChunks(item.memoryId)) continue;
						this.writeChunkRowsSync(item.chunkRows, item.projectId);
						count++;
					}
				}).immediate();
				return count;
			});
			total += inserted;
			if (inserted === 0 && failedRows > 0) {
				throw new StorageError(
					"Legacy memory chunk backfill made no progress after row failures",
					firstFailure,
				);
			}
			if (inserted === 0) return total;
		}
	},

	startLegacyChunkBackfill(this: MemoryStoreInternals): void {
		if (this.closed || this.backfillComplete || this.backfillPromise) return;
		if (this.readChunklessMemoryRows(1).length === 0) {
			this.backfillComplete = true;
			return;
		}
		const now = Date.now();
		if (
			this.backfillFailureCount > 0 &&
			this.backfillLastFailureAt > 0 &&
			now - this.backfillLastFailureAt >= CHUNK_BACKFILL_FAILURE_RESET_MS
		) {
			this.backfillFailureCount = 0;
			this.backfillNextRetryAt = 0;
			this.backfillLastFailureAt = 0;
		}
		if (this.backfillFailureCount >= CHUNK_BACKFILL_MAX_ATTEMPTS) return;
		if (now < this.backfillNextRetryAt) return;

		this.backfillPromise = this.backfillMissingChunks()
			.then((count) => {
				this.backfillComplete = true;
				this.backfillFailureCount = 0;
				this.backfillNextRetryAt = 0;
				this.backfillLastFailureAt = 0;
				if (count > 0) {
					log.info("backfilled legacy memory chunks", { count }, {
						event_name: "sno_station_mem.memory-store-backfill.backfilled.legacy.memory.chunks",
						file: "packages/sno-station-mem/src/store/memory-store-backfill.ts",
						function: "<anonymous callback>",
						site_id: "memory-store-backfill.<anonymous callback>.c483e84a68",
					});
				}
			})
			.catch((error: unknown) => {
				if (this.closed) return;
				const failedAt = Date.now();
				this.backfillFailureCount++;
				this.backfillLastFailureAt = failedAt;
				const canRetry = this.backfillFailureCount < CHUNK_BACKFILL_MAX_ATTEMPTS;
				const retryInMs = canRetry
					? CHUNK_BACKFILL_RETRY_BASE_MS * 2 ** (this.backfillFailureCount - 1)
					: null;
				this.backfillNextRetryAt =
					retryInMs === null ? Number.POSITIVE_INFINITY : failedAt + retryInMs;
				log.warn("legacy memory chunk backfill failed", {
					attempt: this.backfillFailureCount,
					maxAttempts: CHUNK_BACKFILL_MAX_ATTEMPTS,
					retryInMs,
					error,
				}, {
					event_name: "sno_station_mem.memory-store-backfill.legacy.memory.chunk.backfill.failed",
					file: "packages/sno-station-mem/src/store/memory-store-backfill.ts",
					function: "<anonymous callback>",
					site_id: "memory-store-backfill.<anonymous callback>.c4019a929d",
				});
			})
			.finally(() => {
				this.backfillPromise = null;
			});
	},
});
