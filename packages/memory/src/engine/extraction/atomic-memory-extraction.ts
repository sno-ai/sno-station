import { excludeProgressRecords } from "./atomic-progress-boundary";
import { FIXED_MEMORY_SNO_EXTRACT_CHAT, FIXED_MEMORY_SNO_EXTRACT_PROFILE } from "../../model/signed-registry-constants";
import { ATOMIC_CAPTURE_OUTPUT_TOKEN_BUDGET, ATOMIC_EXTRACTION_MAX_INPUT_TOKENS, DEFAULT_MAX_CONTEXT_TOKENS } from "../../../config/index";
/** @file atomic-memory-extraction.ts
 * @purpose Runs the complete dark atomic extraction path through its one storage door.
 * @boundary Product entrypoint; callers supply chunk identity, routing snapshot, and idempotency.
 */

import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createLogger, privateLogReference, currentLogContext, withLogContext } from "@snoai/utils/logger";
import { z } from "zod";
import { countTokens } from "@snoai/chunking";
import {
	decideRemRetirementTargetFromReply,
	renderRemRetirementTargetPrompt,
} from "../rem/index.js";
import attributeDictionary from "../../../config/attribute-dictionary.json" with { type: "json" };
import stateVocabulary from "../../../config/state-vocabulary.json" with { type: "json" };

import {
	createBProfileKeyingTransport,
	runAtomicProfileKeying,
	type AtomicKeyedRecord,
	type AtomicProfileKeyingTransport,
} from "./atomic-profile-keying";
import {
	type AtomicGauntletRecord,
	runAtomicExtractionGauntlet,
	type AtomicResplitTransport,
} from "./atomic-extraction-gauntlet";
import {
	type AtomicExtractionRecord,
	type AtomicExtractionTurn,
	parseAtomicExtractionReply,
} from "./atomic-extraction-reply";
import {
	ATOMIC_EXTRACTION_SKILL,
	atomicExtractionSkillReference,
} from "./atomic-extraction-skill";
import {
	createAtomicGenericExtractionTransport,
	excludeContextOnlyRecords,
	runAtomicGenericExtractionPass,
	runAtomicNumericTurnSweep,
	type AtomicGenericExtractionResult,
	type AtomicGenericExtractionTransport,
} from "./atomic-generic-extractor";
import {
	numberAtomicTurns,
	renderAtomicPromptData,
} from "./atomic-replacement-sanitizer";
import { sessionZoneCarriedBy } from "./date-resolution";
import { resolveAtomicEntityIdentity } from "./entity-identity-judgment";
import { prepareDeterministicTaskLifecycleWrite } from "./task-lifecycle-route";
import {
	createAtomicSubjectGuardTransport,
	runAtomicSubjectGuard,
	type AtomicSubjectGuardTransport,
} from "./atomic-subject-guard";
import { buildAtomicWriteCards } from "./atomic-write-projection";
import { recordTokenCounter } from "../../store/memory-store-write-validation";
import { DEFAULT_LOCALE, type Locale } from "../i18n/locales";
import { createLlmClient, type LlmClient, type LlmClientConfig } from "../../model/llm-client";
import { resolveLlmRoute } from "../../model/llm-mode-routing";
import { readModelReplyJson } from "../shared/model-reply-text";
import type { LlmRoutingConfig } from "../../../config/plugin-config-mode-schema";
import { REM_UPDATE_JUDGMENT_SKILL } from "../../sidecar/rem-update-judgment-skill";
import {
	closeAtomicArrivalRetirementTargets,
	journalAtomicArrivalRetirementRefusal,
	readAtomicArrivalRetirementCandidateSet,
} from "../../store/memory-store-atomic-extraction-write-api";
import {
	listAtomicMemoryEntityCandidates,
	normalizeEntityName,
} from "../../store/memory-store-atomic-entity-api";
import type {
	AtomicExtractionLedgerKey,
	AtomicExtractionRunParameters,
	AtomicExtractionWriteInput,
	AtomicExtractionWriteResult,
	AtomicMemoryEntityRegistration,
	MemoryStore,
	TaskLifecycleWriteInput,
} from "../../store/store";
import { countTodoTransitionsWithoutSource } from "../../store/todo-store";

export interface AtomicMemoryExtractionTransports {
	generic: AtomicGenericExtractionTransport;
	profileKeying: AtomicProfileKeyingTransport;
	resplit: AtomicResplitTransport;
	subjectGuard: AtomicSubjectGuardTransport;
}

export interface RunAtomicMemoryExtractionInput {
	diagnostics?: WindowDiagnostics;
	store: MemoryStore;
	projectId: string;
	ledgerKey: AtomicExtractionLedgerKey;
	turns: readonly AtomicExtractionTurn[];
	contextTurns?: readonly AtomicExtractionTurn[];
	followingTurns?: readonly AtomicExtractionTurn[];
	rawChunk: string;
	routingSnapshotId: string;
	runParameters: AtomicExtractionRunParameters;
	estimatedInputTokens: number;
	extractorVersion: string;
	sessionDateTime: string;
	sessionTimestampMs: number;
	sessionTimezone: string;
	sourceTurnOffset?: number;
	admittedSourceTurnIndexes?: readonly number[];
	/**
	 * Per global turn, the quote spans (character ranges of the turn) some record has already
	 * been written for: seeded from earlier passes of this conversation, and added to as each
	 * window writes. Windows write in order, and a window's slice reaches back over exactly the
	 * previous window's turns, so an entry can only ever be filled in by the window after the one
	 * that owns it. A span is the record's own evidence anchor; a record whose quote could not be
	 * placed in the turn claims the whole turn.
	 */
	claimedSourceSpans?: Map<number, ClaimedFact[]>;
	/**
	 * Per document family (`email`, `project`, `meeting`), the names this conversation has given
	 * it so far, each with the global turn it was stated at. Shared by the windows of one call.
	 */
	documentNames?: Map<string, DocumentName[]>;
	waitForDocumentNames?: () => Promise<void>;
	onDocumentNamesSettled?: () => void;
	onSubjectGuardSettled?: () => void;
	waitForWriteTurn?: () => Promise<void>;
	transports: AtomicMemoryExtractionTransports;
	nowMs: () => number;
	locale?: Locale;
	requestId?: string;
}

/**
 * The words one record claims on a turn, for the windows of ONE call. A quote the gauntlet placed
 * claims its character range. A quote it could not place claims only itself, by its own words:
 * sealing its whole turn would drop every other fact the turn states, and claiming nothing would
 * let the next window write the same sentence again.
 */
/** One claim already made on a turn: the words it quotes, and the fact it states. */
export interface ClaimedFact {
	readonly span: ClaimedSpan;
	/** The model-extracted subject, attribute and value claimed by this record. */
	readonly factKey: string | null;
}

export type ClaimedSpan =
	| { readonly kind: "range"; readonly start: number; readonly end: number }
	| { readonly kind: "quote"; readonly quote: string };
export interface DocumentName {
	turn: number;
	name: string;
}

export type AtomicMemoryExtractionResult =
	| Exclude<AtomicGenericExtractionResult, { status: "complete" }>
	| {
			status: "complete";
			records: AtomicKeyedRecord[];
			write: AtomicExtractionWriteResult;
	  };

export interface AtomicExtractPersistOptions {
	scope?: string;
	sessionDateTime?: string;
	sessionTimezone?: string;
}

export interface AtomicExtractPersistResult {
	created: number;
	merged: 0;
	skipped: number;
	addressLessRefusedCount: 0;
	todoTransitionsWithoutSourceCount: number;
	llmFailures?: number;
}

interface AtomicInsightDistillerConfig {
	defaultScope: string;
	locale?: Locale;
}

const log = createLogger("sno-station-mem:atomic-extraction-windows");
interface WindowDiagnostics {
	proposed: number;
	parseRejected: number;
	discarded: number;
	unkeyed: number;
	persisted: number;
	suppressed: number;
	modelMs: number;
	writeMs: number;
	outcome: string;
	rowIds: string[];
	reasons: Record<string, number>;
	parked: number;
}
const windowDiagnosticContext = new AsyncLocalStorage<WindowDiagnostics>();

function windowDiagnostics(): WindowDiagnostics {
	return { proposed: 0, parseRejected: 0, discarded: 0, unkeyed: 0, persisted: 0,
		suppressed: 0, modelMs: 0, writeMs: 0, outcome: "failed", rowIds: [], reasons: {}, parked: 0 };
}
const ATOMIC_PIPELINE_VERSION = "atomic-v3";
const ATOMIC_LLM_CONCURRENCY = 1;
const ARRIVAL_RETIREMENT_JUDGMENT_BATCH_SIZE = 16;
const STANDING_SUBJECT_CANDIDATE_LIMIT = 64;
const THING_ATTRIBUTE_SLUGS = new Set(stateVocabulary.slugs.map(({ slug }) => slug));
/** The one field of a document that IS its name: the value of `email.purpose` names the e-mail. */
const DOCUMENT_NAMING_SLUGS = new Set(
	stateVocabulary.slugs
		.map(({ slug }) => slug)
		.filter((slug) => slug.endsWith(".purpose") || slug.endsWith(".title")),
);
const TRANSCRIPT_ROLE_LINE = /^(system|user|assistant): ?(.*)$/;

const standingSubjectResolutionSchema = z
	.object({
		resolutions: z.array(
			z
				.object({
					record_index: z.number().int().nonnegative(),
					subject: z.string().min(1).nullable(),
				})
				.strict(),
		),
	})
	.strict();

function hashText(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * The share of the longer name the shorter must cover for the two to be one name. Two windows
 * that both see the purpose turn word its name differently ("To align leadership … reallocation."
 * beside "align leadership … reallocation"); offered both, the resolver reads two candidates that
 * could equally be it and answers null (measured 2026-09-06, every field of the business
 * executive's e-mail). A short title inside a longer one ("Q3 budget" in "Q3 budget review") is
 * two names.
 */
const SAME_NAME_MIN_SHARE = 0.8;

function foldName(name: string): string {
	return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Two wordings of one name: letters and digits alone, the shorter inside the longer and nearly its whole length. */
function sameDocumentName(left: string, right: string): boolean {
	const a = foldName(left);
	const b = foldName(right);
	const short = a.length <= b.length ? a : b;
	const long = a.length <= b.length ? b : a;
	return short.length > 0 && long.includes(short) && short.length >= long.length * SAME_NAME_MIN_SHARE;
}

/**
 * Two wordings of one turn's name are one name; across turns only the same name is ("Launch
 * Plan" at one turn and "Launch Plan v2" at a later one are two documents).
 */
function sameDocumentNameAt(known: DocumentName, candidate: DocumentName): boolean {
	return known.turn === candidate.turn
		? sameDocumentName(known.name, candidate.name)
		: foldName(known.name) === foldName(candidate.name);
}

/** The ledger identity of one chunk, as stamped on every row it writes. */
function atomicChunkKey(key: AtomicExtractionLedgerKey): string {
	return hashText(`${key.conversationId}\u0000${key.chunkHash}\u0000${key.pipelineVersion}`);
}

function documentFamily(attribute: string | null): string | null {
	if (attribute === null || !THING_ATTRIBUTE_SLUGS.has(attribute)) return null;
	return attribute.slice(0, attribute.indexOf("."));
}

/** Two claims collide when their ranges overlap, or when one repeats the other's exact words. */
function spansOverlap(left: ClaimedSpan, right: ClaimedSpan): boolean {
	if (left.kind === "range" && right.kind === "range") {
		return left.start < right.end && right.start < left.end;
	}
	if (left.kind === "quote" && right.kind === "quote") return left.quote === right.quote;
	// A whole turn already written (an earlier pass) covers an unplaceable quote too; a placed
	// range and an unplaceable quote cannot be compared, and both are kept.
	const range = left.kind === "range" ? left : right.kind === "range" ? right : null;
	return range !== null && range.start === 0 && range.end === Number.POSITIVE_INFINITY;
}

/** What a record claims: its placed range, or its own words when the quote could not be placed. */
/**
 * Compare the model's structured identity exactly. An attribute alone cannot distinguish two
 * recipients or two subjects cited in the same source sentence.
 */
function factKeyOf(record: { subject: string | null; attribute: string | null; value: string | null }): string {
	return JSON.stringify([record.subject, record.attribute, record.value]);
}

function claimedSpanOf(record: {
	sourceSpan: { startOffset?: number; endOffset?: number } | null;
	unresolvedSourceSpan?: { quote: string };
}): ClaimedSpan | null {
	const span = record.sourceSpan;
	if (span === null) {
		const quote = record.unresolvedSourceSpan?.quote.trim();
		return quote === undefined || quote === "" ? null : { kind: "quote", quote };
	}
	const start = typeof span.startOffset === "number" && span.startOffset >= 0 ? span.startOffset : 0;
	const end =
		typeof span.endOffset === "number" && span.endOffset > start
			? span.endOffset
			: Number.POSITIVE_INFINITY;
	return { kind: "range", start, end };
}

/**
 * The document names this conversation already wrote, read back from its rows: a window the
 * ledger skips never calls the model again, so the title it once gave would otherwise be gone and
 * every later field of that document would land unkeyed (measured on a session re-sent turn by
 * turn, where the first window is always already written).
 */
function writtenDocumentNames(
	store: MemoryStore,
	projectId: string,
	conversationId: string,
	pipelineVersion: string,
): Map<string, DocumentName[]> {
	const names = new Map<string, DocumentName[]>();
	const chunks = store.sqlite
		.prepare(
			"SELECT chunk_hash FROM nodix_atomic_extraction_ledger WHERE conversation_id = ? AND pipeline_version = ?",
		)
		.all(conversationId, pipelineVersion) as Array<{ chunk_hash: string }>;
	if (chunks.length === 0) return names;
	const keys = chunks.map(({ chunk_hash }) =>
		atomicChunkKey({ conversationId, chunkHash: chunk_hash, pipelineVersion }),
	);
	const rows = store.sqlite
		.prepare(
			`SELECT m.attribute AS attribute, e.display_name AS displayName,
				json_extract(m.metadata, '$.source_order.global_turn_index') AS turnIndex
			FROM nodix_memories m
			JOIN nodix_memory_entities e
				ON e.project_id = m.project_id AND e.entity_id = m.subject
			WHERE m.project_id = ? AND json_valid(m.metadata)
				AND json_extract(m.metadata, '$.source_chunk_key') IN (${keys.map(() => "?").join(", ")})`,
		)
		.all(projectId, ...keys) as Array<{
		attribute: string | null;
		displayName: string | null;
		turnIndex: number | null;
	}>;
	for (const row of rows) {
		const family = documentFamily(row.attribute);
		const name = row.displayName?.trim();
		if (family === null || name === undefined || name === "") continue;
		const turn = typeof row.turnIndex === "number" && Number.isSafeInteger(row.turnIndex) ? row.turnIndex : 0;
		const known = names.get(family) ?? [];
		if (!known.some((seen) => sameDocumentNameAt(seen, { turn, name }))) {
			names.set(family, [...known, { turn, name }]);
		}
	}
	return names;
}

/**
 * Restore only the spans and attributes actually written by this conversation. A partial
 * extraction must leave other facts on the same turn available to a later pass.
 */
function writtenSpansOfConversation(
	store: MemoryStore,
	projectId: string,
	conversationId: string,
	pipelineVersion: string,
): Map<number, ClaimedFact[]> {
	const chunks = store.sqlite
		.prepare(
			"SELECT chunk_hash FROM nodix_atomic_extraction_ledger WHERE conversation_id = ? AND pipeline_version = ?",
		)
		.all(conversationId, pipelineVersion) as Array<{ chunk_hash: string }>;
	const claimed = new Map<number, ClaimedFact[]>();
	if (chunks.length === 0) return claimed;
	const keys = chunks.map(({ chunk_hash }) =>
		atomicChunkKey({ conversationId, chunkHash: chunk_hash, pipelineVersion }),
	);
	const rows = store.sqlite
		.prepare(
			`SELECT json_extract(metadata, '$.source_order.global_turn_index') AS turn_index,
				subject, attribute,
				json_extract(metadata, '$.value') AS value,
				json_extract(metadata, '$.source_fact_key') AS source_fact_key,
				json_extract(metadata, '$.source_span.startOffset') AS span_start,
				json_extract(metadata, '$.source_span.endOffset') AS span_end,
				json_extract(metadata, '$.source_span.quote') AS quote
			FROM nodix_memories
			WHERE project_id = ? AND json_valid(metadata)
				AND json_extract(metadata, '$.source_chunk_key') IN (${keys.map(() => "?").join(", ")})`,
		)
		.all(projectId, ...keys) as Array<{
			turn_index: number | null;
			attribute: string | null;
			subject: string | null;
			value: string | null;
			source_fact_key: string | null;
			span_start: number | null;
			span_end: number | null;
			quote: string | null;
		}>;
	for (const row of rows) {
		if (typeof row.turn_index !== "number" || !Number.isSafeInteger(row.turn_index)) continue;
		let span: ClaimedSpan;
		if (typeof row.span_start === "number" && Number.isSafeInteger(row.span_start)
			&& row.span_start >= 0 && typeof row.span_end === "number"
			&& Number.isSafeInteger(row.span_end) && row.span_end > row.span_start) {
			span = { kind: "range", start: row.span_start, end: row.span_end };
		} else if (typeof row.quote === "string" && row.quote.trim()) {
			span = { kind: "quote", quote: row.quote.trim() };
		} else continue;
		claimed.set(row.turn_index, [
			...(claimed.get(row.turn_index) ?? []),
			{ span, factKey: row.source_fact_key ?? factKeyOf(row) },
		]);
	}
	return claimed;
}

function parseAtomicConversationTurns(conversationText: string): AtomicExtractionTurn[] {
	const turns: AtomicExtractionTurn[] = [];
	let current: AtomicExtractionTurn | undefined;
	for (const line of conversationText.replaceAll("\r\n", "\n").split("\n")) {
		const match = TRANSCRIPT_ROLE_LINE.exec(line);
		const role = match?.[1];
		if (role === "system" || role === "user" || role === "assistant") {
			if (current) turns.push(current);
			current = { role, content: match?.[2] ?? "" };
		} else if (current) {
			current = { ...current, content: `${current.content}\n${line}` };
		}
	}
	if (current) turns.push(current);
	return turns;
}

interface AtomicConversationWindow {
	turns: AtomicExtractionTurn[];
	contextTurns: AtomicExtractionTurn[];
	followingTurns: AtomicExtractionTurn[];
	startIndex: number;
	ownedTurnIndexes: number[];
}

function atomicConversationWindows(
	turns: readonly AtomicExtractionTurn[],
): AtomicConversationWindow[] {
	const userIndexes = turns.flatMap((turn, index) => (turn.role === "user" ? [index] : []));
	if (userIndexes.length === 0) return [];
	if (userIndexes.length <= 2) {
		return [{ turns: [...turns], contextTurns: [], followingTurns: [], startIndex: 0, ownedTurnIndexes: turns.map((_, index) => index) }];
	}
	return userIndexes.slice(0, -1).map((start, index) => {
		const from = index === 0 ? 0 : start;
		const until = userIndexes[index + 2] ?? turns.length;
		const ownedFrom = index === 0 ? 0 : (userIndexes[index + 1] ?? until);
		const ownedTurnIndexes = Array.from(
			{ length: until - ownedFrom },
			(_, ownedOffset) => ownedFrom + ownedOffset,
		);
		const windowTurns = turns.slice(from, until);
		const followingTurns = turns.slice(until, userIndexes[index + 3] ?? turns.length);
		while (followingTurns.length > 0 && countTokens(JSON.stringify({
			context: [], following: followingTurns, turns: windowTurns,
		})) > ATOMIC_EXTRACTION_MAX_INPUT_TOKENS) {
			followingTurns.pop();
		}
		let contextStart = from;
		// Keep the next group (which can hold the current turn's attachment) and then
		// preceding turns within the existing budget, without extending source ownership.
		while (contextStart > 0 && countTokens(JSON.stringify({
			context: turns.slice(contextStart - 1, from), following: followingTurns, turns: windowTurns,
		})) <= ATOMIC_EXTRACTION_MAX_INPUT_TOKENS) {
			contextStart -= 1;
		}
		return { turns: windowTurns, contextTurns: turns.slice(contextStart, from), followingTurns, startIndex: from, ownedTurnIndexes };
	});
}

type SubjectGuardInput = Parameters<AtomicSubjectGuardTransport["guardUserSubjects"]>[0];

interface PendingSubjectGuard {
	input: SubjectGuardInput;
	resolve: (decisions: readonly (boolean | null)[] | null) => void;
	reject: (error: unknown) => void;
}

class AtomicConversationSubjectGuard {
	private readonly settled = new Set<number>();
	private readonly pending: PendingSubjectGuard[] = [];
	private flushing = false;

	constructor(
		private readonly expectedWindows: number,
		private readonly transport: AtomicSubjectGuardTransport,
	) {}

	forWindow(windowIndex: number): AtomicSubjectGuardTransport {
		return {
			repairMissingHalf: (input) => this.transport.repairMissingHalf(input),
			guardUserSubjects: (input) => this.submit(windowIndex, input),
		};
	}

	complete(windowIndex: number): void {
		this.settled.add(windowIndex);
		void this.flush();
	}

	private submit(
		windowIndex: number,
		input: SubjectGuardInput,
	): Promise<readonly (boolean | null)[] | null> {
		this.settled.add(windowIndex);
		return new Promise((resolve, reject) => {
			this.pending.push({ input, resolve, reject });
			void this.flush();
		});
	}

	private async flush(): Promise<void> {
		if (this.flushing || this.settled.size !== this.expectedWindows || this.pending.length === 0) {
			return;
		}
		this.flushing = true;
		const records = this.pending.flatMap(({ input }) => [...input.records]);
		try {
			const decisions = await this.transport.guardUserSubjects({
				records,
				...(this.pending[0]?.input.locale ? { locale: this.pending[0].input.locale } : {}),
			});
			let offset = 0;
			for (const pending of this.pending) {
				const count = pending.input.records.length;
				pending.resolve(decisions === null ? null : decisions.slice(offset, offset + count));
				offset += count;
			}
		} catch (error) {
			for (const pending of this.pending) pending.reject(error);
		}
	}
}

class AtomicLlmConcurrencyGate {
	private active = 0;
	private readonly waiting: Array<() => void> = [];

	async run<T>(operation: () => Promise<T>): Promise<T> {
		if (this.active >= ATOMIC_LLM_CONCURRENCY) {
			await new Promise<void>((resolve) => this.waiting.push(resolve));
		}
		this.active += 1;
		const started = performance.now();
		try {
			return await operation();
		} finally {
			const diagnostic = windowDiagnosticContext.getStore();
			if (diagnostic) diagnostic.modelMs += performance.now() - started;
			this.active -= 1;
			this.waiting.shift()?.();
		}
	}
}

function limitAtomicLlmConcurrency(
	transports: AtomicMemoryExtractionTransports,
): AtomicMemoryExtractionTransports {
	const gate = new AtomicLlmConcurrencyGate();
	return {
		generic: { complete: (input) => gate.run(() => transports.generic.complete(input)) },
		profileKeying: { keyTurn: (input) => gate.run(() => transports.profileKeying.keyTurn(input)) },
		resplit: { resplit: (input) => gate.run(() => transports.resplit.resplit(input)) },
		subjectGuard: {
			repairMissingHalf: (input) => gate.run(() => transports.subjectGuard.repairMissingHalf(input)),
			guardUserSubjects: (input) => gate.run(() => transports.subjectGuard.guardUserSubjects(input)),
		},
	};
}

export function createAtomicResplitTransport(llm: LlmClient, locale: Locale): AtomicResplitTransport {
	return {
		async resplit(input): Promise<AtomicExtractionRecord[] | null> {
			const data = renderAtomicPromptData(
				{ ...input, turns: numberAtomicTurns(input.turns) },
				locale,
			);
			const text = await llm.completeText({
				prompt: [
					ATOMIC_EXTRACTION_SKILL,
					"Task: split each compound record into independently mutable claims.",
					`person_attribute_slugs: ${JSON.stringify(attributeDictionary.slugs.map(({ slug }) => slug))}`,
					`thing_attribute_slugs: ${JSON.stringify(stateVocabulary.slugs.map(({ slug }) => slug))}`,
					data.value,
				].join("\n\n"),
				callLabel: "memory-extract-atomic-resplit",
				adapterSlot: "memory-extract",
				emptyReplyAttempts: 1,
				enableThinking: false,
			});
			if (text === null) return null;
			const parsed = parseAtomicExtractionReply(text, input.turns.length);
			return parsed.ok ? parsed.records : null;
		},
	};
}

export function createSignedAtomicMemoryExtractionTransports(
	config: Omit<LlmClientConfig, "routing"> & { routing: LlmRoutingConfig },
	locale: Locale = DEFAULT_LOCALE,
): AtomicMemoryExtractionTransports {
	const chatRoute = resolveLlmRoute({
		slot: "memory-extract",
		callLabel: "memory-extract-atomic-generic",
		config: config.routing,
	});
	const usesAgentTier = !("off" in chatRoute) && chatRoute.tier === "agent";
	const chat = createLlmClient({
		...config,
		preset: usesAgentTier ? config.preset : FIXED_MEMORY_SNO_EXTRACT_CHAT,
	});
	const profile = createLlmClient({
		...config,
		preset: usesAgentTier ? config.preset : FIXED_MEMORY_SNO_EXTRACT_PROFILE,
	});
	return {
		generic: createAtomicGenericExtractionTransport(chat),
		profileKeying: createBProfileKeyingTransport(profile),
		resplit: createAtomicResplitTransport(chat, locale),
		subjectGuard: createAtomicSubjectGuardTransport(chat),
	};
}

export class AtomicInsightDistiller {
	constructor(
		private readonly store: MemoryStore,
		private readonly transports: AtomicMemoryExtractionTransports,
		private readonly config: AtomicInsightDistillerConfig,
	) {}

	async extractAndPersist(
		conversationText: string,
		sessionKey: string,
		options: AtomicExtractPersistOptions = {},
	): Promise<AtomicExtractPersistResult> {
		return withLogContext({ operation_id: currentLogContext().operation_id ?? randomUUID(), session_reference: sessionKey }, async () => {
		const diagnosticStarted = performance.now();
		const diagnostics: WindowDiagnostics[] = [];
		let captureOutcome = "failed";
		try {
		if (!sessionKey.trim()) throw new Error("Atomic extraction requires sessionKey");
		const turns = parseAtomicConversationTurns(conversationText);
		const windows = atomicConversationWindows(turns);
		if (windows.length === 0) {
			log.warn("atomic extraction found no parseable turn; nothing will be stored", {
				session_reference: privateLogReference(sessionKey),
			}, { event_name: "memory.atomic_memory_extraction.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-memory-extraction.ts", function: "extractAndPersist", site_id: "extraction.atomic-memory-extraction.extractAndPersist.7e1c9d2660" });
		}
		const scope = options.scope ?? this.config.defaultScope;
		const startedAt = Date.now();
		const sessionDateTime = options.sessionDateTime ?? new Date(startedAt).toISOString();
		const sessionTimestampMs = Date.parse(sessionDateTime);
		if (!Number.isFinite(sessionTimestampMs)) {
			throw new Error(`Atomic extraction requires a valid sessionDateTime: ${sessionDateTime}`);
		}
		let created = 0;
		let skipped = 0;
		let llmFailures = 0;
		let nowMs = startedAt;
		const transports = limitAtomicLlmConcurrency(this.transports);
		const subjectGuard = new AtomicConversationSubjectGuard(
			windows.length,
			transports.subjectGuard,
		);
		// The quote spans this conversation already wrote a record for, in any earlier pass, are
		// claimed before any window runs: every agent end re-sends the whole session, the windows
		// are cut again, and a re-cut window that reads an already-written turn must not write it a
		// second time — not even the window that owns it. A turn its owner returned nothing for is
		// not in this map, so a neighbour re-run after a failed attempt can still keep its record.
		const claimedSourceSpans = writtenSpansOfConversation(
			this.store,
			scope,
			sessionKey,
			ATOMIC_PIPELINE_VERSION,
		);
		// Names the conversation gives its documents, carried window to window: the purpose or
		// title turn is in view for at most two windows, and every later field of the same
		// dictation would otherwise land unkeyed. Each window records its own names before it waits
		// for the previous window's, and settles in `finally`, so the chain can neither deadlock
		// against the subject-guard barrier nor hang on a window that threw.
		const documentNames = writtenDocumentNames(
			this.store,
			scope,
			sessionKey,
			ATOMIC_PIPELINE_VERSION,
		);
		let previousWindowFinished = Promise.resolve();
		let previousNamesSettled = Promise.resolve();
		const scheduledWindows = windows.map((window) => {
			const previousWriteTurn = previousWindowFinished;
			const previousNames = previousNamesSettled;
			let finishWindow: () => void = () => undefined;
			let settleNames: () => void = () => undefined;
			previousWindowFinished = new Promise<void>((resolve) => {
				finishWindow = resolve;
			});
			previousNamesSettled = new Promise<void>((resolve) => {
				settleNames = resolve;
			});
			return { ...window, previousWriteTurn, previousNames, finishWindow, settleNames };
		});
		const settledResults = await Promise.allSettled(
			scheduledWindows.map(
				async (
					{
						turns: windowTurns,
						contextTurns,
						followingTurns,
						startIndex,
						ownedTurnIndexes,
						previousWriteTurn,
						previousNames,
						finishWindow,
						settleNames,
					},
					windowIndex,
				) => {
					const diagnostic = windowDiagnostics();
					diagnostics.push(diagnostic);
					const rawChunk = JSON.stringify({ context: contextTurns, following: followingTurns, turns: windowTurns });
					const chunkHash = hashText(`${startIndex}\u0000${rawChunk}`);
					try {
						return await windowDiagnosticContext.run(diagnostic, () => runAtomicMemoryExtraction({
							diagnostics: diagnostic,
							store: this.store,
							projectId: scope,
							ledgerKey: {
								conversationId: sessionKey,
								chunkHash,
								pipelineVersion: ATOMIC_PIPELINE_VERSION,
							},
							turns: windowTurns,
							contextTurns,
							followingTurns,
							rawChunk,
							routingSnapshotId: ATOMIC_PIPELINE_VERSION,
							runParameters: {
								maxInputTokens: ATOMIC_EXTRACTION_MAX_INPUT_TOKENS,
								outputTokenBudget: ATOMIC_CAPTURE_OUTPUT_TOKEN_BUDGET,
								subchunkCount: 1,
							},
							estimatedInputTokens: Math.ceil(rawChunk.length / 4),
							extractorVersion: ATOMIC_PIPELINE_VERSION,
							sessionDateTime,
							sessionTimestampMs,
							sessionTimezone:
								options.sessionTimezone ?? sessionZoneCarriedBy(sessionDateTime) ?? "UTC",
							sourceTurnOffset: startIndex,
							admittedSourceTurnIndexes: ownedTurnIndexes,
							claimedSourceSpans,
							documentNames,
							waitForDocumentNames: () => previousNames,
							onDocumentNamesSettled: settleNames,
							onSubjectGuardSettled: () => subjectGuard.complete(windowIndex),
							waitForWriteTurn: () => previousWriteTurn,
							transports: {
								...transports,
								subjectGuard: subjectGuard.forWindow(windowIndex),
							},
							nowMs: () => nowMs++,
							...(this.config.locale ? { locale: this.config.locale } : {}),
						}));
					} finally {
						settleNames();
						subjectGuard.complete(windowIndex);
						finishWindow();
					}
				},
			),
		);
		const results: AtomicMemoryExtractionResult[] = [];
		for (const result of settledResults) {
			if (result.status === "rejected") throw result.reason;
			results.push(result.value);
		}
		for (const result of results) {
			if (result.status === "complete") {
				created += result.write.createdCount;
				skipped += result.write.suppressed.length;
			} else if (result.status !== "skip") {
				// A window the ledger already wrote is not a model failure; counting it as one made
				// a correct re-send of a growing session look like a broken run.
				llmFailures += 1;
			}
		}
		captureOutcome = llmFailures > 0 ? "partial" : created > 0 ? "success" : "empty_success";
		return {
			created,
			merged: 0,
			skipped,
			addressLessRefusedCount: 0,
			todoTransitionsWithoutSourceCount: countTodoTransitionsWithoutSource(this.store.sqlite),
			...(llmFailures > 0 ? { llmFailures } : {}),
		};
		} finally {
			const sum = (field: keyof Pick<WindowDiagnostics, "proposed" | "parseRejected" | "discarded" | "unkeyed" | "persisted" | "suppressed" | "modelMs" | "writeMs">): number => diagnostics.reduce((total, row) => total + row[field], 0);
			log[captureOutcome === "failed" ? "error" : "info"]("Memory capture completed", { outcome: captureOutcome === "failed" && sum("persisted") > 0 ? "partial" : captureOutcome,
				row_ids: diagnostics.flatMap((row) => row.rowIds).slice(0, 128), store_reference: privateLogReference(this.store.dbPath),
				duration_ms: performance.now() - diagnosticStarted, window_count: diagnostics.length,
				product_session_reference: privateLogReference(sessionKey), model_proposed_count: sum("proposed"),
				outside_window_discarded_count: sum("discarded"), parse_candidate_rejected_count: sum("parseRejected"),
				parse_rejected_count: sum("parseRejected") === 0 ? 0 : "unavailable", parse_rejected_reason: "invalid_payload_has_no_reliable_record_count",
				stored_unkeyed_count: sum("unkeyed"), persisted_count: sum("persisted"), suppressed_count: sum("suppressed"),
				model_duration_ms: sum("modelMs"), write_duration_ms: sum("writeMs"),
				model_duration_reason: "sum_actual_transport_gate_durations",
				later_window_persisted_count: "undetermined", later_window_persisted_reason: "no_cross_window_record_identity",
			}, { event_name: "memory.capture.completed", file: "packages/sno-station-mem/src/engine/extraction/atomic-memory-extraction.ts", function: "extractAndPersist", site_id: "memory.capture.completed" });
		}
		});
	}
}

async function resolveSubjects(
	store: MemoryStore,
	projectId: string,
	records: readonly AtomicKeyedRecord[],
	transport: AtomicGenericExtractionTransport,
	jobId: string,
	nowMs: number,
): Promise<{
	records: AtomicKeyedRecord[];
	entities: AtomicMemoryEntityRegistration[];
	freshEntityRows: boolean[];
	mergeIds: Array<string | undefined>;
}> {
	const entities = new Map<string, AtomicMemoryEntityRegistration>();
	const resolutions = new Map<
		string,
		Awaited<ReturnType<typeof resolveAtomicEntityIdentity>>
	>();
	const resolved: AtomicKeyedRecord[] = [];
	const freshEntityRows: boolean[] = [];
	const mergeIds: Array<string | undefined> = [];
	for (const record of records) {
		if (record.subject === null || record.subjectKind === "unresolved") {
			resolved.push({ ...record, subject: null });
			freshEntityRows.push(false);
			mergeIds.push(undefined);
			continue;
		}
		if (record.subjectKind === "user" || record.subjectKind === "agent") {
			resolved.push({ ...record, subject: record.subjectKind });
			freshEntityRows.push(false);
			mergeIds.push(undefined);
			continue;
		}
		// Key the batch cache on the normalized name so two spellings of one new entity share one
		// judgement, one id and one registration.
		const resolutionKey = normalizeEntityName(record.subject);
		let entity = resolutions.get(resolutionKey);
		if (!entity) {
			entity = await resolveAtomicEntityIdentity({
				store,
				projectId,
				displayName: record.subject,
				jobId,
				nowMs,
				transport,
			});
			resolutions.set(resolutionKey, entity);
		}
		if (entity.registration) {
			entities.set(entity.registration.normalizedName, entity.registration);
		}
		resolved.push({ ...record, subject: entity.entityId });
		freshEntityRows.push(entity.isNew === true);
		mergeIds.push(entity.mergeId);
	}
	return {
		records: resolved,
		entities: [...entities.values()],
		freshEntityRows,
		mergeIds,
	};
}

function parseStandingSubjectResolutions(
	raw: string,
): z.infer<typeof standingSubjectResolutionSchema> | undefined {
	return readModelReplyJson(raw, (value) => {
		const parsed = standingSubjectResolutionSchema.safeParse(value);
		return parsed.success ? parsed.data : undefined;
	});
}

function standingSubjectResponseSchema(candidates: readonly string[]): unknown {
	return {
		type: "object",
		additionalProperties: false,
		required: ["resolutions"],
		properties: {
			resolutions: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["record_index", "subject"],
					properties: {
						record_index: { type: "integer", minimum: 0 },
						subject:
							candidates.length === 0
								? { type: "null" }
								: { anyOf: [{ enum: candidates }, { type: "null" }] },
					},
				},
			},
		},
	};
}

async function readStandingSubjectCandidates(
	input: RunAtomicMemoryExtractionInput,
	unresolved: readonly AtomicGauntletRecord[],
	inBatchCandidates: readonly string[],
): Promise<{ candidates: string[]; storedDisplayNames: Map<string, string> }> {
	// One read per unresolved subject: the registry ranks its entities by the text it is given, so
	// ranking every record on the first one's words hid the second record's document entirely.
	const storedCandidates: Array<{ entityId: string; displayName: string }> = [];
	for (const record of unresolved) {
		// Read again rather than resolve against an empty list, which the model can only answer
		// null: the claim would land unkeyed and no later revision could ever replace it.
		for (let attempt = 1; attempt <= STANDING_SUBJECT_ATTEMPTS; attempt += 1) {
			try {
				for (const candidate of await listAtomicMemoryEntityCandidates(
					input.store,
					input.projectId,
					record.subject ?? record.claimText,
				)) {
					if (!storedCandidates.some(({ entityId }) => entityId === candidate.entityId)) {
						storedCandidates.push(candidate);
					}
				}
				break;
			} catch (error) {
				log.warn("atomic standing subject candidate read failed", {
					attempt,
					error,
				}, { event_name: "memory.atomic_memory_extraction.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-memory-extraction.ts", function: "readStandingSubjectCandidates", site_id: "extraction.atomic-memory-extraction.readStandingSubjectCandidates.b88c6fb3aa" });
			}
		}
	}
	return {
		candidates: [
			...new Set([...inBatchCandidates, ...storedCandidates.map(({ entityId }) => entityId)]),
		].slice(0, STANDING_SUBJECT_CANDIDATE_LIMIT),
		storedDisplayNames: new Map(
			storedCandidates.map(({ entityId, displayName }) => [entityId, displayName]),
		),
	};
}

/**
 * The names this window's own records give their documents: the value of a naming field
 * (`email.purpose`), and the subject of a record the model named itself. Recorded before the
 * window waits for anything, so the chain of windows always completes.
 */
function recordDocumentNames(
	documentNames: Map<string, DocumentName[]> | undefined,
	records: readonly AtomicGauntletRecord[],
	sourceTurnOffset: number,
): void {
	if (documentNames === undefined) return;
	for (const record of records) {
		// An unplaceable quote still names its turn: a title the gauntlet could not locate must
		// still reach the later windows, or every field of that document lands unkeyed.
		const span = record.sourceSpan ?? record.unresolvedSourceSpan;
		if (record.kind !== "standing" || span === undefined) continue;
		const family = documentFamily(record.attribute);
		if (family === null) continue;
		const name =
			record.attribute !== null && DOCUMENT_NAMING_SLUGS.has(record.attribute)
				? record.value
				: record.subjectKind === "named_entity"
					? record.subject
					: null;
		if (name === null || name.trim() === "") continue;
		const turn = sourceTurnOffset + span.turnIndex;
		const names = documentNames.get(family) ?? [];
		if (!names.some((known) => sameDocumentNameAt(known, { turn, name }))) {
			documentNames.set(family, [...names, { turn, name }]);
		}
	}
}

/**
 * Releases the next window only after every earlier window has recorded its names: this window
 * waits for the previous one first, so the chain is transitive, and settles even when it has
 * nothing to record (a skipped or pending chunk).
 */
async function settleDocumentNames(input: RunAtomicMemoryExtractionInput): Promise<void> {
	await input.waitForDocumentNames?.();
	input.onDocumentNamesSettled?.();
}

/**
 * The document names stated in this conversation at or before a record's turn, for the record's
 * family. They are offered to the resolver as candidates ahead of the registry; the resolver,
 * not the engine, decides whether the claim edits one of them or none (a second, still unnamed
 * e-mail must not inherit the first one's name).
 */
function knownDocumentNames(
	documentNames: Map<string, DocumentName[]> | undefined,
	record: AtomicGauntletRecord,
	sourceTurnOffset: number,
): DocumentName[] {
	const family = documentFamily(record.attribute);
	const span = record.sourceSpan ?? record.unresolvedSourceSpan;
	if (family === null || documentNames === undefined || span === undefined) return [];
	const turn = sourceTurnOffset + span.turnIndex;
	return (documentNames.get(family) ?? []).filter((known) => known.turn <= turn);
}

async function deriveStoreCategories(
	input: RunAtomicMemoryExtractionInput,
	records: readonly AtomicGauntletRecord[],
	locale: Locale,
	sourceTurnOffset: number,
): Promise<AtomicKeyedRecord[]> {
	const unresolved = records.filter(
		(record) => record.kind === "standing" && record.subjectKind === "unresolved",
	);
	// The documents this conversation has named so far, for the resolver to choose from: the
	// purpose or title turn is in view for at most two windows, and without these every later
	// field of the same dictation resolved to nothing (measured 2026-09-06, six document questions).
	// A field of a named document is resolved among the conversation's own names; every other
	// unresolved subject among the registry's, as before. Offered together with the registry's
	// entry for the same document under a slightly different wording, the resolver sees two
	// candidates that "could equally be it" and answers null (measured 2026-09-06, three of three
	// e-mail removals); a name resolved here still meets the registry in the entity identity
	// judgement, which merges the wordings.
	const documentRecords = unresolved.filter(
		(record) => knownDocumentNames(input.documentNames, record, sourceTurnOffset).length > 0,
	);
	const otherRecords = unresolved.filter((record) => !documentRecords.includes(record));
	const offeredNames: DocumentName[] = [];
	for (const record of documentRecords) {
		for (const known of knownDocumentNames(input.documentNames, record, sourceTurnOffset)) {
			if (!offeredNames.some((name) => name.name === known.name)) offeredNames.push(known);
		}
	}
	const namedInBatch = records.flatMap((record) =>
		record.subjectKind === "named_entity" &&
		record.subject !== null &&
		(record.sourceSpan ?? record.unresolvedSourceSpan) !== undefined
			? [
					{
						turn:
							sourceTurnOffset +
							((record.sourceSpan ?? record.unresolvedSourceSpan)?.turnIndex ?? 0),
						name: record.subject,
					},
				]
			: [],
	);
	// A window's own wording of a conversation name is not a second candidate.
	const inBatchCandidates: string[] = [];
	for (const candidate of namedInBatch) {
		if (
			!offeredNames.some((known) => sameDocumentNameAt(known, candidate)) &&
			!inBatchCandidates.includes(candidate.name)
		) {
			inBatchCandidates.push(candidate.name);
		}
	}
	const resolved = new Map<number, string>();
	const storedDisplayNames = new Map<string, string>();
	const resolveGroup = async (
		group: readonly AtomicGauntletRecord[],
		candidates: readonly string[],
		displayNames: ReadonlyMap<string, string>,
	): Promise<void> => {
		const answers = await reaskStandingSubjects(input, group, candidates, displayNames, locale);
		for (const [index, subject] of answers) {
			const record = group[index];
			if (record !== undefined) resolved.set(unresolved.indexOf(record), subject);
		}
	};
	if (documentRecords.length > 0) {
		await resolveGroup(
			documentRecords,
			[...offeredNames.map(({ name }) => name), ...inBatchCandidates],
			storedDisplayNames,
		);
	}
	if (otherRecords.length > 0) {
		const stored = await readStandingSubjectCandidates(input, otherRecords, inBatchCandidates);
		for (const [entityId, displayName] of stored.storedDisplayNames) {
			storedDisplayNames.set(entityId, displayName);
		}
		await resolveGroup(otherRecords, stored.candidates, stored.storedDisplayNames);
	}
	let unresolvedIndex = 0;
	return records.map((record): AtomicKeyedRecord => {
		if (record.kind === "occurrence") return { ...record, category: "episodic" };
		if (record.subjectKind === "user") return { ...record, category: "profile", subject: record.lane === "parked" ? record.subject : "user" };
		if (record.subjectKind === "agent") {
			return { ...record, category: "profile", subject: "agent", attribute: null };
		}
		if (record.subjectKind === "named_entity") return { ...record, category: "state" };
		const subject = resolved.get(unresolvedIndex);
		unresolvedIndex += 1;
		return subject === undefined
			? { ...record, category: "episodic", subject: null, attribute: null }
			: {
					...record,
					category: "state",
					subject: storedDisplayNames.get(subject) ?? subject,
					subjectKind: "named_entity",
				};
	});
}

const STANDING_SUBJECT_ATTEMPTS = 3;

async function reaskStandingSubjects(
	input: RunAtomicMemoryExtractionInput,
	records: readonly AtomicGauntletRecord[],
	candidates: readonly string[],
	displayNames: ReadonlyMap<string, string>,
	locale: Locale,
): Promise<Map<number, string>> {
	if (records.length === 0) return new Map();
	const data = renderAtomicPromptData(
		{
			// A stored candidate arrives as an opaque entity id. Offered without its display name,
			// no reader can tell which document it is, so every claim that does not repeat the name
			// resolved to null and was stored unkeyed.
			candidates: candidates.map((subject) => ({
				subject,
				display_name: displayNames.get(subject) ?? subject,
			})),
			records: records.map((record, recordIndex) => ({ recordIndex, record })),
		},
		locale,
	);
	const prompt = [
		ATOMIC_EXTRACTION_SKILL,
		atomicExtractionSkillReference("resolve-subject"),
		"Task: resolve each unresolved standing subject to one supplied candidate or null.",
		data.value,
		`response_schema: ${JSON.stringify(standingSubjectResponseSchema(candidates))}`,
	].join("\n\n");
	// A truncated, unparseable or failed answer is asked again; written through as-is it would
	// turn every document field of the window into an unkeyed episodic row that no later revision
	// can replace. After the last attempt the chunk goes pending instead.
	for (let attempt = 1; attempt <= STANDING_SUBJECT_ATTEMPTS; attempt += 1) {
		try {
			const completion = await input.transports.generic.complete({
				prompt,
				maxTokens: input.runParameters.outputTokenBudget,
				...(input.requestId ? { requestId: input.requestId } : {}),
			});
			if (completion === null) continue;
			input.store.recordAtomicExtractionCalls(input.ledgerKey, input.nowMs());
			if (completion.truncated) continue;
			const parsed = parseStandingSubjectResolutions(completion.text);
			// Every record must come back with exactly one answer — a candidate or an explicit null.
			// A reply that omits records, repeats an index or names something that was never
			// offered is not an answer: it silently turned document fields into unkeyed rows.
			if (parsed === undefined) continue;
			const answers = new Map<number, string | null>();
			let malformed = false;
			for (const { record_index: index, subject } of parsed.resolutions) {
				// An index answered twice, or one nobody asked about, makes the whole reply
				// unusable: keeping the first answer would key the record on a coin toss.
				if (!Number.isInteger(index) || index < 0 || index >= records.length || answers.has(index)) {
					malformed = true;
					break;
				}
				// The model is asked for a candidate id and sometimes answers its display name.
				const named =
					subject === null
						? null
						: (candidates.find(
								(candidate) =>
									candidate === subject || (displayNames.get(candidate) ?? candidate) === subject,
							) ?? undefined);
				if (named === undefined) continue;
				answers.set(index, named);
			}
			if (malformed || answers.size !== records.length) continue;
			return new Map(
				[...answers].flatMap(([index, subject]) => (subject === null ? [] : [[index, subject]])),
			);
		} catch (error) {
			log.warn("atomic standing subject re-ask failed", {
				attempt,
				error,
			}, { event_name: "memory.atomic_memory_extraction.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-memory-extraction.ts", function: "reaskStandingSubjects", site_id: "extraction.atomic-memory-extraction.reaskStandingSubjects.1288498dec" });
		}
	}
	// Every attempt failed. The claims are still written, with the subject left unresolved, as
	// they were before the retries existed: a chunk held back for a later pass is a chunk this
	// harness never sends again, and the whole window's content is then simply gone.
	log.warn("atomic standing subject re-ask exhausted; subjects left unresolved", {
		records: records.length,
		candidates: candidates.length,
	}, { event_name: "memory.atomic_memory_extraction.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-memory-extraction.ts", function: "reaskStandingSubjects", site_id: "extraction.atomic-memory-extraction.reaskStandingSubjects.2b8785b171" });
	return new Map();
}

function taskActionForTodo(
	todo: Exclude<AtomicExtractionRecord["todo"], "none">,
): "open_or_refine" | "complete" | "remove" {
	switch (todo) {
		case "open":
			return "open_or_refine";
		case "done":
			return "complete";
		case "removed":
			return "remove";
	}
}

function buildAtomicTodoWriteFactories(
	input: RunAtomicMemoryExtractionInput,
	records: readonly AtomicKeyedRecord[],
): Array<() => TaskLifecycleWriteInput> {
	const seen = new Set<string>();
	// Profile keying groups record kinds; task transitions must still follow transcript order.
	const ordered = records.map((record, recordIndex) => ({ record, recordIndex })).sort((a, b) =>
		(a.record.sourceSpan?.turnIndex ?? 0) - (b.record.sourceSpan?.turnIndex ?? 0) ||
		(a.record.sourceSpan?.startOffset ?? 0) - (b.record.sourceSpan?.startOffset ?? 0),
	);
	return ordered.flatMap(({ record, recordIndex }) => {
		if (
			record.todo === "none" ||
			record.lane !== "active" ||
			record.subject !== "user" ||
			record.subjectKind !== "user"
		) {
			return [];
		}
		if (record.sourceSpan === null) return [];
		if (input.turns[record.sourceSpan.turnIndex]?.role !== "user") return [];
		const key = [
			record.sourceSpan.turnIndex,
			record.sourceSpan.quote,
			record.todo,
			record.value,
		].join("\u0000");
		if (seen.has(key)) return [];
		seen.add(key);
		const action = taskActionForTodo(record.todo);
		return [
			() =>
				prepareDeterministicTaskLifecycleWrite({
					assertion: {
						kind: "task_lifecycle",
						action,
						projectId: input.projectId,
						subject: "user",
						description: record.value,
						occurrenceAnchors: {},
						revisionDetails: {},
					},
					source: {
						kind: "authorized_untraced",
						sessionKey: input.ledgerKey.conversationId,
						replayIdentity: `${input.ledgerKey.chunkHash}:${recordIndex}`,
						assertionOrdinal: recordIndex,
					},
					firstResolutionNowMs: input.sessionTimestampMs,
					store: input.store,
					todoProvenance: {
						sourceSession: input.ledgerKey.conversationId,
						extractionPath: "agent_end_atomic",
						...(record.closeReason === null ? {} : { closeReason: record.closeReason }),
					},
				}),
		];
	});
}

export async function runAtomicMemoryExtraction(
	input: RunAtomicMemoryExtractionInput,
): Promise<AtomicMemoryExtractionResult> {
	const diagnostic = input.diagnostics ?? windowDiagnostics();
	const started = performance.now();
	try {
	if (!input.projectId.trim()) throw new Error("Atomic extraction requires projectId");
	if (!input.extractorVersion.trim()) throw new Error("Atomic extraction requires extractorVersion");
	const locale = input.locale ?? DEFAULT_LOCALE;
	const generic = await runAtomicGenericExtractionPass({
		diagnostics: diagnostic,
		store: input.store,
		ledgerKey: input.ledgerKey,
		turns: input.turns,
		...(input.contextTurns ? { contextTurns: input.contextTurns } : {}),
		...(input.followingTurns ? { followingTurns: input.followingTurns } : {}),
		rawChunk: input.rawChunk,
		routingSnapshotId: input.routingSnapshotId,
		runParameters: input.runParameters,
		sessionDateTime: input.sessionDateTime,
		estimatedInputTokens: input.estimatedInputTokens,
		nowMs: input.nowMs,
		transport: input.transports.generic,
		locale,
		...(input.requestId ? { requestId: input.requestId } : {}),
	});
	if (generic.status !== "complete") {
		diagnostic.outcome = generic.status;
		await settleDocumentNames(input);
		return generic;
	}

	const progressTurns = generic.progressTurns;
	generic.records = excludeProgressRecords(generic.records, progressTurns);

	const sourceTurnOffset = input.sourceTurnOffset ?? 0;
	const admittedSourceTurnIndexes = input.admittedSourceTurnIndexes
		? new Set(input.admittedSourceTurnIndexes)
		: undefined;
	// Only this window's own turns: a turn belongs to exactly one window, so sweeping a turn the
	// window does not own would pay for a record the admission filter below then discards.
	const eligibleTurnIndexes = admittedSourceTurnIndexes
		? new Set(
				input.turns.flatMap((_, index) =>
					admittedSourceTurnIndexes.has(sourceTurnOffset + index) ? [index] : [],
				),
			)
		: undefined;
	const swept = await runAtomicNumericTurnSweep({
		diagnostics: diagnostic,
		store: input.store,
		ledgerKey: input.ledgerKey,
		turns: input.turns,
		...(input.contextTurns ? { contextTurns: input.contextTurns } : {}),
		...(input.followingTurns ? { followingTurns: input.followingTurns } : {}),
		sessionDateTime: input.sessionDateTime,
		records: generic.records,
		...(eligibleTurnIndexes ? { eligibleTurnIndexes } : {}),
		outputTokenBudget: input.runParameters.outputTokenBudget,
		transport: input.transports.generic,
		locale,
		nowMs: input.nowMs,
		...(input.requestId ? { requestId: input.requestId } : {}),
	});

	const candidates = await runAtomicExtractionGauntlet({
		records: excludeProgressRecords([...generic.records, ...swept], progressTurns),
		turns: input.turns,
		resplitTransport: input.transports.resplit,
		locale,
		sessionDateTime: input.sessionDateTime,
		sessionTimezone: input.sessionTimezone,
	});
	const gauntlet = excludeContextOnlyRecords(
		candidates, input.turns, [...(input.contextTurns ?? []), ...(input.followingTurns ?? [])], locale,
	);
	const contextOnlyCount = candidates.length - gauntlet.length;
	diagnostic.discarded += contextOnlyCount;
	if (contextOnlyCount > 0) diagnostic.reasons.context_only = contextOnlyCount;
	recordDocumentNames(input.documentNames, gauntlet, sourceTurnOffset);
	await settleDocumentNames(input);
	const categorized = await deriveStoreCategories(input, gauntlet, locale, sourceTurnOffset);
	const keyed =
		categorized.length === 0
			? []
			: await runAtomicProfileKeying({
					baseRecords: categorized,
					turns: input.turns,
					projectId: input.projectId,
					transport: input.transports.profileKeying,
					locale,
					sessionDateTime: input.sessionDateTime,
					sessionTimezone: input.sessionTimezone,
				});
	const subjectGuarded =
		keyed.length === 0
			? []
			: await runAtomicSubjectGuard({
					records: keyed,
					turns: input.turns,
					transport: input.transports.subjectGuard,
					locale,
					sessionDateTime: input.sessionDateTime,
					sessionTimezone: input.sessionTimezone,
				});
	const guarded = excludeProgressRecords(subjectGuarded, progressTurns);
	input.onSubjectGuardSettled?.();
	// After the write turn, because admission now reads what earlier windows actually wrote.
	await input.waitForWriteTurn?.();
	const claimed = input.claimedSourceSpans;
	// A quote the gauntlet could not place still names its turn: the record is parked and unkeyed,
	// not dropped (19 of a six-persona run's records vanished here with no row and no reason).
	const globalTurnIndex = (record: (typeof guarded)[number]): number | null => {
		const turnIndex = record.sourceSpan?.turnIndex ?? record.unresolvedSourceSpan?.turnIndex;
		return turnIndex === undefined ? null : sourceTurnOffset + turnIndex;
	};
	// Overlapping quotes do not authorize dropping a different structured fact.
	// What this window itself has taken so far, held separately: its claims reach the shared table
	// only once the write lands, and a model that returns the same record twice in one reply used
	// to write it twice (measured 2026-09-07, an e-mail's recipients row, and four copies of one
	// preference in an earlier replay).
	const claimedHere = new Map<number, ClaimedFact[]>();
	/** The claim recorded for each record, so a record dropped after this pass can withdraw it. */
	const claimedHereByRecord = new Map<(typeof guarded)[number], ClaimedFact>();
	/** Records this reply already listed, whole: subject, attribute, value and wording. */
	const claimedSelf = new Set<string>();
	const isClaimed = (turnIndex: number, span: ClaimedSpan, factKey: string): boolean =>
		(claimed?.get(turnIndex) ?? []).some(
			(known) =>
				spansOverlap(known.span, span) && (known.factKey === null || known.factKey === factKey),
		);
	const admitted = admittedSourceTurnIndexes
		? guarded.filter((record) => {
				const turnIndex = globalTurnIndex(record);
				if (turnIndex === null) {
					diagnostic.reasons.missing_source_identity = (diagnostic.reasons.missing_source_identity ?? 0) + 1;
					return false;
				}
				// The words this record quotes were already written — in an earlier pass of this
				// conversation (seeded), or by the window before this one: not written again,
				// whoever owns the turn. Words nobody quoted yet are a different claim, which is
				// how the second half of "I used to like X, but lately more into Y" survives when
				// the owner returned only the first (measured 2026-09-06, two forgetting losses).
				const span = claimedSpanOf(record);
				const factKey = factKeyOf(record);
				// Inside one reply the model lists the facts it found, and two of them share a
				// sentence and an attribute all the time ("the recipients are Alice and Bob"). Only
				// a record repeated whole is a repeat here; the structured identity rule is for the
				// next window, which re-reads the same turn.
				const quote = (record.sourceSpan ?? record.unresolvedSourceSpan)?.quote ?? "";
				const selfKey = [
					factKey,
					record.subject ?? "",
					record.value ?? "",
					record.claimText,
					turnIndex,
					quote,
				].join("\u0000");
				if (span !== null && (isClaimed(turnIndex, span, factKey) || claimedSelf.has(selfKey))) {
					diagnostic.reasons.claimed_record = (diagnostic.reasons.claimed_record ?? 0) + 1;
					return false;
				}
				claimedSelf.add(selfKey);
				if (span !== null) {
					const fact: ClaimedFact = { span, factKey };
					claimedHere.set(turnIndex, [...(claimedHere.get(turnIndex) ?? []), fact]);
					claimedHereByRecord.set(record, fact);
				}
				if (admittedSourceTurnIndexes.has(turnIndex)) return true;
				// A turn belonging to the window before this one, which wrote nothing for it. This
				// window read that turn too and produced a record for it, so the work is already
				// paid for and the only question is whether anyone kept it. Measured 2026-09-04 on
				// a dictated email: the window owning the key-points turn returned nothing, the
				// next window returned TWO records for that same turn, and both were discarded —
				// the field was extracted and thrown away, and the answer lost half its score.
				if (claimed === undefined) diagnostic.discarded += 1;
				return claimed !== undefined;
			})
		: guarded;
	// Held until the write lands: a window that claims words and then fails on the resolver or the
	// database would make the next window drop its own copy of a fact nobody stored.
	const publishClaims = (): void => {
		if (claimed === undefined) return;
		for (const [turnIndex, facts] of claimedHere) {
			claimed.set(turnIndex, [...(claimed.get(turnIndex) ?? []), ...facts]);
		}
	};
	if (admitted.length !== guarded.length) {
		// A record dropped here leaves no row, no lane and no disposition reason — the one way a
		// claim can vanish from this pipeline without a trace.
		log.warn("Atomic window admission filtered records", {
			discarded: guarded.length - admitted.length,
			kept: admitted.length,
			sourceTurnOffset,
			discardedTurnIndexes: guarded
				.filter((record) => !admitted.includes(record))
				.map(globalTurnIndex),
		}, { event_name: "memory.atomic_memory_extraction.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-memory-extraction.ts", function: "runAtomicMemoryExtraction", site_id: "extraction.atomic-memory-extraction.runAtomicMemoryExtraction.304a5a8d5c" });
	}
	const identityNowMs = input.nowMs();
	const resolved = await resolveSubjects(
		input.store,
		input.projectId,
		admitted,
		input.transports.generic,
		input.ledgerKey.conversationId,
		identityNowMs,
	);
	// A record's identity is the ledger's identity plus its position in the window: the same
	// three fields that name the chunk, so two different chunks can never share a key. The key
	// used to be built from the turn index and the quote's offsets under the session name, and
	// two different sentences of equal length at the same turn of two different days matched
	// it exactly (measured 2026-09-06: "$9.02 on coffee" silently mapped onto "$37.36 on
	// groceries" and was never stored).
	const sourceFactKeys = admitted.map(factKeyOf);
	const projectedCards = buildAtomicWriteCards({
		records: resolved.records,
		idempotencyKeys: resolved.records.map((_record, recordIndex) =>
			hashText(
				`${input.ledgerKey.conversationId}\u0000${input.ledgerKey.chunkHash}\u0000${input.ledgerKey.pipelineVersion}\u0000${recordIndex}`,
			),
		),
		sourceTurnOffset,
		sessionTimestampMs: input.sessionTimestampMs,
		timezone: input.sessionTimezone,
		locale,
	}).map((card, index) => {
		const orderedCard =
			card.endsCurrent && card.validFrom === null
				? { ...card, validFrom: card.timestamp }
				: card;
		const mergeId = resolved.mergeIds[index];
		const isNew = resolved.freshEntityRows[index] === true;
		return {
			...orderedCard,
			metadata: {
				...orderedCard.metadata,
				source_fact_key: sourceFactKeys[index],
				// Which chunk wrote the row, by the ledger's full identity: a later pass of the same
				// conversation reads it back to learn which turns are already written.
				source_chunk_key: atomicChunkKey(input.ledgerKey),
				...(mergeId === undefined ? {} : { merge_id: mergeId }),
				...(isNew ? { entity_identity_new: true } : {}),
			},
		};
	});
	// The store refuses a record over DEFAULT_MAX_CONTEXT_TOKENS, and one such record must not
	// take the whole chunk's write down with it. The skill tells the model to split a claim
	// that long; a record that still arrives over the ceiling is dropped here and counted.
	const countRecordTokens = await recordTokenCounter(input.store.embedder);
	const keptCards = projectedCards.map(
		(card) => countRecordTokens(card.text) <= DEFAULT_MAX_CONTEXT_TOKENS,
	);
	const cards = projectedCards.filter((_card, index) => keptCards[index] === true);
	if (cards.length !== projectedCards.length) {
		// A dropped card leaves no row, so its claim must not reach the shared table — that is
		// exactly what `publishClaims` is held back for. Left published, the next overlapping
		// window reads the turn as already written and drops its own copy, so a fact nobody
		// stored is never extracted again, even when that window words it short enough to fit.
		projectedCards.forEach((_card, index) => {
			if (keptCards[index] === true) return;
			const record = admitted[index];
			if (record === undefined) return;
			const fact = claimedHereByRecord.get(record);
			const turnIndex = globalTurnIndex(record);
			if (fact === undefined || turnIndex === null) return;
			const remaining = (claimedHere.get(turnIndex) ?? []).filter((known) => known !== fact);
			if (remaining.length === 0) claimedHere.delete(turnIndex);
			else claimedHere.set(turnIndex, remaining);
		});
		diagnostic.reasons.over_token_ceiling = projectedCards.length - cards.length;
		log.warn("atomic extraction dropped records over the token ceiling", {
			dropped: projectedCards.length - cards.length,
			kept: cards.length,
			maxTokens: DEFAULT_MAX_CONTEXT_TOKENS,
		}, { event_name: "memory.atomic_extraction.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-memory-extraction.ts", function: "runAtomicMemoryExtraction", site_id: "extraction.atomic-memory-extraction.over_token_ceiling" });
	}
	const atomicFactWrite: AtomicExtractionWriteInput = {
		ledgerKey: input.ledgerKey,
		projectId: input.projectId,
		extractorVersion: input.extractorVersion,
		nowMs: input.nowMs(),
		cards,
		entities: resolved.entities,
	};
	const taskWriteFactories = buildAtomicTodoWriteFactories(input, resolved.records);
	diagnostic.parked = resolved.records.filter((record) => record.lane === "parked").length;
	for (const record of resolved.records) {
		const reason = record.dispositionReason ?? "accepted";
		diagnostic.reasons[reason] = (diagnostic.reasons[reason] ?? 0) + 1;
	}
	const writeStarted = performance.now();
	let write: AtomicExtractionWriteResult;
	try {
	write =
		taskWriteFactories.length === 0
			? await input.store.storeAtomicExtractionChunk(atomicFactWrite)
			: (
					await input.store.applyTaskLifecycleBatchWithAtomicWrite({
						taskWriteFactories,
						atomicFactWrite,
					})
				).atomicFactWrite;
	} finally {
	diagnostic.writeMs = performance.now() - writeStarted;
	}
	diagnostic.persisted = write.createdCount;
	diagnostic.rowIds = write.cardIds;
	diagnostic.suppressed = write.suppressed.length;
	const suppressedKeys = new Set(write.suppressed.map((row) => row.idempotencyKey));
	diagnostic.unkeyed = cards.filter((card) => !suppressedKeys.has(card.idempotencyKey) &&
		(card.subject === null || card.attribute === null)).length;
	diagnostic.outcome = write.createdCount > 0 ? "success" : "empty_success";
	publishClaims();
	// Nominated for the arrival judgement, decided AFTER the write so a card can see the rows of
	// its own batch: every ended card, and every profile or state card whose group holds a live
	// ended claim — "I like A again" has to be able to retire "no longer likes A", which stays
	// live since 2026-09-06 (see closeEndedCardAtCreate), including when both arrive in one window.
	const newEndedCards = cards.filter(
		(card) =>
			card.endsCurrent ||
			((card.category === "profile" || card.category === "state") &&
				card.subject !== null &&
				card.lane === "active" &&
				input.store.hasLiveEndedRowInGroup(
					input.projectId,
					card.category,
					card.subject,
					card.attribute,
				)),
	);
	for (const card of newEndedCards) {
		const stored = input.store.findByExtractionIdempotencyKey(
			input.projectId,
			card.idempotencyKey,
		);
		if (stored === undefined) continue;
		try {
			await runAtomicArrivalRetirementJudgment({
				store: input.store,
				projectId: input.projectId,
				jobId: input.ledgerKey.conversationId,
				nominatedRowId: stored.id,
				nowMs: atomicFactWrite.nowMs,
				transport: input.transports.generic,
				maxTokens: input.runParameters.outputTokenBudget,
				...(input.requestId ? { requestId: input.requestId } : {}),
			});
		} catch (error) {
			// The chunk is already committed and its ledger row complete, so a retry never comes back
			// here: a throw would abandon the remaining cards' retirements too. Keep going, and leave
			// the open row in the journal, where the refusals already are, not only in a log line.
			log.error("atomic arrival retirement failed after write; older facts stay current", {
				nominatedRowId: stored.id,
				session_reference: privateLogReference(input.ledgerKey.conversationId),
				error,
			}, { event_name: "memory.atomic_memory_extraction.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-memory-extraction.ts", function: "runAtomicMemoryExtraction", site_id: "extraction.atomic-memory-extraction.runAtomicMemoryExtraction.0d9673d494" });
			journalAtomicArrivalRetirementRefusal(input.store, {
				jobId: input.ledgerKey.conversationId,
				nominatedRowId: stored.id,
				reason: `judgment_failed:${error instanceof Error ? error.message : String(error)}`,
				candidateSetSize: 0,
			});
		}
	}
	return { status: "complete", records: resolved.records, write };
	} catch (error) {
		diagnostic.outcome = diagnostic.persisted > 0 ? "partial" : "failed";
		throw error;
	} finally {
		log[diagnostic.outcome === "failed" ? "error" : "info"]("Memory extraction window completed", { outcome: diagnostic.outcome,
			row_ids: diagnostic.rowIds.slice(0, 128), parked_count: diagnostic.parked,
			reason_histogram: diagnostic.reasons, category_counts_overlap: true,
			store_reference: privateLogReference(input.store.dbPath),
			duration_ms: performance.now() - started, input_turn_start: input.sourceTurnOffset ?? 0,
			input_turn_count: input.turns.length, input_size: input.rawChunk.length,
			model_proposed_count: diagnostic.proposed, parse_candidate_rejected_count: diagnostic.parseRejected,
			parse_rejected_count: diagnostic.parseRejected === 0 ? 0 : "unavailable", parse_rejected_reason: "invalid_payload_has_no_reliable_record_count",
			outside_window_discarded_count: diagnostic.discarded, stored_unkeyed_count: diagnostic.unkeyed,
			persisted_count: diagnostic.persisted, suppressed_count: diagnostic.suppressed,
			model_duration_ms: windowDiagnosticContext.getStore() === diagnostic ? diagnostic.modelMs : "unavailable",
			model_duration_reason: windowDiagnosticContext.getStore() === diagnostic ? "batched_calls_attributed_to_dispatch_window" : "entry_bypassed_session_transport_gate",
			write_duration_ms: diagnostic.writeMs,
			later_window_persisted_count: "undetermined", later_window_persisted_reason: "no_cross_window_record_identity",
		}, { event_name: "memory.extraction.window.completed", file: "packages/sno-station-mem/src/engine/extraction/atomic-memory-extraction.ts", function: "runAtomicMemoryExtraction", site_id: "memory.extraction.window.completed" });
	}
}

const ARRIVAL_RETIREMENT_JUDGMENT_ATTEMPTS = 3;

/**
 * One batch of the arrival judgement, asked again on a failed or invalid reply: a refusal after a
 * single bad answer left the old and the new fact both current, with no second chance.
 */
async function judgeRetirementBatch(
	input: { transport: AtomicGenericExtractionTransport; maxTokens: number; requestId?: string },
	prompt: string,
	batch: readonly { id: string }[],
): Promise<ReturnType<typeof decideRemRetirementTargetFromReply>> {
	const offered = new Set(batch.map((candidate) => candidate.id));
	let decision = decideRemRetirementTargetFromReply("", offered);
	for (let attempt = 1; attempt <= ARRIVAL_RETIREMENT_JUDGMENT_ATTEMPTS; attempt += 1) {
		let reply = "";
		try {
			reply =
				(
					await input.transport.complete({
						prompt,
						maxTokens: input.maxTokens,
						...(input.requestId ? { requestId: input.requestId } : {}),
					})
				)?.text ?? "";
		} catch (error) {
			log.warn("atomic arrival retirement judgement call failed", {
				attempt,
				error,
			}, { event_name: "memory.atomic_memory_extraction.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-memory-extraction.ts", function: "judgeRetirementBatch", site_id: "extraction.atomic-memory-extraction.judgeRetirementBatch.64b641b407" });
		}
		decision = decideRemRetirementTargetFromReply(reply, offered);
		if (decision.outcome !== "refuse" || decision.reason !== "model_response_invalid") break;
	}
	return decision;
}

async function runAtomicArrivalRetirementJudgment(input: {
	store: MemoryStore;
	projectId: string;
	jobId: string;
	nominatedRowId: string;
	nowMs: number;
	transport: AtomicGenericExtractionTransport;
	maxTokens: number;
	requestId?: string;
}): Promise<void> {
	const candidateSet = await readAtomicArrivalRetirementCandidateSet(input.store, input);
	if (candidateSet === undefined || candidateSet.candidateRows.length === 0) return;
	const targetRowIds = new Set<string>();
	for (
		let start = 0;
		start < candidateSet.candidateRows.length;
		start += ARRIVAL_RETIREMENT_JUDGMENT_BATCH_SIZE
	) {
		const batch = candidateSet.candidateRows.slice(
			start,
			start + ARRIVAL_RETIREMENT_JUDGMENT_BATCH_SIZE,
		);
		const prompt = renderRemRetirementTargetPrompt({
			judgmentSkill: REM_UPDATE_JUDGMENT_SKILL.retirementTarget,
			nominatedRow: candidateSet.nominatedRow,
			candidateRows: batch,
		});
		const decision = await judgeRetirementBatch(input, prompt, batch);
		if (decision.outcome === "refuse") {
			journalAtomicArrivalRetirementRefusal(input.store, {
				jobId: input.jobId,
				nominatedRowId: input.nominatedRowId,
				reason: decision.reason,
				candidateSetSize: candidateSet.candidateRows.length,
			});
			// Only THIS batch is left unjudged. Stopping here let one unreadable answer about the
			// first sixteen candidates leave the row that should have closed open in a later batch.
			continue;
		}
		for (const rowId of decision.targetRowIds) targetRowIds.add(rowId);
	}
	await closeAtomicArrivalRetirementTargets(input.store, {
		jobId: input.jobId,
		nominatedRowId: input.nominatedRowId,
		targetRowIds: [...targetRowIds],
		supersededAt: input.nowMs,
	});
}
