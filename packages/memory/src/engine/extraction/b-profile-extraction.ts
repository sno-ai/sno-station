/** @file b-profile-extraction.ts
 * @purpose Runs the REM B-profile extraction lane, one user turn per call.
 * @boundary Turn selection, contract-shaped rendering, reply classification, and retry only.
 */

import { channel } from "node:diagnostics_channel";
import { z } from "zod";
import { Semaphore } from "async-mutex";
import { projectProfileCandidates } from "./b-profile-projection";
import { stripEnvelopeMetadata } from "./extraction-text-sanitizer";
import type { ExtractionDropRecord } from "./insight-distill-types";
import { redactSecrets } from "../security/redact";
import { LlmClientTerminalError, type LlmClient } from "../../model/llm-client";
import type { ChatMessage } from "../../model/llm-client-types";
import {
	escapeTranscriptRoleContinuations,
	unescapeTranscriptRoleContinuation,
} from "../shared/transcript-role-codec";
import type { CandidateMemory } from "../shared/types";
import { readModelReplyJson } from "../shared/model-reply-text";

const MESSAGE_LINE_PATTERN = /^(system|user|assistant):\s?(.*)$/;
/** One ask plus one retry, shared by every retryable reply class. */
const PROFILE_TURN_ATTEMPTS = 2;
/** Matches the GPU's measured near-linear request concurrency. */
const PROFILE_TURN_CONCURRENCY = 4;
const turnDiagnostics = channel("sno-station-mem.profile-turns");
/**
 * Output cap for one turn, chosen here because the serving side's own default is unusable:
 * measured 2026-08-18, a request carrying no `max_tokens` comes back `finish_reason: "length"`
 * at 16 completion tokens, cutting the JSON mid-string so the whole turn is lost.
 */
const PROFILE_EXTRACTION_MAX_TOKENS = 4096;
/**
 * Folds every line ending to `\n`, and every splitter here runs on the result.
 *
 * A transcript that arrives with CRLF used to lose EVERY turn silently: the line pattern ends
 * `(.*)$`, `.` does not match a carriage return in JavaScript, so no line matched, no turn was
 * found, and the lane made no calls and reported no error. The fold belongs before anything is
 * split, not per turn.
 */
function foldLineEndings(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/** Whitespace the cleaning pipeline treats as blank. Newlines are structure, not whitespace. */
const BLANK_LINE_PATTERN = /^[ \t]*$/;
const TRAILING_WHITESPACE_PATTERN = /[ \t]+$/;

/**
 * Stage 1 of the reply contract: raw structure only, no vocabulary check.
 *
 * A mirror of `b-profile-handover/output-schema.json`, which is the shipped artifact both
 * parties check training rows against. It is mirrored rather than loaded because the repository
 * carries no JSON-Schema validator and the artifact lives outside the build; the shapes are
 * one-to-one — three required keys, `additionalProperties: false` at both levels, `payload` an
 * object of anything.
 *
 * The vocabulary deliberately does NOT appear here. An enum of legal slugs at this stage would
 * make every slug the matcher could still repair fail as malformed, and the matcher would never
 * run — the exact defect the contract's review caught before it shipped.
 */
const stage1CandidateSchema = z
	.object({
		slug: z.string().min(1),
		topic_phrase: z.string().min(1),
		payload: z.record(z.string(), z.unknown()),
	})
	.strict();
const stage1ReplySchema = z
	.object({ profile_candidates: z.array(stage1CandidateSchema) })
	.strict();

export interface BProfileExtractionResult {
	candidates: CandidateMemory[];
	drops: ExtractionDropRecord[];
	projectionDrops: Record<string, number>;
	/** Turns that spent both attempts without a usable reply. */
	turnFailures: number;
	cleanEmptyModelResult: boolean;
}

export class BProfileLaneError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BProfileLaneError";
	}
}

/**
 * Renders the one prompt shape the adapter was trained on: `user: ` and a single turn.
 *
 * It used to render the whole conversation, one `role: content` line per message, plus a
 * trailing system line listing active section names. The adapter has seen neither in training,
 * and the distance between the two shapes is measurable at the first token: on a training-shaped
 * prompt the probability of an end token is 0.0000, on a 13-turn transcript 0.0459, on a 16-turn
 * transcript 0.1004 — which is the empty-reply fault that cost a third of one benchmark
 * persona's memories.
 */
export function renderBProfilePrompt(userTurnContent: string): string {
	return `user: ${escapeTranscriptRoleContinuations(userTurnContent)}`;
}

/**
 * The contract's cleaning pipeline, in its order, and the only implementation of it.
 *
 * Envelope stripping and secret redaction run over the whole transcript before turns are split,
 * which is where their existing implementations operate; the rest is per turn. Blank lines are
 * DELETED rather than collapsed (owner ruling 2026-08-18): the model never sees one, in
 * production or in training.
 */
export function cleanUserTurn(rawContent: string): string {
	return foldLineEndings(rawContent)
		.split("\n")
		.filter((line) => !BLANK_LINE_PATTERN.test(line))
		.map((line) => line.replace(TRAILING_WHITESPACE_PATTERN, ""))
		.join("\n")
		.trim();
}

/** Parses the normalized transcript back into the producer's ordered message list. */
export function parseBProfileMessages(conversationText: string): ChatMessage[] {
	const messages: ChatMessage[] = [];
	let current: ChatMessage | undefined;
	// Folded here too: this function is exported and every caller that builds its own transcript
	// would otherwise hit the same silent nothing.
	for (const line of foldLineEndings(conversationText).split("\n")) {
		const match = MESSAGE_LINE_PATTERN.exec(line);
		if (match) {
			if (current) messages.push({ ...current, content: current.content.trim() });
			const role = match[1];
			if (role !== "system" && role !== "user" && role !== "assistant") continue;
			current = { role, content: match[2] ?? "" };
			continue;
		}
		if (current) {
			current.content = `${current.content}\n${unescapeTranscriptRoleContinuation(line)}`;
		}
	}
	if (current) messages.push({ ...current, content: current.content.trim() });
	return messages;
}

interface TurnOutcome {
	candidates: CandidateMemory[];
	drops: ExtractionDropRecord[];
	projectionDrops: Record<string, number>;
	/** True when the turn parsed and carried nothing, which is a legitimate answer. */
	emptyModelResult: boolean;
}

interface UserTurn {
	turnIndex: number;
	content: string;
}

type ConcurrentTurnOutcome =
	| { kind: "completed"; outcome: TurnOutcome | undefined }
	| { kind: "terminal"; error: unknown }
	| { kind: "abandoned" };

/**
 * One logical task: one initial attempt plus at most one retry.
 *
 * The transport collapses "could not reach it" and "it answered with nothing" into a null
 * completion, and both are retryable, as is a reply that fails either validation stage. A reply
 * that passes is never retried — including one whose candidates all dropped, which is a real
 * answer about that turn and not a failure to get one.
 */
async function extractOneTurn(
	prompt: string,
	llm: LlmClient,
	turnIndex: number,
	turnText: string,
): Promise<TurnOutcome | undefined> {
	for (let attempt = 0; attempt < PROFILE_TURN_ATTEMPTS; attempt++) {
		let raw: string | null;
		try {
			raw = await llm.completeText({
				prompt,
				callLabel: "memory-extract-profile",
				adapterSlot: "memory-extract",
				maxTokens: PROFILE_EXTRACTION_MAX_TOKENS,
			});
		} catch (error) {
			// A slow or broken connection is this turn's problem. Measured 2026-08-18 against the
			// production route: the first of six turns timed out, the error left this loop, and
			// the whole conversation was abandoned after ONE request. Auth and cancellation still
			// propagate — a bad credential fails every remaining turn identically, and a
			// cancellation means the caller has already gone.
			if (isRetryableTransportError(error)) continue;
			throw error;
		}
		if (raw === null) continue;
		const outcome = readReply(raw, turnIndex, turnText);
		if (outcome) return outcome;
	}
	return undefined;
}

/**
 * True for a terminal error that describes THIS call rather than the whole run.
 *
 * The inverse of the repository's own stop-everything predicate
 * (`memory-extraction-pipeline.ts` `isExtractionTerminalError`, and the same shape in
 * `task-lifecycle-route.ts` and `profile-section-writer.ts`), mirrored rather than re-spelled so
 * the two cannot drift apart. Only a bad credential and a REAL cancellation end the chunk: the
 * first fails every remaining turn identically, the second means the caller has already gone.
 *
 * A timed-out request is not a cancellation even though it arrives wearing that label — the
 * transport aborts on its own deadline, so `category` reads `cancelled` with `requestTimedOut`
 * true. Reading that as a cancellation is what cost a six-turn conversation five of its turns,
 * measured 2026-08-18 against the production route.
 */
function isRetryableTransportError(error: unknown): boolean {
	return (
		error instanceof LlmClientTerminalError &&
		error.category !== "auth" &&
		!(error.category === "cancelled" && !error.requestTimedOut)
	);
}

/** Both validation stages. Undefined means malformed, which the caller retries. */
function readReply(
	raw: string,
	turnIndex: number,
	turnText: string,
): TurnOutcome | undefined {
	// The shared unwrapper owns think-stripping and candidate order; this file keeps the shape
	// decision. It used to strip only an EMPTY `<think></think>` at the very start and then parse
	// the whole reply, so a filled think block or any prose around the payload lost the turn.
	const decoded = readModelReplyJson(raw, (value) =>
		stage1ReplySchema.safeParse(value).success ? value : undefined,
	);
	if (decoded === undefined) return undefined;
	const projection = projectProfileCandidates(decoded);
	if (!projection.ok) return undefined;
	return {
		candidates: projection.memories.map((memory) => ({
			category: memory.category,
			sectionName: memory.section_name,
			abstract: memory.abstract,
			overview: memory.overview,
			content: memory.content,
			lane: memory.lane,
			rawCandidateJson: memory.rawCandidateJson,
			sourceTurnIndex: turnIndex,
			// The turn IS the evidence now. The subject gate needs the sentence a claim came
			// from, and this used to be assembled from the model's evidence pointers — which
			// answered "1" to 60 of 60 position probes. A gate handed no evidence cannot judge,
			// and a batch judged against nothing is a batch lost.
			gateEvidenceText: turnText,
			...(memory.dispositionReason ? { dispositionReason: memory.dispositionReason } : {}),
			...(memory.rawTopicPhrase ? { rawTopicPhrase: memory.rawTopicPhrase } : {}),
		})),
		drops: [],
		projectionDrops: { ...projection.dropped },
		emptyModelResult: projection.memories.length === 0,
	};
}

/**
 * Runs the lane over one conversation chunk: one logical task per user turn.
 *
 * Assistant and system turns are never sent (owner ruling 2026-08-18) — they carry nothing about
 * the user's own profile, and the future persona lane reverses this filter under its own
 * contract. A turn that spends both attempts is logged by the caller and abandoned alone; the
 * remaining turns still run, because one bad turn is not a reason to lose a conversation.
 */
export async function extractBProfileCandidatesFromChunk(input: {
	conversationText: string;
	llm: LlmClient;
}): Promise<BProfileExtractionResult> {
	const redacted = foldLineEndings(
		redactSecrets(stripEnvelopeMetadata(input.conversationText)),
	).trim();
	const messages = parseBProfileMessages(redacted);
	const turns = messages.flatMap((message, turnIndex): UserTurn[] => {
		if (message.role !== "user") return [];
		const content = cleanUserTurn(message.content);
		return content.length === 0 ? [] : [{ turnIndex, content }];
	});
	const candidates: CandidateMemory[] = [];
	if (turnDiagnostics.hasSubscribers) {
		turnDiagnostics.publish({ event: "start", userTurns: turns.length, concurrentTurns: Math.max(0, turns.length - 1) });
	}
	const drops: ExtractionDropRecord[] = [];
	const projectionDrops: Record<string, number> = {};
	let turnFailures = 0;
	let answeredTurns = 0;
	let emptyModelResults = 0;
	const runTurn = (turn: UserTurn): Promise<TurnOutcome | undefined> =>
		extractOneTurn(
			renderBProfilePrompt(turn.content),
			input.llm,
			turn.turnIndex,
			turn.content,
		);
	const outcomes: ConcurrentTurnOutcome[] = [];
	const first = turns[0];
	if (first) {
		outcomes.push({ kind: "completed", outcome: await runTurn(first) });
	}
	const semaphore = new Semaphore(PROFILE_TURN_CONCURRENCY);
	let terminalSeen = false;
	const remaining = await Promise.all(
		turns.slice(1).map((turn) =>
			semaphore.runExclusive(async (): Promise<ConcurrentTurnOutcome> => {
				if (terminalSeen) return { kind: "abandoned" };
				try {
					return { kind: "completed", outcome: await runTurn(turn) };
				} catch (error) {
					terminalSeen = true;
					return { kind: "terminal", error };
				}
			}),
		),
	);
	outcomes.push(...remaining);
	if (turnDiagnostics.hasSubscribers) {
		turnDiagnostics.publish({ event: "settled", userTurns: turns.length,
			completed: outcomes.filter(outcome => outcome.kind === "completed").length,
			abandoned: outcomes.filter(outcome => outcome.kind === "abandoned").length,
			terminal: outcomes.filter(outcome => outcome.kind === "terminal").length });
	}
	const terminal = outcomes.find(
		(outcome): outcome is Extract<ConcurrentTurnOutcome, { kind: "terminal" }> =>
			outcome.kind === "terminal",
	);
	if (terminal) throw terminal.error;

	for (const result of outcomes) {
		if (result.kind !== "completed") continue;
		const { outcome } = result;
		if (!outcome) {
			turnFailures++;
			continue;
		}
		answeredTurns++;
		if (outcome.emptyModelResult) emptyModelResults++;
		candidates.push(...outcome.candidates);
		drops.push(...outcome.drops);
		for (const [reason, count] of Object.entries(outcome.projectionDrops)) {
			projectionDrops[reason] = (projectionDrops[reason] ?? 0) + count;
		}
	}

	if (answeredTurns === 0 && turnFailures > 0) {
		throw new BProfileLaneError(
			`B-profile extraction produced no usable reply in ${turnFailures} turn(s)`,
		);
	}
	return {
		candidates,
		drops,
		projectionDrops,
		turnFailures,
		// Noise learning may only read a chunk whose every answered turn was a clean empty.
		cleanEmptyModelResult: answeredTurns > 0 && emptyModelResults === answeredTurns,
	};
}
