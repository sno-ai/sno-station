/** @file atomic-extraction-reply.ts
 * @purpose Defines and recovers the one atomic extraction reply shape.
 * @boundary Reply validation only; no model calls, persistence, or post-processing judgment.
 */

import { z } from "zod";
import { calculateCalendarTime, calendarInstructionSchema, type CalendarInstruction, type CalendarResult } from "./calendar-instruction";
import { createLogger } from "@snoai/utils/logger";
import atomicExtractionSchema from "../../../config/atomic-extraction-response.schema.json" with {
	type: "json",
};
import attributeDictionary from "../../../config/attribute-dictionary.json" with { type: "json" };
import relationDictionary from "../../../config/relation-dictionary.json" with { type: "json" };
import stateVocabulary from "../../../config/state-vocabulary.json" with { type: "json" };
import { modelReplyJsonCandidates, readModelReplyJson } from "../shared/model-reply-text";
import { parseProgressTurns } from "./atomic-progress-boundary";

export type AtomicExtractionTurnRole = "system" | "user" | "assistant";

export interface AtomicExtractionTurn {
	role: AtomicExtractionTurnRole;
	content: string;
}

export type AtomicExtractionResolvedTime = CalendarResult;

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
	time: CalendarInstruction;
	endedTime: CalendarInstruction;
	/** Calculated only from a structured instruction, never from the phrase. */
	resolvedTime: AtomicExtractionResolvedTime | null;
	endsCurrent: boolean;
	/** Source evidence for the ending; `endedTime` is the instruction used for calculation. */
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

const log = createLogger("sno-station-mem:atomic-extraction-reply");
const personAttributeSlugs = new Set(attributeDictionary.slugs.map(({ slug }) => slug));
const thingAttributeSlugs = new Set(stateVocabulary.slugs.map(({ slug }) => slug));
const relationPredicates = new Set([
	...relationDictionary.relations.map(({ type }) => type),
	"MENTIONS",
]);

const relationSchema = z
	.object({
		subject: z.string().min(1),
		predicate: z.string().refine((value) => relationPredicates.has(value)),
		object: z.string().min(1),
	})
	.strip();

const wireTimeSchema = calendarInstructionSchema.catch(() => {
	log.warn("atomic extraction kept a record with an invalid time judgment", {}, {
		event_name: "memory.atomic_extraction_reply.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-extraction-reply.ts",
		function: "wireTimeSchema", site_id: "extraction.atomic-extraction-reply.invalid_time",
	});
	return { kind: "unresolved" } as const;
});

const wireRecordSchema = z
	.object({
		kind: z.enum(["occurrence", "standing"]),
		claim_text: z.string().min(1),
		subject: z.string().min(1),
		subject_kind: z.enum(["user", "agent", "named_entity", "unresolved"]),
		attribute: z.string().nullable(),
		value: z.string().min(1),
		temporal_phrase: z.string().min(1).nullable(),
		time: wireTimeSchema.optional(),
		ended_time: wireTimeSchema.optional(),
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
		}, { event_name: "memory.atomic_extraction_reply.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-extraction-reply.ts", function: "projectRecord", site_id: "extraction.atomic-extraction-reply.projectRecord.327508ac5f" });
	}
	const endedAtPhrase = record.ends_current ? (record.ended_at_phrase ?? null) : null;
	if (record.time === undefined || (record.ends_current && record.ended_time === undefined)) {
		log.warn("atomic extraction kept a record with an omitted time judgment", {
			time_missing: record.time === undefined, ending_time_missing: record.ends_current && record.ended_time === undefined,
		}, { event_name: "memory.atomic_extraction_reply.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-extraction-reply.ts", function: "projectRecord", site_id: "extraction.atomic-extraction-reply.omitted_time" });
	}
	if (!record.ends_current && (record.ended_at_phrase ?? null) !== null) {
		log.warn("atomic extraction dropped an ending time on a claim that does not end", {
			claim_length: record.claim_text.length,
		}, { event_name: "memory.atomic_extraction_reply.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-extraction-reply.ts", function: "projectRecord", site_id: "extraction.atomic-extraction-reply.projectRecord.aac5440fc2" });
	}
	const terminalTodo = record.todo === "done" || record.todo === "removed";
	const closeReason = terminalTodo ? record.close_reason : null;
	if (record.relations.length > MAX_RELATIONS) {
		log.warn("atomic extraction kept the first relations only", {
			offered: record.relations.length,
			kept: MAX_RELATIONS,
		}, { event_name: "memory.atomic_extraction_reply.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-extraction-reply.ts", function: "projectRecord", site_id: "extraction.atomic-extraction-reply.projectRecord.b92c90f285" });
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
		time: record.time ?? { kind: "unresolved" },
		endedTime: record.ends_current ? (record.ended_time ?? { kind: "unresolved" }) : { kind: "none" },
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

const captureFactSchema = wireRecordSchema.pick({
	subject: true, subject_kind: true, temporal_phrase: true, source_span: true,
}).extend({
	id: z.number().int().nonnegative(),
	fact: z.string().min(1),
	ended_at_phrase: wireRecordSchema.shape.ended_at_phrase.unwrap(),
});

const captureReplySchema = z.object({
	claims_found: z.array(z.string().min(1)),
	decisions: z.array(z.object({
		turn_index: z.number().int().nonnegative(), progress_only: z.boolean(),
	})),
	facts: z.array(captureFactSchema),
});

const enrichmentSchema = wireRecordSchema.omit({
	claim_text: true, subject: true, subject_kind: true, temporal_phrase: true,
	ended_at_phrase: true, source_span: true,
}).extend({
	id: z.number().int().nonnegative(),
	time: calendarInstructionSchema,
	ended_time: calendarInstructionSchema,
	relations: z.array(relationSchema.extend({
		predicate: z.enum(relationDictionary.relations.map(({ type }) => type)),
	})).max(MAX_RELATIONS),
});
const enrichmentReplySchema = z.object({ enrichments: z.array(enrichmentSchema) });

export interface AtomicCapturedFact {
	id: number;
	fact: string;
	subject: string;
	subject_kind: AtomicExtractionRecord["subjectKind"];
	temporal_phrase: string | null;
	ended_at_phrase: string | null;
	source_span: { turn_index: number; quote: string };
}
export const ATOMIC_CAPTURE_RESPONSE_JSON_SCHEMA: unknown = z.toJSONSchema(captureReplySchema);
export const ATOMIC_ENRICHMENT_RESPONSE_JSON_SCHEMA: unknown = z.toJSONSchema(enrichmentReplySchema);

export function parseAtomicCaptureReply(
	raw: string,
	turns: readonly AtomicExtractionTurn[],
	{ salvage = false, onReject }: { salvage?: boolean; onReject?: (gate: string) => void } = {},
): { facts: AtomicCapturedFact[]; progressTurns: ReadonlySet<number> } | undefined {
	let gate = "unreadable-json";
	const result = readModelReplyJson(raw, (value) => {
		const parsed = captureReplySchema.safeParse(value);
		if (!parsed.success) {
			if (gate === "unreadable-json") gate = "capture-schema";
			return undefined;
		}
		const { facts, claims_found } = parsed.data;
		const kept = facts.map((fact, index) => ({ ...fact, id: index }))
			.filter((fact) => fact.source_span.turn_index < turns.length);
		// Claims can merge or split into facts; reject only a nonempty inventory with no facts.
		if (claims_found.length > 0 && kept.length === 0) {
			gate = "claims-without-facts";
			return undefined;
		}
		const progressTurns = parseProgressTurns(parsed.data, turns, { salvage });
		if (progressTurns === null) {
			gate = "progress-decisions";
			return undefined;
		}
		const wrongIds = facts.filter((fact, index) => fact.id !== index).length;
		const invalidSpans = facts.filter((fact) => fact.source_span.turn_index >= turns.length).length;
		if (!salvage && (wrongIds > 0 || invalidSpans > 0)) {
			gate = wrongIds > 0 ? "fact-ids" : "source-turn-index";
			return undefined;
		}
		if (wrongIds > 0) {
			log.warn("atomic capture salvaged fact ids", { gate: 5, affected_facts: wrongIds }, {
				event_name: "memory.atomic_extraction_reply.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-extraction-reply.ts", function: "parseAtomicCaptureReply", site_id: "extraction.atomic-extraction-reply.salvage_ids",
			});
		}
		if (invalidSpans > 0) {
			log.warn("atomic capture dropped facts with invalid source turns", { gate: 6, affected_facts: invalidSpans }, {
				event_name: "memory.atomic_extraction_reply.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-extraction-reply.ts", function: "parseAtomicCaptureReply", site_id: "extraction.atomic-extraction-reply.salvage_spans",
			});
		}
		return { facts: kept, progressTurns };
	});
	if (result === undefined) onReject?.(gate);
	return result;
}

function warnUnresolvedEnrichmentTime(
	enrichment: z.infer<typeof enrichmentSchema>,
	sessionDateTime: string | undefined,
): void {
	for (const field of ["time", "ended_time"] as const) {
		const instruction = enrichment[field];
		if (instruction.kind === "none" || instruction.kind === "unresolved" ||
			calculateCalendarTime(instruction, sessionDateTime) !== null) continue;
		const missingComponents: string[] = [];
		if (instruction.kind === "absolute") {
			if (instruction.precision !== "year" && instruction.month === undefined) missingComponents.push("month");
			if (instruction.precision !== "year" && instruction.precision !== "month" &&
				instruction.day === undefined) missingComponents.push("day");
		} else if (sessionDateTime === undefined) missingComponents.push("session_date_time");
		if (instruction.hour === undefined && (instruction.minute !== undefined ||
			(instruction.precision === "minute" && instruction.kind !== "relative"))) missingComponents.push("hour");
		log.warn("atomic enrichment time could not be calculated", {
			fact_id: enrichment.id, field: { name: field }, kind: instruction.kind,
			precision: { unit: instruction.precision },
			missing_components: missingComponents.map((name) => ({ name })),
		}, { event_name: "memory.atomic_extraction_reply.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-extraction-reply.ts", function: "warnUnresolvedEnrichmentTime", site_id: "extraction.atomic-extraction-reply.unresolved_enrichment_time" });
	}
}

export function parseAtomicEnrichmentReply(
	raw: string,
	facts: readonly AtomicCapturedFact[],
	sessionDateTime?: string,
): AtomicExtractionRecord[] | undefined {
	return readModelReplyJson(raw, (value) => {
		const parsed = enrichmentReplySchema.safeParse(value);
		if (!parsed.success) return undefined;
		const byId = new Map(parsed.data.enrichments.map((entry) => [entry.id, entry]));
		if (parsed.data.enrichments.length !== facts.length || byId.size !== facts.length ||
			facts.some((fact) => !byId.has(fact.id))) return undefined;
		const records: AtomicExtractionRecord[] = [];
		for (const fact of facts) {
			const enrichment = byId.get(fact.id);
			if (enrichment === undefined) return undefined;
			warnUnresolvedEnrichmentTime(enrichment, sessionDateTime);
			records.push(projectRecord({ ...enrichment, ...fact, claim_text: fact.fact }));
		}
		return records;
	});
}

export function fallbackAtomicCapturedFact(fact: AtomicCapturedFact): AtomicExtractionRecord {
	return projectRecord({
		...fact, claim_text: fact.fact, kind: "occurrence", attribute: null, value: fact.fact,
		ends_current: false, todo: "none", close_reason: null, changes_current_state: false,
		importance: "low", single_claim: true, relations: [],
		time: { kind: "unresolved" }, ended_time: { kind: "none" },
	});
}
