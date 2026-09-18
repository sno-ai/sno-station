/** @file observable-memory-store.ts
 * @purpose Emits strict runtime audits and best-effort telemetry around memory operations.
 * @boundary Runtime audits fail closed; process telemetry never affects storage.
 */

import type { JsonObject } from "@snoai/sno-observe";
import type { EmbeddingConfig } from "../extraction/embedding-provider-client";
import {
	getSnoStationMemStateDir,
	runWithMemoryAudit,
	runWithMemoryAuditSync,
} from "../operations/runtime-audit-log";
import { StorageError } from "../shared/errors";
import type {
	MemoryEntry,
	MemoryMetadata,
	MemorySearchResult,
	MemoryTier,
} from "../shared/types";
import {
	MemoryStore,
	type ChunkSearchResult,
	type ListOptions,
	type MemoryRow,
	type MemoryStoreInternals,
	type RecordUnplacedCandidateInput,
	type RecordUnplacedCandidateResult,
	type SearchOptions,
	type StoreConfig,
	type StoreInput,
	type StoreResult,
	type SupersedeActiveFactGuard,
	type SupersedeClose,
	type SupersedePreserveExisting,
	type UpdateChanges,
} from "../../store/store";
import { observeBackgroundCooldownKey, type PluginObservability } from "./adapter";
import { countEmbeddingTokens } from "./token-counter";

type SessionUuidProvider = () => string | undefined;

const baseFetchMemoriesInOrder = (MemoryStore.prototype as unknown as MemoryStoreInternals)
	.fetchMemoriesInOrder;
const baseDeleteByIds = (MemoryStore.prototype as unknown as MemoryStoreInternals).deleteByIds;
const baseBackfillMissingChunks = (MemoryStore.prototype as unknown as MemoryStoreInternals)
	.backfillMissingChunks;

export class ObservableMemoryStore extends MemoryStore {
	constructor(
		config: StoreConfig,
		private readonly observability: PluginObservability,
		private readonly sessionUuidProvider: SessionUuidProvider,
		private readonly embeddingConfig: Pick<EmbeddingConfig, "provider" | "model">,
	) {
		super(config);
	}

	override async store(entry: StoreInput): Promise<StoreResult> {
		try {
			const result = await runWithMemoryAudit({
				stateDir: getSnoStationMemStateDir(),
				event: "memory_injected",
				operation: "store",
				scope: entry.projectId,
				startedDetails: {
					scope: entry.projectId,
					category: entry.category,
					count: 1,
				},
				run: () => super.store(entry),
				completedDetails: (stored) => ({
					scope: stored.projectId,
					category: stored.category,
					lane: stored.lane,
					count: 1,
					memory_ids: [stored.id],
					write_outcome: stored.storeWriteOutcome,
					created_count: stored.storeWriteOutcome === "created" ? 1 : 0,
					existing_count: stored.storeWriteOutcome === "existing" ? 1 : 0,
				}),
			});
			if (this.observability.enabled) {
				const sessionUuid = this.sessionUuidProvider();
				this.observability.trackBestEffort(
					"memory.write",
					() => this.emitWrite(result, sessionUuid),
					{
						cooldownKey: observeBackgroundCooldownKey("memory.write", sessionUuid),
					},
				);
			}
			return result;
		} catch (error) {
			this.observability.trackBestEffort("memory_store_throw", () =>
				this.observability.emitError("memory_store_throw", error, this.sessionUuidProvider()),
			);
			throw error;
		}
	}

	override async update(id: string, changes: UpdateChanges): Promise<MemoryEntry | null> {
		try {
			const result = await runWithMemoryAudit({
				stateDir: getSnoStationMemStateDir(),
				event: "memory_updated",
				operation: "update",
				startedDetails: { memory_ids: [id], requested_count: 1 },
				run: () => super.update(id, changes),
				completedDetails: (updated) => ({
					memory_ids: updated ? [updated.id] : [],
					requested_count: 1,
					result_count: updated ? 1 : 0,
					outcome: updated ? "updated" : "missing",
					...(updated ? { scope: updated.projectId } : {}),
				}),
			});
			if (result && this.observability.enabled) {
				const sessionUuid = this.sessionUuidProvider();
				this.observability.trackBestEffort(
					"memory.write",
					() => this.emitWrite(result, sessionUuid),
					{
						cooldownKey: observeBackgroundCooldownKey("memory.write", sessionUuid),
					},
				);
			}
			return result;
		} catch (error) {
			this.observability.trackBestEffort("memory_store_throw", () =>
				this.observability.emitError("memory_store_throw", error, this.sessionUuidProvider()),
			);
			throw error;
		}
	}

	override async bulkStore(entries: Array<StoreInput | null | undefined>): Promise<StoreResult[]> {
		try {
			const requested = entries.filter((entry): entry is StoreInput => entry != null);
			const results = await runWithMemoryAudit({
				stateDir: getSnoStationMemStateDir(),
				event: "memory_injected",
				operation: "bulkStore",
				startedDetails: { count: requested.length },
				run: async () => (await super.bulkStore(entries)) as StoreResult[],
				completedDetails: (stored) => {
					const createdCount = stored.filter(
						(entry) => entry.storeWriteOutcome === "created",
					).length;
					const existingCount = stored.length - createdCount;
					const writeOutcome: "created" | "existing" | "mixed" =
						createdCount === stored.length
							? "created"
							: existingCount === stored.length
								? "existing"
								: "mixed";
					return {
						scope: uniformValue(stored.map((entry) => entry.projectId)),
						category: uniformValue(stored.map((entry) => entry.category)),
						lane: uniformValue(stored.map((entry) => entry.lane)),
						count: stored.length,
						memory_ids: stored.map((entry) => entry.id),
						write_outcome: writeOutcome,
						created_count: createdCount,
						existing_count: existingCount,
					};
				},
			});
			if (this.observability.enabled) {
				for (const entry of results) {
					const sessionUuid = this.sessionUuidProvider();
					this.observability.trackBestEffort(
						"memory.write",
						() => this.emitWrite(entry, sessionUuid),
						{
							cooldownKey: observeBackgroundCooldownKey("memory.write", sessionUuid),
						},
					);
				}
			}
			return results;
		} catch (error) {
			this.observability.trackBestEffort("memory_store_throw", () =>
				this.observability.emitError("memory_store_throw", error, this.sessionUuidProvider()),
			);
			throw error;
		}
	}

	override async supersede(args: {
		create: StoreInput;
		closes: SupersedeClose[];
		activeFactGuard?: SupersedeActiveFactGuard;
		preserveExisting?: SupersedePreserveExisting;
	}): Promise<StoreResult> {
		return runWithMemoryAudit({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_superseded",
			operation: "supersede",
			scope: args.create.projectId,
			startedDetails: {
				scope: args.create.projectId,
				closed_memory_ids: args.closes.map((close) => close.id),
			},
			run: () =>
				runWithMemoryAudit({
					stateDir: getSnoStationMemStateDir(),
					event: "memory_injected",
					operation: "supersede",
					scope: args.create.projectId,
					startedDetails: { scope: args.create.projectId, count: 1 },
					run: async () => (await super.supersede(args)) as StoreResult,
					completedDetails: (stored) => writeDetails(stored),
				}),
			completedDetails: (stored) => ({
				scope: stored.projectId,
				replacement_memory_id: stored.id,
				closed_memory_ids: args.closes.map((close) => close.id),
				write_outcome: stored.storeWriteOutcome,
			}),
		});
	}

	override async createMergeWithRawLineage(
		args: Parameters<MemoryStore["createMergeWithRawLineage"]>[0],
	): ReturnType<MemoryStore["createMergeWithRawLineage"]> {
		const scope = args.rawSource.projectId;
		return runWithMemoryAudit({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_superseded",
			operation: "createMergeWithRawLineage",
			scope,
			startedDetails: {
				scope,
				closed_memory_ids: args.closeExisting.map((close) => close.id),
			},
			run: () =>
				runWithMemoryAudit({
					stateDir: getSnoStationMemStateDir(),
					event: "memory_injected",
					operation: "createMergeWithRawLineage",
					scope,
					startedDetails: { scope, count: 2 },
					run: () => super.createMergeWithRawLineage(args),
					completedDetails: (result) => ({
						scope,
						count: 2,
						memory_ids: [result.rawSource.id, result.merged.id],
						write_outcome: "created" as const,
						created_count: 2,
						existing_count: 0,
					}),
				}),
			completedDetails: (result) => ({
				scope,
				replacement_memory_id: result.merged.id,
				closed_memory_ids: [
					result.rawSource.id,
					...args.closeExisting.map((close) => close.id),
				],
				write_outcome: "created" as const,
			}),
		});
	}

	override async createEventAndSupersede(
		args: Parameters<MemoryStore["createEventAndSupersede"]>[0],
	): ReturnType<MemoryStore["createEventAndSupersede"]> {
		const scope = args.replacement.projectId;
		return runWithMemoryAudit({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_superseded",
			operation: "createEventAndSupersede",
			scope,
			startedDetails: {
				scope,
				closed_memory_ids: args.closeExisting.map((close) => close.id),
			},
			run: () =>
				runWithMemoryAudit({
					stateDir: getSnoStationMemStateDir(),
					event: "memory_injected",
					operation: "createEventAndSupersede",
					scope,
					startedDetails: { scope, count: 2 },
					run: () => super.createEventAndSupersede(args),
					completedDetails: (result) => ({
						scope,
						count: 2,
						memory_ids: [result.event.id, result.replacement.id],
						write_outcome: "created" as const,
						created_count: 2,
						existing_count: 0,
					}),
				}),
			completedDetails: (result) => ({
				scope,
				replacement_memory_id: result.replacement.id,
				closed_memory_ids: args.closeExisting.map((close) => close.id),
				write_outcome: "created" as const,
			}),
		});
	}

	override async importEntry(
		entry: Parameters<MemoryStore["importEntry"]>[0],
	): ReturnType<MemoryStore["importEntry"]> {
		let existed = false;
		return runWithMemoryAudit({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_injected",
			operation: "importEntry",
			scope: entry.projectId,
			startedDetails: { scope: entry.projectId, memory_ids: [entry.id], count: 1 },
			run: async () => {
				existed = await super.hasId(entry.id);
				return super.importEntry(entry);
			},
			completedDetails: (stored) => {
				const writeOutcome: "created" | "existing" = existed ? "existing" : "created";
				return {
					scope: stored.projectId,
					category: stored.category,
					lane: stored.lane,
					count: 1,
					memory_ids: [stored.id],
					write_outcome: writeOutcome,
					created_count: existed ? 0 : 1,
					existing_count: existed ? 1 : 0,
				};
			},
		});
	}

	async backfillMissingChunks(): Promise<number> {
		return runWithMemoryAudit({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_updated",
			operation: "backfillMissingChunks",
			run: () => baseBackfillMissingChunks.call(this),
			completedDetails: (rewrittenRows) => ({
				outcome: rewrittenRows === 0 ? "noop" : "chunks_backfilled",
				rewritten_rows: rewrittenRows,
			}),
		});
	}

	override findByContentHash(hash: string, projectId?: string): MemoryEntry | undefined {
		return this.auditEntryReadSync("findByContentHash", projectId, () =>
			super.findByContentHash(hash, projectId),
		);
	}

	override findByExtractionIdempotencyKey(
		projectId: string,
		key: string,
	): MemoryEntry | undefined {
		return this.auditEntryReadSync("findByExtractionIdempotencyKey", projectId, () =>
			super.findByExtractionIdempotencyKey(projectId, key),
		);
	}

	/**
	 * Audited like a write, because it is one — a preserved failure that leaves no
	 * audit trail is a write nobody can find afterwards.
	 */
	override recordUnplacedCandidate(
		input: RecordUnplacedCandidateInput,
	): RecordUnplacedCandidateResult {
		return runWithMemoryAuditSync({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_injected",
			operation: "recordUnplacedCandidate",
			scope: input.projectId,
			startedDetails: {
				scope: input.projectId,
				category: input.category,
				count: 1,
			},
			run: () => super.recordUnplacedCandidate(input),
			completedDetails: (result) => ({
				scope: input.projectId,
				category: input.category,
				count: 1,
				memory_ids: [result.id],
				write_outcome: result.created ? ("created" as const) : ("existing" as const),
				created_count: result.created ? 1 : 0,
				existing_count: result.created ? 0 : 1,
			}),
		});
	}

	override getById(id: string): MemoryEntry | undefined {
		return this.auditEntryReadSync("getById", undefined, () => super.getById(id), [id]);
	}

	override getByFactKey(projectId: string, factKey: string): MemoryEntry | undefined {
		return this.auditEntryReadSync(
			"getByFactKey",
			projectId,
			() => super.getByFactKey(projectId, factKey),
			[],
		);
	}

	override async hasId(id: string): Promise<boolean> {
		return runWithMemoryAudit({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_read",
			operation: "hasId",
			startedDetails: { memory_ids: [id], requested_count: 1 },
			run: () => super.hasId(id),
			completedDetails: (found) => ({
				memory_ids: found ? [id] : [],
				requested_count: 1,
				result_count: found ? 1 : 0,
				found,
			}),
		});
	}

	override async searchChunksSemantic(
		vector: Float32Array,
		opts: SearchOptions,
	): Promise<ChunkSearchResult[]> {
		return this.auditSearch("searchChunksSemantic", opts, () =>
			super.searchChunksSemantic(vector, opts),
		);
	}

	override async searchChunksKeyword(
		query: string,
		opts: SearchOptions,
	): Promise<ChunkSearchResult[]> {
		return this.auditSearch("searchChunksKeyword", opts, () =>
			super.searchChunksKeyword(query, opts),
		);
	}

	override async searchSemantic(
		vector: Float32Array,
		opts: SearchOptions = {},
	): Promise<MemorySearchResult[]> {
		return this.auditMemorySearch("searchSemantic", opts, () =>
			super.searchSemantic(vector, opts),
		);
	}

	override async searchKeyword(
		query: string,
		opts: SearchOptions = {},
	): Promise<MemorySearchResult[]> {
		return this.auditMemorySearch("searchKeyword", opts, () => super.searchKeyword(query, opts));
	}

	fetchMemoriesInOrder(memoryIds: string[], opts: SearchOptions = {}): MemoryRow[] {
		return runWithMemoryAuditSync({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_read",
			operation: "fetchMemoriesInOrder",
			startedDetails: { memory_ids: memoryIds, requested_count: memoryIds.length },
			run: () => baseFetchMemoriesInOrder.call(this, memoryIds, opts),
			completedDetails: (rows) => ({
				memory_ids: rows.map((row) => row.id),
				requested_count: memoryIds.length,
				result_count: rows.length,
			}),
		});
	}

	override getVectorsByIds(ids: string[]): Map<string, Float32Array> {
		return runWithMemoryAuditSync({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_read",
			operation: "getVectorsByIds",
			startedDetails: { memory_ids: ids, requested_count: ids.length },
			run: () => super.getVectorsByIds(ids),
			completedDetails: (vectors) => ({
				memory_ids: [...vectors.keys()],
				requested_count: ids.length,
				result_count: vectors.size,
			}),
		});
	}

	override getChunksByParent(
		memoryIds: string[],
		facetPolicy?: SearchOptions["facetPolicy"],
	): Map<string, Array<{ chunkIndex: number; chunkText: string; facet: "current" | "history" }>> {
		return runWithMemoryAuditSync({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_read",
			operation: "getChunksByParent",
			startedDetails: { memory_ids: memoryIds, requested_count: memoryIds.length },
			run: () => super.getChunksByParent(memoryIds, facetPolicy),
			completedDetails: (chunks) => ({
				memory_ids: [...chunks.keys()],
				requested_count: memoryIds.length,
				result_count: chunks.size,
			}),
		});
	}

	override async list(opts: ListOptions = {}): Promise<MemoryEntry[]> {
		return runWithMemoryAudit({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_read",
			operation: "list",
			scope: opts.projectId,
			startedDetails: { scope: opts.projectId, requested_count: opts.limit },
			run: () => super.list(opts),
			completedDetails: (entries) => ({
				...(opts.projectId ? { scope: opts.projectId } : {}),
				memory_ids: entries.map((entry) => entry.id),
				result_count: entries.length,
			}),
		});
	}

	override async listReflectionItems(
		opts: Parameters<MemoryStore["listReflectionItems"]>[0],
	): ReturnType<MemoryStore["listReflectionItems"]> {
		return runWithMemoryAudit({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_read",
			operation: "listReflectionItems",
			startedDetails: { requested_count: opts.limit },
			run: () => super.listReflectionItems(opts),
			completedDetails: (entries) => ({
				memory_ids: entries.map((entry) => entry.id),
				result_count: entries.length,
			}),
		});
	}

	override async getMemoryMetadata(
		memoryId: string,
	): Promise<MemoryMetadata | undefined> {
		return runWithMemoryAudit({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_read",
			operation: "getMemoryMetadata",
			startedDetails: { memory_ids: [memoryId], requested_count: 1 },
			run: () => super.getMemoryMetadata(memoryId),
			completedDetails: (metadata) => ({
				memory_ids: metadata ? [memoryId] : [],
				requested_count: 1,
				result_count: metadata ? 1 : 0,
				found: metadata !== undefined,
			}),
		});
	}

	override async updateTier(
		memoryId: string,
		newTier: MemoryTier,
		options?: { writerAuthority?: "offline-family" },
	): Promise<void> {
		await this.auditMetadataMutation("updateTier", [memoryId], () =>
			super.updateTier(memoryId, newTier, options),
		);
	}

	override async updateMetadata(
		memoryId: string,
		patch: Partial<MemoryMetadata>,
	): Promise<void> {
		await this.auditMetadataMutation("updateMetadata", [memoryId], () =>
			super.updateMetadata(memoryId, patch),
		);
	}

	override async applyMetadataDelta(
		memoryId: string,
		deltaFn: (current: MemoryMetadata) => Partial<MemoryMetadata>,
	): Promise<void> {
		await this.auditMetadataMutation("applyMetadataDelta", [memoryId], () =>
			super.applyMetadataDelta(memoryId, deltaFn),
		);
	}

	override async applyMetadataDeltas(
		entries: Parameters<MemoryStore["applyMetadataDeltas"]>[0],
	): Promise<void> {
		await this.auditMetadataMutation(
			"applyMetadataDeltas",
			entries.map((entry) => entry.memoryId),
			() => super.applyMetadataDeltas(entries),
		);
	}

	override async resolveReflectionItem(
		memoryId: string,
		opts: Parameters<MemoryStore["resolveReflectionItem"]>[1],
	): ReturnType<MemoryStore["resolveReflectionItem"]> {
		return runWithMemoryAudit({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_updated",
			operation: "resolveReflectionItem",
			startedDetails: { memory_ids: [memoryId], requested_count: 1 },
			run: () => super.resolveReflectionItem(memoryId, opts),
			completedDetails: (outcome) => ({
				memory_ids: outcome === "not_found" ? [] : [memoryId],
				requested_count: 1,
				result_count: outcome === "not_found" ? 0 : 1,
				outcome,
			}),
		});
	}

	override async delete(
		idOrPrefix: string,
		options?: Parameters<MemoryStore["delete"]>[1],
	): Promise<number> {
		const deletedIds = await runWithMemoryAudit({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_deleted",
			operation: "delete",
			startedDetails: { delete_reason: options?.deleteReason },
			run: () =>
				this.writeMutex.runExclusive(() => {
					const ids = this.resolveDeleteIds(idOrPrefix);
					if (ids.length > 0) baseDeleteByIds.call(this, ids, options);
					return ids;
				}),
			completedDetails: (ids) => ({
				deleted_memory_ids: ids,
				delete_reason: options?.deleteReason,
				count: ids.length,
				outcome: deleteOutcome(ids.length),
			}),
		});
		return deletedIds.length;
	}

	override async deleteMany(
		ids: string[],
		options?: Parameters<MemoryStore["deleteMany"]>[1],
	): Promise<number> {
		const deletedIds = await runWithMemoryAudit({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_deleted",
			operation: "deleteMany",
			startedDetails: { delete_reason: options?.deleteReason, count: ids.length },
			run: () =>
				this.writeMutex.runExclusive(() => {
					const existingIds = this.readExistingMemoryIds(ids);
					if (existingIds.length > 0) baseDeleteByIds.call(this, existingIds, options);
					return existingIds;
				}),
			completedDetails: (existingIds) => ({
				deleted_memory_ids: existingIds,
				delete_reason: options?.deleteReason,
				count: existingIds.length,
				outcome: deleteOutcome(existingIds.length),
			}),
		});
		return deletedIds.length;
	}

	deleteByIds(
		ids: string[],
		options?: Parameters<MemoryStoreInternals["deleteByIds"]>[1],
	): void {
		runWithMemoryAuditSync({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_deleted",
			operation: "deleteByIds",
			startedDetails: { deleted_memory_ids: ids, count: ids.length },
			run: () => {
				const existingIds = ids.filter((id) => super.getById(id) !== undefined);
				baseDeleteByIds.call(this, ids, options);
				return existingIds;
			},
			completedDetails: (deletedIds) => ({
				deleted_memory_ids: deletedIds,
				delete_reason: options?.deleteReason,
				count: deletedIds.length,
				outcome: deleteOutcome(deletedIds.length),
			}),
		});
	}

	override async bulkDelete(
		filter: Parameters<MemoryStore["bulkDelete"]>[0],
		options?: Parameters<MemoryStore["bulkDelete"]>[1],
	): ReturnType<MemoryStore["bulkDelete"]> {
		return runWithMemoryAudit({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_deleted",
			operation: "bulkDelete",
			scope: filter.projectId,
			startedDetails: { scope: filter.projectId, delete_reason: options?.deleteReason },
			run: () => super.bulkDelete(filter, options),
			completedDetails: (result) => ({
				...(filter.projectId ? { scope: filter.projectId } : {}),
				delete_reason: options?.deleteReason,
				count: result.deleted,
				outcome: deleteOutcome(result.deleted),
			}),
		});
	}

	private auditEntryReadSync(
		operation: string,
		scope: string | undefined,
		run: () => MemoryEntry | undefined,
		requestedIds: string[] = [],
	): MemoryEntry | undefined {
		return runWithMemoryAuditSync({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_read",
			operation,
			scope,
			startedDetails: { scope, memory_ids: requestedIds, requested_count: 1 },
			run,
			completedDetails: (entry) => ({
				...(entry ? { scope: entry.projectId, memory_ids: [entry.id] } : {}),
				requested_count: 1,
				result_count: entry ? 1 : 0,
				found: entry !== undefined,
			}),
		});
	}

	private async auditSearch(
		operation: string,
		opts: SearchOptions,
		run: () => Promise<ChunkSearchResult[]>,
	): Promise<ChunkSearchResult[]> {
		return runWithMemoryAudit({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_searched",
			operation,
			startedDetails: { requested_count: opts.limit },
			run,
			completedDetails: (results) => ({
				requested_count: opts.limit,
				result_count: results.length,
				memory_ids: results.map((result) => result.parentMemoryId),
			}),
		});
	}

	private async auditMemorySearch(
		operation: string,
		opts: SearchOptions,
		run: () => Promise<MemorySearchResult[]>,
	): Promise<MemorySearchResult[]> {
		return runWithMemoryAudit({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_searched",
			operation,
			startedDetails: { requested_count: opts.limit },
			run,
			completedDetails: (results) => ({
				requested_count: opts.limit,
				result_count: results.length,
				memory_ids: results.map((result) => result.entry.id),
			}),
		});
	}

	private async auditMetadataMutation(
		operation: string,
		memoryIds: string[],
		run: () => Promise<void>,
	): Promise<void> {
		let existingIds: string[] = [];
		await runWithMemoryAudit({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_updated",
			operation,
			startedDetails: { memory_ids: memoryIds, requested_count: memoryIds.length },
			run: async () => {
				existingIds = memoryIds.filter((id) => super.getById(id) !== undefined);
				await run();
			},
			completedDetails: () => ({
				memory_ids: existingIds,
				requested_count: memoryIds.length,
				result_count: existingIds.length,
				outcome: existingIds.length === 0 ? "missing" : "updated",
			}),
		});
	}

	private resolveDeleteIds(idOrPrefix: string): string[] {
		if (!idOrPrefix.endsWith("*")) {
			return this.readExistingMemoryIds([idOrPrefix]);
		}
		const rawPrefix = idOrPrefix.slice(0, -1);
		if (rawPrefix.length < 4) {
			throw new StorageError(`Wildcard delete prefix too short (min 4 chars): "${rawPrefix}*"`);
		}
		const escapedPrefix = rawPrefix.replace(/[\\%_]/g, "\\$&");
		return (
			this.sqlite
				.prepare("SELECT id FROM nodix_memories WHERE id LIKE ? ESCAPE '\\'")
				.all(`${escapedPrefix}%`) as Array<{ id: string }>
		).map((row) => row.id);
	}

	private readExistingMemoryIds(ids: string[]): string[] {
		const uniqueIds = Array.from(new Set(ids));
		const existingIds: string[] = [];
		for (let index = 0; index < uniqueIds.length; index += 500) {
			const batch = uniqueIds.slice(index, index + 500);
			const rows = this.sqlite
				.prepare(
					"SELECT id FROM nodix_memories WHERE id IN (SELECT value FROM json_each(?))",
				)
				.all(JSON.stringify(batch)) as Array<{ id: string }>;
			existingIds.push(...rows.map((row) => row.id));
		}
		return existingIds;
	}

	private async emitWrite(entry: MemoryEntry, sessionUuid: string | undefined): Promise<void> {
		const keyHash = this.observability.hashText(entry.contentHash || entry.id);
		if (!keyHash) return;
		const tokens = await countEmbeddingTokens(entry.text, this.embeddingConfig);
		await this.observability.emit({
			eventType: "memory.write",
			sessionUuid,
			scope: { project_id: entry.projectId },
			payload: {
				key_hash: keyHash,
				byte_len: Buffer.byteLength(entry.text, "utf8"),
				content_tokens: tokens.count,
				tokens_method: tokens.method,
			} satisfies JsonObject,
		});
	}
}

function uniformValue<T>(values: T[]): T | "mixed" {
	const first = values[0];
	if (first === undefined) return "mixed";
	return values.every((value) => value === first) ? first : "mixed";
}

function deleteOutcome(deletedCount: number): "deleted" | "noop" {
	return deletedCount > 0 ? "deleted" : "noop";
}

function writeDetails(entry: StoreResult): {
	scope: string;
	category: string;
	lane: string;
	count: number;
	memory_ids: string[];
	write_outcome: "created" | "existing";
	created_count: number;
	existing_count: number;
} {
	return {
		scope: entry.projectId,
		category: entry.category,
		lane: entry.lane,
		count: 1,
		memory_ids: [entry.id],
		write_outcome: entry.storeWriteOutcome,
		created_count: entry.storeWriteOutcome === "created" ? 1 : 0,
		existing_count: entry.storeWriteOutcome === "existing" ? 1 : 0,
	};
}
