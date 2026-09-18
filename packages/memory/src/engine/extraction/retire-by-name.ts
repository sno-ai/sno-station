/** @file retire-by-name.ts
 * @purpose Extends one profile-owned retirement to model-named current-position rows.
 * @boundary Extraction-triggered shortlist, judgment, and metadata-only invalidation writes.
 */

import { createHash } from "node:crypto";
import { parseInsightMetadata } from "./memory-metadata-codec";
import { RETIRED_POSITION_JUDGMENT_SKILL } from "./retired-position-judgment-skill";
import { isTerminalLlmFailure, type LlmClient } from "../../model/llm-client";
import { canExtractorWrite } from "../shared/memory-kind-policy";
import type { MemoryEntry, MemoryMetadata } from "../shared/types";
import type { MemoryStore } from "../../store/store";

const SHORTLIST_LIMIT = 8;
export const RETIRE_BY_NAME_MAX_JUDGMENTS_PER_WRITE = 8;
export const RETIRE_BY_NAME_JUDGMENT_CONCURRENCY = 4;
export const RETIRE_BY_NAME_MAX_DURATION_MS = 30_000;
const SEARCH_LIMIT = 64;
const JUDGMENT_MAX_TOKENS = 64;
export const RETIRE_BY_NAME_CALL_LABEL = "profile-section-judgment";
export const RETIRE_BY_NAME_SAMPLING: {
	readonly temperature: "provider-default";
	readonly enableThinking: false;
	readonly maxTokens: 64;
} = {
	temperature: "provider-default",
	enableThinking: false,
	maxTokens: JUDGMENT_MAX_TOKENS,
} as const;

const RETIRE_BY_NAME_PROMPT_TEMPLATE: string = [
	RETIRED_POSITION_JUDGMENT_SKILL.currentPositionMatch,
	'Return JSON only: {"retire":true} or {"retire":false}.',
	"Use exactly one boolean field named retire.",
].join("\n\n");

export const RETIRE_BY_NAME_PROMPT_SHA256: string = createHash("sha256")
	.update(RETIRE_BY_NAME_PROMPT_TEMPLATE)
	.digest("hex");

export interface RetireRowsByNameResult {
	retiredIds: string[];
	completed: boolean;
}

function words(text: string): Set<string> {
	return new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

export function shortlistRetireByNameCandidates(
	retiredPosition: string,
	candidates: readonly MemoryEntry[],
): MemoryEntry[] {
	const retiredWords = words(retiredPosition);
	return candidates
		.map((entry) => {
			const candidateWords = words(entry.text);
			const overlap = [...candidateWords].filter((word) => retiredWords.has(word)).length;
			return { entry, score: candidateWords.size === 0 ? 0 : overlap / candidateWords.size };
		})
		.filter((candidate) => candidate.score > 0)
		.sort(
			(left, right) =>
				right.score - left.score || left.entry.id.localeCompare(right.entry.id),
		)
		.slice(0, SHORTLIST_LIMIT)
		.map((candidate) => candidate.entry);
}

function parseRetireVerdict(value: unknown): boolean | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== 1 || typeof record["retire"] !== "boolean") {
		return undefined;
	}
	return record["retire"];
}

function judgmentPrompt(retiredPosition: string, candidate: MemoryEntry): string {
	return [
		RETIRE_BY_NAME_PROMPT_TEMPLATE,
		`Retired position: ${JSON.stringify(retiredPosition)}`,
		`Candidate row: ${JSON.stringify(candidate.text)}`,
	].join("\n\n");
}

export async function retireRowsByName(params: {
	store: MemoryStore;
	llm?: LlmClient;
	scope: string;
	retiredPosition: string;
	currentPositionId: string;
	triggeringEventIdentity: string;
	triggeringSessionIdentity?: string;
	eventTime: number;
	excludedRowIds?: readonly string[];
	timeoutMs?: number;
	signal?: AbortSignal;
	judgmentBudget?: { remaining: number };
	/** Every row this call settled; the caller persists it so a retry walks past them. */
	judgedCandidateIds: Set<string>;
	deadlineMs?: number;
}): Promise<RetireRowsByNameResult> {
	const llm = params.llm;
	if (!params.retiredPosition.trim()) return { retiredIds: [], completed: true };
	// Not completed, because it is not: retiring by name needs a model and there is none. Saying
	// "completed" here would make the caller clear a queue a model-enabled run had filled, and
	// the stale rows it named would stay live for good. The unbounded growth this used to cause
	// is fixed where it belongs — the writer creates no such work without a model, and
	// `completeRetireByNamePending` does not touch an existing queue without one.
	if (!llm) return { retiredIds: [], completed: false };
	const excludedIds = new Set([
		params.currentPositionId,
		...(params.excludedRowIds ?? []),
	]);
	const matches = await params.store.searchKeyword(params.retiredPosition, {
		limit: SEARCH_LIMIT,
		projectIdFilter: [params.scope],
		// A refused fallback row is the user's own sentence and is served by default recall, so it
		// must be retirable by name like any other current-tense row (owner ruling 2026-09-01).
		includeRefused: true,
		// A retired row can never be a candidate, and a persona carries hundreds of them under
		// the same words; left in, they fill the search cap and hide the live rows behind it.
		// Any stamp at all disqualifies, so the bound is the largest timestamp, not the clock.
		excludeInvalidatedBefore: Number.MAX_SAFE_INTEGER,
		excludeMemoryIds: [...excludedIds],
	});
	// A capped search may have live candidates behind the cap. The caller keeps the work
	// pending and retries with the judged ids excluded, which walks the rest in later runs.
	const searchCapped = matches.length >= SEARCH_LIMIT;
	const eligible = matches.flatMap(({ entry }) => {
		if (excludedIds.has(entry.id)) return [];
		// A row that can never be a candidate for this work item joins the judged set, so a
		// retry excludes it and the capped search moves past it instead of returning it again.
		if (entry.category === "profile" || !canExtractorWrite(entry.category)) {
			params.judgedCandidateIds.add(entry.id);
			return [];
		}
		const metadata = parseInsightMetadata(entry.metadata, entry);
		const writtenByTriggeringEvent =
			metadata.source_message_id === params.triggeringEventIdentity ||
			(params.triggeringSessionIdentity !== undefined &&
				metadata.source_session === params.triggeringSessionIdentity &&
				metadata.asserted_at >= params.eventTime);
		if (metadata.invalidated_at !== undefined) return [];
		if (writtenByTriggeringEvent) {
			params.judgedCandidateIds.add(entry.id);
			return [];
		}
		return [entry];
	});
	const shortlist = shortlistRetireByNameCandidates(params.retiredPosition, eligible);
	if (shortlist.length === 0) {
		if (searchCapped) {
			for (const entry of eligible) params.judgedCandidateIds.add(entry.id);
		}
		return { retiredIds: [], completed: !searchCapped };
	}
	if (params.judgmentBudget && shortlist.length > params.judgmentBudget.remaining) {
		return { retiredIds: [], completed: false };
	}

	let resolved: Awaited<ReturnType<LlmClient["getResolvedConfig"]>>;
	try {
		resolved = await llm.getResolvedConfig();
	} catch {
		return { retiredIds: [], completed: false };
	}
	if (params.judgmentBudget) params.judgmentBudget.remaining -= shortlist.length;
	const judgments: Array<{
		candidate: MemoryEntry;
		verdict: boolean | undefined;
	}> = [];
	let completed = !searchCapped && eligible.length === shortlist.length;
	for (
		let offset = 0;
		offset < shortlist.length;
		offset += RETIRE_BY_NAME_JUDGMENT_CONCURRENCY
	) {
		if (params.deadlineMs !== undefined && Date.now() >= params.deadlineMs) {
			completed = false;
			break;
		}
		const batch = shortlist.slice(offset, offset + RETIRE_BY_NAME_JUDGMENT_CONCURRENCY);
		judgments.push(
			...(await Promise.all(
				batch.map(async (candidate) => {
					try {
						const remainingMs =
							params.deadlineMs === undefined
								? undefined
								: Math.max(1, params.deadlineMs - Date.now());
						const response = await llm.completeJson<unknown>({
							prompt: judgmentPrompt(params.retiredPosition, candidate),
							callLabel: RETIRE_BY_NAME_CALL_LABEL,
							adapterSlot: "profile-merge",
							maxTokens: JUDGMENT_MAX_TOKENS,
							enableThinking: false,
							...(remainingMs === undefined && params.timeoutMs === undefined
								? {}
								: {
										timeoutMs:
											remainingMs === undefined
												? params.timeoutMs
												: Math.min(params.timeoutMs ?? remainingMs, remainingMs),
									}),
							...(params.signal === undefined ? {} : { signal: params.signal }),
							// Walk every candidate against this reply's own shape; without it the first
							// valid object wins and the correct payload behind it is never seen.
							accept: (value) => parseRetireVerdict(value) !== undefined,
						});
						return { candidate, verdict: parseRetireVerdict(response) };
					} catch (error) {
						if (isTerminalLlmFailure(error)) throw error;
						return { candidate, verdict: undefined };
					}
				}),
			)),
		);
	}
	const retiredIds: string[] = [];
	for (const { candidate, verdict } of judgments) {
		if (verdict === undefined) {
			completed = false;
			continue;
		}
		if (!verdict) {
			params.judgedCandidateIds.add(candidate.id);
			continue;
		}
		const receiptPatch = {
			invalidated_at: params.eventTime,
			superseded_by: params.currentPositionId,
			retire_by_name_receipt: {
				prompt_sha256: RETIRE_BY_NAME_PROMPT_SHA256,
				model: resolved.model,
				preset: resolved.preset,
				sampling: RETIRE_BY_NAME_SAMPLING,
				triggering_event_identity: params.triggeringEventIdentity,
			},
		};
		const candidateMetadata = parseInsightMetadata(candidate.metadata, candidate);
		let wroteRetirement = false;
		let contentChangedUnderneath = false;
		try {
			await params.store.applyMetadataDeltas([
				{
					memoryId: candidate.id,
					deltaFn: (current) => {
						if (
							current.invalidated_at !== undefined ||
							(typeof current.valid_from === "number" && current.valid_from > params.eventTime)
						) {
							return undefined;
						}
						if (current.l2_content !== candidateMetadata.l2_content) {
							// The row the model judged is not the row on disk any more. It is still
							// live and unjudged, so it must not be excluded from the retry.
							contentChangedUnderneath = true;
							return undefined;
						}
						wroteRetirement = true;
						// The metadata codec preserves extension fields; integration reads the receipt back.
						return receiptPatch as Partial<MemoryMetadata>;
					},
				},
			]);
		} catch {
			completed = false;
			continue;
		}
		if (contentChangedUnderneath) {
			completed = false;
			continue;
		}
		params.judgedCandidateIds.add(candidate.id);
		if (!wroteRetirement) continue;
		retiredIds.push(candidate.id);
	}
	return { retiredIds, completed };
}
