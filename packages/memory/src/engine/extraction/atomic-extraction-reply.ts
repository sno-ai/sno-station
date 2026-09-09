/** @file atomic-extraction-reply.ts
 * @purpose Defines and recovers the one atomic extraction reply shape.
 * @boundary Reply validation only; no model calls, persistence, or post-processing judgment.
 */

import { z } from "zod";
import { createLogger } from "@snoai/utils/logger";
import atomicExtractionSchema from "../../config/atomic-extraction-response.schema.json" with {
	type: "json",
};
import attributeDictionary from "../../config/attribute-dictionary.json" with { type: "json" };
import relationDictionary from "../../config/relation-dictionary.json" with { type: "json" };
import stateVocabulary from "../../config/state-vocabulary.json" with { type: "json" };
import { modelReplyJsonCandidates } from "@/shared/model-reply-text";

export type AtomicExtractionTurnRole = "system" | "user" | "assistant";

export interface AtomicExtractionTurn {
	role: AtomicExtractionTurnRole;
	content: string;
}

export interface AtomicExtractionResolvedTime {
	year: number;
	month: number;
	day: number;
	hour?: number;
	minute?: number;
}

export interface AtomicExtractionSourceSpan {
	turnIndex: number;
	quote: string;
}

export interface AtomicExtractionRelation {
	subject: string;
	predicate: string;
	object: string;
}

export interface AtomicExtractionRecord {
	kind: "occurrence" | "standing";
	claimText: string;
	subject: string;
	subjectKind: "user" | "agent" | "named_entity" | "unresolved";
	attribute: string | null;
	refusedAttribute?: string;
	value: string;
	temporalPhrase: string | null;
	/** Filled by the engine from `temporalPhrase`; the model never resolves a date. */
	resolvedTime: AtomicExtractionResolvedTime | null;
	endsCurrent: boolean;
	/** The words that say when the ending happened, or null; resolved by the engine into `endedAt`. */
	endedAtPhrase: string | null;
	endedAt: AtomicExtractionResolvedTime | null;
	importance: "high" | "medium" | "low";
	changesCurrentState: boolean;
	todo: "open" | "done" | "removed" | "none";
	closeReason: string | null;
	sourceSpan: AtomicExtractionSourceSpan;
	relations: AtomicExtractionRelation[];
	singleClaim: boolean;
	atomicSanitizerMatches?: string[];
}

export type AtomicExtractionReplyResult =
	| { ok: true; records: AtomicExtractionRecord[]; malformedCandidateCount: number }
	| {
			ok: false;
			reason: "no-schema-payload";
			malformedCandidateCount: number;
	  };

const log = createLogger("mem-claw:atomic-extraction-reply");
const personAttributeSlugs = new Set(attributeDictionary.slugs.map(({ slug }) => slug));
const thingAttributeSlugs = new Set(stateVocabulary.slugs.map(({ slug }) => slug));
const relationPredicates = new Set([
	...relationDictionary.relations.map(({ type }) => type),
	"MENTIONS",
]);

// Year alone, or year and month, is a real answer ("last month", "去年"). An absent part is
const relationSchema = z
	.object({
		subject: z.string().min(1),
		predicate: z.string().refine((value) => relationPredicates.has(value)),
		object: z.string().min(1),
	})
	.strip();

const wireRecordSchema = z
	.object({
		kind: z.enum(["occurrence", "standing"]),
		claim_text: z.string().min(1),
		subject: z.string().min(1),
		subject_kind: z.enum(["user", "agent", "named_entity", "unresolved"]),
		attribute: z.string().nullable(),
		value: z.string().min(1),
		temporal_phrase: z.string().min(1).nullable(),
		ends_current: z.boolean(),
		// Optional on the wire: a reply that omits it is repaired to null rather than refused.
		ended_at_phrase: z.string().min(1).nullable().optional(),
		importance: z.enum(["high", "medium", "low"]),
		changes_current_state: z.boolean(),
		todo: z.enum(["open", "done", "removed", "none"]),
		close_reason: z.string().min(1).nullable(),
		source_span: z
			.object({ turn_index: z.number().int().nonnegative(), quote: z.string().min(1) })
			.strip(),
		relations: z.array(relationSchema),
		single_claim: z.boolean(),
	})
	// Format slips are repaired in projectRecord, never refused: a refused reply costs every
	// memory in the window a retry and then the window (measured 2026-09-05, six red cases of one
	// test file all traced to a stale field shape). Unknown keys are dropped here, and a value the
	// model has no business setting — a date, a fourth relation, a close reason on an open to-do —
	// is normalized below.
	.strip();

const envelopeSchema = z.object({ records: z.array(wireRecordSchema) }).strip();
const arraySchema = z.array(wireRecordSchema);

const MAX_RELATIONS = 3;

function projectRecord(record: z.infer<typeof wireRecordSchema>): AtomicExtractionRecord {
	const allowedAttributes =
		record.subject_kind === "user"
			? personAttributeSlugs
			: record.subject_kind === "named_entity" || record.subject_kind === "unresolved"
				? thingAttributeSlugs
				: undefined;
	// Case and surrounding whitespace are not meaning; the list is lower-case throughout.
	const offeredAttribute = record.attribute === null ? null : record.attribute.trim().toLowerCase();
	const attribute =
		offeredAttribute !== null && allowedAttributes?.has(offeredAttribute) ? offeredAttribute : null;
	if (offeredAttribute !== null && attribute === null) {
		log.warn("atomic extraction attribute stored unkeyed", {
			attribute_length: offeredAttribute.length,
			subjectKind: record.subject_kind,
		}, { event_name: "memory.atomic_extraction_reply.diagnostic", file: "apps/mem-claw/src/extraction/atomic-extraction-reply.ts", function: "projectRecord", site_id: "extraction.atomic-extraction-reply.projectRecord.327508ac5f" });
	}
	const endedAtPhrase = record.ends_current ? (record.ended_at_phrase ?? null) : null;
	if (!record.ends_current && (record.ended_at_phrase ?? null) !== null) {
		log.warn("atomic extraction dropped an ending time on a claim that does not end", {
			claim_length: record.claim_text.length,
		}, { event_name: "memory.atomic_extraction_reply.diagnostic", file: "apps/mem-claw/src/extraction/atomic-extraction-reply.ts", function: "projectRecord", site_id: "extraction.atomic-extraction-reply.projectRecord.aac5440fc2" });
	}
	const terminalTodo = record.todo === "done" || record.todo === "removed";
	const closeReason = terminalTodo ? record.close_reason : null;
	if (record.relations.length > MAX_RELATIONS) {
		log.warn("atomic extraction kept the first relations only", {
			offered: record.relations.length,
			kept: MAX_RELATIONS,
		}, { event_name: "memory.atomic_extraction_reply.diagnostic", file: "apps/mem-claw/src/extraction/atomic-extraction-reply.ts", function: "projectRecord", site_id: "extraction.atomic-extraction-reply.projectRecord.b92c90f285" });
	}
	return {
		kind: record.kind,
		claimText: record.claim_text,
		subject: record.subject,
		subjectKind: record.subject_kind,
		attribute,
		...(offeredAttribute !== null && attribute === null
			? { refusedAttribute: offeredAttribute }
			: {}),
		value: record.value,
		temporalPhrase: record.temporal_phrase,
		resolvedTime: null,
		endsCurrent: record.ends_current,
		endedAtPhrase,
		endedAt: null,
		importance: record.importance,
		changesCurrentState: record.changes_current_state,
		todo: record.todo,
		closeReason,
		sourceSpan: {
			turnIndex: record.source_span.turn_index,
			quote: record.source_span.quote,
		},
		relations: record.relations.slice(0, MAX_RELATIONS),
		singleClaim: record.single_claim,
	};
}

function validatePayload(value: unknown, turnCount: number): AtomicExtractionRecord[] | undefined {
	let records: z.infer<typeof wireRecordSchema>[];
	if (Array.isArray(value)) {
		const parsed = arraySchema.safeParse(value);
		if (!parsed.success) return undefined;
		records = parsed.data;
	} else {
		const parsed = envelopeSchema.safeParse(value);
		if (!parsed.success) return undefined;
		records = parsed.data.records;
	}
	if (records.some((record) => record.source_span.turn_index >= turnCount)) return undefined;
	return records.map(projectRecord);
}

function parsePayload(text: string, turnCount: number): AtomicExtractionRecord[] | undefined {
	try {
		return validatePayload(JSON.parse(text), turnCount);
	} catch {
		return undefined;
	}
}

/**
 * Reads the one reply shape out of whatever the model wrapped it in.
 *
 * Candidate order and think-stripping belong to `modelReplyJsonCandidates`; the schema decision
 * stays here. The first candidate this file admits wins — the previous rule discarded a reply
 * whenever two candidates validated, which cost real memories every time the model wrote its
 * reasoning as prose before the payload (measured 2026-09-04 on the live Memora run).
 */
export function parseAtomicExtractionReply(
	raw: string,
	turnCount: number,
): AtomicExtractionReplyResult {
	let malformedCandidateCount = 0;
	for (const candidate of modelReplyJsonCandidates(raw)) {
		const records = parsePayload(candidate, turnCount);
		if (records) return { ok: true, records, malformedCandidateCount };
		malformedCandidateCount += 1;
	}
	return { ok: false, reason: "no-schema-payload", malformedCandidateCount };
}

export const ATOMIC_EXTRACTION_RESPONSE_JSON_SCHEMA: unknown = atomicExtractionSchema;
