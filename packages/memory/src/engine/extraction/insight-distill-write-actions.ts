/** @file insight-distill-write-actions.ts
 * @purpose Persist non-merge Insight Distill outcomes.
 * @boundary Store mutations for create/support/contextualize/contradict only.
 */

import { validateExtractedContentForStorage } from "@snoai/content-sanitizer";
import { createLogger } from "@snoai/utils/logger";
import { buildIndexedText } from "./extraction-text-sanitizer";
import {
	unresolvedMemoryDate,
	resolveMemoryDate,
	type DateResolutionResult,
} from "./date-resolution";
import {
	appendRelation,
	buildInsightMetadata,
	parseInsightMetadata,
	parseSupportInfo,
	stringifyInsightMetadata,
	updateSupportStats,
} from "./memory-metadata-codec";
import type { MemoryRelation } from "./memory-metadata-types";
import {
	parseSessionTimestamp,
	serializeIntervalMetadata,
} from "./memory-temporality-classifier";
import type {
	CandidateExtractionTrace,
	CandidateMemory,
	CandidateRelation,
	MemoryEntry,
	MemoryCategory,
} from "../shared/types";
import type { LlmClient } from "../../model/llm-client";
import type { LlmRoutingConfig } from "../../../config/plugin-config-mode-schema";
import { stableHash } from "../shared/utils";
import type {
	MemoryStore,
	StoreInput,
} from "../../store/store";

const log = createLogger("sno-station-mem:insight-distill");

function candidateRelationsToMemoryRelations(
	rels: CandidateRelation[] | undefined,
): MemoryRelation[] | undefined {
	if (!rels || rels.length === 0) return undefined;
	return rels.map((r) => ({
		type: r.type,
		targetId: r.target,
		...(r.source ? { source: r.source } : {}),
	}));
}

/**
 * DECISION-LOCK §6/§7 category gates, enforced at the write layer so callers
 * that hand-build `CandidateMemory` cannot bypass the parser's restrictions:
 * - `event_at` only on `episodic`
 * - `entity_kind` only on `episodic`
 * - candidate-supplied `relations` only on `episodic`
 */
function gatedCandidateRelations(candidate: CandidateMemory): MemoryRelation[] | undefined {
	if (candidate.category !== "episodic") {
		return undefined;
	}
	return candidateRelationsToMemoryRelations(candidate.relations);
}

export function buildCandidateTemporalMetadata(params: {
	candidate: CandidateMemory;
	sessionDateTime?: string;
	sessionTimezone?: string;
}): ReturnType<typeof serializeIntervalMetadata> {
	const text = params.candidate.content || params.candidate.abstract;
	const interval = unresolvedMemoryDate({
		text,
		expression: params.candidate.temporalPhrase,
		sessionDateTime: params.sessionDateTime,
		sessionTimezone: params.sessionTimezone,
	}).interval;
	const metadata = serializeIntervalMetadata(params.candidate.category, interval);
	if (params.candidate.temporalPhrase) {
		metadata.temporal_phrase = params.candidate.temporalPhrase;
	}
	return metadata;
}

type DateResolutionParams = {
	candidate: CandidateMemory;
	sessionDateTime?: string;
	sessionTimezone?: string;
	llm?: LlmClient;
	routing?: LlmRoutingConfig;
};

async function resolveCandidateDate(params: DateResolutionParams): Promise<DateResolutionResult> {
	return resolveMemoryDate({
		text: params.candidate.content || params.candidate.abstract,
		expression: params.candidate.temporalPhrase,
		sessionDateTime: params.sessionDateTime,
		sessionTimezone: params.sessionTimezone,
		llm: params.llm,
		routing: params.routing,
	});
}

function timestampFields(
	resolution: DateResolutionResult,
	sessionDateTimeValue: string | undefined,
): { timestamp?: number; timezone: string } {
	// The row timestamp is the memory's AGE and always comes from the session. The resolved
	// instant from the content's own date phrase used to be written here instead, which turned a
	// fact ABOUT an old date into an OLD memory: measured 2026-08-30, a detail taught today
	// carrying a 47-day-old support date was rank 1 after fusion and after the cross-encoder,
	// fell to rank 70 of 83 under time decay, missed the top-20 prompt slice, and the model
	// invented today's date in its place. A content date is the fact's identity, not the
	// memory's age; it is already carried by `event_at`, `valid_from`, `valid_until` and
	// `temporal_phrase` in the metadata patch, where recall can read it without decaying it.
	return {
		...sessionTimestampField(sessionDateTimeValue),
		timezone: resolution.timezone,
	};
}

function normalizeIdempotencyString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function normalizeIdempotencyStringArray(value: string[] | undefined): string[] | undefined {
	const normalized = value
		?.map((item) => item.trim())
		.filter((item) => item.length > 0);
	return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizedRelationsForIdempotency(
	relations: CandidateRelation[] | undefined,
): Array<{ source?: string; target: string; type: string }> | undefined {
	const normalized = relations
		?.map((relation) => ({
			type: relation.type.trim(),
			target: relation.target.trim(),
			...(relation.source?.trim() ? { source: relation.source.trim() } : {}),
		}))
		.filter((relation) => relation.type && relation.target)
		.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
	return normalized && normalized.length > 0 ? normalized : undefined;
}

/**
 * What makes two extracted rows the SAME memory: everything the model said about the claim,
 * and nothing about where or when it was extracted. Session key and chunk trace are excluded
 * on purpose — they are the write's identity, not the content's, and folding them in is what
 * let one sentence be stored three times from three chunks of the same conversation.
 */
export function buildCandidatePayloadFingerprint(candidate: CandidateMemory): string {
	return stableHash(
		JSON.stringify({
			category: candidate.category,
			abstract: normalizeIdempotencyString(candidate.abstract),
			overview: normalizeIdempotencyString(candidate.overview),
			content: normalizeIdempotencyString(candidate.content),
			sectionName: normalizeIdempotencyString(candidate.sectionName),
			rawTopicPhrase: normalizeIdempotencyString(candidate.rawTopicPhrase),
			antiPatternSignature: normalizeIdempotencyString(candidate.antiPatternSignature),
			childrenIds: normalizeIdempotencyStringArray(candidate.childrenIds),
			eventAt: normalizeIdempotencyString(candidate.eventAt),
			temporalPhrase: normalizeIdempotencyString(candidate.temporalPhrase),
			entityKind: normalizeIdempotencyString(candidate.entityKind),
			relations: normalizedRelationsForIdempotency(candidate.relations),
		}),
	);
}

export function buildExtractionIdempotencyKey(
	sessionKey: string | undefined,
	candidate: CandidateMemory,
	trace: CandidateExtractionTrace | undefined = candidate.extractionTrace,
): string | undefined {
	if (!sessionKey || !trace) return undefined;
	return stableHash(
		JSON.stringify({
			v: 4,
			sessionKey,
			trace: {
				source: trace.source,
				chunkIndex: trace.chunkIndex,
				candidateIndex: trace.candidateIndex,
			},
			payloadFingerprint: buildCandidatePayloadFingerprint(candidate),
		}),
	);
}

export function buildExtractionReplayKey(
	sessionKey: string,
	candidate: CandidateMemory,
	replayIdentity?: string,
): string {
	const extractionKey = buildExtractionIdempotencyKey(sessionKey, candidate);
	if (extractionKey) return extractionKey;
	const normalizedIdentity = normalizeIdempotencyString(replayIdentity);
	if (!normalizedIdentity) {
		throw new Error("candidate-processor: missing extraction trace or explicit replay identity");
	}
	return stableHash(
		JSON.stringify({
			v: 1,
			sessionKey,
			replayIdentity: normalizedIdentity,
			payloadFingerprint: buildCandidatePayloadFingerprint(candidate),
		}),
	);
}

export function candidateForwardCompatPatch(
	candidate: CandidateMemory,
	options: {
		sessionKey?: string;
		baseRelations?: MemoryRelation[];
		trailingRelations?: MemoryRelation[];
	} = {},
): {
	event_at?: string;
	entity_kind?: string;
	relations?: MemoryRelation[];
	extraction_source?: CandidateExtractionTrace["source"];
	extraction_chunk_index?: number;
	extraction_chunk_count?: number;
	extraction_start_offset?: number;
	extraction_end_offset?: number;
	extraction_token_count?: number;
	extraction_content_type?: CandidateExtractionTrace["contentType"];
	extraction_chunking_version?: string;
	extraction_candidate_index?: number;
	idempotency_key?: string;
	content_identity_key?: string;
	rawTopicPhrase?: string;
} {
	const patch: {
		event_at?: string;
		entity_kind?: string;
		relations?: MemoryRelation[];
		extraction_source?: CandidateExtractionTrace["source"];
		extraction_chunk_index?: number;
		extraction_chunk_count?: number;
		extraction_start_offset?: number;
		extraction_end_offset?: number;
		extraction_token_count?: number;
		extraction_content_type?: CandidateExtractionTrace["contentType"];
		extraction_chunking_version?: string;
		extraction_candidate_index?: number;
		idempotency_key?: string;
		content_identity_key?: string;
		rawTopicPhrase?: string;
	} = {};
	if (candidate.category === "profile" && candidate.rawTopicPhrase) {
		patch.rawTopicPhrase = candidate.rawTopicPhrase;
	}
	if (candidate.eventAt && candidate.category === "episodic") {
		patch.event_at = candidate.eventAt;
	}
	if (candidate.entityKind && candidate.category === "episodic") {
		patch.entity_kind = candidate.entityKind;
	}
	let relations = options.baseRelations ? [...options.baseRelations] : [];
	for (const relation of gatedCandidateRelations(candidate) ?? []) {
		relations = appendRelation(relations, relation);
	}
	for (const relation of options.trailingRelations ?? []) {
		relations = appendRelation(relations, relation);
	}
	if (relations.length > 0) patch.relations = relations;
	if (candidate.extractionTrace && options.sessionKey) {
		patch.extraction_source = candidate.extractionTrace.source;
		patch.extraction_chunk_index = candidate.extractionTrace.chunkIndex;
		patch.extraction_chunk_count = candidate.extractionTrace.chunkCount;
		patch.extraction_start_offset = candidate.extractionTrace.startOffset;
		patch.extraction_end_offset = candidate.extractionTrace.endOffset;
		patch.extraction_token_count = candidate.extractionTrace.tokenCount;
		patch.extraction_content_type = candidate.extractionTrace.contentType;
		patch.extraction_chunking_version = candidate.extractionTrace.chunkingVersion;
		patch.extraction_candidate_index = candidate.extractionTrace.candidateIndex;
		const idempotencyKey = buildExtractionIdempotencyKey(options.sessionKey, candidate);
		if (idempotencyKey) patch.idempotency_key = idempotencyKey;
		// The two identities are written side by side and answer different questions. The key
		// above says "this exact write already happened, do not repeat it"; the fingerprint says
		// "this is the same memory", and the store hashes the row's content against it. Two
		// separate events keep separate rows because their event time and relations are part of
		// the fingerprint — the settled append-only ruling — while one sentence extracted twice
		// from two chunks of the same conversation collapses to one row.
		patch.content_identity_key = buildCandidatePayloadFingerprint(candidate);
	}
	return patch;
}

export function candidateStructuredMetadataPatch(candidate: CandidateMemory): {
	section_name?: string;
	anti_pattern_signature?: string;
	children_ids?: string[];
	depth?: number;
} {
	const patch: {
		section_name?: string;
		anti_pattern_signature?: string;
		children_ids?: string[];
		depth?: number;
	} = {};
	// A refused episodic fallback keeps the profile address that a later retraction must match.
	if (
		(candidate.category === "profile" ||
			candidate.category === "persona" ||
			(candidate.category === "episodic" && candidate.dispositionReason)) &&
		candidate.sectionName
	) {
		patch.section_name = candidate.sectionName;
	}
	if (candidate.category === "lesson" && candidate.antiPatternSignature) {
		patch.anti_pattern_signature = candidate.antiPatternSignature;
	}
	return patch;
}

/**
 * The 14-field common core every new `working`-tier memory shares. Returned as
 * a plain object so each write site can splice its site-only tail fields and
 * the two trailing spreads (`buildCandidateTemporalMetadata`,
 * `candidateForwardCompatPatch`) after it, in that fixed order.
 */
export function newWorkingMemoryFields(params: {
	candidate: CandidateMemory;
	sessionKey: string;
}): {
	l0_abstract: string;
	l1_overview: string;
	l2_content: string;
	memory_category: MemoryCategory;
	tier: "working";
	access_count: 0;
	confidence: 0.7;
	source_session: string;
	source: "ambient-learning";
	state: "confirmed";
	injected_count: 0;
	bad_recall_count: 0;
	suppressed_until_turn: 0;
} {
	// `asserted_at` is deliberately NOT set here: it must anchor to the session
	// time, which the codec supplies as the default from the entry timestamp
	// (threaded via `sessionTimestampField` at every write site). Setting it to a
	// wall clock here would collapse a replayed/simulated timeline onto ingest time.
	return {
		l0_abstract: params.candidate.abstract,
		l1_overview: params.candidate.overview,
		l2_content: params.candidate.content,
		memory_category: params.candidate.category,
		tier: "working",
		access_count: 0,
		confidence: 0.7,
		source_session: params.sessionKey,
		source: "ambient-learning",
		state: "confirmed",
		injected_count: 0,
		bad_recall_count: 0,
		suppressed_until_turn: 0,
	};
}

export function getDefaultImportance(category: MemoryCategory): number {
	switch (category) {
		case "profile":
			return 0.85;
		case "persona":
			return 0.9;
		case "episodic":
			return 0.7;
		case "lesson":
			return 0.85;
		default:
			return 0.5;
	}
}

export function sanitizeCandidateForStorage(candidate: CandidateMemory): CandidateMemory {
	const result = validateExtractedContentForStorage(candidate as unknown as Record<string, unknown>);
	if (!result.ok) {
		throw new Error(`candidate rejected by content sanitizer: ${result.reason}`);
	}
	return result.value as unknown as CandidateMemory;
}

/**
 * The optional `timestamp` slice of a new memory's `StoreInput`. When the
 * ingest session carries an authoritative date, every memory it produces is
 * stamped with that event time instead of the wall-clock write time. Without
 * it a replayed historical session — a benchmark corpus, an imported chat log —
 * collapses every memory onto ingest time, silently defeating recency ranking
 * and the stale-memory forgetting pass. Returns `{}` when the session has no
 * known date, leaving the persistence layer's `Date.now()` default in place.
 */
export function sessionTimestampField(sessionDateTime: string | undefined): {
	timestamp?: number;
} {
	const ts = parseSessionTimestamp(sessionDateTime);
	if (ts !== undefined) return { timestamp: ts };
	// A session that HAS a date and cannot be parsed is not the same as a session with no date,
	// and the two used to be indistinguishable here. The memory is still written — nothing is lost
	// for a bad timestamp — but it lands stamped with the write time, which on a replayed corpus
	// or an imported chat log silently rewrites history as "just now" and defeats both recency
	// ranking and the stale-memory pass. Loud, because the failure is otherwise invisible.
	if (sessionDateTime !== undefined && sessionDateTime.trim() !== "") {
		log.error("session date could not be parsed; memory will be stamped with the write time", {
			sessionDateTime,
		}, {
			event_name: "sno_station_mem.insight-distill-write-actions.session.date.could.not.be.parsed.memory.will.be.stamped.with.the.write",
			file: "packages/sno-station-mem/src/engine/extraction/insight-distill-write-actions.ts",
			function: "sessionTimestampField",
			site_id: "insight-distill-write-actions.sessionTimestampField.29d4b22da7",
		});
	}
	return {};
}

export interface StoreCandidateResult {
	entry: MemoryEntry;
	created: boolean;
}

function readStoreWriteOutcome(entry: MemoryEntry): "created" | "existing" {
	if (!("storeWriteOutcome" in entry)) {
		throw new Error("memory write did not report its outcome");
	}
	const outcome = entry.storeWriteOutcome;
	if (outcome === "created" || outcome === "existing") return outcome;
	throw new Error("memory write reported an invalid outcome");
}

function candidateStoreInput(
	params: {
		candidate: CandidateMemory;
		vector: Float32Array;
		sessionKey: string;
		targetScope: string;
		sessionDateTime?: string;
		sessionTimezone?: string;
	},
	resolution: DateResolutionResult,
	metadataPatch: Record<string, unknown> = {},
): StoreInput {
	return {
		text: buildIndexedText(params.candidate.abstract, params.candidate.content),
		vector: params.vector,
		category: params.candidate.category,
		projectId: params.targetScope,
		importance: getDefaultImportance(params.candidate.category),
		metadata: stringifyInsightMetadata(
			buildInsightMetadata(
				{
					text: params.candidate.abstract,
					category: params.candidate.category,
					...sessionTimestampField(params.sessionDateTime),
				},
				{
					...newWorkingMemoryFields(params),
					...candidateStructuredMetadataPatch(params.candidate),
					...serializeIntervalMetadata(params.candidate.category, resolution.interval),
					...candidateForwardCompatPatch(params.candidate, {
						sessionKey: params.sessionKey,
					}),
					...metadataPatch,
				},
			),
		),
		...(params.candidate.dispositionReason
			? {
					rawCandidateJson: params.candidate.rawCandidateJson,
					dispositionReason: params.candidate.dispositionReason,
				}
			: {}),
		// No lane field: fallback rows are active episodic memories. Their classification
		// verdict remains in the dedicated disposition column for audit.
		...timestampFields(resolution, params.sessionDateTime),
	};
}

export async function storeCandidate(params: {
	store: MemoryStore;
	candidate: CandidateMemory;
	vector: Float32Array;
	sessionKey: string;
	targetScope: string;
	sessionDateTime?: string;
	sessionTimezone?: string;
	llm?: LlmClient;
	routing?: LlmRoutingConfig;
}): Promise<StoreCandidateResult> {
	const candidate = sanitizeCandidateForStorage(params.candidate);
	const safeParams = { ...params, candidate };
	const resolution = await resolveCandidateDate(safeParams);
	const entry = await params.store.store(candidateStoreInput(safeParams, resolution));
	const created = readStoreWriteOutcome(entry) === "created";
	if (created) {
		log.info("created memory", {
			category: candidate.category,
			memory_id: entry.id,
			abstract_length: candidate.abstract.length,
		}, {
			event_name: "sno_station_mem.insight-distill-write-actions.created.memory",
			file: "packages/sno-station-mem/src/engine/extraction/insight-distill-write-actions.ts",
			function: "storeCandidate",
			site_id: "insight-distill-write-actions.storeCandidate.138415ce64",
		});
	} else {
		log.debug("skipping already persisted extraction candidate after store", {
			category: candidate.category,
			memory_id: entry.id,
		}, {
			event_name: "sno_station_mem.insight-distill-write-actions.skipping.already.persisted.extraction.candidate.after.store",
			file: "packages/sno-station-mem/src/engine/extraction/insight-distill-write-actions.ts",
			function: "storeCandidate",
			site_id: "insight-distill-write-actions.storeCandidate.6754f6ee4b",
		});
	}
	return { entry, created };
}

export async function handleSupport(params: {
	store: MemoryStore;
	matchId: string;
	reason: string;
	contextLabel?: string;
	sessionDateTime?: string;
}): Promise<void> {
	const existing = params.store.getById(params.matchId);
	if (!existing) return;

	const meta = parseInsightMetadata(existing.metadata, existing);
	const supportInfo = parseSupportInfo(meta.support_info);
	meta.support_info = updateSupportStats(
		supportInfo,
		params.contextLabel,
		"support",
		parseSessionTimestamp(params.sessionDateTime),
	);

	await params.store.update(params.matchId, {
		metadata: stringifyInsightMetadata(meta),
	});

	log.info("support recorded", {
		memory_id: params.matchId,
		model_reason_length: params.reason?.length ?? 0,
		outcome: "success",
	}, {
		event_name: "sno_station_mem.insight-distill-write-actions.support.recorded",
		file: "packages/sno-station-mem/src/engine/extraction/insight-distill-write-actions.ts",
		function: "handleSupport",
		site_id: "insight-distill-write-actions.handleSupport.c98c47eeb9",
	});
}

export async function handleContextualize(params: {
	store: MemoryStore;
	candidate: CandidateMemory;
	vector: Float32Array;
	matchId: string;
	sessionKey: string;
	targetScope: string;
	sessionDateTime?: string;
	sessionTimezone?: string;
	contextLabel?: string;
	llm?: LlmClient;
	routing?: LlmRoutingConfig;
}): Promise<void> {
	const candidate = sanitizeCandidateForStorage(params.candidate);
	const safeParams = { ...params, candidate };
	const resolution = await resolveCandidateDate(safeParams);
	const metadata = stringifyInsightMetadata(
		buildInsightMetadata(
			{
				text: candidate.abstract,
				category: candidate.category,
				// Keep assertion chronology at the session time. The interval fields
				// below carry the date discussed by the memory.
				...sessionTimestampField(params.sessionDateTime),
			},
			{
				...newWorkingMemoryFields(safeParams),
				contexts: params.contextLabel ? [params.contextLabel] : [],
				...candidateStructuredMetadataPatch(candidate),
				...serializeIntervalMetadata(candidate.category, resolution.interval),
				...candidateForwardCompatPatch(candidate, {
					sessionKey: params.sessionKey,
					trailingRelations: [{ type: "contextualizes", targetId: params.matchId }],
				}),
			},
		),
	);

	await params.store.store({
		text: buildIndexedText(candidate.abstract, candidate.content),
		vector: params.vector,
		category: candidate.category,
		projectId: params.targetScope,
		importance: getDefaultImportance(candidate.category),
		metadata,
		...timestampFields(resolution, params.sessionDateTime),
	});

	log.info("contextualize created", {
		memory_id: params.matchId,
		outcome: "success",
	}, {
		event_name: "sno_station_mem.insight-distill-write-actions.contextualize.created",
		file: "packages/sno-station-mem/src/engine/extraction/insight-distill-write-actions.ts",
		function: "handleContextualize",
		site_id: "insight-distill-write-actions.handleContextualize.bd66df2159",
	});
}

export async function handleContradict(params: {
	store: MemoryStore;
	candidate: CandidateMemory;
	vector: Float32Array;
	matchId: string;
	sessionKey: string;
	targetScope: string;
	sessionDateTime?: string;
	sessionTimezone?: string;
	contextLabel?: string;
	llm?: LlmClient;
	routing?: LlmRoutingConfig;
}): Promise<void> {
	const candidate = sanitizeCandidateForStorage(params.candidate);
	const safeParams = { ...params, candidate };
	const existing = params.store.getById(params.matchId);
	if (!existing) {
		await storeCandidate(safeParams);
		return;
	}
	const resolution = await resolveCandidateDate(safeParams);

	const metadata = stringifyInsightMetadata(
		buildInsightMetadata(
			{
				text: candidate.abstract,
				category: candidate.category,
				// Keep assertion chronology at the session time. The interval fields
				// below carry the date discussed by the memory.
				...sessionTimestampField(params.sessionDateTime),
			},
			{
				...newWorkingMemoryFields(safeParams),
				contexts: params.contextLabel ? [params.contextLabel] : [],
				...candidateStructuredMetadataPatch(candidate),
				...serializeIntervalMetadata(candidate.category, resolution.interval),
				...candidateForwardCompatPatch(candidate, {
					sessionKey: params.sessionKey,
					trailingRelations: [{ type: "contradicts", targetId: params.matchId }],
				}),
			},
		),
	);

	await params.store.store({
		text: buildIndexedText(candidate.abstract, candidate.content),
		vector: params.vector,
		category: candidate.category,
		projectId: params.targetScope,
		importance: getDefaultImportance(candidate.category),
		metadata,
		...timestampFields(resolution, params.sessionDateTime),
	});

	const meta = parseInsightMetadata(existing.metadata, existing);
	const supportInfo = parseSupportInfo(meta.support_info);
	meta.support_info = updateSupportStats(
		supportInfo,
		params.contextLabel,
		"contradict",
		parseSessionTimestamp(params.sessionDateTime),
	);
	await params.store.update(params.matchId, {
		metadata: stringifyInsightMetadata(meta),
	});

	log.info("contradict recorded", {
		memory_id: params.matchId,
		outcome: "success",
	}, {
		event_name: "sno_station_mem.insight-distill-write-actions.contradict.recorded",
		file: "packages/sno-station-mem/src/engine/extraction/insight-distill-write-actions.ts",
		function: "handleContradict",
		site_id: "insight-distill-write-actions.handleContradict.c6164031da",
	});
}
