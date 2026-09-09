/** @file memory-store-extraction-timestamp-api.ts
 * @purpose Persist the first valid-at-now timestamp for replay-stable extraction ordering.
 * @boundary Synchronous encrypted SQLite transaction keyed by scope and candidate replay identity.
 */

import {
	type ExtractionTimestampResolution,
	MemoryStore,
	type MemoryStoreInternals,
} from "./memory-store-base";
import { StorageError } from "./memory-store-shared";

function readResolvedAtMs(row: unknown): number | undefined {
	if (typeof row !== "object" || row === null) return undefined;
	const value = Reflect.get(row, "resolvedAtMs");
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isResolution(value: unknown): value is ExtractionTimestampResolution {
	if (typeof value !== "object" || value === null) return false;
	return (
		typeof Reflect.get(value, "resolvedAtMs") === "number" &&
		typeof Reflect.get(value, "created") === "boolean"
	);
}

Object.assign(MemoryStore.prototype, {
	resolveExtractionTimestamp(
		this: MemoryStoreInternals,
		projectId: string,
		replayKey: string,
		validAtNowMs: number,
	): ExtractionTimestampResolution {
		if (!projectId.trim() || !replayKey.trim() || !Number.isFinite(validAtNowMs)) {
			throw new StorageError("Extraction timestamp resolution requires a scope, replay key, and finite time");
		}
		const transaction = this.sqlite.transaction((): ExtractionTimestampResolution => {
			const inserted = this.sqlite
				.prepare(
					"INSERT OR IGNORE INTO nodix_memory_extraction_timestamps (project_id, replay_key, resolved_at_ms) VALUES (?, ?, ?) RETURNING resolved_at_ms AS resolvedAtMs",
				)
				.get(projectId, replayKey, validAtNowMs);
			const insertedAtMs = readResolvedAtMs(inserted);
			if (insertedAtMs !== undefined) return { resolvedAtMs: insertedAtMs, created: true };
			const existing = this.sqlite
				.prepare(
					"SELECT resolved_at_ms AS resolvedAtMs FROM nodix_memory_extraction_timestamps WHERE project_id = ? AND replay_key = ?",
				)
				.get(projectId, replayKey);
			const existingAtMs = readResolvedAtMs(existing);
			if (existingAtMs === undefined) {
				throw new StorageError("Extraction timestamp transaction did not create or find a resolution");
			}
			return { resolvedAtMs: existingAtMs, created: false };
		});
		const resolution = transaction.immediate();
		if (!isResolution(resolution)) {
			throw new StorageError("Extraction timestamp transaction returned an invalid result");
		}
		return resolution;
	},
});
