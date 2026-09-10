import { FIXED_PROTOCOL_VALUE_74 } from "../../model/signed-registry-constants";
import {
	getSnoStationMemStateDir,
	runWithMemoryAuditSync,
} from "../operations/runtime-audit-log";
import type { SqliteDatabaseLike } from "../../store/sqlite-runtime";
import { validateMemoryTelemetryMetadata } from "./memory-telemetry-metadata";
import type { MemoryTelemetryMetadata } from "./memory-telemetry-types";

const DELETE_BATCH_SIZE = 500;
/** Purge-safety lookback: recall events inside this window block cascade purges. Event retention MUST keep at least this much usage history (coupled by unit test). */
export const RECENT_RECALL_WINDOW_MS: number = 30 * 24 * 60 * 60 * 1000;

export type MemoryTelemetryPurgeActor = "agent" | "operator";
export type MemoryTelemetryPurgeStatus = "complete" | "partial" | "blocked";

export interface MemoryTelemetryPurgePreviewOptions {
	actor?: MemoryTelemetryPurgeActor;
}

export interface MemoryTelemetryPurgePreview {
	targetFactId: string;
	affectedFactIds: string[];
	downstreamFactIds: string[];
	affectedFactCount: number;
	recentRecallCount: number;
	affectedEpochIds: string[];
	blocked: boolean;
	blockedReason?: "cycle_detected";
}

export interface MemoryTelemetryConfirmPurgeInput {
	factId: string;
	actor: MemoryTelemetryPurgeActor;
	confirmationToken: string;
}

export interface MemoryTelemetryPurgeResult {
	targetFactId: string;
	status: MemoryTelemetryPurgeStatus;
	purgedFactIds: string[];
	failedFactIds: string[];
	blockedReason?: "cycle_detected" | "recent_recall";
}

export interface MemoryTelemetryPurgeService {
	previewImpact(
		factId: string,
		options?: MemoryTelemetryPurgePreviewOptions,
	): MemoryTelemetryPurgePreview;
	confirmPurge(input: MemoryTelemetryConfirmPurgeInput): MemoryTelemetryPurgeResult;
}

export interface CreateMemoryTelemetryPurgeServiceOptions {
	sqlite: SqliteDatabaseLike;
	agentId?: string;
	canDeleteFact?: (factId: string) => boolean;
}

interface MemoryLineageRow {
	id: string;
	fact_id: string | null;
	category: string;
	project_id: string;
	derived_from: string | null;
}

interface MemoryEventLineageRow {
	fact_id: string | null;
	memory_kind: string | null;
	project_id: string | null;
	derived_from: string | null;
}

interface ChunkRow {
	chunk_id: string;
}

interface TargetMemoryRow {
	id: string;
	fact_id: string | null;
	category: string;
	project_id: string;
}

interface EpochRow {
	consolidation_epoch_id: string | null;
}

interface PurgeEventAnchor {
	memoryKind: string | null;
	projectId: string | null;
}

interface ForwardGraph {
	edges: Map<string, string[]>;
	knownFactIds: Set<string>;
}

export function createMemoryTelemetryPurgeService(
	options: CreateMemoryTelemetryPurgeServiceOptions,
): MemoryTelemetryPurgeService {
	return new DefaultMemoryTelemetryPurgeService(
		options.sqlite,
		options.agentId ?? FIXED_PROTOCOL_VALUE_74,
		options.canDeleteFact ?? (() => true),
	);
}

class DefaultMemoryTelemetryPurgeService implements MemoryTelemetryPurgeService {
	constructor(
		private readonly sqlite: SqliteDatabaseLike,
		private readonly agentId: string,
		private readonly canDeleteFact: (factId: string) => boolean,
	) {}

	previewImpact(
		factId: string,
		_options: MemoryTelemetryPurgePreviewOptions = {},
	): MemoryTelemetryPurgePreview {
		return runWithMemoryAuditSync({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_read",
			operation: "previewImpact",
			startedDetails: {
				requested_fact_id: factId,
				fact_ids: [factId],
				requested_count: 1,
			},
			run: () => this.buildPreview(normalizeRequired(factId, "fact_id")),
			completedDetails: (preview) => ({
				requested_fact_id: factId,
				resolved_fact_id: preview.targetFactId,
				fact_ids: preview.affectedFactIds,
				requested_count: 1,
				result_count: preview.affectedFactCount,
			}),
		});
	}

	confirmPurge(input: MemoryTelemetryConfirmPurgeInput): MemoryTelemetryPurgeResult {
		return runWithMemoryAuditSync({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_purged",
			operation: "confirmPurge",
			startedDetails: { target_fact_id: input.factId },
			run: () => this.confirmPurgeUnaudited(input),
			completedDetails: (result) => ({
				target_fact_id: result.targetFactId,
				purged_fact_ids: result.purgedFactIds,
				failed_fact_ids: result.failedFactIds,
				status: result.status,
				...(result.blockedReason ? { blocked_reason: result.blockedReason } : {}),
			}),
		});
	}

	private confirmPurgeUnaudited(
		input: MemoryTelemetryConfirmPurgeInput,
	): MemoryTelemetryPurgeResult {
		const targetFactId = normalizeRequired(input.factId, "fact_id");
		if (input.actor !== "operator") {
			throw new Error("cascade purge confirmation requires an operator actor");
		}
		const expectedToken = `PURGE ${targetFactId}`;
		if (input.confirmationToken !== expectedToken) {
			throw new Error(`cascade purge confirmation token must equal '${expectedToken}'`);
		}

		return this.sqlite.transaction(() => {
			// Recompute the graph and every purge-safety guard inside the delete
			// transaction: a preview built before this call can go stale if a
			// concurrent write adds a descendant or a recall lands in the
			// meantime (host adversarial review 2026-07-13).
			const preview = this.buildPreview(targetFactId);
			const anchor = this.readPurgeEventAnchor(targetFactId);

			if (preview.blocked) {
				const result: MemoryTelemetryPurgeResult = {
					targetFactId,
					status: "blocked",
					purgedFactIds: [],
					failedFactIds: preview.affectedFactIds,
					blockedReason: "cycle_detected",
				};
				this.insertPurgeEvent(targetFactId, result, preview, anchor);
				return result;
			}

			// Purge-safety invariant: a fact (or any of its downstream
			// descendants) recalled inside RECENT_RECALL_WINDOW_MS must never be
			// deleted, even with an operator confirmation token.
			const recentRecallCount = this.readRecentRecallCount(preview.affectedFactIds);
			if (recentRecallCount > 0) {
				const result: MemoryTelemetryPurgeResult = {
					targetFactId,
					status: "blocked",
					purgedFactIds: [],
					failedFactIds: preview.affectedFactIds,
					blockedReason: "recent_recall",
				};
				this.insertPurgeEvent(targetFactId, result, preview, anchor);
				return result;
			}

			const deletionCandidates = preview.affectedFactIds.filter((fact) =>
				this.canDeleteFact(fact),
			);
			const purgedFactIds = this.deleteFacts(deletionCandidates);
			const purgedFactIdSet = new Set(purgedFactIds);
			const failedFactIds = preview.affectedFactIds.filter(
				(fact) => !purgedFactIdSet.has(fact),
			);
			const result: MemoryTelemetryPurgeResult = {
				targetFactId,
				status: failedFactIds.length === 0 ? "complete" : "partial",
				purgedFactIds,
				failedFactIds,
			};
			this.insertPurgeEvent(targetFactId, result, preview, anchor);
			return result;
		}).immediate() as MemoryTelemetryPurgeResult;
	}

	private buildPreview(targetFactId: string): MemoryTelemetryPurgePreview {
		const graph = this.buildForwardGraph();
		if (!graph.knownFactIds.has(targetFactId)) {
			throw new Error(`missing fact: fact_id=${targetFactId}`);
		}
		const traversal = traverseDownstream(targetFactId, graph.edges);
		return {
			targetFactId,
			affectedFactIds: traversal.affectedFactIds,
			downstreamFactIds: traversal.affectedFactIds.slice(1),
			affectedFactCount: traversal.affectedFactIds.length,
			recentRecallCount: this.readRecentRecallCount([targetFactId]),
			affectedEpochIds: this.readAffectedEpochIds(traversal.affectedFactIds),
			blocked: traversal.blocked,
			...(traversal.blocked ? { blockedReason: "cycle_detected" as const } : {}),
		};
	}

	private buildForwardGraph(): ForwardGraph {
		const memoryRows = this.sqlite
			.prepare("SELECT id, fact_id, category, project_id, derived_from FROM nodix_memories")
			.all() as MemoryLineageRow[];
		const graph = new Map<string, string[]>();
		const knownFactIds = new Set<string>();
		for (const row of memoryRows) {
			const factId = row.fact_id ?? row.id;
			knownFactIds.add(factId);
			for (const parentFactId of parseFactIdArray(row.derived_from)) {
				addEdge(graph, parentFactId, factId);
			}
			if (!graph.has(factId)) {
				graph.set(factId, graph.get(factId) ?? []);
			}
		}
		const eventRows = this.sqlite
			.prepare(
				`SELECT fact_id, memory_kind, project_id, derived_from
				 FROM nodix_memory_events
				 WHERE fact_id IS NOT NULL
				   AND derived_from IS NOT NULL
				 ORDER BY id ASC`,
			)
			.all() as MemoryEventLineageRow[];
		for (const row of eventRows) {
			if (!row.fact_id) continue;
			knownFactIds.add(row.fact_id);
			for (const parentFactId of parseFactIdArray(row.derived_from)) {
				addEdge(graph, parentFactId, row.fact_id);
			}
			if (!graph.has(row.fact_id)) {
				graph.set(row.fact_id, graph.get(row.fact_id) ?? []);
			}
		}
		return { edges: graph, knownFactIds };
	}

	private deleteFacts(factIds: string[]): string[] {
		const purgedFactIds: string[] = [];
		for (let i = 0; i < factIds.length; i += DELETE_BATCH_SIZE) {
			const batchFactIds = factIds.slice(i, i + DELETE_BATCH_SIZE);
			const batch = JSON.stringify(batchFactIds);
			const memoryIds = (
				this.sqlite
					.prepare(
						"SELECT id FROM nodix_memories WHERE fact_id IN (SELECT value FROM json_each(?))",
					)
					.all(batch) as Array<{ id: string }>
			).map((row) => row.id);
			this.deleteChunksByMemoryIds(memoryIds);
			const deletedRows = this.sqlite
				.prepare(
					`DELETE FROM nodix_memories
					 WHERE fact_id IN (SELECT value FROM json_each(?))
					 RETURNING fact_id`,
				)
				.all(batch) as Array<{ fact_id: string | null }>;
			const deletedFactIds = new Set(
				deletedRows.flatMap((row) => (row.fact_id === null ? [] : [row.fact_id])),
			);
			purgedFactIds.push(...batchFactIds.filter((factId) => deletedFactIds.has(factId)));
		}
		return purgedFactIds;
	}

	private deleteChunksByMemoryIds(memoryIds: string[]): void {
		if (memoryIds.length === 0) return;
		for (let i = 0; i < memoryIds.length; i += DELETE_BATCH_SIZE) {
			const batch = JSON.stringify(memoryIds.slice(i, i + DELETE_BATCH_SIZE));
			const chunkIds = (
				this.sqlite
					.prepare(
						"SELECT chunk_id FROM nodix_memory_chunks WHERE memory_id IN (SELECT value FROM json_each(?))",
					)
					.all(batch) as ChunkRow[]
			).map((row) => row.chunk_id);
			for (let j = 0; j < chunkIds.length; j += DELETE_BATCH_SIZE) {
				const chunkBatch = JSON.stringify(chunkIds.slice(j, j + DELETE_BATCH_SIZE));
				this.sqlite
					.prepare("DELETE FROM nodix_memory_chunk_vectors WHERE id IN (SELECT value FROM json_each(?))")
					.run(chunkBatch);
			}
			this.sqlite
				.prepare("DELETE FROM nodix_memory_chunks WHERE memory_id IN (SELECT value FROM json_each(?))")
				.run(batch);
		}
	}

	private readRecentRecallCount(factIds: string[]): number {
		if (factIds.length === 0) return 0;
		const batch = JSON.stringify(factIds);
		const row = this.sqlite
			.prepare(
				`SELECT COUNT(*) AS count
				 FROM nodix_memory_events
				 WHERE event_type = 'recall'
				   AND fact_id IN (SELECT value FROM json_each(?))
				   AND timestamp_ms >= ?`,
			)
			.get(batch, Date.now() - RECENT_RECALL_WINDOW_MS) as { count: number } | undefined;
		return row?.count ?? 0;
	}

	private readAffectedEpochIds(factIds: string[]): string[] {
		if (factIds.length === 0) return [];
		const epochIds: string[] = [];
		const seen = new Set<string>();
		for (let i = 0; i < factIds.length; i += DELETE_BATCH_SIZE) {
			const batch = JSON.stringify(factIds.slice(i, i + DELETE_BATCH_SIZE));
			const memoryRows = this.sqlite
				.prepare(
					`SELECT consolidation_epoch_id
					 FROM nodix_memories
					 WHERE fact_id IN (SELECT value FROM json_each(?))
					   AND consolidation_epoch_id IS NOT NULL
					 ORDER BY id ASC`,
				)
				.all(batch) as EpochRow[];
			const eventRows = this.sqlite
				.prepare(
					`SELECT consolidation_epoch_id
					 FROM nodix_memory_events
					 WHERE fact_id IN (SELECT value FROM json_each(?))
					   AND consolidation_epoch_id IS NOT NULL
					 ORDER BY id ASC`,
				)
				.all(batch) as EpochRow[];
			for (const row of [...memoryRows, ...eventRows]) {
				if (!row.consolidation_epoch_id || seen.has(row.consolidation_epoch_id)) continue;
				seen.add(row.consolidation_epoch_id);
				epochIds.push(row.consolidation_epoch_id);
			}
		}
		return epochIds;
	}

	private insertPurgeEvent(
		targetFactId: string,
		result: MemoryTelemetryPurgeResult,
		preview: MemoryTelemetryPurgePreview,
		anchor: PurgeEventAnchor,
	): void {
		const metadata: MemoryTelemetryMetadata = validateMemoryTelemetryMetadata("purge", {
			status: result.status,
			affected_fact_count: preview.affectedFactCount,
			purged_fact_ids: result.purgedFactIds,
			failed_fact_ids: result.failedFactIds,
			...(result.blockedReason ? { blocked_reason: result.blockedReason } : {}),
		});
		this.sqlite
			.prepare(
				`INSERT INTO nodix_memory_events
				 (event_type, fact_id, memory_kind, timestamp_ms, agent_id, project_id, metadata_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				"purge",
				targetFactId,
				anchor.memoryKind,
				Date.now(),
				this.agentId,
				anchor.projectId,
				JSON.stringify(metadata),
			);
	}

	private readPurgeEventAnchor(targetFactId: string): PurgeEventAnchor {
		const primary = this.sqlite
			.prepare(
				"SELECT id, fact_id, category, project_id FROM nodix_memories WHERE fact_id = ? ORDER BY id ASC LIMIT 1",
			)
			.get(targetFactId) as TargetMemoryRow | undefined;
		if (primary) {
			return { memoryKind: primary.category, projectId: primary.project_id };
		}
		const event = this.sqlite
			.prepare(
				`SELECT memory_kind, project_id
				 FROM nodix_memory_events
				 WHERE fact_id = ?
				 ORDER BY id DESC
				 LIMIT 1`,
			)
			.get(targetFactId) as MemoryEventLineageRow | undefined;
		return { memoryKind: event?.memory_kind ?? null, projectId: event?.project_id ?? null };
	}
}

function addEdge(graph: Map<string, string[]>, parentFactId: string, childFactId: string): void {
	const children = graph.get(parentFactId) ?? [];
	if (!children.includes(childFactId)) {
		children.push(childFactId);
	}
	graph.set(parentFactId, children);
}

function traverseDownstream(
	targetFactId: string,
	graph: Map<string, string[]>,
): { affectedFactIds: string[]; blocked: boolean } {
	const affectedFactIds: string[] = [];
	const visited = new Set<string>();
	const active = new Set<string>();
	let blocked = false;

	function visit(factId: string): void {
		if (active.has(factId)) {
			blocked = true;
			return;
		}
		if (visited.has(factId)) return;
		visited.add(factId);
		active.add(factId);
		affectedFactIds.push(factId);
		const children = graph.get(factId) ?? [];
		for (const child of children) {
			visit(child);
		}
		active.delete(factId);
	}

	visit(targetFactId);
	return { affectedFactIds, blocked };
}

function parseFactIdArray(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
	} catch {
		return [];
	}
}

function normalizeRequired(value: string | undefined, label: string): string {
	const normalized = value?.trim();
	if (!normalized) {
		throw new Error(`${label} is required`);
	}
	return normalized;
}
