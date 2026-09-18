import { readRemOperationalConfig } from "./config";
import { FIXED_MEMORY_SNO_EXTRACT_CHAT, FIXED_PROTOCOL_VALUE_74 } from "../model/signed-registry-constants";
/** @file rem-batch-executor.ts
 * @purpose Runs the production REM scan, judgments, and recoverable mutations for one scope.
 * @boundary One profile's encrypted SQLite database, Sno GPU judgments, and durable REM ledgers.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { createLogger } from "@snoai/utils/logger";
import { currentLogContext, withLogContext } from "@snoai/utils/log-context";
import { countTokens } from "@snoai/chunking";
import { z } from "zod";
import attributeDictionary from "../../config/attribute-dictionary.json" with { type: "json" };
import stateVocabulary from "../../config/state-vocabulary.json" with { type: "json" };
import { REM_MODEL_OUTPUT_TOKEN_CAP } from "./config";
import {
	assembleRemPopulation,
	parseRemEnableConfiguration,
	resolveRemEntryConfiguration,
	runRemEntryPreflight,
	runRemOrderedWave,
	validateRemEntryArtifacts,
} from "./rem-entry-foundations";
import {
	adapterAViewFromRecord,
	arbitrateReplaceVerdicts,
	buildReplaceEligibleClauses,
	classifyRemRow,
	composeRemNegatedCurrent,
	createRemRepository,
	decideRemClauseCarry,
	decideRemRetirementTargetFromReply,
	decideRemUpdateRelationFromReply,
	decideRemUpdateFromReply,
	decideRemUpdateVerification,
	decideReplaceCoverage,
	deriveRemConfigurationSha256,
	enumerateRemUpdateMembers,
	installRemSchema,
	parseAdapterAChatVerdict,
	parseReplaceClauseVerdict,
	parseReplaceCoverageAtoms,
	recordNonRefusePairDecision,
	runRemStages,
	REM_UPDATE_LOCALES,
	getRemUpdateLocaleResource,
	renderAdapterAPrompt,
	renderRemClauseCarryPrompt,
	renderRemRetirementTargetPrompt,
	renderRemUpdateJudgmentPrompt,
	renderRemUpdateRelationJudgmentPrompt,
	renderRemUpdateVerificationPrompt,
	renderReplaceClauseVerdictPrompt,
	renderReplaceCoveragePrompt,
	validateRemSubstantiveWaveEffects,
	type JournalEntry,
	type OrderedAdapterAPair,
	type RemBuiltOperationType,
	type RemOperationalConfiguration,
	type RemOperationType,
	type RemRepository,
	type RemUpdateLocale,
	assertJobIdentity,
} from "../engine/rem/index.js";
import { createEmbedder, type Embedder } from "../engine/extraction/embedding-provider-client";
import {
	readSnoStationMemConfig,
	resolveSnoStationMemConfigPath,
	resolveSqliteDbPath,
} from "../engine/bindings/embedder-config-files";
import { createLlmClient, type LlmClient } from "../model/llm-client";
import { readModelReplyJson } from "../engine/shared/model-reply-text";
import { pickLlmRoutingConfig } from "../model/llm-mode-routing";
import { REM_UPDATE_JUDGMENT_SKILL } from "./rem-update-judgment-skill";
import { pluginConfigSchema } from "../engine/shared/types";
import { loadStorageExtensions } from "../store/connection";
import { getSnoStationMemStateDir } from "../engine/operations/runtime-audit-log";
import { MemoryStore } from "../store/store";
import { scoreCandidatesBySimilarity } from "../store/memory-store-atomic-extraction-write-api";
import {
	initSqliteRuntime,
	openSqliteDatabase,
	type SqliteDatabaseLike,
} from "../store/sqlite-runtime";
import {
	createSnoStationMemRemMutationExecutor,
	createSnoStationMemRemPorts,
	createSnoStationMemRemRecovery,
	type RemMutationWriter,
	type RemWriterOperation,
} from "../store/rem-sqlite-adapter";
import {
	createCoverageGatedConflictPort,
	createRemReplaceCarrierPort,
	issueReplaceCoverageAllow,
} from "../store/rem-sqlite-adapter";
import { deriveRemUpdateStamp } from "../store/rem-update-stamp-migration";
import {
	closeMemoryRow,
	compareMemorySourceOrder,
	readMemorySourceOrder,
} from "../store/memory-source-order";
import { createRetriever, type MemoryRetriever } from "../engine/retrieval/retriever";
import { DEFAULT_RETRIEVAL_CONFIG } from "../engine/retrieval/retrieval-config";

export {
	assembleRemPopulation,
	parseRemEnableConfiguration,
	resolveRemEntryConfiguration,
	runRemEntryPreflight,
	runRemOrderedWave,
	validateRemEntryArtifacts,
};

export const REM_MODEL_STAGES = [
	"rem-replace-clause-carry",
	"rem-update-judgment",
	"rem-update-verification",
	"rem-update-relation-judgment",
	"rem-update-retirement-target",
	"rem-replace-pair",
	"rem-replace-clauses",
	"rem-replace-coverage",
] as const;
export type RemModelStage = (typeof REM_MODEL_STAGES)[number];

export interface RemModelStageResponsePort {
	respond(request: { stage: RemModelStage; prompt: string }): Promise<string>;
}

export function createRemModelStageResponsePort(input: RemModelStageResponsePort): RemModelStageResponsePort {
	return input;
}

const log = createLogger("sno-station-mem:rem-sidecar:batch");
const canonicalStoreWriteQueues = new Map<string, Promise<void>>();
interface CandidateRow {
	id: string;
	text: string;
	category: "profile" | "episodic" | "state";
	project_id: string;
	timestamp: number;
	metadata: string;
	content_hash: string;
	fact_id: string;
	raw_candidate_json: string | null;
	subject: string | null;
	attribute: string | null;
	eventAt: string | number | null;
	validFromColumn: number | null;
}

interface StampedRow {
	id: string;
}

interface Candidate extends CandidateRow {
	canonicalAddress: string;
	factKey?: string;
	locale: RemUpdateLocale;
	validFrom: number;
	owner: "restate" | "verdict" | "none";
	state: "transition" | "stale-current" | "pure-negation" | "ambiguous";
}

interface ClaimedCandidate extends Candidate {
	claimToken: string;
}

export interface RemReplacePairCandidate {
	id: string;
	text: string;
	category: "profile" | "episodic" | "state";
	project_id: string;
	canonicalAddress: string;
	factKey?: string;
}

export interface RemReplaceCandidateLookupPort {
	embed(text: string): Promise<Float32Array>;
	searchSemantic(
		vector: Float32Array,
		options: {
			category: "profile" | "episodic" | "state";
			limit: number;
			minScore: number;
			projectIdFilter: string[];
		},
	): Promise<ReadonlyArray<{ id: string; score: number }>>;
}

export interface RemReplaceCandidatePair<T extends RemReplacePairCandidate = RemReplacePairCandidate> {
	pairId: string;
	sortKey: string;
	left: T;
	right: T;
	/** The neighbour search's own score. Absent for pairs proposed only by a shared address. */
	score?: number;
}

type CandidatePair<T extends Candidate = Candidate> = RemReplaceCandidatePair<T>;

const retirementAttributeConfigSchema = z.object({
	slugs: z.array(
		z.object({
			slug: z.string(),
			family: z.string().optional(),
			cardinality: z.enum(["one", "many"]).optional(),
		}),
	),
});
const personRetirementAttributes = retirementAttributeConfigSchema.parse(attributeDictionary).slugs;
const stateRetirementAttributes = retirementAttributeConfigSchema.parse(stateVocabulary).slugs;
const attributeFamilyBySlug = new Map(
	personRetirementAttributes.map((entry) => [entry.slug, entry.family]),
);
for (const entry of stateRetirementAttributes) {
	attributeFamilyBySlug.set(entry.slug, entry.slug.split(".", 1)[0]);
}
const oneCardinalityAttributes = new Set(
	[...personRetirementAttributes, ...stateRetirementAttributes]
		.filter((entry) => entry.cardinality === "one")
		.map((entry) => entry.slug),
);
const RETIREMENT_SUBJECT_CANDIDATE_CAP = 64;
const RETIREMENT_SIMILARITY_CANDIDATE_CAP = 8;
const RETIREMENT_JUDGMENT_BATCH_SIZE = 16;

interface BatchRuntime {
	database: SqliteDatabaseLike;
	store: MemoryStore;
	embedder: Embedder;
	llm: LlmClient;
	retriever: MemoryRetriever;
	recallTopK: number;
	autoRecallTimeoutMs: number;
	modelStageResponses?: RemModelStageResponsePort;
	close(): Promise<void>;
}

// What the deleted ceilings used to guess at, reported as fact by every wave. These are the numbers
// a real bound would have to be derived from, and until one is derived from them there is no bound.
// `modelTokens` is our own estimate — prompt length plus the fixed output allowance — not the
// provider's accounting, because it is computed before the call is made.
export interface RemWaveMeasurements {
	rowsConsidered: number;
	pairsBuilt: number;
	pairCapBinding: boolean;
	modelCalls: number;
	modelTokens: number;
	wallMs: number;
}

export interface RemBatchJobResult extends JournalEntry {
	candidateCount: number;
	stampedSkippedCount: number;
	actionableCandidateCount: number;
	terminalState: "done";
	appliedFraction: number | null;
	parseFailureCount: number;
	topRefusalReasons: string[];
	measurements: RemWaveMeasurements;
	updateRows?: RemAppliedUnitStatistics;
	relationPairs?: RemAppliedUnitStatistics;
}

export interface RemAppliedUnitStatistics {
	considered: number;
	applied: number;
	appliedFraction: number | null;
}

type RemStageResult = JournalEntry & {
	measurements: RemWaveMeasurements;
	updateRows?: RemAppliedUnitStatistics;
	relationPairs?: RemAppliedUnitStatistics;
};

type RemPerOperationResult = { operation: RemBuiltOperationType } & Pick<
	RemBatchJobResult,
	| "actionsApplied"
	| "actionableCandidateCount"
	| "candidateCount"
	| "parseFailureCount"
	| "topRefusalReasons"
	| "measurements"
>;

interface RemStageErrorLog {
	name: string;
	message: string;
	stack: string | null;
	cause: RemStageErrorLog | null;
}

export async function runRemBatchJob(input: {
	jobId: string;
	jobType: RemBuiltOperationType;
	scope: string;
	implementationVersion?: string;
	modelStageResponses?: RemModelStageResponsePort;
	configuration?: RemOperationalConfiguration;
}): Promise<RemBatchJobResult> {
	assertJobIdentity(input.jobId, input.jobType);
	if (input.scope.trim().length === 0) throw new Error("REM scope is required");
	const dbPath = resolveBatchDatabasePath();
	return runWithCanonicalStoreWriteMutex(dbPath, () => runRemBatchJobUnlocked(input));
}

export async function runRemProductionOrderedWave(input: {
	stateRoot: string;
	personaDbPath?: string;
	configSource: string;
	scope: string;
	waveId?: string;
	requestedOperations?: readonly RemBuiltOperationType[];
	implementationVersion?: string;
}): Promise<
	| { decision: "refuse"; reasonCode: string }
	| ({ decision: "allow"; reasonCode: null; waveId: string } & Pick<
		RemBatchJobResult,
		| "actionsApplied"
		| "actionableCandidateCount"
		| "appliedFraction"
		| "candidateCount"
		| "stampedSkippedCount"
		| "parseFailureCount"
		| "topRefusalReasons"
		| "measurements"
	> & { perOperation: RemPerOperationResult[] })
> {
	const resolved = { configuration: readRemOperationalConfig(input.configSource) };
	await initSqliteRuntime();
	const configuredPath = resolveBatchDatabasePath();
	const waveId = input.waveId ?? `rem-wave-${randomUUID()}`;
	const requestedOperations = input.requestedOperations ?? (["rem-replace", "rem-update"] as const);
	const results: Array<{ operation: RemBuiltOperationType } & RemBatchJobResult> = [];
	let stageFailed = false;
	const journalDatabase = openSqliteDatabase(configuredPath, { fileMustExist: true });
	try {
		const repository = createRemRepository(journalDatabase.db);
		for (const jobType of requestedOperations) {
			const stageResults = await runRemStages({
				repository,
				jobId: waveId,
				jobType,
				config: { stages: resolved.configuration.operations },
				onStageError: ({ stage, error }) => {
					log.warn("ordered_wave_stage_failed", {
						error: describeRemStageError(error),
						job_id: waveId,
						job_type: jobType,
						stage,
					}, {
						event_name: "sno_station_mem.rem-batch-executor.ordered.wave.stage.failed",
						file: "packages/sno-station-mem/src/sidecar/rem-batch-executor.ts",
						function: "onStageError",
						site_id: "rem-batch-executor.onStageError.d5f24d50d3",
					});
				},
				stages: [
					{
						name: jobType,
						run: async () => {
							const result = await runRemBatchJob({
								jobId: waveId,
								jobType,
								scope: input.scope,
								configuration: resolved.configuration,
								...(input.implementationVersion === undefined
									? {}
									: { implementationVersion: input.implementationVersion }),
							});
							results.push({ operation: jobType, ...result });
							return result;
						},
					},
				],
			});
			if (stageResults[jobType] === "failed") stageFailed = true;
		}
	} finally {
		journalDatabase.db.close();
	}
	if (stageFailed) return { decision: "refuse", reasonCode: "ordered_wave_stage_failed" };
	const database = openSqliteDatabase(configuredPath, { fileMustExist: true });
	try {
		const substantive = validateRemSubstantiveWaveEffects({ database: database.db, waveId });
		if (substantive.decision === "refuse") return substantive;
	} finally {
		database.db.close();
	}
	const actionableCandidateCount = results.reduce(
		(total, result) => total + result.actionableCandidateCount,
		0,
	);
	const actionsApplied = results.reduce((total, result) => total + result.actionsApplied, 0);
	return {
		decision: "allow" as const,
		reasonCode: null,
		waveId,
		actionsApplied,
		actionableCandidateCount,
		appliedFraction:
			actionableCandidateCount === 0 ? null : actionsApplied / actionableCandidateCount,
		candidateCount: Math.max(0, ...results.map((result) => result.candidateCount)),
		stampedSkippedCount: results.reduce(
			(total, result) => total + result.stampedSkippedCount,
			0,
		),
		parseFailureCount: results.reduce((total, result) => total + result.parseFailureCount, 0),
		topRefusalReasons: [...new Set(results.flatMap((result) => result.topRefusalReasons))].slice(0, 2),
		measurements: {
			rowsConsidered: Math.max(0, ...results.map((result) => result.measurements.rowsConsidered)),
			pairsBuilt: results.reduce((total, result) => total + result.measurements.pairsBuilt, 0),
			pairCapBinding: results.some((result) => result.measurements.pairCapBinding),
			modelCalls: results.reduce((total, result) => total + result.measurements.modelCalls, 0),
			modelTokens: results.reduce((total, result) => total + result.measurements.modelTokens, 0),
			wallMs: results.reduce((total, result) => total + result.measurements.wallMs, 0),
		},
		perOperation: results.map(({ operation, ...result }) => ({
			operation,
			actionsApplied: result.actionsApplied,
			actionableCandidateCount: result.actionableCandidateCount,
			candidateCount: result.candidateCount,
			parseFailureCount: result.parseFailureCount,
			topRefusalReasons: result.topRefusalReasons,
			measurements: result.measurements,
		})),
	};
}

function describeRemStageError(
	error: unknown,
	seen: Set<Error> = new Set(),
): RemStageErrorLog {
	if (!(error instanceof Error)) {
		return { name: "NonError", message: String(error), stack: null, cause: null };
	}
	if (seen.has(error)) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack ?? null,
			cause: { name: "CircularCause", message: error.message, stack: null, cause: null },
		};
	}
	seen.add(error);
	return {
		name: error.name,
		message: error.message,
		stack: error.stack ?? null,
		cause: error.cause === undefined ? null : describeRemStageError(error.cause, seen),
	};
}

async function runRemBatchJobUnlocked(input: {
	jobId: string;
	jobType: RemBuiltOperationType;
	scope: string;
	implementationVersion?: string;
	modelStageResponses?: RemModelStageResponsePort;
	configuration?: RemOperationalConfiguration;
}): Promise<RemBatchJobResult> {
	return withLogContext({ operation_id: currentLogContext().operation_id ?? input.jobId, job_id: input.jobId, session_reference: input.scope }, async () => {
		const started = performance.now();
		let completed: RemBatchJobResult | undefined;
		let failure: unknown;
		let cleanupCompleted = false;
		try {
			const runtime = await openBatchRuntime(input);
			try {
				installRemSchema(runtime.database);
				const stampedRows = readStampedRowsForJournal(
					runtime.database,
					input.scope,
					input.implementationVersion ?? "rem-update-v1",
				);
				const rows = readCandidates(runtime.database, input.scope);
				const repository = createRemRepository(runtime.database);
				const candidates = classifyCandidates(repository, rows);
				log.info("scan_started", {
					job_id: input.jobId,
					job_type: input.jobType,
					candidates: candidates.length,
				}, {
					event_name: "sno_station_mem.rem-batch-executor.scan.started",
					file: "packages/sno-station-mem/src/sidecar/rem-batch-executor.ts",
					function: "runRemBatchJobUnlocked",
					site_id: "rem-batch-executor.runRemBatchJobUnlocked.55c52b91cf",
				});
				const result: RemStageResult = input.jobType === "rem-update"
					? await runUpdate({
							jobId: input.jobId,
							jobType: "rem-update",
							runtime,
							repository,
							candidates,
							stampedRows,
							configuration: input.configuration,
							implementationVersion: input.implementationVersion,
						})
					: await runReplace({
							jobId: input.jobId,
							jobType: "rem-replace",
							runtime,
							repository,
							candidates,
							configuration: input.configuration,
						});
				const refusals = repository
					.listJournal(input.jobId, input.jobType)
					.filter((entry) => entry.outcome === "refused");
				const reasonCounts = Map.groupBy(refusals.flatMap((entry) => entry.reason ?? []), (reason) => reason);
				const topRefusalReasons = [...reasonCounts.entries()]
					.sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
					.slice(0, 2)
					.map(([reason]) => reason);
				const parseFailureCount = refusals.filter((entry) => /schema|invalid|parse/u.test(entry.reason ?? "")).length;
				const actionableCandidateCount =
					result.updateRows === undefined && result.relationPairs === undefined
						? result.pairsScanned
						: (result.updateRows?.considered ?? 0) + (result.relationPairs?.considered ?? 0);
				const stampedSkippedCount = input.jobType === "rem-update"
					? refusals.filter((entry) => entry.reason === "already_stamped").length
					: 0;
				const appliedFraction =
					actionableCandidateCount === 0 ? null : result.actionsApplied / actionableCandidateCount;
				completed = {
					...result,
					candidateCount: rows.length,
					stampedSkippedCount,
					actionableCandidateCount,
					terminalState: "done",
					appliedFraction,
					parseFailureCount,
					topRefusalReasons,
				};
				return completed;
			} finally {
				await runtime.close();
				cleanupCompleted = true;
			}
		} catch (error) {
			failure = error;
			throw error;
		} finally {
			let outcome = "failed";
			if (completed) {
				outcome = completed.actionsApplied > 0 ? "success" : "empty-success";
				if (!cleanupCompleted) outcome = "partial";
			}
			log[completed && cleanupCompleted ? "info" : "error"]("REM batch completed", {
				outcome,
				job_id: input.jobId,
				job_type: input.jobType,
				cleanup_completed: cleanupCompleted,
				applied_count: completed?.actionsApplied ?? null,
				candidate_count: completed?.candidateCount ?? null,
				actionable_candidate_count: completed?.actionableCandidateCount ?? null,
				parse_failure_count: completed?.parseFailureCount ?? null,
				duration_ms: performance.now() - started,
				...(failure === undefined ? {} : { error: failure }),
			}, {
				event_name: "sidecar.batch.completed",
				file: "packages/sno-station-mem/src/sidecar/rem-batch-executor.ts",
				function: "runRemBatchJobUnlocked",
				site_id: "sidecar.batch.completed",
			});
		}
	});
}

export async function runWithCanonicalStoreWriteMutex<T>(
	canonicalStorePath: string,
	action: () => Promise<T>,
): Promise<T> {
	const identity = realpathSync(canonicalStorePath);
	const predecessor = canonicalStoreWriteQueues.get(identity) ?? Promise.resolve();
	let release: (() => void) | undefined;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = predecessor.catch(() => undefined).then(() => current);
	canonicalStoreWriteQueues.set(identity, queued);
	await predecessor.catch(() => undefined);
	try {
		return await action();
	} finally {
		release?.();
		if (canonicalStoreWriteQueues.get(identity) === queued) canonicalStoreWriteQueues.delete(identity);
	}
}

async function openBatchRuntime(input: {
	jobId: string;
	jobType: RemBuiltOperationType;
	modelStageResponses?: RemModelStageResponsePort;
	configuration?: RemOperationalConfiguration;
}): Promise<BatchRuntime> {
	const configPath = resolveSnoStationMemConfigPath();
	const hostConfig = existsSync(configPath) ? readSnoStationMemConfig(configPath) : undefined;
	const dbPath = resolveSqliteDbPath(hostConfig, (value) =>
		path.isAbsolute(value) ? value : path.resolve(path.dirname(configPath), value),
	);
	const pluginConfigValue =
		hostConfig?.plugins?.entries?.[FIXED_PROTOCOL_VALUE_74]?.config ?? {};
	const pluginConfig = pluginConfigSchema.parse(pluginConfigValue);
	await initSqliteRuntime();
	const embedder = createEmbedder(pluginConfig.embedding, getSnoStationMemStateDir());
	let store: MemoryStore | undefined;
	let database: ReturnType<typeof openSqliteDatabase> | undefined;
	try {
		store = new MemoryStore({
			dbPath,
			vectorDim: embedder.dimensions,
			embedder,
			memoryTelemetry: pluginConfig.memoryTelemetry,
		});
		database = openSqliteDatabase(dbPath, { fileMustExist: true });
		log.info("database_opened", {
			event: "database_opened",
			job_id: input.jobId,
			job_type: input.jobType,
			database_path: realpathSync(dbPath),
		}, {
			event_name: "sno_station_mem.rem-batch-executor.database.opened",
			file: "packages/sno-station-mem/src/sidecar/rem-batch-executor.ts",
			function: "openBatchRuntime",
			site_id: "rem-batch-executor.openBatchRuntime.86fa720e8f",
		});
		loadStorageExtensions(database);
		const llm = createLlmClient({
			preset: FIXED_MEMORY_SNO_EXTRACT_CHAT,
			...(pluginConfig.extraction.llm.apiKey
				? { apiKey: pluginConfig.extraction.llm.apiKey }
				: {}),
			timeoutMs: 60_000,
			routing: pickLlmRoutingConfig({
				mode: "rem-enhanced",
				remEnhanced: {
					occasions: {
						memoryExtract: "snoRemMem",
						conflictAdjudication: "snoRemMem",
					},
				},
			}),
			onProviderResponse: ({ adapterSlot, callLabel, provider, requestId, model, usage }) => {
				log.info("llm_provider_response", {
					event: "llm_provider_response",
					job_id: input.jobId,
					job_type: input.jobType,
					adapter_slot: adapterSlot,
					call_label: callLabel,
					request_id: requestId ?? null,
					provider,
					model: model ?? null,
					usage: usage ? { ...usage, source: "provider-returned" } : null,
				}, {
					event_name: "sno_station_mem.rem-batch-executor.llm.provider.response",
					file: "packages/sno-station-mem/src/sidecar/rem-batch-executor.ts",
					function: "onProviderResponse",
					site_id: "rem-batch-executor.onProviderResponse.df4f2d4fa1",
				});
			},
		});
		const modelStageResponses =
			input.modelStageResponses ??
			createRemModelStageResponsePort({
				respond: ({ stage, prompt }) =>
					llm.completeText({
						prompt,
						callLabel: remModelCallLabel(stage),
						adapterSlot:
							stage === "rem-replace-pair" ? "conflict-adjudication" : "memory-extract",
					}).then((response) => response ?? ""),
			});
		return {
			database: database.db,
			store,
			embedder,
			llm,
			retriever: createRetriever(store, embedder, undefined, {
				...DEFAULT_RETRIEVAL_CONFIG,
				...pluginConfig.retrieval,
			}),
			recallTopK: pluginConfig.retrieval.recallTopK,
			autoRecallTimeoutMs: pluginConfig.autoRecallTimeoutMs,
			modelStageResponses,
			async close(): Promise<void> {
				database?.db.close();
				await store?.close();
				await embedder.dispose();
			},
		};
	} catch (error) {
		database?.db.close();
		await store?.close();
		await embedder.dispose();
		throw error;
	}
}

function resolveBatchDatabasePath(): string {
	const configPath = resolveSnoStationMemConfigPath();
	const hostConfig = existsSync(configPath) ? readSnoStationMemConfig(configPath) : undefined;
	return resolveSqliteDbPath(hostConfig, (value) =>
		path.isAbsolute(value) ? value : path.resolve(path.dirname(configPath), value),
	);
}

const REM_CANDIDATE_PREDICATE_SQL = `lane = 'active'
	AND length(trim(text)) > 0
	AND category IN ('profile', 'episodic', 'state')
	AND json_valid(metadata)
	AND json_extract(metadata, '$.superseded_by') IS NULL`;

export function enumerateRemCandidateScopes(
	database: SqliteDatabaseLike,
): Array<{ scope: string; candidateCount: number }> {
	const rows = database
		.prepare(
			`SELECT project_id AS scope, count(*) AS candidate_count
			FROM nodix_memories
			WHERE ${REM_CANDIDATE_PREDICATE_SQL}
			GROUP BY project_id
			ORDER BY project_id`,
		)
		.all() as Array<{ scope: string; candidate_count: number }>;
	return rows.map((row) => ({ scope: row.scope, candidateCount: row.candidate_count }));
}

export function readCandidates(database: SqliteDatabaseLike, scope: string): CandidateRow[] {
	return database
		.prepare(
			`SELECT id, text, category, project_id, timestamp, metadata, content_hash, fact_id,
				raw_candidate_json, subject, attribute,
				json_extract(metadata, '$.event_at') AS eventAt, valid_from AS validFromColumn
			FROM nodix_memories
			WHERE project_id = ?
				AND ${REM_CANDIDATE_PREDICATE_SQL}
			ORDER BY timestamp, id`,
		)
		.all(scope) as CandidateRow[];
}

function readStampedRowsForJournal(
	database: SqliteDatabaseLike,
	scope: string,
	implementationVersion: string,
): StampedRow[] {
	const rows = database
		.prepare(
			`SELECT id, text, category, metadata FROM nodix_memories
			WHERE project_id = ?
				AND category IN ('profile', 'episodic', 'state')
				AND json_valid(metadata)
				AND json_type(metadata, '$.rem_update_idempotency_key') = 'text'
				AND length(json_extract(metadata, '$.rem_update_idempotency_key')) > 0
				AND json_type(metadata, '$.rem_update_source_version') = 'text'
				AND length(json_extract(metadata, '$.rem_update_source_version')) > 0
			ORDER BY id`,
		)
		.all(scope) as Array<Pick<CandidateRow, "id" | "text" | "category" | "metadata">>;
	return rows.flatMap((row) => {
		const metadata = parseMetadata(row.metadata);
		const storedStamp = metadata["rem_update_idempotency_key"];
		const sourceVersion = metadata["rem_update_source_version"];
		const resultTextSha256 = metadata["rem_update_result_text_sha256"];
		if (
			typeof storedStamp !== "string" ||
			typeof sourceVersion !== "string" ||
			resultTextSha256 !== sha256(row.text)
		) {
			return [];
		}
		const locale = readUpdateLocale(row.metadata);
		const expectedStamp = deriveRemUpdateStamp({
			source: sourceVersion,
			implementationVersion,
			memoryKind: row.category,
			locale,
			localeResource: getRemUpdateLocaleResource(locale),
		});
		return storedStamp === expectedStamp ? [{ id: row.id }] : [];
	});
}

function classifyCandidates(
	repository: RemRepository,
	rows: readonly CandidateRow[],
): Candidate[] {
	const classifiedAt = new Date().toISOString();
	return rows.flatMap((row) => {
		const canonicalAddress = readCanonicalAddress(row.metadata) ?? `row:${row.id}`;
		const factKey = readFactKey(row.metadata);
		const classified = classifyRemRow({
			rowId: row.id,
			text: row.text,
			contentHash: row.content_hash,
		});
		repository.recordClassification({
			rowId: row.id,
			contentHash: row.content_hash,
			state: classified.state,
			classifiedAt,
		});
		return [
			{
				...row,
				canonicalAddress,
				...(factKey === undefined ? {} : { factKey }),
				locale: readUpdateLocale(row.metadata),
				validFrom: readValidFrom(row.metadata, row.timestamp),
				owner: classified.owner,
				state: classified.state,
			},
		];
	});
}

interface RemUpdateBudget {
	configuration: RemOperationalConfiguration | undefined;
	modelCalls: number;
	startedAtMs: number;
	tokens: number;
}

function createRemUpdateBudget(configuration: RemOperationalConfiguration | undefined): RemUpdateBudget {
	return { configuration, modelCalls: 0, startedAtMs: Date.now(), tokens: 0 };
}

// A meter, not a gate. This used to refuse the call when it crossed a configured wall clock, call
// count or token ceiling; all three were guesses, and the token one could never be satisfied at all,
// so the stage made zero model calls in every run it was configured for. What each was watching now
// leaves in the wave summary as a measurement, where a real ceiling can be derived from real waves
// if one ever turns out to be needed.
function recordRemUpdateModelCall(budget: RemUpdateBudget, prompt: string): void {
	budget.modelCalls += 1;
	budget.tokens += countTokens(prompt) + REM_MODEL_OUTPUT_TOKEN_CAP;
}

async function runUpdate(input: {
	jobId: string;
	jobType: "rem-update";
	runtime: BatchRuntime;
	repository: RemRepository;
	candidates: readonly Candidate[];
	stampedRows: readonly StampedRow[];
	configuration?: RemOperationalConfiguration;
	implementationVersion?: string;
}): Promise<RemStageResult> {
	const budget = createRemUpdateBudget(input.configuration);
	// Every eligible row is considered. This used to keep only the first `maxRows`, which was 10
	// against a persona's ~209 actionable candidates — not a ceiling on work but silent, permanent
	// discard of 95% of it, with nothing in the output saying so.
	const candidates = input.candidates;
	const ports = createSnoStationMemRemPorts({
		database: input.runtime.database,
		llmClient: input.runtime.llm,
		memoryStore: input.runtime.store,
	});
	const configurationSha256 =
		input.configuration === undefined
			? "0".repeat(64)
			: deriveRemConfigurationSha256(input.configuration);
	const recovery = createSnoStationMemRemRecovery(input.runtime.database);
	const mutationExecutor = createSnoStationMemRemMutationExecutor({
		database: input.runtime.database,
		jobType: input.jobType,
		configurationSha256,
		liveContentionRetries: input.configuration?.retries.liveContentionRetries ?? 0,
		recovery,
		applyTextVersion: (write, verification) =>
			ports.conflict.writeTextVersion({ ...write, verification }),
	});
	await mutationExecutor.recoverPendingAttempts();
	const relationEffects = await runProductionUpdateRelations({
		...input,
		budget,
		candidates,
		configurationSha256,
		mutationExecutor,
		recovery,
	});
	let actionsApplied = relationEffects.actionsApplied;
	let verdicts = relationEffects.verdicts;
	let llmCalls = relationEffects.llmCalls;
	let successfulLlmCalls = relationEffects.successfulLlmCalls;
	let lastRefusalReason = relationEffects.lastRefusalReason;
	const stampedRowIds = new Set(input.stampedRows.map((row) => row.id));
	const owned = candidates.filter(
		(candidate) =>
			candidate.owner === "restate" &&
			!stampedRowIds.has(candidate.id) &&
			!relationEffects.handledRowIds.has(candidate.id),
	);
	for (const stampedRow of input.stampedRows) {
		if (relationEffects.handledRowIds.has(stampedRow.id)) continue;
		appendRefusal(
			input.repository,
			input.jobId,
			input.jobType,
			stampedRow.id,
			"already_stamped",
		);
	}
	for (const [index, candidate] of owned.entries()) {
		const claimed = claimCandidate(input.repository, candidate, "restate");
		if (!claimed) continue;
		log.info("update_progress", {
			job_id: input.jobId,
			current: index + 1,
			total: owned.length,
			row_id: candidate.id,
		}, {
			event_name: "sno_station_mem.rem-batch-executor.update.progress",
			file: "packages/sno-station-mem/src/sidecar/rem-batch-executor.ts",
			function: "runUpdate",
			site_id: "rem-batch-executor.runUpdate.dbf2a836db",
		});
		try {
			if (candidate.state === "ambiguous") {
				lastRefusalReason = "ambiguous_unresolved";
				appendRefusal(
					input.repository,
					input.jobId,
					input.jobType,
					candidate.id,
					"ambiguous_unresolved",
				);
				completeCandidate(
					input.repository,
					claimed,
					candidate.content_hash,
					input.jobId,
					input.jobType,
				);
				continue;
			}
			if (candidate.state !== "transition") {
				lastRefusalReason = "row_not_owned";
				releaseCandidate(input.repository, claimed);
				appendRefusal(
					input.repository,
					input.jobId,
					input.jobType,
					candidate.id,
					"row_not_owned",
				);
				continue;
			}
			if (
				candidate.category !== "profile" &&
				candidate.category !== "episodic" &&
				candidate.category !== "state"
			) {
				lastRefusalReason = "missing_row_kind";
				releaseCandidate(input.repository, claimed);
				appendRefusal(
					input.repository,
					input.jobId,
					input.jobType,
					candidate.id,
					"missing_row_kind",
				);
				continue;
			}
			const enumeratedMembers = enumerateRemUpdateMembers(candidate.text);
			const prompt = renderRemUpdateJudgmentPrompt({
				judgmentSkill: REM_UPDATE_JUDGMENT_SKILL.rewrite,
				source: candidate.text,
				...(enumeratedMembers.length === 0 ? {} : { enumeratedMembers }),
			});
			recordRemUpdateModelCall(budget, prompt);
			llmCalls += 1;
			const reply = await completeJsonStage(
				input.runtime,
				"rem-update-judgment",
				prompt,
			);
			const replyText = typeof reply === "string" ? reply : JSON.stringify(reply) ?? "";
			const decision = decideRemUpdateFromReply(replyText);
			log.info("update_decision_evaluated", {
				job_id: input.jobId,
				row_id: candidate.id,
				outcome: decision.outcome,
				...(decision.outcome === "refuse"
					? { reason: decision.reason }
					: { retired_value_count: decision.retiredValues.length }),
			}, {
				event_name: "sno_station_mem.rem-batch-executor.update.decision.evaluated",
				file: "packages/sno-station-mem/src/sidecar/rem-batch-executor.ts",
				function: "runUpdate",
				site_id: "rem-batch-executor.runUpdate.7dfc387204",
			});
			if (decision.outcome === "refuse") {
				if (decision.reason !== "model_response_invalid") {
					successfulLlmCalls += 1;
					if (decision.reason !== "no_retired_fact") verdicts += 1;
				}
				lastRefusalReason = decision.reason;
				releaseCandidate(input.repository, claimed);
				appendRefusal(input.repository, input.jobId, input.jobType, candidate.id, decision.reason);
				continue;
			}
			successfulLlmCalls += 1;
			const verificationPrompt = renderRemUpdateVerificationPrompt({
				judgmentSkill: REM_UPDATE_JUDGMENT_SKILL.verification,
				source: candidate.text,
				proposedCurrent: decision.proposedCurrent,
				retiredValues: decision.retiredValues,
			});
			recordRemUpdateModelCall(budget, verificationPrompt);
			llmCalls += 1;
			const verificationReply = await completeJsonStage(
				input.runtime,
				"rem-update-verification",
				verificationPrompt,
			);
			const verificationReplyText =
				typeof verificationReply === "string"
					? verificationReply
					: JSON.stringify(verificationReply) ?? "";
			const verification = decideRemUpdateVerification(verificationReplyText);
			log.info("update_verification_evaluated", {
				job_id: input.jobId,
				row_id: candidate.id,
				outcome: verification.outcome,
				...(verification.outcome === "refuse" ? { reason: verification.reason } : {}),
			}, {
				event_name: "sno_station_mem.rem-batch-executor.update.verification.evaluated",
				file: "packages/sno-station-mem/src/sidecar/rem-batch-executor.ts",
				function: "runUpdate",
				site_id: "rem-batch-executor.runUpdate.7ffc737c24",
			});
			if (verification.outcome === "refuse") {
				if (verification.reason !== "model_response_invalid") {
					successfulLlmCalls += 1;
					verdicts += 1;
				}
				lastRefusalReason = verification.reason;
				releaseCandidate(input.repository, claimed);
				appendRefusal(
					input.repository,
					input.jobId,
					input.jobType,
					candidate.id,
					verification.reason,
				);
				continue;
			}
			successfulLlmCalls += 1;
			verdicts += 1;
			const rewriteConfig = {
				implementationVersion: input.implementationVersion ?? "rem-update-v1",
				memoryKind: candidate.category,
				locale: candidate.locale,
				localeResource: getRemUpdateLocaleResource(candidate.locale),
			} as const;
			const updateStamp = deriveRemUpdateStamp({ source: candidate.text, ...rewriteConfig });
			const evidenceId = `rem-update:${input.jobId}:${candidate.id}:rewrite`;
			input.runtime.database
				.prepare(
					`INSERT OR REPLACE INTO nodix_rem_write_verdicts(
						evidence_id, winner_row_id, loser_row_id, target_row_id,
						retired_fact_atoms_json, recorded_at
					) VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run(
					evidenceId,
					candidate.id,
					candidate.id,
					candidate.id,
					JSON.stringify([candidate.text]),
					ports.clock.now(),
				);
			const handle = await mutationExecutor.openAttempt({
				jobId: input.jobId,
				stage: "rem-update",
				rowId: candidate.id,
				writer: "writeTextVersion",
				authorization: {
					rowId: candidate.id,
					preWriteContentSha256: candidate.content_hash,
					proposedTextSha256: sha256(decision.proposedCurrent),
					evidenceId,
					configurationSha256,
				},
			});
			const resolution = await mutationExecutor.mutateAttempt(handle, {
				kind: "writeTextVersion",
				replacementText: decision.proposedCurrent,
				historyText: candidate.text,
				supersededItems: decision.retiredValues,
				sourceVersion: candidate.text,
				rewriteConfig,
				idempotencyKey: updateStamp,
				reason: "REM update accepted the model judgment and mechanical source checks.",
				timestamp: ports.clock.now(),
			});
			const outcome = await mutationExecutor.closeAttempt(handle, resolution);
			if (outcome.outcome !== "succeeded") {
				releaseCandidate(input.repository, claimed);
				appendRefusal(
					input.repository,
					input.jobId,
					input.jobType,
					candidate.id,
					outcome.reasonCode ?? "mutation_failed",
				);
				continue;
			}
			if (outcome.postWriteContentSha256 === null) {
				throw new Error("successful REM write attempt omitted its post-write content hash");
			}
			actionsApplied += 1;
			completeCandidate(
				input.repository,
				claimed,
				outcome.postWriteContentSha256,
				input.jobId,
				input.jobType,
			);
		} catch (error) {
			releaseCandidate(input.repository, claimed);
			throw error;
		}
	}
	if (llmCalls > 0 && successfulLlmCalls === 0) {
		throw new Error(
			`REM LLM calls all failed: ${lastRefusalReason ?? input.runtime.llm.getLastError() ?? "unknown"}`,
		);
	}
	const updateRows = appliedUnitStatistics(
		owned.length,
		actionsApplied - relationEffects.actionsApplied,
	);
	const relationPairs = appliedUnitStatistics(
		relationEffects.pairsScanned,
		relationEffects.actionsApplied,
	);
	// A summary row counts as substantive ONLY when it actually applied something. Writing "done"
	// for a wave that applied nothing made validateRemSubstantiveWaveEffects see journal rows with
	// no successful write attempt and raise `journal_only` — its internal-inconsistency alarm — for
	// the ordinary case of a wave that had nothing to do. "no-action" is the outcome that already
	// means exactly that, and the guard already excludes it. The alarm still fires when a row
	// reports applied work that no write attempt backs, which is what it is for.
	input.repository.appendJournal(input.jobId, input.jobType, {
		stage: "update-rows",
		outcome: updateRows.applied > 0 ? "done" : "no-action",
		pairsScanned: updateRows.considered,
		verdicts: 0,
		actionsApplied: updateRows.applied,
	});
	input.repository.appendJournal(input.jobId, input.jobType, {
		stage: "update-relation-pairs",
		outcome: relationPairs.applied > 0 ? "done" : "no-action",
		pairsScanned: relationPairs.considered,
		verdicts: 0,
		actionsApplied: relationPairs.applied,
	});
	return {
		...journal(input.jobType, relationEffects.pairsScanned, verdicts, actionsApplied),
		updateRows,
		relationPairs,
		measurements: {
			rowsConsidered: candidates.length,
			pairsBuilt: 0,
			pairCapBinding: false,
			modelCalls: budget.modelCalls,
			modelTokens: budget.tokens,
			wallMs: Date.now() - budget.startedAtMs,
		},
	};
}

function appliedUnitStatistics(considered: number, applied: number): RemAppliedUnitStatistics {
	return {
		considered,
		applied,
		appliedFraction: considered === 0 ? null : applied / considered,
	};
}

async function runProductionUpdateRelations(input: {
	jobId: string;
	jobType: RemOperationType;
	runtime: BatchRuntime;
	repository: RemRepository;
	candidates: readonly Candidate[];
	configuration?: RemOperationalConfiguration;
	configurationSha256: string;
	budget: RemUpdateBudget;
	mutationExecutor: ReturnType<typeof createSnoStationMemRemMutationExecutor>;
	recovery: ReturnType<typeof createSnoStationMemRemRecovery>;
}): Promise<{
	actionsApplied: number;
	handledRowIds: Set<string>;
	lastRefusalReason: string | undefined;
	llmCalls: number;
	pairsScanned: number;
	successfulLlmCalls: number;
	verdicts: number;
}> {
	if (input.configuration === undefined) {
		return {
			actionsApplied: 0,
			handledRowIds: new Set(),
			lastRefusalReason: undefined,
			llmCalls: 0,
			pairsScanned: 0,
			successfulLlmCalls: 0,
			verdicts: 0,
		};
	}
	const grouped = Map.groupBy(
		input.candidates.filter((candidate) => candidate.state !== "ambiguous"),
		(candidate) => candidate.canonicalAddress,
	);
	type RelationSelection = NonNullable<
		ReturnType<typeof selectRemUpdateRelationCandidates<Candidate>>
	>;
	const relationWork: Array<{
		candidates: Candidate[];
		retirementPair?: RelationSelection;
	}> = [...grouped.values()].map((candidates) => ({ candidates }));
	let actionsApplied = 0;
	const handledRowIds = new Set<string>();
	const closedRowIds = new Set<string>();
	let lastRefusalReason: string | undefined;
	let llmCalls = 0;
	let pairsScanned = 0;
	let successfulLlmCalls = 0;
	let verdicts = 0;
	for (let workIndex = 0; workIndex < relationWork.length; workIndex += 1) {
		const work = relationWork[workIndex];
		if (work === undefined) continue;
		const { candidates } = work;
		let retirementPair = work.retirementPair;
		let retirementApplied = retirementPair !== undefined;
		const nominatedRows = candidates
			.filter(
				(candidate) => candidate.owner === "restate" || candidate.state === "pure-negation",
			)
			.sort(
				(left, right) =>
					compareMemorySourceOrder(rowOrderKey(right), rowOrderKey(left)) ||
					right.id.localeCompare(left.id),
			);
		for (const nominatedRow of retirementPair === undefined ? nominatedRows : []) {
			if (handledRowIds.has(nominatedRow.id)) continue;
			const candidateSet = await buildRemRetirementCandidateSet({
				runtime: input.runtime,
				repository: input.repository,
				jobId: input.jobId,
				nominatedRow,
				candidates: input.candidates.filter((candidate) => !closedRowIds.has(candidate.id)),
				configuration: input.configuration,
			});
			const retirementTarget = await runRemRetirementTargetGate({
				...input,
				nominatedRow,
				...candidateSet,
			});
			llmCalls += retirementTarget.llmCalls;
			pairsScanned += retirementTarget.pairsScanned;
			successfulLlmCalls += retirementTarget.successfulLlmCalls;
			verdicts += retirementTarget.verdicts;
			if (retirementTarget.lastRefusalReason !== undefined) {
				lastRefusalReason = retirementTarget.lastRefusalReason;
			}
			if (retirementTarget.outcome === "selected") {
				handledRowIds.add(retirementTarget.nominatedRowId);
				const mechanicalRows = retirementTarget.targetRows.filter((targetRow) =>
					retirementTarget.mechanicalRowIds.has(targetRow.id),
				);
				for (const targetRow of mechanicalRows) {
					handledRowIds.add(targetRow.id);
					closedRowIds.add(targetRow.id);
				}
				actionsApplied += applyRetirementCloses({
					database: input.runtime.database,
					repository: input.repository,
					jobId: input.jobId,
					nominatedRow,
					targetRows: mechanicalRows,
					mechanicalRowIds: retirementTarget.mechanicalRowIds,
				});
				const modelPairs = retirementTarget.targetRows
					.filter((targetRow) => !retirementTarget.mechanicalRowIds.has(targetRow.id))
					.map((targetRow): RelationSelection => ({
						linked: [],
						prior: targetRow,
						relationCandidate: nominatedRow,
						retraction: nominatedRow.state === "pure-negation" ? nominatedRow : undefined,
					}));
				retirementPair = modelPairs[0];
				relationWork.splice(
					workIndex + 1,
					0,
					...modelPairs.slice(1).map((pair) => ({
						candidates: [pair.prior, pair.relationCandidate],
						retirementPair: pair,
					})),
				);
				retirementApplied = true;
				break;
			}
			if (retirementTarget.outcome === "stop") {
				handledRowIds.add(retirementTarget.nominatedRowId);
			}
		}
		let selected = retirementPair;
		if (selected === undefined && !retirementApplied) {
			selected = selectRemUpdateRelationCandidates(
				candidates.filter((candidate) => !handledRowIds.has(candidate.id)),
			);
		}
		if (selected === undefined) continue;
		const { linked, prior, relationCandidate, retraction } = selected;
		pairsScanned += 1;
		const prompt = renderRemUpdateRelationJudgmentPrompt({
			judgmentSkill: REM_UPDATE_JUDGMENT_SKILL.relation,
			rowText: relationCandidate.text,
			predecessorTexts: [prior.text],
			successorTexts: linked.map((candidate) => candidate.text),
		});
		recordRemUpdateModelCall(input.budget, prompt);
		llmCalls += 1;
		const reply = await completeTextStage(
			input.runtime,
			"rem-update-relation-judgment",
			prompt,
		);
		let relation = decideRemUpdateRelationFromReply(reply ?? "");
		if (
			retirementPair !== undefined &&
			relation.outcome === "refuse" &&
			relation.reason === "no_retired_fact"
		) {
			const parsedReply = parseStageJson(reply ?? "");
			const supersedesEverything =
				typeof parsedReply === "object" && parsedReply !== null
					? (parsedReply as Record<string, unknown>)["supersedes_everything"]
					: undefined;
			relation =
				typeof supersedesEverything === "boolean"
					? { outcome: "allow", supersedesEverything }
					: { outcome: "refuse", reason: "model_response_invalid" };
		}
		if (relation.outcome === "allow" || relation.reason === "no_retired_fact") {
			successfulLlmCalls += 1;
		} else {
			lastRefusalReason = relation.reason;
		}
		verdicts += 1;
		if (relation.outcome === "refuse") {
			// `no_retired_fact` is the model correctly reporting that this row retires nothing.
			// It is journalled like any other refusal, but it must NOT go through
			// recordInvalidWriterAttempts: that exists to record a degraded attempt per writer
			// when the model's answer was absent or unusable, and running it here would
			// manufacture a row of failed write attempts for a row nobody ever tried to write.
			if (relation.reason !== "no_retired_fact") {
				handledRowIds.add(prior.id);
				await recordInvalidWriterAttempts({
					...input,
					row: prior,
					successor: relationCandidate,
					reason: relation.reason,
				});
			}
			appendRefusal(
				input.repository,
				input.jobId,
				"rem-update",
				prior.id,
				relation.reason,
			);
			continue;
		}
		let replacementText: string | undefined;
		let retiredValues: readonly string[] = [prior.text];
		let writeReason = "REM update accepted the live retraction relation.";
		if (!relation.supersedesEverything) {
			const rewritePrompt = renderRemUpdateJudgmentPrompt({
				judgmentSkill: REM_UPDATE_JUDGMENT_SKILL.rewrite,
				source: prior.text,
				supersedingText: relationCandidate.text,
			});
			recordRemUpdateModelCall(input.budget, rewritePrompt);
			llmCalls += 1;
			const rewriteReply = await completeJsonStage(
				input.runtime,
				"rem-update-judgment",
				rewritePrompt,
			);
			const rewriteReplyText =
				typeof rewriteReply === "string"
					? rewriteReply
					: JSON.stringify(rewriteReply) ?? "";
			const rewrite = decideRemUpdateFromReply(rewriteReplyText);
			if (rewrite.outcome === "refuse") {
				if (rewrite.reason !== "model_response_invalid") {
					successfulLlmCalls += 1;
					if (rewrite.reason !== "no_retired_fact") verdicts += 1;
				}
				lastRefusalReason = rewrite.reason;
				appendRefusal(
					input.repository,
					input.jobId,
					"rem-update",
					prior.id,
					rewrite.reason,
				);
				continue;
			}
			successfulLlmCalls += 1;
			const verificationPrompt = renderRemUpdateVerificationPrompt({
				judgmentSkill: REM_UPDATE_JUDGMENT_SKILL.verification,
				source: prior.text,
				supersedingText: relationCandidate.text,
				proposedCurrent: rewrite.proposedCurrent,
				retiredValues: rewrite.retiredValues,
			});
			recordRemUpdateModelCall(input.budget, verificationPrompt);
			llmCalls += 1;
			const verificationReply = await completeJsonStage(
				input.runtime,
				"rem-update-verification",
				verificationPrompt,
			);
			const verificationReplyText =
				typeof verificationReply === "string"
					? verificationReply
					: JSON.stringify(verificationReply) ?? "";
			const verification = decideRemUpdateVerification(verificationReplyText);
			if (verification.outcome === "refuse") {
				if (verification.reason !== "model_response_invalid") {
					successfulLlmCalls += 1;
					verdicts += 1;
				}
				lastRefusalReason = verification.reason;
				appendRefusal(
					input.repository,
					input.jobId,
					"rem-update",
					prior.id,
					verification.reason,
				);
				continue;
			}
			successfulLlmCalls += 1;
			verdicts += 1;
			replacementText = rewrite.proposedCurrent;
			retiredValues = rewrite.retiredValues;
			writeReason = "REM update preserved facts outside the partial supersession.";
		} else if (retraction !== undefined) {
			const proposedCurrent = composeRemNegatedCurrent({
				topic: prior.canonicalAddress,
				priorRowId: prior.id,
				retractionText: retraction.text,
			}).assertions[0]?.provenance;
			if (proposedCurrent === undefined) {
				throw new Error("REM update omitted its current assertion");
			}
			const verificationPrompt = renderRemUpdateVerificationPrompt({
				judgmentSkill: REM_UPDATE_JUDGMENT_SKILL.verification,
				source: prior.text,
				proposedCurrent,
				retiredValues: [prior.text],
				retractionText: retraction.text,
			});
			recordRemUpdateModelCall(input.budget, verificationPrompt);
			llmCalls += 1;
			const verificationReply = await completeJsonStage(
				input.runtime,
				"rem-update-verification",
				verificationPrompt,
			);
			const verificationReplyText =
				typeof verificationReply === "string"
					? verificationReply
					: JSON.stringify(verificationReply) ?? "";
			const verification = decideRemUpdateVerification(verificationReplyText);
			if (verification.outcome === "refuse") {
				if (verification.reason !== "model_response_invalid") {
					successfulLlmCalls += 1;
					verdicts += 1;
				}
				lastRefusalReason = verification.reason;
				appendRefusal(
					input.repository,
					input.jobId,
					"rem-update",
					prior.id,
					verification.reason,
				);
				continue;
			}
			successfulLlmCalls += 1;
			verdicts += 1;
		}
		if (retirementPair !== undefined && replacementText === undefined) {
			actionsApplied += applyRetirementCloses({
				database: input.runtime.database,
				repository: input.repository,
				jobId: input.jobId,
				nominatedRow: relationCandidate,
				targetRows: [prior],
				mechanicalRowIds: new Set(),
			});
			handledRowIds.add(prior.id);
			closedRowIds.add(prior.id);
			continue;
		}
		const evidenceId = `rem-update:${input.jobId}:${prior.id}`;
		input.runtime.database
			.prepare(
				`INSERT OR REPLACE INTO nodix_rem_write_verdicts(
					evidence_id, winner_row_id, loser_row_id, target_row_id,
					retired_fact_atoms_json, recorded_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				evidenceId,
				relationCandidate.id,
				prior.id,
				prior.id,
				JSON.stringify(retiredValues),
				new Date().toISOString(),
			);
		const writer = replacementText === undefined ? "softClose" : "writeTextVersion";
		const handle = await input.mutationExecutor.openAttempt({
			jobId: input.jobId,
			stage: "rem-update:relation",
			rowId: prior.id,
			writer,
			authorization: {
				rowId: prior.id,
				preWriteContentSha256: prior.content_hash,
				proposedTextSha256: sha256(replacementText ?? prior.text),
				evidenceId,
				configurationSha256: input.configurationSha256,
			},
		});
		const timestamp = new Date().toISOString();
		const resolution = await input.mutationExecutor.mutateAttempt(
			handle,
			replacementText === undefined
				? {
						kind: "softClose",
						successorId: relationCandidate.id,
						reason: "REM update accepted the newer active relation.",
						timestamp,
					}
				: {
						kind: "writeTextVersion",
						replacementText,
						historyText: prior.text,
						supersededItems: retiredValues,
						idempotencyKey: evidenceId,
						reason: writeReason,
						timestamp,
					},
		);
		const outcome = await input.mutationExecutor.closeAttempt(handle, resolution);
		if (outcome.outcome !== "succeeded") {
			const reason = outcome.reasonCode ?? "mutation_failed";
			lastRefusalReason = reason;
			appendRefusal(input.repository, input.jobId, "rem-update", prior.id, reason);
			continue;
		}
		handledRowIds.add(prior.id);
		closedRowIds.add(prior.id);
		actionsApplied += 1;
		if (retirementPair !== undefined) {
			appendRetirementTargetDone(
				input.repository,
				input.jobId,
				relationCandidate.id,
				prior.id,
			);
		}
	}
	return {
		actionsApplied,
		handledRowIds,
		lastRefusalReason,
		llmCalls,
		pairsScanned,
		successfulLlmCalls,
		verdicts,
	};
}

type RemRetirementTargetGateResult = {
	lastRefusalReason?: string;
	llmCalls: number;
	pairsScanned: number;
	successfulLlmCalls: number;
	verdicts: number;
} & (
	| { outcome: "continue" }
	| { outcome: "stop"; nominatedRowId: string }
	| {
			outcome: "selected";
			nominatedRowId: string;
			targetRows: Candidate[];
			mechanicalRowIds: ReadonlySet<string>;
	  }
);

interface RemRetirementCandidateSet {
	candidateRows: Candidate[];
	mechanicalRows: Candidate[];
}

function introducesFreshEntity(candidate: Candidate): boolean {
	try {
		const metadata: unknown = JSON.parse(candidate.metadata);
		return (
			typeof metadata === "object" &&
			metadata !== null &&
			"entity_identity_new" in metadata &&
			metadata.entity_identity_new === true
		);
	} catch {
		return false;
	}
}

function readEventDate(eventAt: Candidate["eventAt"]): string | undefined {
	if (eventAt === null) return undefined;
	const date = new Date(eventAt);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

function retirementAttributeRank(nominatedRow: Candidate, candidate: Candidate): number {
	if (
		nominatedRow.attribute !== null &&
		candidate.attribute !== null &&
		nominatedRow.attribute === candidate.attribute
	) {
		return 0;
	}
	const nominatedFamily =
		nominatedRow.attribute === null
			? undefined
			: attributeFamilyBySlug.get(nominatedRow.attribute);
	const candidateFamily =
		candidate.attribute === null ? undefined : attributeFamilyBySlug.get(candidate.attribute);
	if (nominatedFamily !== undefined && nominatedFamily === candidateFamily) return 1;
	return candidate.attribute === null ? 2 : 3;
}

async function readRetirementSimilarityScores(input: {
	runtime: BatchRuntime;
	nominatedRow: Candidate;
	candidates: readonly Candidate[];
}): Promise<Map<string, number>> {
	if (input.candidates.length === 0) return new Map();
	const vector = await input.runtime.embedder.embed(input.nominatedRow.text);
	return scoreCandidatesBySimilarity(
		input.runtime.store,
		vector,
		input.candidates.map(({ id }) => id),
	);
}

function appendRetirementCandidateCap(
	repository: RemRepository,
	jobId: string,
	nominatedRowId: string,
	omittedCount: number,
): void {
	repository.appendJournal(jobId, "rem-update", {
		stage: `update-retirement-candidates:${nominatedRowId}`,
		outcome: "no-action",
		pairsScanned: 0,
		verdicts: 0,
		actionsApplied: 0,
		reason: "candidate_cap_truncated",
		detail: JSON.stringify({ nominatedRowId, omittedCount }),
		rowId: nominatedRowId,
	});
}

function limitRetirementSubjectRows(input: {
	rows: readonly Candidate[];
	repository: RemRepository;
	jobId: string;
	nominatedRowId: string;
}): Candidate[] {
	if (input.rows.length > RETIREMENT_SUBJECT_CANDIDATE_CAP) {
		appendRetirementCandidateCap(
			input.repository,
			input.jobId,
			input.nominatedRowId,
			input.rows.length - RETIREMENT_SUBJECT_CANDIDATE_CAP,
		);
	}
	return input.rows.slice(0, RETIREMENT_SUBJECT_CANDIDATE_CAP);
}

function sortByRetirementSimilarity(
	rows: readonly Candidate[],
	scores: ReadonlyMap<string, number>,
): Candidate[] {
	return [...rows].sort(
		(left, right) =>
			(scores.get(right.id) ?? Number.NEGATIVE_INFINITY) -
				(scores.get(left.id) ?? Number.NEGATIVE_INFINITY) ||
			left.id.localeCompare(right.id),
	);
}

function readOutsideSubjectSimilarityRows(input: {
	eligible: readonly Candidate[];
	sameSubject: readonly Candidate[];
	scores: ReadonlyMap<string, number>;
	minScore: number;
}): Candidate[] {
	const subjectIds = new Set(input.sameSubject.map((candidate) => candidate.id));
	return sortByRetirementSimilarity(
		input.eligible.filter(
			(candidate) =>
				!subjectIds.has(candidate.id) &&
				(input.scores.get(candidate.id) ?? Number.NEGATIVE_INFINITY) >= input.minScore,
		),
		input.scores,
	).slice(0, RETIREMENT_SIMILARITY_CANDIDATE_CAP);
}

async function buildRemRetirementCandidateSet(input: {
	runtime: BatchRuntime;
	repository: RemRepository;
	jobId: string;
	nominatedRow: Candidate;
	candidates: readonly Candidate[];
	configuration: RemOperationalConfiguration;
}): Promise<RemRetirementCandidateSet> {
	if (introducesFreshEntity(input.nominatedRow)) {
		return { candidateRows: [], mechanicalRows: [] };
	}
	const eligible = input.candidates.filter(
		(candidate) =>
			candidate.id !== input.nominatedRow.id &&
			candidate.category === input.nominatedRow.category &&
			isRemRowOlder(candidate, input.nominatedRow),
	);
	const eventDate = readEventDate(input.nominatedRow.eventAt);
	if (input.nominatedRow.eventAt !== null && eventDate === undefined) return {
		candidateRows: [],
		mechanicalRows: [],
	};
	const sameSubject =
		input.nominatedRow.subject === null
			? []
			: eligible.filter((candidate) => candidate.subject === input.nominatedRow.subject);
	if (input.nominatedRow.subject === null) {
		// No subject, so there is no group to read: every older row in the scope is a candidate,
		// ranked by similarity and capped. REQ-4 calls this "the similarity candidates only" and
		// it is today's path — which offers every older row, not a score-filtered slice. Gating it
		// on the similarity threshold here would offer NOTHING for a row the store cannot key, and
		// a retirement sentence that reaches no judgement is exactly the failure PRD 110 closed.
		const scoresForAll = await readRetirementSimilarityScores({
			runtime: input.runtime,
			nominatedRow: input.nominatedRow,
			candidates: eligible,
		});
		return {
			candidateRows: limitRetirementSubjectRows({
				rows: sortByRetirementSimilarity(eligible, scoresForAll),
				repository: input.repository,
				jobId: input.jobId,
				nominatedRowId: input.nominatedRow.id,
			}),
			mechanicalRows: [],
		};
	}
	const scores = await readRetirementSimilarityScores({
		runtime: input.runtime,
		nominatedRow: input.nominatedRow,
		candidates: eligible,
	});
	if (eventDate !== undefined) {
		const eventRows = sortByRetirementSimilarity(
			sameSubject.filter((candidate) => readEventDate(candidate.eventAt) === eventDate),
			scores,
		);
		return {
			candidateRows: limitRetirementSubjectRows({
				rows: eventRows,
				repository: input.repository,
				jobId: input.jobId,
				nominatedRowId: input.nominatedRow.id,
			}),
			mechanicalRows: [],
		};
	}
	// A pure negation rejects one value; which row that retires is a judgement, never mechanical.
	const oneGroup =
		input.nominatedRow.subject !== null &&
		input.nominatedRow.attribute !== null &&
		input.nominatedRow.state !== "pure-negation" &&
		oneCardinalityAttributes.has(input.nominatedRow.attribute)
			? sameSubject.filter(
					(candidate) => candidate.attribute === input.nominatedRow.attribute,
				)
			: [];
	const oneGroupIds = new Set(oneGroup.map((candidate) => candidate.id));
	const rankedSubjectRows = sameSubject
		.filter((candidate) => !oneGroupIds.has(candidate.id))
		.sort(
			(left, right) =>
				retirementAttributeRank(input.nominatedRow, left) -
					retirementAttributeRank(input.nominatedRow, right) ||
				(scores.get(right.id) ?? Number.NEGATIVE_INFINITY) -
					(scores.get(left.id) ?? Number.NEGATIVE_INFINITY) ||
				left.id.localeCompare(right.id),
		);
	const similarityRows = readOutsideSubjectSimilarityRows({
		eligible,
		sameSubject,
		scores,
		minScore: input.configuration.retrieval.similarityThreshold,
	});
	return {
		candidateRows: [
			...limitRetirementSubjectRows({
				rows: rankedSubjectRows,
				repository: input.repository,
				jobId: input.jobId,
				nominatedRowId: input.nominatedRow.id,
			}),
			...similarityRows,
		],
		mechanicalRows: oneGroup,
	};
}

async function runRemRetirementTargetGate(input: {
	jobId: string;
	runtime: BatchRuntime;
	repository: RemRepository;
	nominatedRow: Candidate;
	candidateRows: readonly Candidate[];
	mechanicalRows: readonly Candidate[];
	budget: RemUpdateBudget;
}): Promise<RemRetirementTargetGateResult> {
	if (input.candidateRows.length === 0 && input.mechanicalRows.length === 0) {
		appendRetirementNoTarget(input.repository, input.jobId, input.nominatedRow.id, 0);
		return { ...emptyRetirementTargetGateResult(), lastRefusalReason: "no_retirement_target" };
	}
	const targetRowIds = new Set(input.mechanicalRows.map((candidate) => candidate.id));
	let llmCalls = 0;
	let refusalReason: "model_response_invalid" | "row_id_not_offered" | undefined;
	for (let start = 0; start < input.candidateRows.length; start += RETIREMENT_JUDGMENT_BATCH_SIZE) {
		const batch = input.candidateRows.slice(start, start + RETIREMENT_JUDGMENT_BATCH_SIZE);
		const prompt = renderRemRetirementTargetPrompt({
			judgmentSkill: REM_UPDATE_JUDGMENT_SKILL.retirementTarget,
			nominatedRow: { id: input.nominatedRow.id, text: input.nominatedRow.text },
			candidateRows: batch.map((candidate) => ({ id: candidate.id, text: candidate.text })),
		});
		recordRemUpdateModelCall(input.budget, prompt);
		llmCalls += 1;
		let reply: string | null = null;
		try {
			reply = await completeTextStage(input.runtime, "rem-update-retirement-target", prompt);
		} catch {
			// A target-stage transport failure follows the same fail-closed path as an invalid reply.
		}
		const decision = decideRemRetirementTargetFromReply(
			reply ?? "",
			new Set(batch.map((candidate) => candidate.id)),
		);
		if (decision.outcome === "refuse") {
			appendRetirementTargetRefusal(
				input.repository,
				input.jobId,
				input.nominatedRow.id,
				decision.reason,
				input.candidateRows.length,
			);
			// Each batch is an independent candidate shard. A refused batch is recorded and skipped,
			// not a stop: the remaining batches are still judged, so a fact that should close but sits
			// in a later batch is not lost to one bad reply.
			refusalReason = decision.reason;
			continue;
		}
		for (const rowId of decision.targetRowIds) targetRowIds.add(rowId);
	}
	if (refusalReason !== undefined && targetRowIds.size === 0) {
		return {
			outcome: "stop",
			nominatedRowId: input.nominatedRow.id,
			lastRefusalReason: refusalReason,
			llmCalls,
			pairsScanned: llmCalls,
			successfulLlmCalls: 0,
			verdicts: llmCalls,
		};
	}
	if (targetRowIds.size === 0) {
		appendRetirementNoTarget(
			input.repository,
			input.jobId,
			input.nominatedRow.id,
			input.candidateRows.length,
		);
		return {
			outcome: "continue",
			lastRefusalReason: "no_retirement_target",
			llmCalls,
			pairsScanned: llmCalls,
			successfulLlmCalls: llmCalls,
			verdicts: llmCalls,
		};
	}
	const candidateById = new Map(
		[...input.mechanicalRows, ...input.candidateRows].map((candidate) => [candidate.id, candidate]),
	);
	const targetRows = [...targetRowIds].flatMap((rowId) => {
		const row = candidateById.get(rowId);
		return row === undefined ? [] : [row];
	});
	return {
		outcome: "selected",
		nominatedRowId: input.nominatedRow.id,
		targetRows,
		mechanicalRowIds: new Set(input.mechanicalRows.map((candidate) => candidate.id)),
		llmCalls,
		pairsScanned: llmCalls,
		successfulLlmCalls: llmCalls,
		verdicts: llmCalls,
	};
}

function emptyRetirementTargetGateResult(): RemRetirementTargetGateResult {
	return {
		outcome: "continue",
		llmCalls: 0,
		pairsScanned: 0,
		successfulLlmCalls: 0,
		verdicts: 0,
	};
}

function applyRetirementCloses(input: {
	database: SqliteDatabaseLike;
	repository: RemRepository;
	jobId: string;
	nominatedRow: Candidate;
	targetRows: readonly Candidate[];
	mechanicalRowIds: ReadonlySet<string>;
}): number {
	const supersededAt = new Date().toISOString();
	const closeRows = input.database.transaction((): number => {
		let closed = 0;
		for (const targetRow of input.targetRows) {
			const changed = closeMemoryRow(input.database, {
				targetRowId: targetRow.id,
				closingRowId: input.nominatedRow.id,
				closingOrder: rowOrderKey(input.nominatedRow),
				closingValidFrom: input.nominatedRow.validFromColumn,
				supersededAt,
			});
			if (!changed) continue;
			appendRetirementTargetDone(
				input.repository,
				input.jobId,
				input.nominatedRow.id,
				targetRow.id,
				input.mechanicalRowIds.has(targetRow.id) ? "cardinality_one" : undefined,
			);
			closed += 1;
		}
		return closed;
	});
	const result = closeRows.immediate();
	if (typeof result !== "number") throw new Error("REM retirement close count is invalid");
	return result;
}

export function selectRemUpdateRelationCandidates<
	T extends { id: string; state: Candidate["state"]; timestamp: number },
>(candidates: readonly T[]):
	| { linked: T[]; prior: T; relationCandidate: T; retraction: T | undefined }
	| undefined {
	if (candidates.length < 2) return undefined;
	const ordered = [...candidates].sort(
		(left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id),
	);
	const relationCandidate = ordered.at(-1);
	if (relationCandidate === undefined) return undefined;
	const prior = ordered.findLast(
		(candidate) => candidate.id !== relationCandidate.id && candidate.state !== "pure-negation",
	);
	if (prior === undefined) return undefined;
	return {
		linked: ordered.filter(
			(candidate) => candidate.id !== prior.id && candidate.id !== relationCandidate.id,
		),
		prior,
		relationCandidate,
		retraction: relationCandidate.state === "pure-negation" ? relationCandidate : undefined,
	};
}

async function recordInvalidWriterAttempts(input: {
	jobId: string;
	jobType: RemOperationType;
	runtime: BatchRuntime;
	configuration?: RemOperationalConfiguration;
	configurationSha256: string;
	recovery: ReturnType<typeof createSnoStationMemRemRecovery>;
	row: Candidate;
	successor: Candidate;
	reason: "model_response_absent" | "model_response_invalid";
}): Promise<void> {
	const executor = createSnoStationMemRemMutationExecutor({
		database: input.runtime.database,
		jobType: input.jobType,
		configurationSha256: input.configurationSha256,
		liveContentionRetries: input.configuration?.retries.liveContentionRetries ?? 0,
		modelResponse: { kind: input.reason === "model_response_absent" ? "absent" : "invalid" },
		recovery: input.recovery,
		applyTextVersion: (write) => input.runtime.store.applyRemTextVersion(write),
	});
	for (const writer of [
		"moveLane",
		"writeTextVersion",
		"softClose",
		"restoreLane",
		"restoreTextVersion",
		"restoreMark",
		"applyRemTextVersion",
	] as const satisfies readonly RemMutationWriter[]) {
		const operation = invalidWriterOperation(writer, input.row, input.successor);
		const proposedText =
			operation.kind === "writeTextVersion" || operation.kind === "applyRemTextVersion"
				? operation.replacementText
				: input.row.text;
		const handle = await executor.openAttempt({
			jobId: input.jobId,
			stage: "rem-update",
			rowId: input.row.id,
			writer,
			authorization: {
				rowId: input.row.id,
				preWriteContentSha256: input.row.content_hash,
				proposedTextSha256: sha256(proposedText),
				evidenceId: `invalid-response:${input.jobId}:${writer}`,
				configurationSha256: input.configurationSha256,
			},
		});
		const resolution = await executor.mutateAttempt(handle, operation);
		await executor.closeAttempt(handle, resolution);
	}
}

function invalidWriterOperation(
	writer: RemMutationWriter,
	row: Candidate,
	successor: Candidate,
): RemWriterOperation {
	const timestamp = new Date().toISOString();
	if (writer === "moveLane") {
		return { kind: writer, targetLane: "active", reason: "invalid model response", timestamp };
	}
	if (writer === "writeTextVersion" || writer === "applyRemTextVersion") {
		return { kind: writer, replacementText: row.text, reason: "invalid model response", timestamp };
	}
	if (writer === "softClose") {
		return { kind: writer, successorId: successor.id, reason: "invalid model response", timestamp };
	}
	return { kind: writer, recoveryHandle: `invalid-response:${row.id}:${writer}` };
}

/**
 * The order key a row carries, or the order it can still be given from what it has.
 *
 * REQ-2 persists `metadata.source_order` on every row extraction writes, and the maintenance pass
 * backfills the rows written before it. Until that pass has run on a store, its rows have no key,
 * and the wave still has to order them: a row's own content time is what it has, and that is what
 * the executor compared before this change. Falling back to it keeps an unmigrated store working
 * and never lets an unkeyed row outrank a keyed one whose content time is later.
 */
function rowOrderKey(row: Pick<Candidate, "metadata" | "timestamp" | "validFromColumn">) {
	try {
		return readMemorySourceOrder(row.metadata);
	} catch {
		return {
			valid_from: row.validFromColumn ?? row.timestamp,
			session_moment: row.timestamp,
			session_ordinal: Number.NEGATIVE_INFINITY,
			global_turn_index: Number.NEGATIVE_INFINITY,
			rowid: Number.NEGATIVE_INFINITY,
		};
	}
}

function isRemRowOlder(
	candidate: Pick<Candidate, "id" | "metadata" | "timestamp" | "validFromColumn">,
	nominated: Pick<Candidate, "id" | "metadata" | "timestamp" | "validFromColumn">,
): boolean {
	const order = compareMemorySourceOrder(rowOrderKey(candidate), rowOrderKey(nominated));
	// Two rows that carry no key and share a content time tie on every field. The id is the last
	// resort and is what this executor compared before the key existed, so the order it produced
	// for such a store is unchanged.
	return order < 0 || (order === 0 && candidate.id.localeCompare(nominated.id) < 0);
}

async function runReplace(input: {
	jobId: string;
	jobType: "rem-replace";
	runtime: BatchRuntime;
	repository: RemRepository;
	candidates: readonly Candidate[];
	configuration?: RemOperationalConfiguration;
}): Promise<RemStageResult> {
	const startedAtMs = Date.now();
	let modelTokens = 0;
	const ports = createSnoStationMemRemPorts({
		database: input.runtime.database,
		llmClient: input.runtime.llm,
		memoryStore: input.runtime.store,
	});
	const configurationSha256 =
		input.configuration === undefined
			? "0".repeat(64)
			: deriveRemConfigurationSha256(input.configuration);
	const recovery = createSnoStationMemRemRecovery(input.runtime.database);
	await createSnoStationMemRemMutationExecutor({
		database: input.runtime.database,
		jobType: input.jobType,
		configurationSha256,
		liveContentionRetries: input.configuration?.retries.liveContentionRetries ?? 0,
		recovery,
	}).recoverPendingAttempts();
	const durableSoftCloseBaseline = countSuccessfulSoftCloses(input.runtime.database, input.jobId);
	for (const candidate of input.candidates) {
		if (candidate.owner !== "restate") continue;
		input.repository.appendJournal(input.jobId, input.jobType, {
			stage: `row-claim:${candidate.id}`,
			outcome: "refused",
			pairsScanned: 0,
			verdicts: 0,
			actionsApplied: 0,
			reason: "owned_by_restate",
		});
	}
	const eligible = input.candidates.filter((candidate) => candidate.owner === "verdict");
	const corpusHash = sha256(
		JSON.stringify(eligible.map((row) => [row.id, row.content_hash]).sort(compareTuple)),
	);
	const pairingConfigHash = derivePairingConfigHash(input.configuration);
	// No configuration means no owner-decided floor, cap or neighbour limit. Inventing them here is
	// what produced a wave that judged 97 unrelated pairs, so this path builds nothing instead.
	const openGeneration = input.configuration === undefined
		? undefined
		: input.repository.findOpenVerdictGeneration({ corpusSnapshotHash: corpusHash, pairingConfigHash });
	let generationId = openGeneration?.generationId;
	let indexedPairBuild: { pairs: CandidatePair[]; pairCapBinding: boolean };
	if (input.configuration === undefined) {
		indexedPairBuild = { pairs: [], pairCapBinding: false };
	} else if (generationId !== undefined) {
		const candidateById = new Map(eligible.map((candidate) => [candidate.id, candidate]));
		const storedPairs = input.repository.listVerdictPairs(generationId);
		indexedPairBuild = {
			pairs: storedPairs.flatMap((pair): CandidatePair[] => {
				const left = candidateById.get(pair.leftRowId);
				const right = candidateById.get(pair.rightRowId);
				return left && right
					? [{ pairId: pair.pairId, sortKey: pair.sortKey, left, right }]
					: [];
			}),
			pairCapBinding:
				storedPairs.filter((pair) => pair.claimState !== "done").length >
				input.configuration.budgets.maxPairs,
		};
	} else {
		indexedPairBuild = await buildIndexedPairs(
			input.runtime,
			eligible,
			input.configuration,
			input.repository,
			input.jobId,
			corpusHash,
		);
		generationId = `rem-generation-${sha256(`${input.jobId}:${corpusHash}`).slice(0, 24)}`;
		if (indexedPairBuild.pairs.length > 0) {
			const inherited = readLatestGeneration(input.runtime.database);
			input.repository.createVerdictGeneration({
				generationId,
				corpusSnapshotHash: corpusHash,
				pairingConfigHash,
				maxLlmCalls: Math.max(3, indexedPairBuild.pairs.length * 3),
				maxTokens: Math.max(8_192, indexedPairBuild.pairs.length * 3 * 8_192),
				pairs: indexedPairBuild.pairs.map((pair) => ({
					pairId: pair.pairId,
					leftRowId: pair.left.id,
					rightRowId: pair.right.id,
					sortKey: pair.sortKey,
				})),
				...(inherited === undefined ? {} : { inheritedRefusalsFromGenerationId: inherited }),
			});
		}
	}
	const indexedPairs = indexedPairBuild.pairs;
	const pairableIds = new Set(indexedPairs.flatMap((pair) => [pair.left.id, pair.right.id]));
	const claimed = eligible.flatMap((candidate) => {
		if (!pairableIds.has(candidate.id)) return [];
		const row = claimCandidate(input.repository, candidate, "verdict");
		return row ? [row] : [];
	});
	const claimedById = new Map(claimed.map((candidate) => [candidate.id, candidate]));
	const pairs = indexedPairs.flatMap((pair): CandidatePair<ClaimedCandidate>[] => {
		const left = claimedById.get(pair.left.id);
		const right = claimedById.get(pair.right.id);
		return left && right ? [{ ...pair, left, right }] : [];
	});
	const participatingRowIds = new Set(
		pairs.flatMap((pair) => [pair.left.id, pair.right.id]),
	);
	const participatingClaimed = claimed.filter((candidate) => participatingRowIds.has(candidate.id));
	for (const candidate of claimed) {
		if (!participatingRowIds.has(candidate.id)) releaseCandidate(input.repository, candidate);
	}
	if (pairs.length === 0 || generationId === undefined) {
		return {
			...journal(input.jobType, 0, 0, 0),
			measurements: {
				rowsConsidered: input.candidates.length,
				pairsBuilt: indexedPairs.length,
				pairCapBinding: indexedPairBuild.pairCapBinding,
				modelCalls: 0,
				modelTokens: 0,
				wallMs: Date.now() - startedAtMs,
			},
		};
	}
	const byId = new Map(participatingClaimed.map((candidate) => [candidate.id, candidate]));
	const invocationId = randomUUID();
	const candidatesToRelease = new Set<string>();
	const completedContentHashes = new Map<string, string>();
	const closedRowIds = new Set<string>();
	let verdicts = 0;
	let actionsApplied = 0;
	let llmCalls = 0;
	let successfulLlmCalls = 0;
	let pairsScanned = 0;
	// The reason the wave reports when every call it made failed. Without it the fatal message read
	// `REM LLM calls all failed: unknown` for a cause the loop had already named and journalled — the
	// transport succeeded and the model's answer was unparseable, which `getLastError` never sees.
	// The update path already prefers its own refusal reason for exactly this.
	let lastRefusalReason: string | undefined;
	const maxPairsThisRun = input.configuration?.budgets.maxPairs ?? pairs.length;
	for (let index = 0; index < maxPairsThisRun; index += 1) {
		let resumedVerdict: string | undefined;
		let pairClaim:
			| { pairId: string; leftRowId: string; rightRowId: string }
			| undefined;
		const abandoned = input.repository
			.listVerdictPairs(generationId)
			.find((pair) => pair.claimState === "claimed" && pair.invocationId !== null);
		if (abandoned?.invocationId) {
			const resumed = input.repository.resumeVerdictPair({
				generationId,
				pairId: abandoned.pairId,
				expectedInvocationId: abandoned.invocationId,
				invocationId,
				resumedAt: new Date().toISOString(),
				holderPid: process.pid,
			});
			if (resumed.next === "refused") break;
			pairClaim = {
				pairId: abandoned.pairId,
				leftRowId: abandoned.leftRowId,
				rightRowId: abandoned.rightRowId,
			};
			if (resumed.next === "complete") {
				pairsScanned += 1;
				const recorded = input.repository.readVerdictPair(generationId, abandoned.pairId);
				input.repository.completePair({
					generationId,
					pairId: abandoned.pairId,
					invocationId,
				});
				if (recorded.actionsApplied === 1) {
					input.repository.appendJournal(input.jobId, "rem-replace", {
						stage: `replace-pair:${abandoned.pairId}`,
						outcome: "done",
						pairsScanned: 1,
						verdicts: 1,
						actionsApplied: 1,
						pairId: abandoned.pairId,
					});
				}
				continue;
			}
			if (resumed.next === "apply_action") resumedVerdict = resumed.verdict;
		} else {
			pairClaim = input.repository.claimNextPair({
				generationId,
				invocationId,
				claimedAt: new Date().toISOString(),
				holderPid: process.pid,
			});
		}
		if (!pairClaim) break;
		pairsScanned += 1;
		const left = byId.get(pairClaim.leftRowId);
		const right = byId.get(pairClaim.rightRowId);
		if (!left || !right) {
			refusePairOutcome(
				input.repository,
				input.jobId,
				generationId,
				pairClaim.pairId,
				invocationId,
				"candidate_row_unavailable",
			);
			continue;
		}
		if (closedRowIds.has(left.id) || closedRowIds.has(right.id)) {
			refusePairOutcome(
				input.repository,
				input.jobId,
				generationId,
				pairClaim.pairId,
				invocationId,
				"row_closed_by_prior_pair",
			);
			continue;
		}
		log.info("replace_progress", {
			job_id: input.jobId,
			current: index + 1,
			total: pairs.length,
			pair_id: pairClaim.pairId,
		}, {
			event_name: "sno_station_mem.rem-batch-executor.replace.progress",
			file: "packages/sno-station-mem/src/sidecar/rem-batch-executor.ts",
			function: "runReplace",
			site_id: "rem-batch-executor.runReplace.e1e35e40e9",
		});
		const ordered = orderCandidates(left, right);
		let pairVerdict: ReturnType<typeof parseAdapterAChatVerdict>;
		if (resumedVerdict !== undefined) {
			pairVerdict = parseAdapterAChatVerdict(resumedVerdict);
		} else {
			input.repository.recordVerdictCheckpoint({
				generationId,
				pairId: pairClaim.pairId,
				invocationId,
				checkpoint: "before_llm",
				recordedAt: new Date().toISOString(),
			});
			const pairPrompt = renderAdapterAPrompt(ordered.views.older, ordered.views.newer);
			modelTokens += reserveReplaceStage(input.repository, generationId, pairClaim.pairId, invocationId, "rem-replace-pair", pairPrompt, input.jobId);
			llmCalls += 1;
			const pairText = await completeTextStage(input.runtime, "rem-replace-pair", pairPrompt);
			pairVerdict = pairText === null ? "uncertain" : parseAdapterAChatVerdict(pairText);
			const validPairResponse = pairText !== null && isValidPairVerdictResponse(pairText);
			if (validPairResponse) successfulLlmCalls += 1;
			if (pairText !== null && !validPairResponse) {
				lastRefusalReason = "model_response_invalid";
				await recordNonRefusePairDecision({
					database: input.runtime.database,
					attemptIdentity: `${generationId}:${pairClaim.pairId}:arbitration`,
					waveId: input.jobId,
					operation: "rem-replace",
					decision: "refuse",
					source: "arbitration",
					reason: "model_response_invalid",
					throughRefusePair: false,
				});
			}
		}
		verdicts += 1;
		if (resumedVerdict === undefined) {
			input.repository.recordVerdictCheckpoint({
				generationId,
				pairId: pairClaim.pairId,
				invocationId,
				checkpoint: "verdict_recorded",
				verdict: pairVerdict,
				recordedAt: new Date().toISOString(),
			});
		}
		if (pairVerdict !== "replacement") {
			if (pairVerdict === "keep") {
				candidatesToRelease.add(left.id);
				candidatesToRelease.add(right.id);
				appendPairOutcome(input.repository, input.jobId, pairClaim.pairId, "no-action", pairVerdict);
				input.repository.completePair({ generationId, pairId: pairClaim.pairId, invocationId });
			} else {
				candidatesToRelease.add(left.id);
				candidatesToRelease.add(right.id);
				refusePairOutcome(
					input.repository,
					input.jobId,
					generationId,
					pairClaim.pairId,
					invocationId,
					pairVerdict,
				);
			}
			continue;
		}
		const clauses = buildReplaceEligibleClauses(ordered.older.text, ordered.newer.text);
		const clausePrompt = renderReplaceClauseVerdictPrompt(clauses);
		modelTokens += reserveReplaceStage(input.repository, generationId, pairClaim.pairId, invocationId, "rem-replace-clauses", clausePrompt, input.jobId);
		llmCalls += 1;
		const clauseValue = await completeJsonStage(
			input.runtime,
			"rem-replace-clauses",
			clausePrompt,
		);
		const clauseVerdict = parseReplaceClauseVerdict(clauseValue, clauses);
		if (clauseVerdict.parseState === "valid") successfulLlmCalls += 1;
		const arbitration = arbitrateReplaceVerdicts(pairVerdict, clauseVerdict);
		if (arbitration.outcome !== "proceed") {
			const reason = arbitration.outcome === "no-action" ? "no_action" : arbitration.reason;
			candidatesToRelease.add(left.id);
			candidatesToRelease.add(right.id);
			refusePairOutcome(
				input.repository,
				input.jobId,
				generationId,
				pairClaim.pairId,
				invocationId,
				reason,
			);
			continue;
		}
		// An episodic pair may never close (40-rem-replace-prd.md §1: episodic resolves to the F5
		// mark, and until F5's gates pass the verdict is journaled and takes no action). Coverage
		// therefore decides nothing here, and running it first lets a coverage refusal replace the
		// verdict row that F5's calibration is accumulating.
		if (ordered.older.category === "episodic") {
			// The reason names why nothing happened, not what the model said. `"replacement"` was the
			// verdict, and a reader who found it in the journal had to already know this branch exists
			// to tell a designed no-action from a silent one. Measured 2026-08-12: this is the reason
			// on every one of the 18 replacement verdicts across six personas, and every one of them
			// is episodic — so it is the whole explanation for the close stage writing nothing.
			appendPairOutcome(
				input.repository,
				input.jobId,
				pairClaim.pairId,
				"no-action",
				"episodic_mark_not_built",
			);
			input.repository.completePair({ generationId, pairId: pairClaim.pairId, invocationId });
			continue;
		}
		const coveragePrompt = renderReplaceCoveragePrompt({
			older: ordered.older.text,
			newer: ordered.newer.text,
			retiringClauseIndices: arbitration.retiringClauseIndices,
		});
		modelTokens += reserveReplaceStage(input.repository, generationId, pairClaim.pairId, invocationId, "rem-replace-coverage", coveragePrompt, input.jobId);
		llmCalls += 1;
		const coverageValue = await completeJsonStage(
			input.runtime,
			"rem-replace-coverage",
			coveragePrompt,
		);
		const atoms = parseReplaceCoverageAtoms(coverageValue);
		if (atoms !== undefined) successfulLlmCalls += 1;
		const carrier = createRemReplaceCarrierPort({
			database: input.runtime.database,
			winnerRowId: ordered.newer.id,
			loserRowId: ordered.older.id,
			loserProjectId: ordered.older.project_id,
			loserCategory: ordered.older.category,
		});
		const coverageDecision =
			atoms === undefined
				? { decision: "refuse" as const, reason: "coverage_schema", atoms: [] }
				: await decideReplaceCoverage({
						older: ordered.older.text,
						newer: ordered.newer.text,
						retiringClauseIndices: arbitration.retiringClauseIndices,
						atoms,
						carrier,
						rawCandidateEvidence: ordered.older.raw_candidate_json ?? ordered.older.text,
					});
		const coverage = Object.freeze({
			...coverageDecision,
			pairId: pairClaim.pairId,
		});
		// A deleted gate leaves a count, or the deletion is unmeasurable. These are the conditions
		// that used to refuse here and no longer do; journalling them is what lets the next reader
		// say how often each occurred on real data instead of arguing about it.
		// Owner ruling 2026-08-13: the count is of conditions DETECTED, so a refusal is journalled
		// too. Gating on `allow` meant a condition that co-occurred with a refusal was seen and
		// then thrown away, which is the same unmeasurable state the deletion was meant to end.
		// The refusal statistics are unaffected: `topRefusalReasons` and `parseFailureCount`
		// filter `outcome === "refused"` and these rows are written `no-action`.
		if (coverage.observations !== undefined) {
			for (const observation of coverage.observations) {
				input.repository.appendJournal(input.jobId, input.jobType, {
					stage: `coverage-observation:${pairClaim.pairId}`,
					outcome: "no-action",
					pairsScanned: 0,
					verdicts: 0,
					actionsApplied: 0,
					reason:
						observation.detail === undefined
							? observation.code
							: `${observation.code}:${observation.detail}`,
					pairId: pairClaim.pairId,
				});
			}
		}
		if (coverage.decision === "refuse") {
			// `detail` names which carrier condition failed. Journalling the bare reason once cost an
			// evening of forensics on a store to learn why three correct replacements were blocked.
			const coverageReason =
				coverage.detail === undefined ? coverage.reason : `${coverage.reason}:${coverage.detail}`;
			if (atoms === undefined) {
				await recordNonRefusePairDecision({
					database: input.runtime.database,
					attemptIdentity: `${generationId}:${pairClaim.pairId}:coverage`,
					waveId: input.jobId,
					operation: "rem-replace",
					decision: "refuse",
					source: "coverage",
					reason: coverageReason,
					throughRefusePair: false,
				});
			}
			log.info("replace_coverage_refused", {
				job_id: input.jobId,
				pair_id: pairClaim.pairId,
				older_row_id: ordered.older.id,
				newer_row_id: ordered.newer.id,
				reason: coverage.reason,
				...(coverage.detail === undefined ? {} : { detail: coverage.detail }),
			}, {
				event_name: "sno_station_mem.rem-batch-executor.replace.coverage.refused",
				file: "packages/sno-station-mem/src/sidecar/rem-batch-executor.ts",
				function: "runReplace",
				site_id: "rem-batch-executor.runReplace.de3a5f3ce3",
			});
			candidatesToRelease.add(left.id);
			candidatesToRelease.add(right.id);
			refusePairOutcome(
				input.repository,
				input.jobId,
				generationId,
				pairClaim.pairId,
				invocationId,
				coverageReason,
			);
			continue;
		}
		// Carry forward before closing, never after: the close demotes every chunk of the older row to
		// the history facet, so a clause that is not already in the survivor at that moment leaves the
		// current facet and stops reaching an answer. These are the clauses no atom certified —
		// deleting the accounting refusal is what lets a short or empty atom list through, and this is
		// what keeps that deletion from costing a fact. Owner ruling 2026-08-11.
		if (
			coverage.decision === "allow" &&
			coverage.uncertifiedClauses !== undefined &&
			coverage.uncertifiedClauses.length > 0
		) {
			const carryPrompt = renderRemClauseCarryPrompt({
				judgmentSkill: REM_UPDATE_JUDGMENT_SKILL.clauseCarry,
				survivorText: ordered.newer.text,
				clauses: coverage.uncertifiedClauses,
			});
			modelTokens += reserveReplaceStage(
				input.repository,
				generationId,
				pairClaim.pairId,
				invocationId,
				"rem-replace-clause-carry",
				carryPrompt,
				input.jobId,
			);
			llmCalls += 1;
			const carryReply = await completeJsonStage(
				input.runtime,
				"rem-replace-clause-carry",
				carryPrompt,
			);
			const carryReplyText =
				typeof carryReply === "string" ? carryReply : JSON.stringify(carryReply) ?? "";
			const carryDecision = decideRemClauseCarry(
				carryReplyText,
				coverage.uncertifiedClauses.length,
			);
			if (carryDecision.outcome === "refuse") {
				const reason = "invalid_clause_carry_reply";
				lastRefusalReason = reason;
				input.repository.appendJournal(input.jobId, input.jobType, {
					stage: `carry-forward:${pairClaim.pairId}`,
					outcome: "refused",
					pairsScanned: 0,
					verdicts: 0,
					actionsApplied: 0,
					reason,
					pairId: pairClaim.pairId,
				});
				candidatesToRelease.add(left.id);
				candidatesToRelease.add(right.id);
				refusePairOutcome(
					input.repository,
					input.jobId,
					generationId,
					pairClaim.pairId,
					invocationId,
					reason,
				);
				continue;
			}
			successfulLlmCalls += 1;
			const carried = coverage.uncertifiedClauses.filter(
				(clause, index) =>
					carryDecision.alreadyCurrent[index] !== true || !ordered.newer.text.includes(clause),
			);
			if (carried.length > 0) {
				const replacementText = `${ordered.newer.text} ${carried.join(" ")}`;
				const verificationPrompt = renderRemUpdateVerificationPrompt({
					judgmentSkill: REM_UPDATE_JUDGMENT_SKILL.verification,
					source: [ordered.newer.text, ...carried].join("\n"),
					proposedCurrent: replacementText,
					retiredValues: [],
				});
				modelTokens += reserveReplaceStage(
					input.repository,
					generationId,
					pairClaim.pairId,
					invocationId,
					"rem-update-verification",
					verificationPrompt,
					input.jobId,
				);
				llmCalls += 1;
				const verificationReply = await completeJsonStage(
					input.runtime,
					"rem-update-verification",
					verificationPrompt,
				);
				const verificationReplyText =
					typeof verificationReply === "string"
						? verificationReply
						: JSON.stringify(verificationReply) ?? "";
				const verification = decideRemUpdateVerification(verificationReplyText);
				if (verification.outcome === "refuse") {
					if (verification.reason !== "model_response_invalid") successfulLlmCalls += 1;
					lastRefusalReason = verification.reason;
					input.repository.appendJournal(input.jobId, input.jobType, {
						stage: `carry-forward:${pairClaim.pairId}`,
						outcome: "refused",
						pairsScanned: 0,
						verdicts: 0,
						actionsApplied: 0,
						reason: verification.reason,
						pairId: pairClaim.pairId,
					});
					candidatesToRelease.add(left.id);
					candidatesToRelease.add(right.id);
					refusePairOutcome(
						input.repository,
						input.jobId,
						generationId,
						pairClaim.pairId,
						invocationId,
						verification.reason,
					);
					continue;
				}
				successfulLlmCalls += 1;
				const carryEvidenceId = `rem-replace:${input.jobId}:${pairClaim.pairId}:carry-forward`;
				input.runtime.database
					.prepare(
						`INSERT OR REPLACE INTO nodix_rem_write_verdicts(
							evidence_id, winner_row_id, loser_row_id, target_row_id,
							retired_fact_atoms_json, recorded_at
						) VALUES (?, ?, ?, ?, ?, ?)`,
					)
					.run(
						carryEvidenceId,
						ordered.newer.id,
						ordered.newer.id,
						ordered.newer.id,
						JSON.stringify([]),
						ports.clock.now(),
					);
				// Its own executor: the one built below is constructed with a soft-close applier bound
				// to this pair's coverage token, and this write is a text version on the SURVIVOR, a
				// different row and a different writer.
				const carryExecutor = createSnoStationMemRemMutationExecutor({
					database: input.runtime.database,
					jobType: input.jobType,
					configurationSha256,
					liveContentionRetries: input.configuration?.retries.liveContentionRetries ?? 0,
					recovery,
					applyTextVersion: (write, verification) =>
						ports.conflict.writeTextVersion({ ...write, verification }),
				});
				const carryHandle = await carryExecutor.openAttempt({
					jobId: input.jobId,
					stage: `rem-replace:${pairClaim.pairId}:carry-forward`,
					rowId: ordered.newer.id,
					writer: "writeTextVersion",
					authorization: {
						rowId: ordered.newer.id,
						preWriteContentSha256: ordered.newer.content_hash,
						proposedTextSha256: sha256(replacementText),
						evidenceId: carryEvidenceId,
						configurationSha256,
					},
				});
				const carryResolution = await carryExecutor.mutateAttempt(carryHandle, {
					kind: "writeTextVersion",
					replacementText,
					historyText: ordered.newer.text,
					idempotencyKey: carryEvidenceId,
					reason:
						"REM replacement carried older clauses no coverage atom certified into the survivor.",
					timestamp: ports.clock.now(),
				});
				const carryOutcome = await carryExecutor.closeAttempt(carryHandle, carryResolution);
				if (carryOutcome.outcome === "succeeded") {
					if (carryOutcome.postWriteContentSha256 === null) {
						throw new Error("REM carry-forward succeeded without a post-write content hash");
					}
					completedContentHashes.set(ordered.newer.id, carryOutcome.postWriteContentSha256);
					byId.set(ordered.newer.id, {
						...ordered.newer,
						text: replacementText,
						content_hash: carryOutcome.postWriteContentSha256,
					});
				}
				input.repository.appendJournal(input.jobId, input.jobType, {
					stage: `carry-forward:${pairClaim.pairId}`,
					outcome: carryOutcome.outcome === "succeeded" ? "done" : "refused",
					pairsScanned: 0,
					verdicts: 0,
					actionsApplied: 0,
					reason: `carried=${carried.length}:${carryOutcome.outcome}`,
					pairId: pairClaim.pairId,
				});
				// A close that proceeds after a failed carry-forward is the data loss this block
				// exists to prevent, so that one case keeps the pair open for the next run.
				if (carryOutcome.outcome !== "succeeded") {
					candidatesToRelease.add(left.id);
					candidatesToRelease.add(right.id);
					refusePairOutcome(
						input.repository,
						input.jobId,
						generationId,
						pairClaim.pairId,
						invocationId,
						"carry_forward_failed",
					);
					continue;
				}
			}
		}
		const coverageAllow = issueReplaceCoverageAllow(coverage);
		const retiredFactAtoms = arbitration.retiringClauseIndices.flatMap((clauseIndex) => {
			const clause = clauses[clauseIndex];
			return clause?.origin === "older" ? [clause.value] : [];
		});
		// This used to throw, which turned one pair's bad index into the death of the whole wave and
		// every persona behind it. The named clauses that do resolve are what gets retired; the ones
		// that do not are counted. Deleted as a stopping condition on the same ruling as the coverage
		// gates it sits behind — a model naming an index that is not an older clause is a prompt
		// problem to measure, not a reason to abandon work the two verdict stages both authorized.
		if (retiredFactAtoms.length !== arbitration.retiringClauseIndices.length) {
			log.info("replace_retiring_index_unresolved", {
				job_id: input.jobId,
				pair_id: pairClaim.pairId,
				named: arbitration.retiringClauseIndices.length,
				resolved: retiredFactAtoms.length,
			}, {
				event_name: "sno_station_mem.rem-batch-executor.replace.retiring.index.unresolved",
				file: "packages/sno-station-mem/src/sidecar/rem-batch-executor.ts",
				function: "runReplace",
				site_id: "rem-batch-executor.runReplace.e4be8cfe8f",
			});
		}
		const evidenceId = `rem-replace:${input.jobId}:${pairClaim.pairId}:soft-close`;
		input.runtime.database
			.prepare(
				`INSERT OR REPLACE INTO nodix_rem_write_verdicts(
					evidence_id, winner_row_id, loser_row_id, target_row_id,
					retired_fact_atoms_json, recorded_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				evidenceId,
				ordered.newer.id,
				ordered.older.id,
				ordered.older.id,
				JSON.stringify(retiredFactAtoms),
				ports.clock.now(),
			);
		let softCloseRefusalReason: string | undefined;
		const mutationExecutor = createSnoStationMemRemMutationExecutor({
			database: input.runtime.database,
			jobType: input.jobType,
			configurationSha256,
			liveContentionRetries: input.configuration?.retries.liveContentionRetries ?? 0,
			recovery,
			applySoftClose: async (write) => {
				const result = await createCoverageGatedConflictPort(ports.conflict).softClose({
					...write,
					pairId: pairClaim.pairId,
					coverageAllow,
				});
				if (!result.applied) softCloseRefusalReason = result.reason;
				return result;
			},
		});
		const handle = await mutationExecutor.openAttempt({
			jobId: input.jobId,
			stage: "rem-replace",
			rowId: ordered.older.id,
			writer: "softClose",
			authorization: {
				rowId: ordered.older.id,
				preWriteContentSha256: ordered.older.content_hash,
				proposedTextSha256: sha256(ordered.older.text),
				evidenceId,
				configurationSha256,
			},
		});
		const resolution = await mutationExecutor.mutateAttempt(handle, {
			kind: "softClose",
			successorId: ordered.newer.id,
			reason: "REM replacement judgments and whole-content coverage authorized the close.",
			timestamp: ports.clock.now(),
		});
		const outcome = await mutationExecutor.closeAttempt(handle, resolution);
		if (outcome.outcome !== "succeeded") {
			const reason = softCloseRefusalReason ?? outcome.reasonCode ?? "mutation_refused";
			candidatesToRelease.add(left.id);
			candidatesToRelease.add(right.id);
			if (reason === "content_changed" || reason === "target_changed") {
				// Through the same helper as every other refusal. This branch used to call the
				// repository directly and omit the job identity, which is why a contention refusal --
				// the case where a write was abandoned because the row moved -- was the one outcome
				// that left no ledger row.
				refusePairOutcome(
					input.repository,
					input.jobId,
					generationId,
					pairClaim.pairId,
					invocationId,
					reason,
				);
			} else {
				refusePairOutcome(
					input.repository,
					input.jobId,
					generationId,
					pairClaim.pairId,
					invocationId,
					reason,
				);
			}
			continue;
		}
		input.repository.recordVerdictCheckpoint({
			generationId,
			pairId: pairClaim.pairId,
			invocationId,
			checkpoint: "action_applied",
			recordedAt: new Date().toISOString(),
		});
		input.repository.completePair({ generationId, pairId: pairClaim.pairId, invocationId });
		if (outcome.postWriteContentSha256 === null) {
			throw new Error("REM soft-close succeeded without a post-write content hash");
		}
		completedContentHashes.set(ordered.older.id, outcome.postWriteContentSha256);
		closedRowIds.add(ordered.older.id);
		actionsApplied += 1;
		// A refused or no-action pair names itself in the journal; an applied one did not,
		// so the durable record could say a wave replaced something without saying which
		// pair. One row per pair outcome, whatever the outcome.
		input.repository.appendJournal(input.jobId, "rem-replace", {
			stage: `replace-pair:${pairClaim.pairId}`,
			outcome: "done",
			pairsScanned: 1,
			verdicts: 1,
			actionsApplied: 1,
			pairId: pairClaim.pairId,
		});
	}
	for (const candidate of participatingClaimed) {
		const modified =
			completedContentHashes.has(candidate.id) || closedRowIds.has(candidate.id);
		if (candidatesToRelease.has(candidate.id) && !modified) {
			releaseCandidate(input.repository, candidate);
		}
	}
	if (llmCalls > 0 && successfulLlmCalls === 0) {
		throw new Error(
			`REM LLM calls all failed: ${lastRefusalReason ?? input.runtime.llm.getLastError() ?? "unknown"}`,
		);
	}
	const durableActionsApplied =
		countSuccessfulSoftCloses(input.runtime.database, input.jobId) - durableSoftCloseBaseline;
	if (durableActionsApplied !== actionsApplied) {
		throw new Error(
			`REM applied count mismatch: reported=${actionsApplied} durable=${durableActionsApplied}`,
		);
	}
	const queuedRowIds = new Set(
		(input.runtime.database
			.prepare(
				`SELECT left_row_id, right_row_id FROM nodix_rem_scan_pairs
				WHERE generation_id = ? AND claim_state != 'done'`,
			)
			.all(generationId) as Array<{ left_row_id: string; right_row_id: string }>).flatMap(
			(row) => [row.left_row_id, row.right_row_id],
		),
	);
	for (const candidate of participatingClaimed) {
		const completedContentHash = completedContentHashes.get(candidate.id);
		const modified = completedContentHash !== undefined || closedRowIds.has(candidate.id);
		if ((candidatesToRelease.has(candidate.id) && !modified) || queuedRowIds.has(candidate.id)) {
			continue;
		}
		completeCandidate(
			input.repository,
			candidate,
			completedContentHash ?? candidate.content_hash,
			input.jobId,
			input.jobType,
		);
	}
	return {
		...journal(input.jobType, pairsScanned, verdicts, actionsApplied),
		measurements: {
			rowsConsidered: input.candidates.length,
			pairsBuilt: indexedPairs.length,
			pairCapBinding: indexedPairBuild.pairCapBinding,
			modelCalls: llmCalls,
			modelTokens,
			wallMs: Date.now() - startedAtMs,
		},
	};
}

function countSuccessfulSoftCloses(database: SqliteDatabaseLike, jobId: string): number {
	const row = database
		.prepare(
			`SELECT count(*) AS count FROM nodix_rem_write_attempts
			WHERE job_id = ? AND writer = 'softClose' AND outcome = 'succeeded'`,
		)
		.get(jobId) as { count: number };
	return row.count;
}

function claimCandidate(
	repository: RemRepository,
	candidate: Candidate,
	owner: "restate" | "verdict",
): ClaimedCandidate | undefined {
	const claimToken = randomUUID();
	const result = repository.claimRow({
		rowId: candidate.id,
		contentHash: candidate.content_hash,
		owner,
		claimToken,
		claimTs: new Date().toISOString(),
		holderPid: process.pid,
	});
	if (result.claimed) return { ...candidate, claimToken };
	if (result.reason !== "already_claimed") return undefined;
	const recovered = repository.recoverRowClaim({
		rowId: candidate.id,
		contentHash: candidate.content_hash,
		owner,
		expectedClaimToken: result.claimToken,
		claimToken,
		claimTs: new Date().toISOString(),
		holderPid: process.pid,
	});
	return recovered.recovered ? { ...candidate, claimToken } : undefined;
}

function completeCandidate(
	repository: RemRepository,
	candidate: ClaimedCandidate,
	currentContentHash: string,
	jobId: string,
	jobType: RemOperationType,
): void {
	const result = repository.completeRowClaim({
		rowId: candidate.id,
		contentHash: candidate.content_hash,
		currentContentHash,
		owner: candidate.owner === "restate" ? "restate" : "verdict",
		claimToken: candidate.claimToken,
		completedAt: new Date().toISOString(),
		jobId,
		jobType,
	});
	if (!result.completed) throw new Error(`REM row completion refused: ${result.reason}`);
}

function releaseCandidate(repository: RemRepository, candidate: ClaimedCandidate): void {
	const result = repository.releaseRowClaim({
		rowId: candidate.id,
		contentHash: candidate.content_hash,
		owner: candidate.owner === "restate" ? "restate" : "verdict",
		claimToken: candidate.claimToken,
	});
	if (!result.released && result.reason !== "content_changed") {
		throw new Error(`REM row release refused: ${result.reason}`);
	}
}

async function buildIndexedPairs(
	runtime: Pick<BatchRuntime, "embedder" | "store">,
	candidates: readonly Candidate[],
	configuration: RemOperationalConfiguration,
	repository: RemRepository,
	jobId: string,
	snapshotWatermark: string,
): Promise<{ pairs: CandidatePair[]; pairCapBinding: boolean }> {
	return buildRemReplaceCandidateQueue({
		candidates,
		configuration,
		repository,
		jobId,
		snapshotWatermark,
		lookup: {
			embed: (text) => runtime.embedder.embed(text),
			searchSemantic: async (vector, options) => {
				const matches = await runtime.store.searchSemantic(vector, options);
				return matches.map((match) => ({ id: match.entry.id, score: match.score }));
			},
		},
	}) as Promise<{ pairs: CandidatePair[]; pairCapBinding: boolean }>;
}

function derivePairingConfigHash(configuration: RemOperationalConfiguration | undefined): string {
	return sha256(
		JSON.stringify({
			version: "rem-pairing-v4-semantic",
			retrieval: configuration?.retrieval ?? null,
		}),
	);
}

export async function buildRemReplaceCandidateQueue(input: {
	candidates: readonly RemReplacePairCandidate[];
	configuration: RemOperationalConfiguration;
	repository: RemRepository;
	jobId: string;
	snapshotWatermark: string;
	lookup: RemReplaceCandidateLookupPort;
}): Promise<{ pairs: RemReplaceCandidatePair[]; pairCapBinding: boolean }> {
	const { candidates, configuration, repository, jobId, snapshotWatermark, lookup } = input;
	const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
	const pairs = new Map<string, RemReplaceCandidatePair>();
	for (const rows of Map.groupBy(candidates, (candidate) => candidate.canonicalAddress).values()) {
		const ordered = [...rows].sort((left, right) => left.id.localeCompare(right.id));
		for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
			for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
				const left = ordered[leftIndex];
				const right = ordered[rightIndex];
				if (left && right && left.category === right.category) {
					addCandidatePair(pairs, left, right, undefined, "address");
				}
			}
		}
	}
	for (const [index, candidate] of candidates.entries()) {
		log.info("replace_candidate_progress", {
			current: index + 1,
			total: candidates.length,
			row_id: candidate.id,
		}, {
			event_name: "sno_station_mem.rem-batch-executor.replace.candidate.progress",
			file: "packages/sno-station-mem/src/sidecar/rem-batch-executor.ts",
			function: "buildRemReplaceCandidateQueue",
			site_id: "rem-batch-executor.buildRemReplaceCandidateQueue.25aa1a67a6",
		});
		let matches: ReadonlyArray<{ id: string; score: number }>;
		try {
			const vector = await lookup.embed(candidate.text);
			matches = await lookup.searchSemantic(vector, {
				category: candidate.category,
				limit: Math.min(configuration.retrieval.neighborLimit, candidates.length),
				minScore: configuration.retrieval.similarityThreshold,
				projectIdFilter: [candidate.project_id],
			});
		} catch (error) {
			recordCandidateLookup(repository, jobId, candidate.id, "lookup-failed", {
				snapshotWatermark,
				complete: false,
				recordedAt: new Date().toISOString(),
				error: error instanceof Error ? error.message : String(error),
			});
			continue;
		}
		let found = false;
		for (const match of matches) {
			const peer = byId.get(match.id);
			if (!peer || peer.id === candidate.id || peer.category !== candidate.category) {
				continue;
			}
			found = true;
			addCandidatePair(pairs, candidate, peer, match.score, "semantic");
		}
		recordCandidateLookup(repository, jobId, candidate.id, found ? "found" : "exhaustive-none", {
			snapshotWatermark,
			complete: true,
			recordedAt: new Date().toISOString(),
		});
	}
	// A scored pair came from the neighbour search and cleared the configured floor; an unscored
	// one was proposed only because two rows share an address, and on the measured corpus that
	// branch produced 66 pairs and not one replacement verdict while the scored branch produced
	// every one. Scored pairs therefore rank first, most similar first, and sortKey breaks ties so
	// a re-run returns the same list.
	const ordered = [...pairs.values()].sort((left, right) => {
		if (left.score !== right.score) {
				if (left.score === undefined) return 1;
				if (right.score === undefined) return -1;
				return right.score - left.score;
			}
			return left.sortKey.localeCompare(right.sortKey);
		});
	return {
		// Every pair is persisted; the per-run cap is applied when pairs are claimed (PRD 40 REQ-1).
		pairs: ordered,
		pairCapBinding: ordered.length > configuration.budgets.maxPairs,
	};
}

function recordCandidateLookup(
	repository: RemRepository,
	jobId: string,
	rowId: string,
	state: "found" | "exhaustive-none" | "lookup-failed",
	detail: { snapshotWatermark: string; complete: boolean; recordedAt: string; error?: string },
): void {
	// A lookup is not an applied action, so "found" is recorded as "no-action". The alarm still
	// fires when a row claims applied work that no successful write attempt backs.
	let outcome: JournalEntry["outcome"] = "no-action";
	if (state === "lookup-failed") outcome = "refused";
	repository.appendJournal(jobId, "rem-replace", {
		stage: `candidate-lookup:${rowId}`,
		outcome,
		pairsScanned: 0,
		verdicts: 0,
		actionsApplied: 0,
		reason: state,
		detail: JSON.stringify(detail),
		rowId,
	});
}

function addCandidatePair<T extends RemReplacePairCandidate>(
	pairs: Map<string, RemReplaceCandidatePair<T>>,
	first: T,
	second: T,
	score?: number,
	source: "address" | "semantic" = "semantic",
): void {
	const [left, right] = [first, second].sort((a, b) => a.id.localeCompare(b.id));
	if (!left || !right) return;
	const addressKey = [left.canonicalAddress, right.canonicalAddress].sort().join("\u0000");
	const tier = source === "semantic" ? "1" : "2";
	const sortKey = `${tier}\u0000${addressKey}\u0000${left.id}\u0000${right.id}`;
	const pairKey = `${left.id}\u0000${right.id}`;
	const existing = pairs.get(pairKey);
	const bestScore =
		score === undefined
			? existing?.score
			: existing?.score === undefined
				? score
				: Math.max(existing.score, score);
	const selectedSortKey = existing && existing.sortKey < sortKey ? existing.sortKey : sortKey;
	pairs.set(pairKey, {
		pairId: `rem-pair-${sha256(pairKey).slice(0, 24)}`,
		sortKey: selectedSortKey,
		left,
		right,
		...(bestScore === undefined ? {} : { score: bestScore }),
	});
}

function orderCandidates(left: ClaimedCandidate, right: ClaimedCandidate): {
	older: ClaimedCandidate;
	newer: ClaimedCandidate;
	views: OrderedAdapterAPair;
} {
	const leftIsOlder =
		compareMemorySourceOrder(rowOrderKey(left), rowOrderKey(right)) < 0 ||
		(compareMemorySourceOrder(rowOrderKey(left), rowOrderKey(right)) === 0 &&
			left.id.localeCompare(right.id) < 0);
	const leftView = adapterAViewFromRecord({
		text: left.text,
		kind: left.category,
		validFrom: left.validFrom,
		assertedAt: left.timestamp,
		contentHash: left.content_hash,
	});
	const rightView = adapterAViewFromRecord({
		text: right.text,
		kind: right.category,
		validFrom: right.validFrom,
		assertedAt: right.timestamp,
		contentHash: right.content_hash,
	});
	return leftIsOlder
		? {
				older: left,
				newer: right,
				views: { older: leftView, newer: rightView, candidateRole: "newer" },
			}
		: {
				older: right,
				newer: left,
				views: { older: rightView, newer: leftView, candidateRole: "older" },
			};
}

function appendRefusal(
	repository: RemRepository,
	jobId: string,
	jobType: "rem-update",
	rowId: string,
	reason: string,
	detail?: string,
): void {
	repository.appendJournal(jobId, jobType, {
		stage: `update-row:${rowId}`,
		outcome: "refused",
		pairsScanned: 0,
		verdicts: 0,
		actionsApplied: 0,
		reason,
		...(detail === undefined ? {} : { detail }),
		rowId,
	});
}

function appendRetirementNoTarget(
	repository: RemRepository,
	jobId: string,
	nominatedRowId: string,
	candidateSetSize: number,
): void {
	repository.appendJournal(jobId, "rem-update", {
		stage: `update-retirement-target:${nominatedRowId}`,
		outcome: "no-action",
		pairsScanned: 0,
		verdicts: 1,
		actionsApplied: 0,
		reason: "no_retirement_target",
		detail: JSON.stringify({ nominatedRowId, candidateSetSize }),
		rowId: nominatedRowId,
	});
}

function appendRetirementTargetRefusal(
	repository: RemRepository,
	jobId: string,
	nominatedRowId: string,
	reason: string,
	candidateSetSize: number,
): void {
	repository.appendJournal(jobId, "rem-update", {
		stage: `update-retirement-target:${nominatedRowId}`,
		outcome: "refused",
		pairsScanned: 0,
		verdicts: 1,
		actionsApplied: 0,
		reason,
		detail: JSON.stringify({ nominatedRowId, candidateSetSize }),
		rowId: nominatedRowId,
	});
}

function appendRetirementTargetDone(
	repository: RemRepository,
	jobId: string,
	nominatedRowId: string,
	targetRowId: string,
	reason?: "cardinality_one",
): void {
	repository.appendJournal(jobId, "rem-update", {
		stage: `update-retirement-target:${nominatedRowId}`,
		outcome: "done",
		pairsScanned: 1,
		verdicts: 1,
		actionsApplied: 1,
		...(reason === undefined ? {} : { reason }),
		detail: JSON.stringify({ nominatedRowId, targetRowId }),
		rowId: nominatedRowId,
	});
}

function appendPairOutcome(
	repository: RemRepository,
	jobId: string,
	pairId: string,
	outcome: "done" | "refused" | "no-action",
	reason: string,
): void {
	repository.appendJournal(jobId, "rem-replace", {
		stage: `replace-pair:${pairId}`,
		outcome,
		pairsScanned: 1,
		verdicts: 1,
		actionsApplied: 0,
		reason,
		pairId,
	});
}

function refusePairOutcome(
	repository: RemRepository,
	jobId: string,
	generationId: string,
	pairId: string,
	invocationId: string,
	reason: string,
): void {
	repository.refusePair({
		generationId,
		pairId,
		invocationId,
		reason,
		jobId,
		jobType: "rem-replace",
	});
}

function readLatestGeneration(database: SqliteDatabaseLike): string | undefined {
	const row = database
		.prepare("SELECT generation_id FROM nodix_rem_scan_generations ORDER BY rowid DESC LIMIT 1")
		.get() as { generation_id: string } | undefined;
	return row?.generation_id;
}

// `fact_key` is deliberately not in this list. `70-rem-offline-processing-prd.md` states that
// pairing is by semantic similarity and NOT by `fact_key` equality — that is Module 4's mechanism —
// while this resolver used to consult it anyway. Measured 2026-08-12 across two persona stores
// (`dev-scripts/census-canonical-address.mts`): `fact_key` supplied ZERO addresses in
// either — 37/27/0/92 and 34/26/0/76 across topic, section_name, fact_key, idempotency_key — and
// every address shared by two or more rows came from `topic` or `section_name`. So the forbidden
// mechanism was unreachable rather than live, and removing it changes no behaviour; it buys only
// that the next reader is not misled by a path that contradicts its governing document.
function readCanonicalAddress(metadataJson: string): string | undefined {
	const metadata = parseMetadata(metadataJson);
	for (const key of ["topic", "section_name", "idempotency_key"]) {
		const value = metadata[key];
		if (typeof value === "string" && value.trim().length > 0) return `${key}:${value.trim()}`;
	}
	return undefined;
}

function readFactKey(metadataJson: string): string | undefined {
	const value = parseMetadata(metadataJson)["fact_key"];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readValidFrom(metadataJson: string, assertedAt: number): number {
	const value = parseMetadata(metadataJson)["valid_from"];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return assertedAt;
}

function readUpdateLocale(metadataJson: string): RemUpdateLocale {
	const value = parseMetadata(metadataJson)["locale"];
	return REM_UPDATE_LOCALES.find((locale) => locale === value) ?? "en";
}

function parseMetadata(value: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(value);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("REM candidate metadata must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

/**
 * The wave's summary entry. It is RETURNED, never appended here: `runRemStages` appends whatever a
 * stage returns, and a second append inside the stage put the same row in twice. Measured on all six
 * personas of the 2026-08-11 runs — every store carried four identical summary rows where two
 * belonged, so any per-wave count read from the journal was double the truth. One writer, and it is
 * the stage runner that owns the stage lifecycle.
 */
function journal(
	jobType: RemBuiltOperationType,
	pairsScanned: number,
	verdicts: number,
	actionsApplied: number,
): JournalEntry {
	return {
		stage: jobType,
		outcome: actionsApplied === 0 ? "no-action" : "done",
		pairsScanned,
		verdicts,
		actionsApplied,
	};
}

function remModelCallLabel(stage: RemModelStage): RemModelStage {
	return stage === "rem-update-retirement-target" ? "rem-update-relation-judgment" : stage;
}

async function completeTextStage(
	runtime: Pick<BatchRuntime, "llm" | "modelStageResponses">,
	stage: RemModelStage,
	prompt: string,
): Promise<string | null> {
	if (runtime.modelStageResponses !== undefined) {
		return runtime.modelStageResponses.respond({ stage, prompt });
	}
	return runtime.llm.completeText({
		prompt,
		callLabel: remModelCallLabel(stage),
		adapterSlot: stage === "rem-replace-pair" ? "conflict-adjudication" : "memory-extract",
	});
}

async function completeJsonStage(
	runtime: Pick<BatchRuntime, "llm" | "modelStageResponses">,
	stage: RemModelStage,
	prompt: string,
): Promise<unknown> {
	if (runtime.modelStageResponses === undefined) {
		return runtime.llm.completeJson<unknown>({
			prompt,
			callLabel: stage,
			adapterSlot: "memory-extract",
		});
	}
	const response = await runtime.modelStageResponses.respond({ stage, prompt });
	if (
		stage === "rem-replace-clause-carry" ||
		stage === "rem-update-judgment" ||
		stage === "rem-update-verification"
	) {
		return response;
	}
	return parseStageJson(response);
}

/**
 * Reads a stage reply the way every other JSON boundary in this app reads one.
 *
 * This used to be a bare `JSON.parse` in a try/catch. The model answers these stages correctly and
 * then wraps the answer in a markdown fence some of the time, and the bare parse threw the whole
 * reply away — `parseReplaceClauseVerdict` saw `undefined`, called it invalid, and the pair was
 * journaled as `clause_parse_failed` and released, so the memory was never updated at all.
 *
 * Measured 2026-08-27 against GPU_BASE_URL on the clause prompt for the `rem-replace-roundtrip-reopen`
 * fixture, 30 calls per ordering: with the pair ordered one way the model never fenced its reply;
 * with the pair ordered the other way it fenced 12 of 30, and every one of those 12 carried the
 * correct verdict. That is the whole of the intermittent refusal — not an empty reply, not the
 * model's judgement, and not `parseReplaceClauseVerdict` being strict.
 *
 * `readModelReplyJson` is the one shared reader every extraction path uses; this is not a
 * second implementation.
 */
function parseStageJson(response: string): unknown {
	return readModelReplyJson(response, (value) => (value === undefined ? undefined : { value }))
		?.value;
}

function isValidPairVerdictResponse(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed === "replacement" || trimmed === "keep" || trimmed === "uncertain") return true;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
		const verdict = (parsed as Record<string, unknown>)["verdict"];
		return verdict === "replacement" || verdict === "keep" || verdict === "uncertain";
	} catch {
		return false;
	}
}

function reserveReplaceStage(
	repository: RemRepository,
	generationId: string,
	pairId: string,
	invocationId: string,
	stage:
		| "rem-replace-pair"
		| "rem-replace-clause-carry"
		| "rem-replace-clauses"
		| "rem-replace-coverage"
		| "rem-update-verification",
	prompt: string,
	jobId: string,
): number {
	const reservation = repository.reserveLlmBudget({
		generationId,
		pairId,
		invocationId,
		stage,
		prompt,
		outputTokenCap: REM_MODEL_OUTPUT_TOKEN_CAP,
		countTokens,
	});
	if (reservation.status === "reserved") return reservation.tokens;
	// Accounting only. This used to refuse the pair, first against two configured ceilings and then,
	// after those were deleted, whenever the accounting itself could not be written. Failing to
	// MEASURE a call is not a reason to skip the WORK: the pair was legitimate either way, and a
	// silently dropped adjudication is the expensive outcome while a missing token count is not.
	log.warn("replace_stage_unmeasured", {
		job_id: jobId,
		pair_id: pairId,
		stage,
		reason: reservation.reason,
	}, {
		event_name: "sno_station_mem.rem-batch-executor.replace.stage.unmeasured",
		file: "packages/sno-station-mem/src/sidecar/rem-batch-executor.ts",
		function: "reserveReplaceStage",
		site_id: "rem-batch-executor.reserveReplaceStage.4e67e45fd5",
	});
	return 0;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function compareTuple(left: readonly string[], right: readonly string[]): number {
	return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
