/** @file memory-store-vector-api.ts
 * @purpose Provides chunk vector reads used by retrieval scoring and reranking.
 * @boundary Prototype-mounted MemoryStore methods; no compaction or maintenance ownership.
 */

import { MemoryStore, type MemoryStoreInternals } from "./memory-store-base";
import { bytesToF32, JSON_ID_BATCH_SIZE } from "./memory-store-shared";

Object.assign(MemoryStore.prototype, {
	getVectorsByIds(this: MemoryStoreInternals, ids: string[]): Map<string, Float32Array> {
		const out = new Map<string, Float32Array>();
		if (ids.length === 0) return out;
		const unique = Array.from(new Set(ids));
		for (let i = 0; i < unique.length; i += JSON_ID_BATCH_SIZE) {
			const batch = unique.slice(i, i + JSON_ID_BATCH_SIZE);
			// json_each pushdown against the vec0 virtual table is probe-verified
			// (per-id point lookups, no scan).
			const rows = this.sqlite
				.prepare(
					"SELECT id, embedding FROM nodix_memory_chunk_vectors WHERE id IN (SELECT value FROM json_each(?))",
				)
				.all(JSON.stringify(batch)) as { id: string; embedding: Uint8Array }[];
			for (const row of rows) {
				out.set(row.id, bytesToF32(row.embedding));
			}
		}
		return out;
	},
});
