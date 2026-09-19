/** @file memory-store-base.ts
 * @purpose Owns MemoryStore construction and declares prototype-mounted storage APIs.
 * @boundary Runtime collaborators and cross-file method typing only.
 */

import type {
	RemMutationResult,
	WriteTextVersionInput,
} from "../engine/rem/index";

import type { MemoryTier, MemoryMetadata } from "../engine/shared/types";
import type {
	AdmittedTaskLifecycleAssertion,
	TaskLifecycleCommandClaim,
} from "../engine/extraction/task-lifecycle-assertion";
import type {
	TaskLifecycleInstanceSnapshot,
	TaskLifecycleResolution,
} from "../engine/extraction/task-lifecycle-resolver";
import {
	type BulkDeleteResult,
	type ChunkSearchResult,
	type DrizzleDB,
	type Embedder,
	initDb,
	type ListOptions,
	log,
	type MemoryCategory,
	type MemoryDeleteOptions,
	type MemoryEntry,
	type MemoryRow,
	type MemorySearchResult,
	Mutex,
	type PreparedChunkRow,
	type QuarantinedStoreInput,
	type RecordUnplacedCandidateInput,
	type RecordUnplacedCandidateResult,
	type ReflectionResolveOutcome,
	type SearchOptions,
	type SqliteDatabaseLike,
	type StatsResult,
	StorageError,
	type StoreConfig,
	type StoreInput,
	type StoreResult,
	type UnplacedCandidate,
	type UnplacedCandidateQuery,
	type UpdateChanges,
	VECTOR_DIMENSION_DEFAULT,
} from "./memory-store-shared";
import { MemoryTelemetryEventWriter } from "../engine/telemetry/memory-telemetry-events";
import { migrateLegacyRemUpdateStamps } from "./rem-update-stamp-migration";

export type {
	BulkDeleteResult,
	ChunkSearchResult,
	ChunkSearchRow,
	ListOptions,
	MemoryRow,
	PreparedChunkRow,
	QuarantineDispositionReason,
	RecordUnplacedCandidateInput,
	RecordUnplacedCandidateResult,
	SearchOptions,
	StatsResult,
	StoreConfig,
	StoreInput,
	StoreResult,
	QuarantinedStoreInput,
	UnplacedCandidate,
	UnplacedCandidateQuery,
	UpdateChanges,
} from "./memory-store-shared";

export type SupersedeActiveFactGuard =
	| {
			factKey: string;
			expectedId: string | null;
			expectedIds?: never;
	  }
	| {
			factKey: string;
			expectedIds: readonly string[];
			expectedId?: never;
	  };

export interface ActiveTaskProjectionGuard {
	taskIds: readonly string[];
	maxItems: number;
}

export interface SupersedeClose {
	id: string;
	buildMetadata: (createdId: string) => string;
	expectedContentHash?: string;
	expectedMetadata?: string;
}

export interface SupersedePreserveExisting {
	id: string;
	expectedContentHash: string;
	expectedMetadata: string;
}

export interface ProfileRecoveryWrite {
	mutationAttemptId: string;
	sectionName: string;
	removedAtMs: number;
}

export interface ProfileRecoveryEntry {
	mutationAttemptId: string;
	removedRowId: string;
	removedValue: string;
	sectionName: string;
	removedAtMs: number;
}

export type MemoryRelationPredicate =
	| "IS_A"
	| "WORKS_ON"
	| "NEEDS"
	| "PREFERS"
	| "FORBIDS"
	| "USES"
	| "DEPENDS_ON"
	| "CAUSED"
	| "FIXED_BY"
	| "DECIDED"
	| "SUPERSEDES"
	| "GOVERNED_BY"
	| "OWNED_BY"
	| "MEMBER_OF"
	| "LOCATED_AT"
	| "HAS_SKILL"
	| "INTERESTED_IN"
	| "HAS_ACCOUNT"
	| "HAS_OCCUPATION"
	| "HAS_METRIC"
	| "WORKS_AT"
	| "ATTENDED"
	| "MENTIONS";

export interface MemoryRelation {
	sourceCardId: string;
	projectId: string;
	subject: string;
	predicate: MemoryRelationPredicate;
	object: string;
	createdAt: number;
}

export interface MemoryRelationWalkInput {
	projectId: string;
	node: string;
	direction?: "outgoing" | "incoming";
	includeMentions?: boolean;
}

export type AtomicExtractionLedgerState =
	| "open"
	| "calls_recorded"
	| "complete"
	| "pending_reprocess";

export type AtomicExtractionReprocessReason =
	| "input-overflow"
	| "truncation-exhaustion"
	| "parse-exhaustion";

export interface AtomicExtractionLedgerKey {
	conversationId: string;
	chunkHash: string;
	pipelineVersion: string;
}

export interface AtomicExtractionRunParameters {
	maxInputTokens: number;
	outputTokenBudget: number;
	subchunkCount: number;
}

export interface AtomicExtractionReprocessBounds {
	maxOutputTokenBudget: number;
	requiredInputTokens?: number;
}

export type AtomicExtractionRepairStrategy =
	| "raise-input-budget"
	| "rechunk-smaller"
	| "subchunk-smaller"
	| "double-output-budget"
	| "rerun-as-is";

export interface AtomicExtractionLedgerEntry extends AtomicExtractionLedgerKey {
	state: AtomicExtractionLedgerState;
	rawChunk: string;
	routingSnapshotId: string;
	runParameters: AtomicExtractionRunParameters;
	reprocessReason: AtomicExtractionReprocessReason | null;
	reprocessAttemptCount: number;
	failedReply: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface AtomicExtractionWriteRelation {
	subject: string;
	predicate: MemoryRelationPredicate;
	object: string;
}

export interface AtomicMemoryEntityRegistration {
	entityId: string;
	displayName: string;
	normalizedName: string;
}

export interface AtomicMemoryEntityResolution {
	entityId: string;
	registration?: AtomicMemoryEntityRegistration;
}

export interface AtomicExtractionWriteCard {
	idempotencyKey: string;
	refusedAttribute?: string;
	globalTurnIndex: number;
	endsCurrent: boolean;
	endedAt: number | null;
	text: string;
	category: "episodic" | "profile" | "state";
	subject: string | null;
	attribute: string | null;
	/**
	 * When the remembered thing happened — the resolved event time, or the session's own time when
	 * the model resolved none. NOT the moment of the write.
	 *
	 * Retrieval ages a row as `now - entry.timestamp` (retriever-scoring-pipeline.ts:222,291), so
	 * a write clock here makes every row equally new and kills recency and time decay outright.
	 * Measured 2026-09-04: the write bound its own `nowMs`, and all 40 episodic rows of a Memora
	 * persona carried the run's date while their own text carried the right one — against 376 rows
	 * correctly spread over the conversation week in the store the previous path wrote.
	 */
	timestamp: number;
	validFrom: number | null;
	validUntil: number | null;
	importance: number;
	timezone: string;
	lane: "active" | "parked";
	dispositionReason: "compound" | "subject-unverified" | "subject-rejected" | null;
	/**
	 * PARKED rows only: the record as judged, serialized, so a rejected candidate can be replayed.
	 *
	 * The unplaced-candidate migration refuses to move a non-active row that lacks it, and refuses
	 * loudly: measured 2026-09-04, 18 parked rows per persona had no value here, the migration
	 * aborted inside `initDb`, and all three Memora personas produced no score at all.
	 *
	 * It stays null on an active row on purpose. REM reads this same column as replace evidence
	 * (rem-batch-executor.ts:1855) and tests it with `evidence.includes(clause.value)` over rows
	 * where `lane = 'active'`; a serialized record escapes quotes and newlines, so filling it for
	 * an active row would refuse a replace that a plain-text row allows. REM never reads a parked
	 * row, so the two consumers do not collide.
	 */
	rawCandidateJson: string | null;
	metadata?: Readonly<Record<string, unknown>>;
	relations: readonly AtomicExtractionWriteRelation[];
}

export interface AtomicExtractionWriteInput {
	ledgerKey: AtomicExtractionLedgerKey;
	projectId: string;
	extractorVersion: string;
	nowMs: number;
	cards: readonly AtomicExtractionWriteCard[];
	entities?: readonly AtomicMemoryEntityRegistration[];
}

export interface AtomicExtractionWriteResult {
	ledger: AtomicExtractionLedgerEntry;
	cardIds: string[];
	createdCount: number;
	suppressed: Array<{
		idempotencyKey: string;
		reason: "key-suppressed" | "content-suppressed";
	}>;
}

export type MemorySuppressionInput =
	| { projectId: string; subject: string; attribute: string; nowMs: number }
	| { projectId: string; content: string; nowMs: number };

export interface MemorySuppressionResult {
	created: boolean;
	shape: "key" | "content";
	projectId: string;
}

export interface BeginAtomicExtractionChunkInput extends AtomicExtractionLedgerKey {
	rawChunk: string;
	routingSnapshotId: string;
	runParameters: AtomicExtractionRunParameters;
	nowMs: number;
}

export type BeginAtomicExtractionChunkResult =
	| { action: "run"; entry: AtomicExtractionLedgerEntry }
	| { action: "pending"; entry: AtomicExtractionLedgerEntry }
	| { action: "skip"; entry: AtomicExtractionLedgerEntry };

export type ReopenAtomicExtractionChunkResult =
	| {
			status: "reopened";
			strategy: AtomicExtractionRepairStrategy;
			entry: AtomicExtractionLedgerEntry;
	  }
	| { status: "stuck"; entry: AtomicExtractionLedgerEntry };

export interface ExtractionTimestampResolution {
	resolvedAtMs: number;
	created: boolean;
}

export type TaskLifecycleTimestampSource = "event_at" | "session_time" | "first_resolution";

export interface TaskLifecycleTimestampInput {
	projectId: string;
	commandId: string;
	effectiveAtMs: number;
	timeSource: TaskLifecycleTimestampSource;
}

export interface TaskLifecycleTimestampResolution {
	effectiveAtMs: number;
	timeSource: TaskLifecycleTimestampSource;
	created: boolean;
}

export type TaskLifecycleWriteOutcome =
	| "created_instance"
	| "created_unresolved_instance"
	| "refined"
	| "evidence_only"
	| "completed"
	| "removed"
	| "terminal_evidence_only"
	| "none"
	| "uncertain";

export interface TaskLifecycleWriteInput {
	admission: AdmittedTaskLifecycleAssertion;
	commandClaim: TaskLifecycleCommandClaim;
	resolution: TaskLifecycleResolution;
	todoProvenance?: {
		sourceSession: string;
		extractionPath: string;
		closeReason?: string;
	};
	atomicFactWrite?: AtomicExtractionWriteInput;
}

export interface TaskLifecycleBatchWriteInput {
	taskWriteFactories: readonly (() => TaskLifecycleWriteInput)[];
	atomicFactWrite: AtomicExtractionWriteInput;
}

export interface TaskLifecycleCommandReplayInput {
	admission: AdmittedTaskLifecycleAssertion;
	commandClaim: TaskLifecycleCommandClaim;
}

export interface TaskLifecycleWriteResult {
	commandId: string;
	result: TaskLifecycleWriteOutcome;
	activeTaskId: string | null;
	activeTaskRevisionId: string | null;
	replayed: boolean;
	atomicFactWrite?: AtomicExtractionWriteResult;
}

export interface TaskLifecycleBatchWriteResult {
	tasks: TaskLifecycleWriteResult[];
	atomicFactWrite: AtomicExtractionWriteResult;
}

export type TodoStatus = "open" | "done" | "removed";

export interface TodoRecord {
	projectId: string;
	activeTaskId: string;
	description: string;
	status: TodoStatus;
	openedAt: number;
	closedAt: number | null;
	closeReason: string | null;
}

export interface TodoListInput {
	projectIdFilter: readonly string[];
	includeHistory: boolean;
	limit: number;
}

export interface TodoListResult {
	items: TodoRecord[];
	totalCount: number;
}

export interface TaskLifecycleMigrationSourceRow {
	legacy_row_locator: string;
	project_id: string;
	description?: string;
	description_sha256?: string;
	legacy_status: "active" | "completed" | "removed";
	created_at_ms: number;
	transitioned_at_ms: number;
	ordered_lifecycle_events: readonly unknown[];
	provenance: Readonly<Record<string, unknown>>;
	binding_evidence?: Readonly<Record<string, unknown>>;
}

export interface TaskLifecycleMigrationCensusRow {
	legacy_row_locator: string;
	project_id: string;
	legacy_status: "active" | "completed" | "removed";
	preserved_created_at_ms: number;
	preserved_transitioned_at_ms: number;
	preserved_lifecycle_events?: readonly unknown[];
	provenance?: Readonly<Record<string, unknown>>;
	binding_evidence: Readonly<Record<string, unknown>> | string;
	legacy_command_binding: "bound" | "preserved_unbound";
	source_command_tuple: readonly string[] | null;
	command_id: string | null;
	migration_group_tuple: readonly string[];
	migration_group_key: string;
	migration_instance_tuple: readonly string[];
	active_task_id: string;
	migration_revision_tuple: readonly string[] | null;
	active_task_revision_id: string | null;
	revision_role: "current" | "terminal_non_current" | "evidence_only";
	projection_member: boolean;
	disposition: string;
	grouping_evidence?: string;
}

export interface TaskLifecycleMigrationManifestRow {
	source: TaskLifecycleMigrationSourceRow;
	census: TaskLifecycleMigrationCensusRow;
}

export interface TaskLifecycleMigrationManifest {
	schemaVersion: 1;
	manifestId: string;
	inputStoreHash: string;
	rows: TaskLifecycleMigrationManifestRow[];
	manifestHash: string;
}

export interface TaskLifecycleMigrationApplyResult {
	manifestHash: string;
	stateHash: string;
	rowCount: number;
	replayed: boolean;
}

export class TaskLifecycleCommandCollisionError extends StorageError {
	constructor(readonly projectId: string, readonly commandId: string) {
		super(
			`Task lifecycle command '${projectId}/${commandId}' conflicts with its persisted canonical input`,
		);
		this.name = "TaskLifecycleCommandCollisionError";
	}
}

export class TaskLifecycleStateCollisionError extends StorageError {
	constructor(readonly identity: string) {
		super(`Task lifecycle state identity '${identity}' conflicts with its canonical tuple`);
		this.name = "TaskLifecycleStateCollisionError";
	}
}

export class TaskLifecycleStaleResolutionError extends StorageError {
	constructor(readonly activeTaskId: string) {
		super(`Task lifecycle resolution for '${activeTaskId}' is no longer current`);
		this.name = "TaskLifecycleStaleResolutionError";
	}
}

export class TaskLifecycleTimestampCollisionError extends StorageError {
	constructor(readonly projectId: string, readonly commandId: string) {
		super(
			`Task lifecycle timestamp '${projectId}/${commandId}' is already bound to a different resolution`,
		);
		this.name = "TaskLifecycleTimestampCollisionError";
	}
}

export class StaleSupersedeTargetError extends StorageError {
	constructor(
		readonly factKey: string,
		readonly expectedId: string | null,
		readonly expectedIds?: readonly string[] | undefined,
	) {
		super(
			expectedIds && expectedIds.length > 1
				? `Active fact '${factKey}' no longer matches the expected memory set`
				: expectedId === null
				? `Active fact '${factKey}' appeared before initial write`
				: `Active fact '${factKey}' no longer matches expected memory '${expectedId}'`,
		);
		this.name = "StaleSupersedeTargetError";
	}
}

export class MemoryStore {
	public readonly dbPath: string;
	public hasFtsSupport: boolean;
	readonly db: DrizzleDB;
	readonly sqlite: SqliteDatabaseLike;
	readonly vectorDim: number;
	readonly telemetryEvents: MemoryTelemetryEventWriter;
	readonly writeMutex: Mutex;
	readonly embedder: Embedder;
	backfillComplete: boolean;
	backfillPromise: Promise<void> | null;
	backfillTimer: ReturnType<typeof setTimeout> | null;
	backfillFailureCount: number;
	backfillNextRetryAt: number;
	backfillLastFailureAt: number;
	closed: boolean;
	sqliteClosed: boolean;
	findByContentHash(_hash: string, _scope?: string): MemoryEntry | undefined {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	findByExtractionIdempotencyKey(
		_projectId: string,
		_key: string,
	): MemoryEntry | undefined {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	recordUnplacedCandidate(
		_input: RecordUnplacedCandidateInput,
	): RecordUnplacedCandidateResult {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	listUnplacedCandidates(_query?: UnplacedCandidateQuery): UnplacedCandidate[] {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	resolveExtractionTimestamp(
		_projectId: string,
		_replayKey: string,
		_validAtNowMs: number,
	): ExtractionTimestampResolution {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	resolveTaskLifecycleTimestamp(
		_input: TaskLifecycleTimestampInput,
	): TaskLifecycleTimestampResolution {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	applyTaskLifecycleResolution(
		_input: TaskLifecycleWriteInput,
	): Promise<TaskLifecycleWriteResult> {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	applyTaskLifecycleBatchWithAtomicWrite(
		_input: TaskLifecycleBatchWriteInput,
	): Promise<TaskLifecycleBatchWriteResult> {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	findTaskLifecycleCommandReplay(
		_input: TaskLifecycleCommandReplayInput,
	): TaskLifecycleWriteResult | undefined {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	readTaskLifecycleInstances(_projectId: string): TaskLifecycleInstanceSnapshot[] {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	listTodos(_input: TodoListInput): TodoListResult {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	readProfileRecoveryEntries(_rowId: string): ProfileRecoveryEntry[] {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	applyTaskLifecycleMigration(
		_manifest: TaskLifecycleMigrationManifest,
	): Promise<TaskLifecycleMigrationApplyResult> {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	getById(_id: string): MemoryEntry | undefined {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	getByFactKey(_scope: string, _factKey: string): MemoryEntry | undefined {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	isMemoryOnFactSurface(_id: string): boolean {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	getAtomicBySubjectAttribute(
		_projectId: string,
		_subject: string,
		_attribute: string,
	): MemoryEntry | undefined {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	resolveAtomicMemoryEntity(
		_projectId: string,
		_displayName: string,
	): AtomicMemoryEntityResolution {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	listAtomicValidAt(_projectId: string, _atMs: number): MemoryEntry[] {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	walkMemoryRelations(_input: MemoryRelationWalkInput): MemoryRelation[] {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	beginAtomicExtractionChunk(
		_input: BeginAtomicExtractionChunkInput,
	): BeginAtomicExtractionChunkResult {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	recordAtomicExtractionCalls(_key: AtomicExtractionLedgerKey, _nowMs: number): void {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	markAtomicExtractionPending(
		_key: AtomicExtractionLedgerKey,
		_reason: AtomicExtractionReprocessReason,
		_failedReply: string | null,
		_nowMs: number,
		_runParameters?: AtomicExtractionRunParameters,
	): void {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	reopenAtomicExtractionChunk(
		_key: AtomicExtractionLedgerKey,
		_attemptCap: number,
		_bounds: AtomicExtractionReprocessBounds,
		_nowMs: number,
	): ReopenAtomicExtractionChunkResult {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	completeAtomicExtractionChunk(
		_key: AtomicExtractionLedgerKey,
		_nowMs: number,
		_write: (database: SqliteDatabaseLike) => void,
	): AtomicExtractionLedgerEntry {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	storeAtomicExtractionChunk(
		_input: AtomicExtractionWriteInput,
	): Promise<AtomicExtractionWriteResult> {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	hasLiveEndedRowInGroup(
		_projectId: string,
		_category: string,
		_subject: string,
		_attribute: string | null,
	): boolean {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	createMemorySuppression(_input: MemorySuppressionInput): Promise<MemorySuppressionResult> {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	store(_entry: StoreInput): Promise<StoreResult> {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	storeQuarantinedCandidate(_entry: QuarantinedStoreInput): Promise<StoreResult> {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	bulkStore(entries: Array<StoreInput | null | undefined>): Promise<MemoryEntry[]> {
		void entries;
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	supersede(args: {
		create: StoreInput;
		closes: SupersedeClose[];
		activeFactGuard?: SupersedeActiveFactGuard;
		activeTaskProjectionGuard?: ActiveTaskProjectionGuard;
		preserveExisting?: SupersedePreserveExisting;
		reviveInvalidatedExisting?: boolean;
		profileRecovery?: ProfileRecoveryWrite;
	}): Promise<MemoryEntry> {
		void args;
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	createMergeWithRawLineage(args: {
		rawSource: StoreInput;
		merged:
			| StoreInput
			| ((ids: { rawSourceId: string; mergedId: string }) => StoreInput);
		closeExisting: Array<{
			id: string;
			buildMetadata: (ids: { rawSourceId: string; mergedId: string }) => string;
		}>;
		buildRawSourceMetadata: (ids: { rawSourceId: string; mergedId: string }) => string;
	}): Promise<{ rawSource: MemoryEntry; merged: MemoryEntry }> {
		void args;
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	createEventAndSupersede(args: {
		event: StoreInput;
		replacement: StoreInput;
		closeExisting: Array<{
			id: string;
			buildMetadata: (ids: { eventId: string; replacementId: string }) => string;
		}>;
		profileRecovery?: ProfileRecoveryWrite;
	}): Promise<{ event: MemoryEntry; replacement: MemoryEntry }> {
		void args;
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	importEntry(
		entry: Omit<MemoryEntry, "timezone"> & {
			timezone?: string;
			vector?: Float32Array;
			trusted?: boolean;
			system?: boolean;
			offlineFamily?: boolean;
		},
	): Promise<MemoryEntry> {
		void entry;
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	hasId(_id: string): Promise<boolean> {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	searchChunksSemantic(vector: Float32Array, opts: SearchOptions): Promise<ChunkSearchResult[]> {
		void vector;
		void opts;
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	searchChunksKeyword(query: string, opts: SearchOptions): Promise<ChunkSearchResult[]> {
		void query;
		void opts;
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	searchSemantic(vector: Float32Array, opts: SearchOptions): Promise<MemorySearchResult[]> {
		void vector;
		void opts;
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	hasIncompleteTaskCarrierPopulation(opts: SearchOptions): boolean {
		void opts;
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	searchAggregationEvidence(opts: SearchOptions): Promise<MemorySearchResult[]> {
		void opts;
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	searchKeyword(query: string, opts: SearchOptions): Promise<MemorySearchResult[]> {
		void query;
		void opts;
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	getVectorsByIds(_ids: string[]): Map<string, Float32Array> {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	getChunksByParent(
		memoryIds: string[],
		facetPolicy?: SearchOptions["facetPolicy"],
	): Map<string, Array<{ chunkIndex: number; chunkText: string; facet: "current" | "history" }>> {
		void memoryIds;
		void facetPolicy;
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	delete(_idOrPrefix: string, _options?: MemoryDeleteOptions): Promise<number> {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	deleteMany(_ids: string[], _options?: MemoryDeleteOptions): Promise<number> {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	list(_opts: ListOptions): Promise<MemoryEntry[]> {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	stats(_scope?: string): Promise<StatsResult> {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	update(id: string, changes: UpdateChanges): Promise<MemoryEntry | null> {
		void id;
		void changes;
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	applyRemTextVersion(_input: WriteTextVersionInput): Promise<RemMutationResult> {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	updateTier(
		memoryId: string,
		newTier: MemoryTier,
		options?: { writerAuthority?: "offline-family" },
	): Promise<void> {
		void memoryId;
		void newTier;
		void options;
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	updateMetadata(memoryId: string, patch: Partial<MemoryMetadata>): Promise<void> {
		void memoryId;
		void patch;
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	resolveReflectionItem(
		memoryId: string,
		opts: {
			resolvedAt: number;
			resolvedBy?: string;
			note?: string;
			writerAuthority?: "offline-family";
		},
	): Promise<ReflectionResolveOutcome> {
		void memoryId;
		void opts;
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	listReflectionItems(opts: {
		projectIdFilter?: string[];
		limit?: number;
		unresolvedOnly?: boolean;
	}): Promise<MemoryEntry[]> {
		void opts;
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	applyMetadataDelta(
		memoryId: string,
		deltaFn: (current: MemoryMetadata) => Partial<MemoryMetadata>,
	): Promise<void> {
		void memoryId;
		void deltaFn;
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	applyMetadataDeltas(
		entries: Array<{
			memoryId: string;
			deltaFn: (current: MemoryMetadata) => Partial<MemoryMetadata> | undefined;
		}>,
	): Promise<void> {
		void entries;
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	getMemoryMetadata(memoryId: string): Promise<MemoryMetadata | undefined> {
		void memoryId;
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	bulkDelete(
		filter: { projectId?: string; category?: MemoryCategory },
		_options?: MemoryDeleteOptions,
	): Promise<BulkDeleteResult> {
		void filter;
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	close(): Promise<void> {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	closeSync(): void {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	startLegacyChunkBackfill(): void {
		throw new StorageError("MemoryStore implementation modules were not loaded");
	}

	scheduleLegacyChunkBackfill(): void {
		if (this.closed || this.backfillComplete || this.backfillPromise || this.backfillTimer) return;
		this.backfillTimer = setTimeout(() => {
			this.backfillTimer = null;
			this.startLegacyChunkBackfill();
		}, 0);
		this.backfillTimer.unref();
	}

	cancelScheduledLegacyChunkBackfill(): boolean {
		if (this.backfillTimer === null) return false;
		clearTimeout(this.backfillTimer);
		this.backfillTimer = null;
		return true;
	}

	constructor(config: StoreConfig) {
		this.dbPath = config.dbPath;
		// This persistence step establishes state that later reads and cleanup paths depend on.
		this.vectorDim = config.vectorDim ?? VECTOR_DIMENSION_DEFAULT;
		this.writeMutex = new Mutex();
		this.embedder = config.embedder;
		this.backfillComplete = false;
		this.backfillPromise = null;
		this.backfillTimer = null;
		this.backfillFailureCount = 0;
		this.backfillNextRetryAt = 0;
		this.backfillLastFailureAt = 0;
		this.closed = false;
		this.sqliteClosed = false;
		const db = initDb(this.dbPath, this.vectorDim);
		// The chokepoint wrapper — NOT the raw $client — so every store statement
		// flows through the shared statement cache.
		const sqlite = db.chokepoint;
		// Isolate the storage operation that can fail because of runtime I/O or input shape.
		try {
			this.vectorDim = db.vectorDimension;
			const hasFtsSupport =
				sqlite
					.prepare(
						"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'nodix_memory_chunks_fts' LIMIT 1",
					)
					.get() !== undefined;
			this.db = db;
			// This persistence step establishes state that later reads and cleanup paths depend on.
			this.sqlite = sqlite;
			this.hasFtsSupport = hasFtsSupport;
			this.telemetryEvents = new MemoryTelemetryEventWriter({
				sqlite,
				config: config.memoryTelemetry,
			});
			migrateLegacyRemUpdateStamps(sqlite);
		} catch (error) {
			sqlite.close();
			// Surface this invalid storage state as an explicit typed failure.
			throw error;
		}
		// Log operational context for storage without changing control flow.
		log.info("memory store initialized", {
			dbPath: config.dbPath,
			vectorDim: this.vectorDim,
			hasFtsSupport: this.hasFtsSupport,
		}, {
			event_name: "sno_station_mem.memory-store-base.memory.store.initialized",
			file: "packages/sno-station-mem/src/store/memory-store-base.ts",
			function: "<anonymous callback>",
			site_id: "memory-store-base.<anonymous callback>.3dd5e75e4f",
		});
		this.scheduleLegacyChunkBackfill();
	}
}

export interface MemoryStoreInternals {
	dbPath: string;
	hasFtsSupport: boolean;
	db: DrizzleDB;
	sqlite: SqliteDatabaseLike;
	vectorDim: number;
	telemetryEvents: MemoryTelemetryEventWriter;
	writeMutex: Mutex;
	embedder: Embedder;
	backfillComplete: boolean;
	backfillPromise: Promise<void> | null;
	backfillTimer: ReturnType<typeof setTimeout> | null;
	backfillFailureCount: number;
	backfillNextRetryAt: number;
	backfillLastFailureAt: number;
	closed: boolean;
	sqliteClosed: boolean;
	toEntry(row: MemoryRow): MemoryEntry;
	parseMetadataObject(metadata: string | null): Record<string, unknown>;
	validateVector(vector: Float32Array): void;
	prepareChunkInserts(memoryId: string, text: string): Promise<PreparedChunkRow[]>;
	writeChunkRowsSync(rows: PreparedChunkRow[], projectId: string): void;
	deleteChunksByMemoryIdsSync(memoryIds: string[]): void;
	readChunklessMemoryRows(limit: number): MemoryRow[];
	memoryExists(memoryId: string): boolean;
	memoryHasChunks(memoryId: string): boolean;
	backfillMissingChunks(): Promise<number>;
	startLegacyChunkBackfill(): void;
	scheduleLegacyChunkBackfill(): void;
	cancelScheduledLegacyChunkBackfill(): boolean;
	readExistingByHash(projectId: string, hash: string, category: MemoryCategory): MemoryRow | undefined;
	findByContentHash(hash: string, projectId?: string): MemoryEntry | undefined;
	findByExtractionIdempotencyKey(projectId: string, key: string): MemoryEntry | undefined;
	recordUnplacedCandidate(input: RecordUnplacedCandidateInput): RecordUnplacedCandidateResult;
	listUnplacedCandidates(query?: UnplacedCandidateQuery): UnplacedCandidate[];
	resolveExtractionTimestamp(
		projectId: string,
		replayKey: string,
		validAtNowMs: number,
	): ExtractionTimestampResolution;
	resolveTaskLifecycleTimestamp(
		input: TaskLifecycleTimestampInput,
	): TaskLifecycleTimestampResolution;
	applyTaskLifecycleResolution(
		input: TaskLifecycleWriteInput,
	): Promise<TaskLifecycleWriteResult>;
	applyTaskLifecycleBatchWithAtomicWrite(
		input: TaskLifecycleBatchWriteInput,
	): Promise<TaskLifecycleBatchWriteResult>;
	findTaskLifecycleCommandReplay(
		input: TaskLifecycleCommandReplayInput,
	): TaskLifecycleWriteResult | undefined;
	readTaskLifecycleInstances(projectId: string): TaskLifecycleInstanceSnapshot[];
	listTodos(input: TodoListInput): TodoListResult;
	readProfileRecoveryEntries(rowId: string): ProfileRecoveryEntry[];
	applyTaskLifecycleMigration(
		manifest: TaskLifecycleMigrationManifest,
	): Promise<TaskLifecycleMigrationApplyResult>;
	getById(id: string): MemoryEntry | undefined;
	getByFactKey(projectId: string, factKey: string): MemoryEntry | undefined;
	isMemoryOnFactSurface(id: string): boolean;
	getAtomicBySubjectAttribute(
		projectId: string,
		subject: string,
		attribute: string,
	): MemoryEntry | undefined;
	resolveAtomicMemoryEntity(
		projectId: string,
		displayName: string,
	): AtomicMemoryEntityResolution;
	listAtomicValidAt(projectId: string, atMs: number): MemoryEntry[];
	walkMemoryRelations(input: MemoryRelationWalkInput): MemoryRelation[];
	beginAtomicExtractionChunk(input: BeginAtomicExtractionChunkInput): BeginAtomicExtractionChunkResult;
	recordAtomicExtractionCalls(key: AtomicExtractionLedgerKey, nowMs: number): void;
	markAtomicExtractionPending(
		key: AtomicExtractionLedgerKey,
		reason: AtomicExtractionReprocessReason,
		failedReply: string | null,
		nowMs: number,
		runParameters?: AtomicExtractionRunParameters,
	): void;
	reopenAtomicExtractionChunk(
		key: AtomicExtractionLedgerKey,
		attemptCap: number,
		bounds: AtomicExtractionReprocessBounds,
		nowMs: number,
	): ReopenAtomicExtractionChunkResult;
	completeAtomicExtractionChunk(
		key: AtomicExtractionLedgerKey,
		nowMs: number,
		write: (database: SqliteDatabaseLike) => void,
	): AtomicExtractionLedgerEntry;
	storeAtomicExtractionChunk(input: AtomicExtractionWriteInput): Promise<AtomicExtractionWriteResult>;
	hasLiveEndedRowInGroup(
		projectId: string,
		category: string,
		subject: string,
		attribute: string | null,
	): boolean;
	createMemorySuppression(input: MemorySuppressionInput): Promise<MemorySuppressionResult>;
	store(entry: StoreInput): Promise<StoreResult>;
	storeQuarantinedCandidate(entry: QuarantinedStoreInput): Promise<StoreResult>;
	bulkStore(entries: Array<StoreInput | null | undefined>): Promise<MemoryEntry[]>;
	supersede(args: {
		create: StoreInput;
		closes: SupersedeClose[];
		activeFactGuard?: SupersedeActiveFactGuard;
		activeTaskProjectionGuard?: ActiveTaskProjectionGuard;
		preserveExisting?: SupersedePreserveExisting;
		reviveInvalidatedExisting?: boolean;
		profileRecovery?: ProfileRecoveryWrite;
	}): Promise<MemoryEntry>;
	createMergeWithRawLineage(args: {
		rawSource: StoreInput;
		merged:
			| StoreInput
			| ((ids: { rawSourceId: string; mergedId: string }) => StoreInput);
		closeExisting: Array<{
			id: string;
			buildMetadata: (ids: { rawSourceId: string; mergedId: string }) => string;
		}>;
		buildRawSourceMetadata: (ids: { rawSourceId: string; mergedId: string }) => string;
	}): Promise<{ rawSource: MemoryEntry; merged: MemoryEntry }>;
	createEventAndSupersede(args: {
		event: StoreInput;
		replacement: StoreInput;
		closeExisting: Array<{
			id: string;
			buildMetadata: (ids: { eventId: string; replacementId: string }) => string;
		}>;
		profileRecovery?: ProfileRecoveryWrite;
	}): Promise<{ event: MemoryEntry; replacement: MemoryEntry }>;
	importEntry(
		entry: Omit<MemoryEntry, "timezone"> & {
			timezone?: string;
			vector?: Float32Array;
			trusted?: boolean;
			system?: boolean;
			offlineFamily?: boolean;
		},
	): Promise<MemoryEntry>;
	hasId(id: string): Promise<boolean>;
	searchChunksSemantic(vector: Float32Array, opts: SearchOptions): Promise<ChunkSearchResult[]>;
	searchChunksKeyword(query: string, opts: SearchOptions): Promise<ChunkSearchResult[]>;
	fetchMemoriesInOrder(memoryIds: string[], opts?: SearchOptions): MemoryRow[];
	searchSemantic(vector: Float32Array, opts: SearchOptions): Promise<MemorySearchResult[]>;
	hasIncompleteTaskCarrierPopulation(opts: SearchOptions): boolean;
	searchAggregationEvidence(opts: SearchOptions): Promise<MemorySearchResult[]>;
	searchKeyword(query: string, opts: SearchOptions): Promise<MemorySearchResult[]>;
	getVectorsByIds(ids: string[]): Map<string, Float32Array>;
	getRepresentativeVectorsForMemories(memoryIds: string[]): Map<string, Float32Array>;
	attachSnippets(results: MemorySearchResult[], facetPolicy?: SearchOptions["facetPolicy"]): void;
	getChunksByParent(
		memoryIds: string[],
		facetPolicy?: SearchOptions["facetPolicy"],
	): Map<string, Array<{ chunkIndex: number; chunkText: string; facet: "current" | "history" }>>;
	delete(idOrPrefix: string, options?: MemoryDeleteOptions): Promise<number>;
	deleteMany(ids: string[], options?: MemoryDeleteOptions): Promise<number>;
	deleteByIds(ids: string[], options?: MemoryDeleteOptions): void;
	list(opts: ListOptions): Promise<MemoryEntry[]>;
	stats(projectId?: string): Promise<StatsResult>;
	update(id: string, changes: UpdateChanges): Promise<MemoryEntry | null>;
	updateTier(
		memoryId: string,
		newTier: MemoryTier,
		options?: { writerAuthority?: "offline-family" },
	): Promise<void>;
	applyRemTextVersion(input: WriteTextVersionInput): Promise<RemMutationResult>;
	updateMetadata(memoryId: string, patch: Partial<MemoryMetadata>): Promise<void>;
	/**
	 * Atomically marks a `memory-reflection-item` row resolved (sets the
	 * reflection-item `resolvedAt` / `resolvedBy` / `resolutionNote` fields only,
	 * metadata-only, no content_hash recompute). The read-guard-write runs under
	 * the write mutex, so a concurrent caller observes `already_resolved` rather
	 * than clobbering the first resolution.
	 */
	resolveReflectionItem(
		memoryId: string,
		opts: {
			resolvedAt: number;
			resolvedBy?: string;
			note?: string;
			writerAuthority?: "offline-family";
		},
	): Promise<ReflectionResolveOutcome>;
	/** Lists `memory-reflection-item` rows (newest first), optionally projectId-filtered and unresolved-only. */
	listReflectionItems(opts: {
		projectIdFilter?: string[];
		limit?: number;
		unresolvedOnly?: boolean;
	}): Promise<MemoryEntry[]>;
	applyMetadataDelta(
		memoryId: string,
		deltaFn: (current: MemoryMetadata) => Partial<MemoryMetadata>,
	): Promise<void>;
	applyMetadataDeltas(
		entries: Array<{
			memoryId: string;
			deltaFn: (current: MemoryMetadata) => Partial<MemoryMetadata> | undefined;
		}>,
	): Promise<void>;
	getMemoryMetadata(memoryId: string): Promise<MemoryMetadata | undefined>;
	bulkDelete(
		filter: { projectId?: string; category?: MemoryCategory },
		options?: MemoryDeleteOptions,
	): Promise<BulkDeleteResult>;
	close(): Promise<void>;
	closeSync(): void;
	closeSqlite(): void;
}
