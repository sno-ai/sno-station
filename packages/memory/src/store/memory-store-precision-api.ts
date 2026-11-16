import { MemoryStore, type MemoryStoreInternals } from "./memory-store-base";
import { stableHash, f32ToBytes, hashInputForEntry, type MemoryEntry, type MemoryRow } from "./memory-store-shared";
import { FIXED_PROTOCOL_VALUE_73 } from "../model/signed-registry-constants";
import { deriveRemWriteIdentity } from "../engine/rem/index";
import type { RecallOptions } from "../contract/inputs";

export type CaptureMode = "work" | "chat";
export type MemoryPlace = { skinId: string; projectId: string; surface: string };
export type PlaceMode = MemoryPlace & { mode: CaptureMode; decidedAt: number };
export type PlaceLoadedFiles = MemoryPlace & { files: NonNullable<RecallOptions["loadedFiles"]>; updatedAt: number };
export type LoadedFileJudgment = {
	memoryId: string; memoryContentHash: string; filePath: string; fileSha256: string;
	verdict: "said" | "not-said" | "opposite"; judgedAt: number;
};

export function normalizePrecisionText(text: string): string {
	return text.trim().replace(/\s+/gu, " ");
}

Object.assign(MemoryStore.prototype, {
	getPlaceMode(this: MemoryStoreInternals, place: MemoryPlace): CaptureMode | undefined {
		const row = this.sqlite.prepare("SELECT mode FROM nodix_place_modes WHERE skin_id = ? AND project_id = ? AND surface = ?")
			.get(place.skinId, place.projectId, place.surface) as { mode: CaptureMode } | undefined;
		return row?.mode;
	},
	setPlaceMode(this: MemoryStoreInternals, place: PlaceMode): void {
		this.sqlite.prepare("INSERT INTO nodix_place_modes(skin_id, project_id, surface, mode, decided_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
			.run(place.skinId, place.projectId, place.surface, place.mode, place.decidedAt);
	},
	setPlaceLoadedFiles(this: MemoryStoreInternals, place: PlaceLoadedFiles): void {
		this.sqlite.prepare(`INSERT INTO nodix_place_loaded_files(skin_id, project_id, surface, files, updated_at) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(skin_id, project_id, surface) DO UPDATE SET files = excluded.files, updated_at = excluded.updated_at`)
			.run(place.skinId, place.projectId, place.surface, JSON.stringify(place.files), place.updatedAt);
	},
	listPlaceLoadedFiles(this: MemoryStoreInternals): PlaceLoadedFiles[] {
		const rows = this.sqlite.prepare("SELECT skin_id AS skinId, project_id AS projectId, surface, files, updated_at AS updatedAt FROM nodix_place_loaded_files")
			.all() as Array<MemoryPlace & { files: string; updatedAt: number }>;
		return rows.map(row => ({ ...row, files: JSON.parse(row.files) }));
	},
	getLoadedFileJudgments(this: MemoryStoreInternals, memoryId: string): LoadedFileJudgment[] {
		return this.sqlite.prepare(`SELECT memory_id AS memoryId, memory_content_hash AS memoryContentHash,
			file_path AS filePath, file_sha256 AS fileSha256, verdict, judged_at AS judgedAt
			FROM nodix_loaded_file_judgments WHERE memory_id = ?`).all(memoryId) as LoadedFileJudgment[];
	},
	setLoadedFileJudgment(this: MemoryStoreInternals, judgment: LoadedFileJudgment): void {
		this.sqlite.prepare(`INSERT INTO nodix_loaded_file_judgments(memory_id, memory_content_hash, file_path, file_sha256, verdict, judged_at)
			VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(memory_id, file_path) DO UPDATE SET
			memory_content_hash = excluded.memory_content_hash, file_sha256 = excluded.file_sha256,
			verdict = excluded.verdict, judged_at = excluded.judged_at`)
			.run(judgment.memoryId, judgment.memoryContentHash, judgment.filePath, judgment.fileSha256, judgment.verdict, judgment.judgedAt);
	},
	listPrecisionProjects(this: MemoryStoreInternals): string[] {
		const rows = this.sqlite.prepare("SELECT DISTINCT project_id AS projectId FROM nodix_memories")
			.all() as { projectId: string }[];
		return rows.map(row => row.projectId);
	},
	readActivePrecisionRows(this: MemoryStoreInternals, projectId: string): MemoryEntry[] {
		const rows = this.sqlite.prepare(`SELECT id, text, category, project_id AS projectId, importance, timestamp,
			timezone, metadata, content_hash, fact_id, lane FROM nodix_memories
			WHERE project_id = ? AND lane = 'active'
			AND json_extract(metadata, '$.superseded_by') IS NULL AND json_extract(metadata, '$.invalidated_at') IS NULL`)
			.all(projectId) as MemoryRow[];
		return rows.map(row => this.toEntry(row));
	},
	async moveRowsToGlobal(this: MemoryStoreInternals, ids: readonly string[]): Promise<void> {
		await this.writeMutex.runExclusive(() => this.sqlite.transaction(() => {
			for (const id of ids) {
				const row = this.getById(id);
				if (!row || row.projectId === "global" || row.lane !== "active") continue;
				const duplicate = this.readActivePrecisionRows("global").find(peer => peer.category === row.category
					&& normalizePrecisionText(peer.text) === normalizePrecisionText(row.text));
				if (duplicate) {
					this.deleteByIds([id]);
					continue;
				}
				const metadata = this.parseMetadataObject(row.metadata);
				const contentHash = stableHash(typeof metadata.idempotency_key === "string"
					? JSON.stringify([FIXED_PROTOCOL_VALUE_73, "global", metadata.idempotency_key, row.text, row.category])
					: hashInputForEntry(row.text, row.metadata));
				const chunks = this.sqlite.prepare("SELECT chunk_id FROM nodix_memory_chunks WHERE memory_id = ?").all(id) as { chunk_id: string }[];
				const vectors = this.getVectorsByIds(chunks.map(chunk => chunk.chunk_id));
				for (const [chunkId, vector] of vectors) {
					this.sqlite.prepare("DELETE FROM nodix_memory_chunk_vectors WHERE id = ?").run(chunkId);
					this.sqlite.prepare("INSERT INTO nodix_memory_chunk_vectors(id, project_id, embedding) VALUES (?, 'global', vec_f32(?))")
						.run(chunkId, f32ToBytes(vector));
				}
				this.sqlite.prepare("UPDATE nodix_memories SET project_id = 'global', content_hash = ?, metadata = ? WHERE id = ?")
					.run(contentHash, JSON.stringify({ ...metadata, source_project_id: row.projectId }), id);
				this.sqlite.prepare("UPDATE nodix_rem_census_rows SET write_identity_sha256 = ? WHERE row_id = ?")
					.run(deriveRemWriteIdentity({ rowId: id, text: row.text, contentHash, timestamp: row.timestamp }), id);
			}
		}).immediate());
	},
});
