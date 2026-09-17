/** @file query-manifest-capture.ts
 * @purpose Captures reviewed query inputs through production read paths for phase-zero calibration.
 * @boundary Read-only MemoryStore, retrieval, rendering, token counting, and task projection reads.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { countTokens } from "@snoai/chunking";
import {
	AUTO_RECALL_INJECTION_TOP_K,
	DEFAULT_TOP_K,
	MAX_CANDIDATE_POOL_SIZE,
	PRECISION_RECALL_POOL_SIZE_FACTOR,
} from "../../../config/index";
import { formatRelevantMemoriesContext } from "../extraction/capture-policy-detector";
import {
	ACTIVE_TASK_PROJECTION_MAX_ITEMS,
	buildActiveTaskProjection,
} from "../extraction/active-task-projection";
import type { Embedder } from "../extraction/embedding-provider-client";
import { createRetriever, type RetrievalConfig } from "./retriever";
import type { RetrievalStageMetadata } from "./retrieval-trace";
import type { MemoryEntry, RetrievalResult } from "../shared/types";
import type { MemoryStore } from "../../store/store";

export type QueryIntent = "lookup" | "list-all" | "recommend" | "synthesis" | "other";
export type QueryTaskMode = "current" | "history" | "non-task";

export interface ReviewedAddressExpectation {
	sectionName: string;
	expectedLiveMatchCount: number;
}

export interface ReviewedQueryInput {
	queryId: string;
	text: string;
	projectId: string;
	intent: QueryIntent;
	taskMode: QueryTaskMode;
	expectedAddresses: ReviewedAddressExpectation[];
	requiredSupportingCarrierIds: string[];
	expectedActiveTaskIds: string[];
	expectedTerminalTaskIds: string[];
}

export type CapturedValue<T> =
	| { status: "available"; value: T }
	| { status: "missing"; reason: string };

export type ApplicableCapture<T> =
	| { status: "available"; value: T }
	| { status: "not-applicable"; reason: string };

export interface MissingAddressCapture {
	reviewedSectionName: string;
	expectedLiveMatchCount: number;
	canonicalSectionName: CapturedValue<string>;
	derivedFactKey: CapturedValue<string>;
	actualLiveMatchCount: CapturedValue<number>;
	selectedRowId: CapturedValue<string>;
	selectedKind: CapturedValue<string>;
	selectedSectionName: CapturedValue<string>;
	selectedFactKey: CapturedValue<string>;
	selectedLane: CapturedValue<string>;
	selectedInvalidatedAt: CapturedValue<number | null>;
	productionResolverMethod: CapturedValue<string>;
	productionStoreMethod: CapturedValue<string>;
}

export interface QueryAddressResolutionCapture {
	status: "missing";
	reason: string;
	reviewedAddresses: MissingAddressCapture[];
}

export interface CandidateScoreCapture {
	status: "available" | "missing";
	value?: number;
	reason?: string;
}

export interface QueryCandidateCapture {
	memoryId: string;
	taskIdentifiers: {
		activeTaskId: CapturedValue<string>;
		activeTaskRevisionId: CapturedValue<string>;
	};
	kind: CapturedValue<string>;
	sectionName: CapturedValue<string>;
	factKey: CapturedValue<string>;
	lane: string;
	invalidatedAt: CapturedValue<number | null>;
	lifecycle: {
		activeTaskKind: CapturedValue<string>;
		activeTaskStatus: CapturedValue<string>;
		activeTaskCreatedAt: CapturedValue<number>;
		activeTaskTransitionedAt: CapturedValue<number>;
		activeTaskLifecycle: CapturedValue<unknown>;
	};
	rawScores: {
		dense: CandidateScoreCapture;
		bm25: CandidateScoreCapture;
		fused: CandidateScoreCapture;
		rerank: CandidateScoreCapture;
		mmr: CandidateScoreCapture;
	};
	finalPreAdmissionScore: number;
	renderedText: CapturedValue<string>;
	renderedTokenCount: CapturedValue<number>;
	provenance: {
		retrievalMethod: "MemoryRetriever.retrieveWithTrace";
		renderingMethod: "formatRelevantMemoriesContext";
		tokenCountMethod: "@snoai/chunking.countTokens";
	};
}

export interface DirectFallbackTaskRow {
	activeTaskId: string;
	currentRevisionId: string;
	description: string;
	status: "active";
	createdAt: number;
	occurrenceAnchors: ReturnType<
		MemoryStore["readTaskLifecycleInstances"]
	>[number]["occurrenceAnchors"];
	revisionDetails: ReturnType<
		MemoryStore["readTaskLifecycleInstances"]
	>[number]["revisionDetails"];
}

export interface CurrentListCapture {
	productionQueryFallbackPath: CapturedValue<string>;
	captureEnumerationPath: "MemoryStore.readTaskLifecycleInstances";
	fallbackValidity: {
		validity: "valid" | "invalid";
		reasons: string[];
	};
	directFallbackRowsBeforeOrdering: DirectFallbackTaskRow[];
	directFallbackRowsAfterOrdering: DirectFallbackTaskRow[];
	directTaskRead: {
		method: "MemoryStore.readTaskLifecycleInstances";
		rows: ReturnType<MemoryStore["readTaskLifecycleInstances"]>;
	};
	projection: {
		method: "buildActiveTaskProjection";
		maxItems: number;
		validity: "valid" | "invalid";
		reasons: string[];
		expectedText: string;
		expectedTaskIds: string[];
		actualProjectionMemoryIds: string[];
	};
}

export interface QueryManifestCapture {
	schemaVersion: "query-manifest-capture.phase-zero.v1";
	referenceTimeMs: number;
	inputStore: {
		sha256: string;
		hashMethod: "sha256(database-bytes+wal-bytes-with-stable-labels)";
	};
	productionLimits: {
		defaultTopK: number;
		autoRecallTopK: number;
		configuredAutoRecallTopK: number;
		configuredCandidatePoolSize: number;
		maxCandidatePoolSize: number;
	};
	productionBoundary: {
		source: "auto-recall";
		method: "onBeforeAgentStart -> MemoryRetriever.retrieve";
		captureMethod: "MemoryRetriever.retrieveWithTrace";
		retrievalConfig: Omit<RetrievalConfig, "rerankApiKey">;
		retrievalConfigSha256: string;
	};
	queries: QueryCapture[];
}

export interface QueryCapture {
	queryId: string;
	text: string;
	intent: QueryIntent;
	taskMode: QueryTaskMode;
	projectId: string;
	inputStoreHash: string;
	reviewedExpectations: {
		expectedAddresses: ReviewedAddressExpectation[];
		requiredSupportingCarrierIds: string[];
		expectedActiveTaskIds: string[];
		expectedTerminalTaskIds: string[];
	};
	addressResolution: QueryAddressResolutionCapture;
	retrieval: {
		method: "MemoryRetriever.retrieveWithTrace";
		storeMethods: Array<"MemoryStore.searchSemantic" | "MemoryStore.searchKeyword">;
		mode: "precision-recall" | "vector" | "aggregation";
		topK: number;
		candidatePoolLimit: number;
		stages: Array<{
			name: string;
			inputCount: number;
			outputCount: number;
			droppedIds: string[];
			scoreRange: [number, number] | null;
			metadata?: RetrievalStageMetadata;
		}>;
	};
	candidates: QueryCandidateCapture[];
	supportingCarrierPresence: Array<{ memoryId: string; presentInCandidateSet: boolean }>;
	currentListCapture: ApplicableCapture<CurrentListCapture>;
}

export interface CaptureQueryManifestInput {
	store: MemoryStore;
	embedder: Embedder;
	referenceTimeMs: number;
	retrievalConfig: RetrievalConfig;
	productionTopK: number;
	queries: ReviewedQueryInput[];
}

export interface SerializedQueryManifestCapture {
	bytes: string;
	sha256: string;
}

const ADDRESS_RESOLVER_MISSING_REASON =
	"No production Query address resolver exists; reviewed address expectations are not resolved by fixture-only or write-side mappings.";
const VALUE_MISSING_REASON = "Source field is absent on the production row or retrieval result.";
const QUERY_FALLBACK_MISSING_REASON =
	"No production Query current-list direct fallback path exists; rows below are an explicit read-only capture through production store and Extraction projection methods.";

const REFERENCE_TIME_METHODS = [
	"filterExpired",
	"filterExpiredCandidates",
	"applyRecencyBoost",
	"applyTimeDecay",
	"applyRetentionBoost",
] as const;

function available<T>(value: T): CapturedValue<T> {
	return { status: "available", value };
}

function missing<T>(reason: string = VALUE_MISSING_REASON): CapturedValue<T> {
	return { status: "missing", reason };
}

function captureString(value: unknown): CapturedValue<string> {
	return typeof value === "string" && value.length > 0 ? available(value) : missing();
}

function captureNumber(value: unknown): CapturedValue<number> {
	return typeof value === "number" && Number.isFinite(value) ? available(value) : missing();
}

function captureNullableTimestamp(value: unknown): CapturedValue<number | null> {
	if (value === null) return available(null);
	return typeof value === "number" && Number.isFinite(value) ? available(value) : missing();
}

function parseMetadata(entry: MemoryEntry): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(entry.metadata);
		return parsed !== null && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function captureScore(value: number | undefined): CandidateScoreCapture {
	return value === undefined
		? { status: "missing", reason: "The production retrieval branch did not emit this score." }
		: { status: "available", value };
}

function sanitizedRetrievalConfig(
	config: RetrievalConfig,
): Omit<RetrievalConfig, "rerankApiKey"> {
	const { rerankApiKey: _rerankApiKey, ...sanitized } = config;
	return sanitized;
}

function canonicalizeForHash(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalizeForHash);
	if (value === null || typeof value !== "object") return value;
	const canonical: Record<string, unknown> = {};
	const entries: Array<[string, unknown]> = Object.entries(value);
	for (const [key, child] of entries.toSorted(([left], [right]) => left.localeCompare(right))) {
		if (child !== undefined) canonical[key] = canonicalizeForHash(child);
	}
	return canonical;
}

function hashJson(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalizeForHash(value)))
		.digest("hex");
}

function renderedRecordBlocks(rendered: string): string[] {
	const blocks: string[] = [];
	let current: string[] | undefined;
	for (const line of rendered.split("\n")) {
		if (/^memory \d+: /u.test(line)) {
			if (current) blocks.push(current.join("\n"));
			current = [line];
		} else if (current && line !== "</relevant-memories>") {
			current.push(line);
		}
	}
	if (current) blocks.push(current.join("\n"));
	return blocks;
}

function renderedCandidateAt(
	results: readonly RetrievalResult[],
	index: number,
): CapturedValue<string> {
	const prefix = results.slice(0, index + 1).map((result) => ({
		category: result.entry.category,
		text: result.snippet?.trim() ? result.snippet : result.entry.text,
		lane: result.entry.lane,
	}));
	const rendered = formatRelevantMemoriesContext(prefix);
	const priorPrefix = prefix.slice(0, -1);
	const priorRendered = formatRelevantMemoriesContext(priorPrefix);
	const records = renderedRecordBlocks(rendered);
	const priorCount = renderedRecordBlocks(priorRendered).length;
	return records.length > priorCount
		? available(records[records.length - 1] ?? "")
		: missing("The production renderer filtered this candidate.");
}

function captureCandidate(
	result: RetrievalResult,
	index: number,
	results: readonly RetrievalResult[],
): QueryCandidateCapture {
	const metadata = parseMetadata(result.entry);
	const renderedText = renderedCandidateAt(results, index);
	return {
		memoryId: result.entry.id,
		taskIdentifiers: {
			activeTaskId: captureString(metadata.active_task_id),
			activeTaskRevisionId: captureString(metadata.active_task_revision_id),
		},
		kind: captureString(metadata.kind),
		sectionName: captureString(metadata.section_name),
		factKey: captureString(metadata.fact_key),
		lane: result.entry.lane,
		invalidatedAt: captureNullableTimestamp(metadata.invalidated_at ?? null),
		lifecycle: {
			activeTaskKind: captureString(metadata.active_task_kind),
			activeTaskStatus: captureString(metadata.active_task_status),
			activeTaskCreatedAt: captureNumber(metadata.active_task_created_at),
			activeTaskTransitionedAt: captureNumber(metadata.active_task_transitioned_at),
			activeTaskLifecycle:
				metadata.active_task_lifecycle === undefined
					? missing()
					: available(metadata.active_task_lifecycle),
		},
		rawScores: {
			dense: captureScore(result.denseScore),
			bm25: captureScore(result.bm25Score),
			fused: captureScore(result.fusedScore),
			rerank: captureScore(result.rerankScore),
			mmr: captureScore(result.mmrScore),
		},
		finalPreAdmissionScore: result.score,
		renderedText,
		renderedTokenCount:
			renderedText.status === "available"
				? available(countTokens(renderedText.value))
				: missing(renderedText.reason),
		provenance: {
			retrievalMethod: "MemoryRetriever.retrieveWithTrace",
			renderingMethod: "formatRelevantMemoriesContext",
			tokenCountMethod: "@snoai/chunking.countTokens",
		},
	};
}

function addressResolutionFor(query: ReviewedQueryInput): QueryAddressResolutionCapture {
	return {
		status: "missing",
		reason: ADDRESS_RESOLVER_MISSING_REASON,
		reviewedAddresses: query.expectedAddresses.map((address) => ({
			reviewedSectionName: address.sectionName,
			expectedLiveMatchCount: address.expectedLiveMatchCount,
			canonicalSectionName: missing(ADDRESS_RESOLVER_MISSING_REASON),
			derivedFactKey: missing(ADDRESS_RESOLVER_MISSING_REASON),
			actualLiveMatchCount: missing(ADDRESS_RESOLVER_MISSING_REASON),
			selectedRowId: missing(ADDRESS_RESOLVER_MISSING_REASON),
			selectedKind: missing(ADDRESS_RESOLVER_MISSING_REASON),
			selectedSectionName: missing(ADDRESS_RESOLVER_MISSING_REASON),
			selectedFactKey: missing(ADDRESS_RESOLVER_MISSING_REASON),
			selectedLane: missing(ADDRESS_RESOLVER_MISSING_REASON),
			selectedInvalidatedAt: missing(ADDRESS_RESOLVER_MISSING_REASON),
			productionResolverMethod: missing(ADDRESS_RESOLVER_MISSING_REASON),
			productionStoreMethod: missing(ADDRESS_RESOLVER_MISSING_REASON),
		})),
	};
}

async function listAllActiveProfiles(store: MemoryStore, projectId: string): Promise<MemoryEntry[]> {
	const rows: MemoryEntry[] = [];
	const pageSize = 100;
	for (let offset = 0; ; offset += pageSize) {
		const page = await store.list({
			projectId,
			category: "profile",
			lane: "active",
			limit: pageSize,
			offset,
		});
		rows.push(...page);
		if (page.length < pageSize) return rows;
	}
}

function validateProjection(
	entries: readonly MemoryEntry[],
	orderedRows: readonly DirectFallbackTaskRow[],
	fallbackReasons: readonly string[],
): CurrentListCapture["projection"] {
	const projection = buildActiveTaskProjection(
		orderedRows.map((row) => ({
			id: row.activeTaskId,
			description: row.description,
			status: "active",
			createdAt: row.createdAt,
		})),
	);
	const projectionRows = entries.filter((entry) => {
		const metadata = parseMetadata(entry);
		return (
			metadata.section_name === "active_tasks" &&
			metadata.active_task_kind === "projection" &&
			(metadata.invalidated_at === undefined || metadata.invalidated_at === null)
		);
	});
	const reasons = [...fallbackReasons];
	if (projectionRows.length !== 1) {
		reasons.push(`Expected one active projection row, found ${projectionRows.length}.`);
	}
	const storedProjection = projectionRows[0];
	if (storedProjection) {
		const metadata = parseMetadata(storedProjection);
		if (storedProjection.text !== projection.text) reasons.push("Projection text differs.");
		if (JSON.stringify(metadata.active_task_ids) !== JSON.stringify(projection.taskIds)) {
			reasons.push("Projection task identifiers differ.");
		}
		if (JSON.stringify(metadata.active_task_titles) !== JSON.stringify(projection.titles)) {
			reasons.push("Projection titles differ.");
		}
	}
	return {
		method: "buildActiveTaskProjection",
		maxItems: ACTIVE_TASK_PROJECTION_MAX_ITEMS,
		validity: reasons.length === 0 ? "valid" : "invalid",
		reasons,
		expectedText: projection.text,
		expectedTaskIds: projection.taskIds,
		actualProjectionMemoryIds: projectionRows.map((entry) => entry.id),
	};
}

async function captureCurrentList(
	store: MemoryStore,
	query: ReviewedQueryInput,
): Promise<ApplicableCapture<CurrentListCapture>> {
	if (query.intent !== "list-all" || query.taskMode !== "current") {
		return {
			status: "not-applicable",
			reason: "The reviewed input is not a current-list query.",
		};
	}
	const profiles = await listAllActiveProfiles(store, query.projectId);
	const directTaskRows = store.readTaskLifecycleInstances(query.projectId);
	const beforeOrdering = directTaskRows
		.filter((instance) => instance.terminalAtMs === undefined)
		.map((instance) => ({
			activeTaskId: instance.activeTaskId,
			currentRevisionId: instance.currentRevisionId,
			description: instance.currentDescription,
			status: "active" as const,
			createdAt: instance.createdAtMs,
			occurrenceAnchors: instance.occurrenceAnchors,
			revisionDetails: instance.revisionDetails,
		}));
	const projectionOrder = buildActiveTaskProjection(
		beforeOrdering.map((row) => ({
			id: row.activeTaskId,
			description: row.description,
			status: "active",
			createdAt: row.createdAt,
		})),
	).taskIds;
	const byTaskId = new Map(beforeOrdering.map((row) => [row.activeTaskId, row]));
	const afterOrdering = projectionOrder.flatMap((taskId) => {
		const row = byTaskId.get(taskId);
		return row ? [row] : [];
	});
	return {
		status: "available",
		value: {
			productionQueryFallbackPath: missing(QUERY_FALLBACK_MISSING_REASON),
			captureEnumerationPath: "MemoryStore.readTaskLifecycleInstances",
			fallbackValidity: {
				validity: "valid",
				reasons: [],
			},
			directFallbackRowsBeforeOrdering: beforeOrdering,
			directFallbackRowsAfterOrdering: afterOrdering,
			directTaskRead: {
				method: "MemoryStore.readTaskLifecycleInstances",
				rows: directTaskRows,
			},
			projection: validateProjection(profiles, afterOrdering, []),
		},
	};
}

function methodsForMode(
	mode: "precision-recall" | "vector" | "aggregation",
): Array<"MemoryStore.searchSemantic" | "MemoryStore.searchKeyword"> {
	if (mode === "vector") return ["MemoryStore.searchSemantic"];
	// The aggregation path reads rows through `searchAggregationEvidence`, which is neither of
	// these two; it is listed under neither rather than mislabelled as one of them.
	if (mode === "aggregation") return [];
	return ["MemoryStore.searchSemantic", "MemoryStore.searchKeyword"];
}

function runWithSynchronousReferenceTime(
	referenceTimeMs: number,
	operation: () => unknown,
): unknown {
	const originalDateNow = Date.now;
	Date.now = () => referenceTimeMs;
	try {
		return operation();
	} finally {
		Date.now = originalDateNow;
	}
}

function pinSynchronousRetrieverClock(retriever: object, referenceTimeMs: number): void {
	for (const methodName of REFERENCE_TIME_METHODS) {
		const originalMethod: unknown = Reflect.get(retriever, methodName);
		if (typeof originalMethod !== "function") {
			throw new Error(`Production retriever method missing: ${methodName}`);
		}
		Reflect.set(retriever, methodName, function (this: unknown, ...args: unknown[]): unknown {
			return runWithSynchronousReferenceTime(referenceTimeMs, () =>
				Reflect.apply(originalMethod, this, args),
			);
		});
	}
}

function assertReviewedInputs(queries: readonly ReviewedQueryInput[], referenceTimeMs: number): void {
	if (!Number.isFinite(referenceTimeMs)) throw new Error("referenceTimeMs must be finite");
	const queryIds = new Set<string>();
	for (const query of queries) {
		if (!query.queryId || !query.text || !query.projectId) {
			throw new Error("Each reviewed query requires queryId, exact text, and projectId");
		}
		if (queryIds.has(query.queryId)) throw new Error(`Duplicate queryId: ${query.queryId}`);
		queryIds.add(query.queryId);
	}
}

function hashStoreFile(hash: ReturnType<typeof createHash>, label: string, path: string): void {
	hash.update(`${label}\0`);
	if (!existsSync(path)) {
		hash.update("missing\0");
		return;
	}
	const bytes = readFileSync(path);
	hash.update(`${bytes.byteLength}\0`);
	hash.update(bytes);
}

export function hashQueryManifestStore(store: MemoryStore): string {
	return hashQueryManifestStorePath(store.dbPath);
}

export function hashQueryManifestStorePath(dbPath: string): string {
	const hash = createHash("sha256");
	hashStoreFile(hash, "database", dbPath);
	hashStoreFile(hash, "wal", `${dbPath}-wal`);
	return hash.digest("hex");
}

export async function captureQueryManifest(
	input: CaptureQueryManifestInput,
): Promise<QueryManifestCapture> {
	assertReviewedInputs(input.queries, input.referenceTimeMs);
	const inputStoreHash = hashQueryManifestStore(input.store);
	const retriever = createRetriever(input.store, input.embedder, undefined, input.retrievalConfig);
	pinSynchronousRetrieverClock(retriever, input.referenceTimeMs);
	if (!Number.isInteger(input.productionTopK) || input.productionTopK < 1) {
		throw new Error("productionTopK must be a positive integer");
	}
	const queries: QueryCapture[] = [];
	for (const query of input.queries) {
		const topK = input.productionTopK;
		const candidatePoolLimit = Math.min(
			Math.max(input.retrievalConfig.candidatePoolSize, topK * PRECISION_RECALL_POOL_SIZE_FACTOR),
			MAX_CANDIDATE_POOL_SIZE,
		);
		const { results, trace } = await retriever.retrieveWithTrace({
			query: query.text,
			limit: topK,
			scopeFilter: [query.projectId],
			source: "auto-recall",
			excludeInvalidatedBefore: input.referenceTimeMs,
		});
		const candidates = results.map((result, index) => captureCandidate(result, index, results));
		queries.push({
			queryId: query.queryId,
			text: query.text,
			intent: query.intent,
			taskMode: query.taskMode,
			projectId: query.projectId,
			inputStoreHash,
			reviewedExpectations: {
				expectedAddresses: query.expectedAddresses,
				requiredSupportingCarrierIds: query.requiredSupportingCarrierIds,
				expectedActiveTaskIds: query.expectedActiveTaskIds,
				expectedTerminalTaskIds: query.expectedTerminalTaskIds,
			},
			addressResolution: addressResolutionFor(query),
			retrieval: {
				method: "MemoryRetriever.retrieveWithTrace",
				storeMethods: methodsForMode(trace.mode),
				mode: trace.mode,
				topK,
				candidatePoolLimit,
				stages: trace.stages.map((stage) => ({
					name: stage.name,
					inputCount: stage.inputCount,
					outputCount: stage.outputCount,
					droppedIds: stage.droppedIds,
					scoreRange: stage.scoreRange,
					...(stage.metadata && { metadata: stage.metadata }),
				})),
			},
			candidates,
			supportingCarrierPresence: query.requiredSupportingCarrierIds.map((memoryId) => ({
				memoryId,
				presentInCandidateSet: candidates.some((candidate) => candidate.memoryId === memoryId),
			})),
			currentListCapture: await captureCurrentList(input.store, query),
		});
	}
	const outputStoreHash = hashQueryManifestStore(input.store);
	if (outputStoreHash !== inputStoreHash) {
		throw new Error(
			`Read-only query capture changed store bytes: before=${inputStoreHash} after=${outputStoreHash}`,
		);
	}
	return {
		schemaVersion: "query-manifest-capture.phase-zero.v1",
		referenceTimeMs: input.referenceTimeMs,
		inputStore: {
			sha256: inputStoreHash,
			hashMethod: "sha256(database-bytes+wal-bytes-with-stable-labels)",
		},
		productionLimits: {
			defaultTopK: DEFAULT_TOP_K,
			autoRecallTopK: AUTO_RECALL_INJECTION_TOP_K,
			configuredAutoRecallTopK: input.productionTopK,
			configuredCandidatePoolSize: input.retrievalConfig.candidatePoolSize,
			maxCandidatePoolSize: MAX_CANDIDATE_POOL_SIZE,
		},
		productionBoundary: {
			source: "auto-recall",
			method: "onBeforeAgentStart -> MemoryRetriever.retrieve",
			captureMethod: "MemoryRetriever.retrieveWithTrace",
			retrievalConfig: sanitizedRetrievalConfig(input.retrievalConfig),
			retrievalConfigSha256: hashJson(
				sanitizedRetrievalConfig(input.retrievalConfig),
			),
		},
		queries,
	};
}

export function serializeQueryManifestCapture(
	capture: QueryManifestCapture,
): SerializedQueryManifestCapture {
	const bytes = `${JSON.stringify(capture, null, 2)}\n`;
	return {
		bytes,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}
