/** @file memory-store-atomic-time-api.ts
 * @purpose Reads active atomic cards through one half-open valid-time predicate.
 * @boundary Project-scoped storage query only.
 */

import {
	MemoryStore,
	type MemoryStoreInternals,
} from "./memory-store-base";
import type { MemoryRow } from "./memory-store-shared";
import { StorageError } from "./memory-store-shared";

Object.assign(MemoryStore.prototype, {
	listAtomicValidAt(
		this: MemoryStoreInternals,
		projectId: string,
		atMs: number,
	): ReturnType<MemoryStoreInternals["toEntry"]>[] {
		if (!projectId.trim()) throw new StorageError("Atomic valid-time projectId must not be empty");
		if (!Number.isSafeInteger(atMs) || atMs < 0) {
			throw new StorageError("Atomic valid-time instant must be a non-negative safe integer");
		}
		const rows = this.sqlite
			.prepare(
				`SELECT * FROM nodix_memories
				WHERE project_id = ? AND lane = 'active'
					AND valid_from IS NOT NULL AND valid_from <= ?
					AND (valid_until IS NULL OR ? < valid_until)
				ORDER BY timestamp DESC, id DESC`,
			)
			.all(projectId, atMs, atMs) as MemoryRow[];
		return rows.map((row) => this.toEntry(row));
	},
});
