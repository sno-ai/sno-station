import { FIXED_MEMORY_SNO_AI_EXTRACT } from "../../model/signed-registry-constants";
/** @file profile-section-writer.ts
 * @purpose Mutation-native profile section writer for current-state memory.
 * @boundary Owns profile rows only; no retrieval injection or conflict scan.
 */

import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { createLogger, privateLogReference } from "@snoai/utils/logger";
import { z } from "zod";
import { MAX_LIST_LIMIT } from "../../../config/index";
import {
	adapterAViewFromRecord,
	orderAdapterAPair,
	parseAdapterAChatVerdict,
	prospectiveProfileView,
	renderAdapterAPrompt,
	renderAdapterAChatPrompt,
	type AdapterAMemoryView,
	type AdapterAVerdict,
} from "../rem/index.js";
import liveClauseVerdictAttestation from "../../../fixtures/live-clause-verdict-gold/attestation.json" with {
	type: "json",
};
import liveClauseVerdictCorpus from "../../../fixtures/live-clause-verdict-gold/corpus.json" with {
	type: "json",
};
import { canonicalizeProfileSectionName } from "./b-profile-section-canonicalizer";
import { boundSectionContent, buildIndexedText } from "./extraction-text-sanitizer";
import { recordTokenCounter } from "../../store/memory-store-write-validation";
import {
	registerLiveClauseVerdictArtifacts,
	type LiveClauseVerdictRegistration,
} from "./live-clause-verdict-gate";
import {
	buildInsightMetadata,
	deriveFactKey,
	parseInsightMetadata,
	stringifyInsightMetadata,
} from "./memory-metadata-codec";
import {
	RETIRE_BY_NAME_MAX_DURATION_MS,
	RETIRE_BY_NAME_MAX_JUDGMENTS_PER_WRITE,
	retireRowsByName,
} from "./retire-by-name";
import { RETIRED_POSITION_JUDGMENT_SKILL } from "./retired-position-judgment-skill";
import { routeTaskLifecycleCandidate } from "./task-lifecycle-route";
import {
	currentMutationAttemptId,
	type MutationAttemptCompletion,
	runWithMutationAttempt,
} from "../operations/runtime-audit-log";
import { type LlmClient, LlmClientTerminalError } from "../../model/llm-client";
import { resolveLlmRoute } from "../../model/llm-mode-routing";
import type { LlmRoutingConfig } from "../../../config/plugin-config-mode-schema";
import type { MemoryEntry } from "../shared/types";
import { StorageError } from "../shared/errors";
import {
	StaleSupersedeTargetError,
	type MemoryStore,
	type StoreInput,
} from "../../store/store";

export type ProfileSectionOutcome = "merged" | "appended" | "tombstoned" | "no-op";

export interface RetireByNameRunBudget {
	remaining: number;
	deadlineMs: number;
}

export function createRetireByNameRunBudget(timeoutMs?: number): RetireByNameRunBudget {
	const durationMs = Math.min(
		timeoutMs ?? RETIRE_BY_NAME_MAX_DURATION_MS,
		RETIRE_BY_NAME_MAX_DURATION_MS,
	);
	return {
		remaining: RETIRE_BY_NAME_MAX_JUDGMENTS_PER_WRITE,
		deadlineMs: Date.now() + durationMs,
	};
}

type ProfileMutationOutcome = MutationAttemptCompletion["outcome"];

interface ProfileSectionUpdateResult {
	outcome: ProfileSectionOutcome;
	rowId: string;
	mutationOutcome: ProfileMutationOutcome;
	refusalReason?: string;
}

export const PROFILE_IDENTITY_SECTION = "identity";
export const retiredProfileSectionMarker = (canonicalSection: string) =>
	`${canonicalSection}: none`;
const PROFILE_CONFLICT_TOP_K = 5;
const CLEAR_RETIRE_BY_NAME_PENDING_ATTEMPTS = 3;
const ADVANCE_PROFILE_CONFIRMATION_ATTEMPTS = 3;
/** Work items one profile row's pending marker may hold. Past this the oldest is dropped. */
const RETIRE_BY_NAME_MAX_PENDING_WORK_ITEMS = 16;
const log = createLogger("sno-station-mem:profile-section-writer");

function adapterAViewFromEntry(entry: MemoryEntry): AdapterAMemoryView {
	const metadata = parseInsightMetadata(entry.metadata, entry);
	return adapterAViewFromRecord({
		text: metadata.l2_content ?? entry.text,
		kind: entry.category,
		validFrom: metadata.valid_from ?? entry.timestamp,
		assertedAt: metadata.asserted_at ?? entry.timestamp,
		contentHash: entry.contentHash,
	});
}

export interface ProfileSectionSource {
	sessionKey?: string;
	messageId?: string;
	source?: "ambient-learning" | "manual" | "reflection";
}

export interface RunProfileSectionUpdateParams {
	scope: string;
	sectionName: string;
	topic?: string;
	newAssertion: string;
	evidence?: string;
	taskStatusEvidence?: string;
	metadataPatch?: Record<string, unknown>;
	source: ProfileSectionSource;
	store: MemoryStore;
	/** Absent in local-first mode; merge/classify/match use deterministic fallbacks. */
	llm?: LlmClient;
	/**
	 * Product-mode routing slice. When present, the cross-row conflict scan
	 * uses the resolved Sno or agent transport. Local First skips the model;
	 * any call failure keeps both conflicting rows.
	 */
	routing?: LlmRoutingConfig;
	at: number;
	timeoutMs?: number;
	signal?: AbortSignal;
	retireByNameBudget?: RetireByNameRunBudget;
	/** The upstream B-profile gate already confirmed this is a task candidate. */
	confirmedTaskCandidate?: boolean;
}

/**
 * The action vocabulary the writer knows how to execute. The runtime list and
 * the compile-time union are one declaration so a reply can be checked against
 * exactly the actions we can carry out.
 */
const PROFILE_MERGE_ACTIONS = ["merge", "tombstone", "no-op"] as const;
type ProfileMergeAction = (typeof PROFILE_MERGE_ACTIONS)[number];

export interface ProfileJudgmentClause {
	origin: "stored" | "incoming";
	value: string;
}

interface ProfileJudgmentResponse {
	verdict: ProfileMergeAction;
	retired_clause_indices: number[];
}

interface ProfileTextResponse {
	abstract: string;
	overview: string;
	content: string;
}

interface UsableProfileJudgment {
	verdict: ProfileMergeAction;
	retiredClauseIndices: number[];
	retiredClauses: string[];
}

interface LifecycleRetirementContext {
	incomingAssertion: string;
	liveSiblingSectionNames: string[];
	/** Unusable ANSWERS so far. Transport failures are excluded — see `deferLifecycleRetirement`. */
	attempts?: number;
	/** Why the last deferral happened. Carried so a dropped item can say what kept failing. */
	lastFailure?: "malformed-answer" | "transport";
}

interface DeferredLifecycleRetirement {
	positions: string[];
	context: LifecycleRetirementContext;
}

type LifecycleRetirementClassification =
	| { kind: "classified"; positions: string[] }
	| { kind: "deferred"; work: DeferredLifecycleRetirement };

type ProfileMergeResult =
	| {
			kind: "merge";
			content: string;
			/** Absent when the rewrite was not persisted; the store derives both from the content. */
			abstract?: string;
			overview?: string;
			retireByNamePositions: string[];
			deferredLifecycleRetirement?: DeferredLifecycleRetirement;
			retainedClauses: string[];
			/** Present when the rewrite was not used, naming why. Absent when it was persisted. */
			textRepair?: { reason: string };
			retirementRecheck?: ProfileRetirementRecheckReceipt;
	  }
	| { kind: "tombstone" }
	| { kind: "no-op" }
	| { kind: "preserved-without-adjudication"; content: string; reason: string };

const profileJudgmentResponseSchema: z.ZodType<ProfileJudgmentResponse> = z
	.object({
		verdict: z.enum(PROFILE_MERGE_ACTIONS),
		retired_clause_indices: z.array(z.number().int().nonnegative()),
	})
	.strict();

const profileTextResponseSchema: z.ZodType<ProfileTextResponse> = z
	.object({
		abstract: z.string().trim().min(1),
		overview: z.string().trim().min(1),
		content: z.string(),
	})
	.strict();

const lifecycleRetirementResponseSchema = z
	.object({ lifecycle_retired_clause_indices: z.array(z.number().int().nonnegative()) })
	.strict();

export const PROFILE_SECTION_JUDGMENT_CALL_LABEL = "profile-section-judgment";
export const PROFILE_SECTION_TEXT_CALL_LABEL = "profile-section-text";
export const PROFILE_SECTION_LIFECYCLE_RETIREMENT_CALL_LABEL =
	"profile-section-lifecycle-retirement";
export const PROFILE_SECTION_JUDGMENT_INSTRUCTIONS = [
	"Judge one current-state profile update.",
	'Return JSON only: {"verdict":"merge|tombstone|no-op","retired_clause_indices":[0]}.',
	"Do not return content, summaries, explanations, or any generated prose.",
	"Indices are zero-based positions into the supplied array. Use each index at most once.",
	"For merge, retire only clauses that the incoming assertion replaces, removes, or makes historical.",
	"For tombstone, retire the whole section and return an empty index array.",
	"Choose tombstone when the incoming clause explicitly asks to delete, remove, forget, or stop tracking the entire saved section or preference. A changed or negated preference that still states current user information is merge, not tombstone.",
	"For no-op, return an empty index array and use it only when the stored state already covers every incoming clause.",
	"Choose no-op when stored and incoming clauses state the same fact or preference with synonymous wording; a paraphrase is not a replacement.",
	"Never retire every incoming clause.",
	"For preferences.general, ownership is an independent retirement reason and does not require the incoming clause to contradict or replace the stored clause. Each listed sibling suffix names the topic it owns. Retire a stored general clause when its meaning belongs to that topic; for example, when preferences.films is listed, retire a stored general clause saying the user likes James Stewart movies. Keep a general clause when no listed sibling owns its topic. One fact family has one owner.",
] as const;
export const PROFILE_SECTION_JUDGMENT_MODEL_CONFIG = {
	preset: FIXED_MEMORY_SNO_AI_EXTRACT as typeof FIXED_MEMORY_SNO_AI_EXTRACT,
	provider: "sno-gpu",
	model: "qwen3.8-27b-extract",
} as const;
export const PROFILE_SECTION_JUDGE_IMPLEMENTATION_CONTRACT = {
	schemaVersion: 1,
	responseFields: ["verdict", "retired_clause_indices"],
	strictResponse: true,
	zeroBasedIndices: true,
	uniqueIndices: true,
	inRangeIndices: true,
	tombstoneAndNoOpRequireEmptyIndices: true,
	allIncomingRetiredIsUnusable: true,
} as const;

function stableSha256(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export const PROFILE_SECTION_JUDGMENT_BINDINGS: {
	readonly promptSha256: string;
	readonly modelConfigSha256: string;
	readonly judgeImplementationSha256: string;
} = {
	promptSha256: stableSha256(PROFILE_SECTION_JUDGMENT_INSTRUCTIONS),
	modelConfigSha256: stableSha256(PROFILE_SECTION_JUDGMENT_MODEL_CONFIG),
	judgeImplementationSha256: stableSha256(PROFILE_SECTION_JUDGE_IMPLEMENTATION_CONTRACT),
};

const LIVE_CLAUSE_VERDICT_REGISTRATION: LiveClauseVerdictRegistration =
	registerLiveClauseVerdictArtifacts({
		corpus: liveClauseVerdictCorpus,
		attestation: liveClauseVerdictAttestation,
		expectedPromptSha256: PROFILE_SECTION_JUDGMENT_BINDINGS.promptSha256,
		expectedModelConfigSha256: PROFILE_SECTION_JUDGMENT_BINDINGS.modelConfigSha256,
		expectedJudgeImplementationSha256:
			PROFILE_SECTION_JUDGMENT_BINDINGS.judgeImplementationSha256,
	});

export const PROFILE_SECTION_JUDGMENT_REGISTRATION_ENABLED: boolean =
	LIVE_CLAUSE_VERDICT_REGISTRATION.enabled;

export function renderProfileSectionJudgmentPrompt(input: {
	sectionName: string;
	topic?: string;
	clauses: readonly ProfileJudgmentClause[];
	evidence?: string;
	liveSiblingSectionNames?: readonly string[];
}): string {
	return [
		...PROFILE_SECTION_JUDGMENT_INSTRUCTIONS,
		`Section: ${input.sectionName}`,
		input.topic ? `Topic: ${input.topic}` : "Topic: <missing>",
		`Eligible clauses: ${JSON.stringify(input.clauses)}`,
		`Live specific sibling sections: ${JSON.stringify(input.liveSiblingSectionNames ?? [])}`,
		input.evidence ? `Evidence:\n${input.evidence}` : "",
	].join("\n\n");
}

function renderProfileSectionTextPrompt(input: {
	sectionName: string;
	topic?: string;
	retainedClauses: readonly string[];
	retiredClauses: readonly string[];
	evidence?: string;
}): string {
	return [
		"Write one current-state profile section after a separate judgment has already finished.",
		'Return JSON only: {"abstract":"...","overview":"...","content":"..."}.',
		"Do not decide or name superseded clauses. Do not return a verdict or clause indices.",
		"The content must contain every retained clause below verbatim as a whole clause. Do not add connective text or any other clause. Do not reword or omit a retained clause.",
		`Section: ${input.sectionName}`,
		input.topic ? `Topic: ${input.topic}` : "Topic: <missing>",
		`Retained clauses: ${JSON.stringify(input.retainedClauses)}`,
		`Already retired clauses: ${JSON.stringify(input.retiredClauses)}`,
		input.evidence ? `Evidence:\n${input.evidence}` : "",
	].join("\n\n");
}

export function parseProfileSectionJudgment(
	response: unknown,
	clauses: readonly ProfileJudgmentClause[],
): UsableProfileJudgment | undefined {
	const parsed = profileJudgmentResponseSchema.safeParse(response);
	if (!parsed.success) return undefined;
	const indices = parsed.data.retired_clause_indices;
	if (new Set(indices).size !== indices.length) return undefined;
	if (indices.some((index) => index >= clauses.length)) return undefined;
	if (parsed.data.verdict !== "merge" && indices.length > 0) return undefined;
	const incomingIndices = clauses.flatMap((clause, index) =>
		clause.origin === "incoming" ? [index] : [],
	);
	if (
		incomingIndices.length > 0 &&
		incomingIndices.every((index) => indices.includes(index))
	) {
		return undefined;
	}
	return {
		verdict: parsed.data.verdict,
		retiredClauseIndices: indices,
		retiredClauses: indices.map((index) => clauses[index]?.value ?? ""),
	};
}

/**
 * Deferrals a single lifecycle work item may collect before it is dropped. A route that is ON
 * but keeps answering unusably (transport error, malformed reply) would otherwise re-queue the
 * same positions on every write for the life of the store.
 */
const LIFECYCLE_RETIREMENT_MAX_DEFERRALS = 3;

/**
 * Only an ANSWER can exhaust the bound. A transport error or timeout says nothing about whether
 * the route can ever answer, and three timeouts is an ordinary afternoon on a busy GPU — counting
 * them would throw away a retirement and leave the stale row it named live for good. A malformed
 * or empty answer from a route that resolved ON is the failure that repeats, so it is the one
 * that counts. Owner ruling via CTS, 2026-09-02, resolving the DEC-12 conflict.
 */
function deferLifecycleRetirement(
	retiredClauses: readonly string[],
	incomingAssertion: string,
	liveSiblingSectionNames: readonly string[],
	attempts = 0,
	failure: "malformed-answer" | "transport" = "malformed-answer",
): LifecycleRetirementClassification {
	const nextAttempts = failure === "transport" ? attempts : attempts + 1;
	if (nextAttempts >= LIFECYCLE_RETIREMENT_MAX_DEFERRALS) {
		log.warn("lifecycle retirement dropped after repeated unusable answers", {
			positions: retiredClauses.length,
			attempts: nextAttempts,
			failure,
		}, {
			event_name: "sno_station_mem.profile-section-writer.lifecycle.retirement.dropped.after.repeated.unusable.answers",
			file: "packages/sno-station-mem/src/engine/extraction/profile-section-writer.ts",
			function: "deferLifecycleRetirement",
			site_id: "profile-section-writer.deferLifecycleRetirement.f94b354ff4",
		});
		return { kind: "classified", positions: [] };
	}
	return {
		kind: "deferred",
		work: {
			positions: [...retiredClauses],
			context: {
				incomingAssertion,
				liveSiblingSectionNames: [...liveSiblingSectionNames],
				attempts: nextAttempts,
				lastFailure: failure,
			},
		},
	};
}

async function lifecycleRetireByNamePositions(
	params: RunProfileSectionUpdateParams,
	liveSiblingSectionNames: readonly string[],
	retiredClauses: readonly string[],
	incomingAssertion = params.newAssertion,
	attempts = 0,
): Promise<LifecycleRetirementClassification> {
	if (
		params.sectionName !== "preferences.general" ||
		liveSiblingSectionNames.length === 0 ||
		retiredClauses.length === 0
	) {
		return { kind: "classified", positions: [...retiredClauses] };
	}
	// Decided before the call, never from its answer. With no model the parse fails on undefined
	// or null and the deferred branch queues the work with its classification context; the queue
	// then re-defers on every later write and the marker never clears. Nothing to classify here,
	// so nothing is queued. A live route that answers badly still defers, and is bounded below.
	if (profileMergeCallHasNoModel(params, PROFILE_SECTION_LIFECYCLE_RETIREMENT_CALL_LABEL)) {
		return { kind: "classified", positions: [] };
	}
	let response: unknown;
	try {
		response = await params.llm?.completeJson<unknown>({
			prompt: [
				"Separate lifecycle retirement from profile ownership cleanup.",
				'Return JSON only: {"lifecycle_retired_clause_indices":[0]}.',
				"Indices are zero-based positions into Removed clauses.",
				"Include a clause only when the incoming assertion replaces it, removes it, or makes it historical.",
				"Exclude a clause removed only because a live specific sibling section owns its topic.",
				`Incoming assertion: ${JSON.stringify(incomingAssertion)}`,
				`Removed clauses: ${JSON.stringify(retiredClauses)}`,
				`Live specific sibling sections: ${JSON.stringify(liveSiblingSectionNames)}`,
			].join("\n\n"),
			callLabel: PROFILE_SECTION_LIFECYCLE_RETIREMENT_CALL_LABEL,
			adapterSlot: "profile-merge",
			...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
			...(params.signal ? { signal: params.signal } : {}),
		});
	} catch (error) {
		if (!isDeterministicFallbackError(error)) throw error;
		return deferLifecycleRetirement(
			retiredClauses,
			incomingAssertion,
			liveSiblingSectionNames,
			attempts,
			"transport",
		);
	}
	const parsed = lifecycleRetirementResponseSchema.safeParse(response);
	if (!parsed.success) {
		return deferLifecycleRetirement(
			retiredClauses,
			incomingAssertion,
			liveSiblingSectionNames,
			attempts,
		);
	}
	const indices = parsed.data.lifecycle_retired_clause_indices;
	if (
		new Set(indices).size !== indices.length ||
		indices.some((index) => index >= retiredClauses.length)
	) {
		return deferLifecycleRetirement(
			retiredClauses,
			incomingAssertion,
			liveSiblingSectionNames,
			attempts,
		);
	}
	return {
		kind: "classified",
		positions: indices.map((index) => retiredClauses[index] ?? "").filter(Boolean),
	};
}

function isDeterministicFallbackError(error: unknown): error is LlmClientTerminalError {
	return (
		error instanceof LlmClientTerminalError &&
		(error.category === "timeout" ||
			error.category === "transport" ||
			(error.category === "cancelled" && error.requestTimedOut))
	);
}

function rethrowConflictCancellation(error: unknown): void {
	if (
		error instanceof LlmClientTerminalError &&
		(error.category === "auth" || (error.category === "cancelled" && !error.requestTimedOut))
	) {
		throw error;
	}
}

export async function runProfileSectionUpdate(
	params: RunProfileSectionUpdateParams,
): Promise<{ outcome: ProfileSectionOutcome; rowId: string }> {
	const started = performance.now();
	try {
	const trimmedSectionName = params.sectionName.trim();
	if (!trimmedSectionName) {
		throw new Error("profile-section-writer: sectionName is required");
	}
	// A blank scope resolves to one shared profile for every caller that passes it.
	if (!params.scope.trim()) {
		throw new Error("profile-section-writer: scope is required");
	}
	const sectionName = canonicalizeProfileSectionName(trimmedSectionName);
	const normalizedParams =
		sectionName === params.sectionName ? params : { ...params, sectionName };
	if (sectionName === "active_tasks") {
		const result = await runTypedActiveTaskUpdate(normalizedParams);
		log.info("Profile task update completed", {
			outcome: result.outcome, memory_id: result.rowId, duration_ms: performance.now() - started,
			committed_count: "unavailable", committed_count_reason: "task_route_returns_outcome_not_count",
		}, {
			event_name: "memory.profile.completed", file: "packages/sno-station-mem/src/engine/extraction/profile-section-writer.ts",
			function: "runProfileSectionUpdate", site_id: "memory.profile.task.completed",
		});
		return result;
	}
	const result = await runWithMutationAttempt({
		stateDir: dirname(params.store.dbPath),
		event: "memory_superseded",
		operation: "profile-section-update",
		writer: "profile-section",
		subject: sectionName,
		run: async () => {
			try {
				return await runProfileSectionUpdateOnce(normalizedParams);
			} catch (error) {
				if (!(error instanceof StaleSupersedeTargetError)) throw error;
				return runProfileSectionUpdateOnce(normalizedParams);
			}
		},
		completedOutcome: (completed) => ({
			outcome: completed.mutationOutcome,
			...(completed.refusalReason === undefined
				? {}
				: { refusalReason: completed.refusalReason }),
		}),
	});
	log.info("Profile section update completed", {
		outcome: result.outcome, mutation_outcome: result.mutationOutcome,
		memory_id: result.rowId, duration_ms: performance.now() - started,
		reason_code: result.refusalReason ?? "not_refused",
		committed_count: "unavailable", committed_count_reason: "writer_returns_outcome_not_count",
	}, {
		event_name: "memory.profile.completed", file: "packages/sno-station-mem/src/engine/extraction/profile-section-writer.ts",
		function: "runProfileSectionUpdate", site_id: "memory.profile.section.completed",
	});
	return { outcome: result.outcome, rowId: result.rowId };
	} catch (error) {
		log.warn("Profile section update failed", {
			outcome: "failed", error, duration_ms: performance.now() - started,
			committed_count: "unavailable", committed_count_reason: "multi_step_write_failed",
		}, {
			event_name: "memory.profile.failed", file: "packages/sno-station-mem/src/engine/extraction/profile-section-writer.ts",
			function: "runProfileSectionUpdate", site_id: "memory.profile.failed",
		});
		throw error;
	}
}

async function runTypedActiveTaskUpdate(
	params: RunProfileSectionUpdateParams,
): Promise<{ outcome: ProfileSectionOutcome; rowId: string }> {
	const sessionKey = params.source.sessionKey ?? params.source.messageId;
	const replayIdentity = params.source.messageId;
	if (!sessionKey || !replayIdentity) {
		throw new Error(
			"profile-section-writer: active task updates require an authorized replay identity",
		);
	}
	const route = await routeTaskLifecycleCandidate({
		projectId: params.scope,
		candidateText: params.newAssertion,
		confirmedTaskCandidate: params.confirmedTaskCandidate !== false,
		source: {
			kind: "authorized_untraced",
			sessionKey,
			replayIdentity,
			assertionOrdinal: 0,
		},
		firstResolutionNowMs: params.at,
		store: params.store,
		...(params.llm === undefined ? {} : { llm: params.llm }),
		...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
		...(params.signal === undefined ? {} : { signal: params.signal }),
	});
	if (route.status === "none") {
		const safetyNet = await writeEpisodicSafetyNet(params, "task_lifecycle_none");
		return { outcome: safetyNet.replayed ? "no-op" : "appended", rowId: safetyNet.rowId };
	}
	const { result } = route;
	const outcome =
		result.write.replayed ||
		result.write.result === "none" ||
		result.write.result === "uncertain"
			? "no-op"
			: result.write.result === "created_instance" ||
					result.write.result === "created_unresolved_instance"
				? "appended"
				: "merged";
	return {
		outcome,
		rowId: result.write.activeTaskId ?? "",
	};
}

async function runProfileSectionUpdateOnce(
	params: RunProfileSectionUpdateParams,
): Promise<ProfileSectionUpdateResult> {
	const sectionName = params.sectionName;
	const factKey = profileFactKey(sectionName);
	const countRecordTokens = await recordTokenCounter(params.store.embedder);
	const existing = params.store.getByFactKey(params.scope, factKey);
	if (!existing) {
		const content = params.newAssertion;
		const written = await writeProfileRow({
			params,
			content,
			input: profileStoreInput({
				countRecordTokens,
				scope: params.scope,
				sectionName,
				topic: params.topic,
				content,
				evidence: params.evidence,
				metadataPatch: params.metadataPatch,
				source: params.source,
				at: params.at,
				supersedes: undefined,
			}),
			outcome: "appended",
		});
		return {
			...written,
			mutationOutcome: written.outcome === "no-op" ? "no-mutation" : "committed",
		};
	}
	// A chronologically older assertion must not replace or delete a newer
	// live value for the same section.
	const existingValidFrom = parseInsightMetadata(existing.metadata, existing).valid_from;
	if (typeof existingValidFrom === "number" && params.at < existingValidFrom) {
		await resumeRetireByNamePending(existing, params);
		return { outcome: "no-op", rowId: existing.id, mutationOutcome: "no-mutation" };
	}
	const existingContent = parseInsightMetadata(existing.metadata, existing).l2_content;
	const existingIsRetiredMarker =
		typeof existingContent === "string" &&
		normalizeExactAssertionText(existingContent) ===
			normalizeExactAssertionText(retiredProfileSectionMarker(sectionName));
	if (
		typeof existingContent === "string" &&
		normalizeExactAssertionText(existingContent) ===
			normalizeExactAssertionText(params.newAssertion)
	) {
		// The row does not change, but the confirmation still happened, and the out-of-order
		// guard above reads `valid_from` to decide what is stale. Leaving it at the FIRST
		// assertion let a message from between the two overwrite a value the user had just
		// restated: tea at t1, tea again at t3, then a delayed "coffee now" from t2 compared
		// itself against t1, passed, and the profile became coffee. Only ever forward, so a
		// slower older call cannot drag the bar back.
		// The confirmation rewrote this row's metadata, so the pending work below has to read the
		// row as it now stands; handing it the pre-confirmation snapshot spends one of its own
		// compare-and-set attempts losing a conflict it can see coming.
		const confirmed = await advanceProfileConfirmation(existing, existingValidFrom, params);
		await resumeRetireByNamePending(confirmed, params);
		return { outcome: "no-op", rowId: existing.id, mutationOutcome: "no-mutation" };
	}
	const tombstoneReplay = await tombstoneReplayResult(params, factKey);
	if (tombstoneReplay) {
		return { ...tombstoneReplay, mutationOutcome: "no-mutation" };
	}

	const merged = await mergeProfileSection(existing, params);
	if (merged.kind === "preserved-without-adjudication") {
		if (
			typeof existingContent === "string" &&
			normalizeExactAssertionText(merged.content) ===
				normalizeExactAssertionText(existingContent)
		) {
			await resumeRetireByNamePending(existing, params);
			return { outcome: "no-op", rowId: existing.id, mutationOutcome: "no-mutation" };
		}
		const written = await writeProfileRow({
			params,
			content: merged.content,
			input: profileStoreInput({
				countRecordTokens,
				scope: params.scope,
				sectionName,
				topic: params.topic,
				content: merged.content,
				evidence: params.evidence,
				metadataPatch: {
					...params.metadataPatch,
					merged_without_adjudication: true,
					adjudication_failure_reason: merged.reason,
				},
				source: params.source,
				at: params.at,
				supersedes: existing.id,
			}),
			existing,
			outcome: "merged",
		});
		return {
			...written,
			mutationOutcome:
				written.outcome === "no-op" ? "no-mutation" : "preserved-without-adjudication",
		};
	}
	if (merged.kind === "no-op") {
		const confirmed = await advanceProfileConfirmation(existing, existingValidFrom, params);
		await resumeRetireByNamePending(confirmed, params);
		return { outcome: "no-op", rowId: existing.id, mutationOutcome: "no-mutation" };
	}
	if (merged.kind === "tombstone") {
		if (existingIsRetiredMarker) {
			await resumeRetireByNamePending(existing, params);
			let event: MemoryEntry;
			try {
				event = await params.store.supersede({
					create: tombstoneEventStoreInput(params, existing.id),
					closes: [],
					activeFactGuard: {
						factKey,
						expectedId: existing.id,
					},
				});
			} catch (error) {
				const replay = await tombstoneReplayResult(params, factKey);
				if (replay) return { ...replay, mutationOutcome: "no-mutation" };
				throw error;
			}
			log.warn("retired profile section tombstone reaffirmed", {
				eventRowId: event.id,
				markerRowId: existing.id,
				section: sectionName,
				verdict: merged.kind,
			}, {
				event_name: "sno_station_mem.profile-section-writer.retired.profile.section.tombstone.reaffirmed",
				file: "packages/sno-station-mem/src/engine/extraction/profile-section-writer.ts",
				function: "runProfileSectionUpdateOnce",
				site_id: "profile-section-writer.runProfileSectionUpdateOnce.28936dcd3c",
			});
			return { outcome: "tombstoned", rowId: existing.id, mutationOutcome: "committed" };
		}
		// Retiring a whole section names every clause it held, and judging each of those needs a
		// model. With none, carry forward only the queue that already exists: a section deleted
		// and re-created repeatedly in local-first would otherwise append work on every deletion.
		const tombstonePending = appendRetireByNameWork(
			readRetireByNamePending(existing),
			profileMergeCallHasNoModel(params, PROFILE_SECTION_JUDGMENT_CALL_LABEL)
				? []
				: splitExactClauses(existingContent ?? existing.text),
			params,
			[existing.id],
			"profile-tombstone",
		);
		const markerInput = profileStoreInput({
			countRecordTokens,
			scope: params.scope,
			sectionName,
			topic: params.topic,
			content: retiredProfileSectionMarker(sectionName),
			metadataPatch: {
				idempotency_key: tombstoneMarkerIdempotencyKey(params),
				// The marker's identity is the section and this retirement, not its repeated text.
				content_identity_key: tombstoneMarkerIdempotencyKey(params),
			},
			source: params.source,
			at: params.at,
			supersedes: existing.id,
		});
		const replacement =
			tombstonePending === undefined
				? markerInput
				: {
						...markerInput,
						metadata: addRetireByNamePending(markerInput.metadata, tombstonePending),
					};
		let created: { event: MemoryEntry; replacement: MemoryEntry };
		try {
			created = await params.store.createEventAndSupersede({
				event: tombstoneEventStoreInput(params, existing.id),
				replacement,
				closeExisting: [
					{
						id: existing.id,
						buildMetadata: ({ replacementId }) =>
							closeProfileMetadata(existing, replacementId, params.at),
					},
				],
				profileRecovery: {
					mutationAttemptId: currentMutationAttemptId(),
					sectionName,
					removedAtMs: params.at,
				},
			});
		} catch (error) {
			const replay = await tombstoneReplayResult(params, factKey);
			if (replay) return { ...replay, mutationOutcome: "no-mutation" };
			throw error;
		}
		if (tombstonePending) {
			await completeRetireByNamePending(created.replacement, params, tombstonePending);
		}
		log.warn("profile section tombstoned; incoming assertion preserved", {
			closedRowId: existing.id,
			eventRowId: created.event.id,
			markerRowId: created.replacement.id,
			section: sectionName,
			verdict: merged.kind,
		}, {
			event_name: "sno_station_mem.profile-section-writer.profile.section.tombstoned.incoming.assertion.preserved",
			file: "packages/sno-station-mem/src/engine/extraction/profile-section-writer.ts",
			function: "runProfileSectionUpdateOnce",
			site_id: "profile-section-writer.runProfileSectionUpdateOnce.e3afdfb6d8",
		});
		return {
			outcome: "tombstoned",
			rowId: created.replacement.id,
			mutationOutcome: "committed",
		};
	}
	if (
		typeof existingContent === "string" &&
		normalizeExactAssertionText(merged.content) === normalizeExactAssertionText(existingContent)
	) {
		await resumeRetireByNamePending(existing, params);
		return { outcome: "no-op", rowId: existing.id, mutationOutcome: "no-mutation" };
	}

	const written = await writeProfileRow({
		params,
		content: merged.content,
		input: profileStoreInput({
			countRecordTokens,
			scope: params.scope,
			sectionName,
			topic: params.topic,
			content: merged.content,
			evidence: params.evidence,
			metadataPatch: {
				...params.metadataPatch,
				...(merged.retirementRecheck
					? { profile_retirement_recheck: merged.retirementRecheck }
					: {}),
			},
			source: params.source,
			at: params.at,
			supersedes: existing.id,
			abstract: sectionName === PROFILE_IDENTITY_SECTION ? undefined : merged.abstract,
			overview: sectionName === PROFILE_IDENTITY_SECTION ? undefined : merged.overview,
		}),
		existing,
		retiredPositions: merged.retireByNamePositions,
		...(merged.deferredLifecycleRetirement
			? { deferredLifecycleRetirement: merged.deferredLifecycleRetirement }
			: {}),
		outcome: "merged",
	});
	if (merged.textRepair !== undefined) {
		log.warn("profile text step not used; row written from the judged clauses", {
			memory_id: existing.id,
			section: sectionName,
			reason_code: "text_repair_required", reason_detail: merged.textRepair.reason,
		}, {
			event_name: "sno_station_mem.profile-section-writer.profile.text.step.not.used.row.written.from.the.judged.clauses",
			file: "packages/sno-station-mem/src/engine/extraction/profile-section-writer.ts",
			function: "runProfileSectionUpdateOnce",
			site_id: "profile-section-writer.runProfileSectionUpdateOnce.80241da6d8",
		});
	}
	return {
		...written,
		mutationOutcome:
			written.outcome === "no-op"
				? "no-mutation"
				: merged.textRepair !== undefined
					? "repaired-merge-text"
					: "committed",
	};
}

function profileFactKey(sectionName: string): string {
	const factKey = deriveFactKey({ kind: "profile", section_name: sectionName });
	if (!factKey) {
		throw new Error("profile-section-writer: unable to derive profile fact_key");
	}
	return factKey;
}

export const PROFILE_RETIREMENT_RECHECK_CALL_LABEL = "profile-retirement-recheck";
/**
 * Retirements past this count in one write are kept, never judged; the cap bounds model calls.
 * One general rewrite retired at most 9 clauses in the 2026-09-01 store (99% retired 4 or fewer).
 */
export const PROFILE_RETIREMENT_RECHECK_MAX_PER_WRITE = 16;
const PROFILE_RETIREMENT_RECHECK_CONCURRENCY = 4;
const PROFILE_RETIREMENT_RECHECK_MAX_TOKENS = 64;
const PROFILE_RETIREMENT_RECHECK_SIBLING_CHARS = 600;
const PROFILE_RETIREMENT_RECHECK_PROMPT_TEMPLATE: string = [
	RETIRED_POSITION_JUDGMENT_SKILL.retirementRecheck,
	'Return JSON only, exactly one boolean field named retire: {"retire":true} or {"retire":false}.',
].join("\n\n");
export const PROFILE_RETIREMENT_RECHECK_PROMPT_SHA256: string = createHash("sha256")
	.update(PROFILE_RETIREMENT_RECHECK_PROMPT_TEMPLATE)
	.digest("hex");
export const PROFILE_RETIREMENT_RECHECK_SAMPLING: {
	readonly temperature: "provider-default";
	readonly enableThinking: false;
	readonly maxTokens: 64;
} = {
	temperature: "provider-default",
	enableThinking: false,
	maxTokens: PROFILE_RETIREMENT_RECHECK_MAX_TOKENS,
} as const;

/** What the second key over one retirement decided, written into the merged row's metadata. */
export interface ProfileRetirementRecheckReceipt {
	prompt_sha256: string;
	model: string;
	preset: string;
	sampling: typeof PROFILE_RETIREMENT_RECHECK_SAMPLING;
	retired: string[];
	kept: string[];
	/** Retirements past the per-write cap; kept without a judgement. */
	unchecked: number;
}

function parseRecheckVerdict(value: unknown): boolean | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== 1 || typeof record["retire"] !== "boolean") {
		return undefined;
	}
	return record["retire"];
}

function renderRetirementRecheckPrompt(input: {
	sectionName: string;
	storedClause: string;
	incomingAssertion: string;
	siblingContents: ReadonlyMap<string, string>;
}): string {
	// Names alone cannot answer the question the skill asks. Measured 2026-09-02 on 13 general
	// clauses whose topic a live sibling owns but whose words no sibling carries: with names only
	// the judge retired 4 of 13 and was unstable on 2 more, and each of those was the last copy
	// of the fact. With the content in the prompt it retired 0 of 13 and still retired 14 of 20
	// genuine replacements — the recheck costs nothing on real replacements and only pays here.
	const siblings: Record<string, string> = {};
	if (input.sectionName === "preferences.general") {
		for (const [name, content] of input.siblingContents) {
			siblings[name] = content.slice(0, PROFILE_RETIREMENT_RECHECK_SIBLING_CHARS);
		}
	}
	return [
		PROFILE_RETIREMENT_RECHECK_PROMPT_TEMPLATE,
		`Section: ${input.sectionName}`,
		`Stored clause (retired): ${JSON.stringify(input.storedClause)}`,
		`Incoming assertion: ${JSON.stringify(input.incomingAssertion)}`,
		`Live sibling sections and their content: ${JSON.stringify(siblings)}`,
	].join("\n\n");
}

/**
 * The second key on every clause the profile judgement retired from `preferences.general`.
 * Measured 2026-09-01 on the PRD 130 Memora store: 753 clauses were retired across 1,149
 * rewrites, 317 of them shared no content word with the incoming assertion, and 238 of those in
 * the general section had no live sibling carrying them; replayed one by one, 39 of 40 such
 * retirements were judged wrong, while 14 of 20 genuine replacements were still retired. A
 * retirement stands only when this focused question also answers yes; an unusable answer keeps
 * the clause.
 */
async function recheckProfileRetirements(input: {
	params: RunProfileSectionUpdateParams;
	clauses: readonly ProfileJudgmentClause[];
	retiredClauseIndices: readonly number[];
	siblingContents: ReadonlyMap<string, string>;
}): Promise<{ retiredClauseIndices: number[]; receipt?: ProfileRetirementRecheckReceipt }> {
	const llm = input.params.llm;
	if (!llm || input.retiredClauseIndices.length === 0) {
		return { retiredClauseIndices: [...input.retiredClauseIndices] };
	}
	const durationMs = Math.min(
		input.params.timeoutMs ?? RETIRE_BY_NAME_MAX_DURATION_MS,
		RETIRE_BY_NAME_MAX_DURATION_MS,
	);
	const deadlineMs = Date.now() + durationMs;
	const candidates = input.retiredClauseIndices.slice(0, PROFILE_RETIREMENT_RECHECK_MAX_PER_WRITE);
	const checked: number[] = [];
	const verdicts: Array<boolean | undefined> = [];
	for (let offset = 0; offset < candidates.length; ) {
		if (Date.now() >= deadlineMs) break;
		const batchSize = Math.min(
			PROFILE_RETIREMENT_RECHECK_CONCURRENCY,
			candidates.length - offset,
		);
		const batch = candidates.slice(offset, offset + batchSize);
		const remainingMs = Math.max(1, deadlineMs - Date.now());
		checked.push(...batch);
		verdicts.push(
			...(await Promise.all(
				batch.map(async (index) => {
					const clause = input.clauses[index];
					if (!clause) return undefined;
					try {
						const response = await llm.completeJson<unknown>({
							prompt: renderRetirementRecheckPrompt({
								sectionName: input.params.sectionName,
								storedClause: clause.value,
								incomingAssertion: input.params.newAssertion,
								siblingContents: input.siblingContents,
							}),
							callLabel: PROFILE_RETIREMENT_RECHECK_CALL_LABEL,
							adapterSlot: "profile-merge",
							maxTokens: PROFILE_RETIREMENT_RECHECK_MAX_TOKENS,
							enableThinking: false,
							timeoutMs: Math.min(input.params.timeoutMs ?? remainingMs, remainingMs),
							...(input.params.signal ? { signal: input.params.signal } : {}),
						});
						return parseRecheckVerdict(response);
					} catch (error) {
						if (!isDeterministicFallbackError(error)) throw error;
						return undefined;
					}
				}),
			)),
		);
		offset += batch.length;
	}
	// The receipt names the model; the decision above never depends on this lookup.
	let resolved: { model: string; preset: string };
	try {
		resolved = await llm.getResolvedConfig();
	} catch (error) {
		log.warn("profile retirement recheck could not resolve the model for its receipt", {
			section: input.params.sectionName,
			error,
		}, {
			event_name: "sno_station_mem.profile-section-writer.profile.retirement.recheck.could.not.resolve.the.model.for.its.receipt",
			file: "packages/sno-station-mem/src/engine/extraction/profile-section-writer.ts",
			function: "recheckProfileRetirements",
			site_id: "profile-section-writer.recheckProfileRetirements.613c569527",
		});
		resolved = { model: "unresolved", preset: "unresolved" };
	}
	const retiredClauseIndices: number[] = [];
	const retired: string[] = [];
	const kept: string[] = [];
	checked.forEach((index, position) => {
		const value = input.clauses[index]?.value ?? "";
		if (verdicts[position] === true) {
			retiredClauseIndices.push(index);
			retired.push(value);
		} else {
			kept.push(value);
		}
	});
	const unchecked = input.retiredClauseIndices.length - checked.length;
	return {
		retiredClauseIndices,
		receipt: {
			prompt_sha256: PROFILE_RETIREMENT_RECHECK_PROMPT_SHA256,
			model: resolved.model,
			preset: resolved.preset,
			sampling: PROFILE_RETIREMENT_RECHECK_SAMPLING,
			retired,
			kept,
			unchecked,
		},
	};
}

async function mergeProfileSection(
	existing: MemoryEntry,
	params: RunProfileSectionUpdateParams,
): Promise<ProfileMergeResult> {
	const existingContent = parseInsightMetadata(existing.metadata, existing).l2_content;
	const mergeBase =
		typeof existingContent === "string" &&
		normalizeExactAssertionText(existingContent) ===
			normalizeExactAssertionText(retiredProfileSectionMarker(params.sectionName))
			? ""
			: typeof existingContent === "string"
				? existingContent
				: existing.text;
	const clausesByValue = new Map<string, ProfileJudgmentClause>();
	for (const value of splitExactClauses(mergeBase)) {
		clausesByValue.set(value, { origin: "stored", value });
	}
	for (const value of splitExactClauses(params.newAssertion)) {
		// Incoming wins the tag when the exact clause is present on both sides.
		clausesByValue.set(value, { origin: "incoming", value });
	}
	const clauses = [...clausesByValue.values()];
	const liveSiblings = await listLiveSpecificSiblings(params);
	const liveSiblingSectionNames = liveSiblings.map((sibling) => sibling.name);
	const judgmentPrompt = renderProfileSectionJudgmentPrompt({
		sectionName: params.sectionName,
		topic: params.topic,
		clauses,
		evidence: params.evidence,
		liveSiblingSectionNames,
	});
	if (!LIVE_CLAUSE_VERDICT_REGISTRATION.enabled) {
		return {
			kind: "preserved-without-adjudication",
			content: fallbackProfileMerge(mergeBase, params.newAssertion),
			reason: `activation-${LIVE_CLAUSE_VERDICT_REGISTRATION.reason}`,
		};
	}
	let response: unknown;
	let transportFailure: string | undefined;
	if (params.llm) {
		try {
			response = await params.llm.completeJson<unknown>({
				prompt: judgmentPrompt,
				callLabel: PROFILE_SECTION_JUDGMENT_CALL_LABEL,
				adapterSlot: "profile-merge",
				...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
				...(params.signal ? { signal: params.signal } : {}),
				// Walk every candidate against this reply's own shape; without it the first valid
				// object wins and the correct payload behind it is never seen.
				accept: (value) => parseProfileSectionJudgment(value, clauses) !== undefined,
			});
		} catch (error) {
			if (!isDeterministicFallbackError(error)) throw error;
			transportFailure = error.category;
		}
	}

	const judgment = parseProfileSectionJudgment(response, clauses);
	const noOpWouldDrop =
		judgment?.verdict === "no-op" && !sectionAlreadyCovers(mergeBase, params.newAssertion);
	if (!judgment || noOpWouldDrop) {
		const reason = noOpWouldDrop
			? "no-op-would-drop-incoming"
			: transportFailure !== undefined
				? `transport-${transportFailure}`
				: response == null
					? "null-or-absent-judgment"
					: "malformed-judgment";
		log.warn("profile judgment unusable; deterministic preservation selected", {
			section: params.sectionName,
			reason,
		}, {
			event_name: "sno_station_mem.profile-section-writer.profile.judgment.unusable.deterministic.preservation.selected",
			file: "packages/sno-station-mem/src/engine/extraction/profile-section-writer.ts",
			function: "mergeProfileSection",
			site_id: "profile-section-writer.mergeProfileSection.c707285ef3",
		});
		return {
			kind: "preserved-without-adjudication",
			content: fallbackProfileMerge(mergeBase, params.newAssertion),
			reason,
		};
	}
	if (judgment.verdict === "no-op") return { kind: "no-op" };
	if (judgment.verdict === "tombstone") return { kind: "tombstone" };

	// Specific sections carry one position. Only the general section needs a second check for
	// unrelated clauses that the ownership judgment tried to retire.
	const recheck =
		params.sectionName === "preferences.general"
			? await recheckProfileRetirements({
					params,
					clauses,
					retiredClauseIndices: judgment.retiredClauseIndices,
					siblingContents:
						judgment.retiredClauseIndices.length > 0
							? new Map(liveSiblings.map((sibling) => [sibling.name, sibling.content]))
							: new Map(),
				})
			: { retiredClauseIndices: [...judgment.retiredClauseIndices] };
	const retiredClauses = recheck.retiredClauseIndices.map(
		(index) => clauses[index]?.value ?? "",
	);
	const lifecycleRetirement = await lifecycleRetireByNamePositions(
		params,
		liveSiblingSectionNames,
		retiredClauses,
	);
	const retireByNamePositions =
		lifecycleRetirement.kind === "classified" ? lifecycleRetirement.positions : [];
	const deferredLifecycleRetirement =
		lifecycleRetirement.kind === "deferred" ? lifecycleRetirement.work : undefined;
	const retiredIndices = new Set(recheck.retiredClauseIndices);
	const retainedClauses = clauses.flatMap((clause, index) =>
		retiredIndices.has(index) ? [] : [clause.value],
	);
	let textResponse: unknown;
	try {
		textResponse = await params.llm?.completeJson<unknown>({
			prompt: renderProfileSectionTextPrompt({
				sectionName: params.sectionName,
				topic: params.topic,
				retainedClauses,
				retiredClauses,
				evidence: params.evidence,
			}),
			callLabel: PROFILE_SECTION_TEXT_CALL_LABEL,
			adapterSlot: "profile-merge",
			...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
			...(params.signal ? { signal: params.signal } : {}),
		});
	} catch (error) {
		if (!isDeterministicFallbackError(error)) throw error;
		return judgedClauseMerge(
			retainedClauses,
			retireByNamePositions,
			`text-step-${error.category}`,
			deferredLifecycleRetirement,
			recheck.receipt,
		);
	}
	if (
		textResponse == null ||
		(typeof textResponse === "object" &&
			textResponse !== null &&
			"content" in textResponse &&
			typeof textResponse.content === "string" &&
			textResponse.content.trim() === "")
	) {
		return judgedClauseMerge(
			retainedClauses,
			retireByNamePositions,
			"text-step-returned-empty",
			deferredLifecycleRetirement,
			recheck.receipt,
		);
	}
	const parsedText = profileTextResponseSchema.safeParse(textResponse);
	if (!parsedText.success) {
		return judgedClauseMerge(
			retainedClauses,
			retireByNamePositions,
			"text-step-malformed-response",
			deferredLifecycleRetirement,
			recheck.receipt,
		);
	}
	const content = parsedText.data.content.trim();
	if (!content) {
		return judgedClauseMerge(
			retainedClauses,
			retireByNamePositions,
			"text-step-returned-empty",
			deferredLifecycleRetirement,
			recheck.receipt,
		);
	}
	// The judgment already decided the exact clause set this section should carry. The rewrite is
	// allowed to make that set read better; it is not allowed to change it. So the only rewrite
	// that gets persisted is one whose clauses ARE the retained set, exactly.
	//
	// Both halves of that matter and neither used to be checked properly:
	//   - It used to check only that every retained clause was present, and on failure discarded
	//     the whole write and left the row untouched. The caller then filed the incoming fact as
	//     an episodic row, so one clause the rewrite failed to copy cost the section every fact in
	//     the turn, silently — and the longer a section got the likelier that became, so a profile
	//     stopped accepting new facts about exactly the topics it already knew most about.
	//   - It never checked that retired clauses were gone. A rewrite that kept one, or reworded it
	//     into "Previously I preferred tea, but now coffee", passed, and the row then carried the
	//     retired value and the live one at once. Exact-set equality catches the reworded case that
	//     no per-clause filter can: the reworded clause is not in the retained set, so the set
	//     differs, so the rewrite is not used.
	//
	// When the rewrite does not match, the retained clauses ARE the answer — they are the exact
	// source clauses the judgment kept — so they are written directly. Nothing is lost and nothing
	// retired survives, by construction rather than by a second check. `abstract` and `overview`
	// are dropped with the prose that produced them: they are model text about a content string
	// that is not being persisted, and `profileStoreInput` derives both from the real content.
	const contentClauses = splitExactClauses(content);
	const sortedRetainedClauses = [...retainedClauses].sort();
	const sortedContentClauses = [...contentClauses].sort();
	const rewriteMatchesJudgment =
		sortedContentClauses.length === sortedRetainedClauses.length &&
		sortedContentClauses.every((clause, index) => clause === sortedRetainedClauses[index]);
	if (rewriteMatchesJudgment) {
		return {
			kind: "merge",
			content,
			abstract: parsedText.data.abstract,
			overview: parsedText.data.overview,
			retireByNamePositions,
			...(deferredLifecycleRetirement ? { deferredLifecycleRetirement } : {}),
			retainedClauses,
			...(recheck.receipt ? { retirementRecheck: recheck.receipt } : {}),
		};
	}
	return judgedClauseMerge(
		retainedClauses,
		retireByNamePositions,
		"text-step-changed-the-clause-set",
		deferredLifecycleRetirement,
		recheck.receipt,
	);
}

/**
 * The merge the judgment itself already decided: exactly the clauses it kept, one per line.
 *
 * Used whenever the text step cannot be trusted to produce them — it failed, it returned nothing
 * usable, or it returned a different clause set. This never refuses. A refusal here used to leave
 * the row stale AND file the incoming fact as an episodic row, so an ordinary dependency failure
 * silently cost the profile its update while the caller was told a row had been written.
 */
function judgedClauseMerge(
	retainedClauses: string[],
	retireByNamePositions: string[],
	reason: string,
	deferredLifecycleRetirement?: DeferredLifecycleRetirement,
	retirementRecheck?: ProfileRetirementRecheckReceipt,
): ProfileMergeResult {
	return {
		kind: "merge",
		content: retainedClauses.join("\n"),
		retireByNamePositions,
		...(deferredLifecycleRetirement ? { deferredLifecycleRetirement } : {}),
		retainedClauses,
		textRepair: { reason },
		...(retirementRecheck ? { retirementRecheck } : {}),
	};
}

function splitExactClauses(text: string): string[] {
	const rawClauses: string[] = [];
	const separators: string[] = [];
	let cursor = 0;
	// Sentence and list boundaries only. A comma boundary was measured on the 2026-09-01 run to
	// cut 111 of 551 live `preferences.general` clauses into halves ("The user currently prefers
	// cooler," / "more humid environments.") — each half then judged and retired on its own.
	for (const boundary of text.matchAll(/\n+|(?<=[.!?;])\s+/gu)) {
		rawClauses.push(text.slice(cursor, boundary.index));
		separators.push(boundary[0]);
		cursor = boundary.index + boundary[0].length;
	}
	rawClauses.push(text.slice(cursor));
	const reconstructed = rawClauses
		.map((clause, index) => `${clause}${separators[index] ?? ""}`)
		.join("");
	if (reconstructed !== text) {
		throw new Error("profile-section-writer: exact clause segmentation was not lossless");
	}
	return rawClauses.map((clause) => clause.trim()).filter((clause) => clause.length > 0);
}

function profileStoreInput(args: {
	scope: string;
	sectionName: string;
	topic?: string;
	content: string;
	evidence?: string;
	metadataPatch?: Record<string, unknown>;
	source: ProfileSectionSource;
	at: number;
	supersedes?: string;
	abstract?: string;
	overview?: string;
	countRecordTokens: (text: string) => number;
}): StoreInput {
	const rawText = args.content.trim();
	const abstract = args.abstract?.trim() || firstSentence(rawText);
	const text = boundSectionContent(rawText, abstract, args.countRecordTokens);
	const overview = args.overview?.trim() || `- ${text}`;
	const metadata = buildInsightMetadata(
		{ text, category: "profile", timestamp: args.at },
		{
			l0_abstract: abstract,
			l1_overview: overview,
			l2_content: text,
			tier: "core",
			access_count: 0,
			confidence: 0.85,
			last_accessed_at: args.at,
			asserted_at: args.at,
			valid_from: args.at,
			source_session: args.source.sessionKey,
			state: "confirmed",
			source: args.source.source ?? "ambient-learning",
			injected_count: 0,
			bad_recall_count: 0,
			suppressed_until_turn: 0,
			...args.metadataPatch,
			section_name: args.sectionName,
			...(args.supersedes ? { supersedes: args.supersedes } : {}),
			...(args.topic ? { topic: args.topic } : {}),
			...(args.evidence ? { evidence: args.evidence } : {}),
			...(args.sectionName === "preferences.general" && !args.topic
				? { "profile.preference.missing_topic": true }
				: {}),
		},
	);
	return {
		text: buildIndexedText(abstract, text),
		category: "profile",
		projectId: args.scope,
		importance: 0.85,
		timestamp: args.at,
		metadata: stringifyInsightMetadata(metadata),
		trusted: true,
	};
}

async function writeEpisodicSafetyNet(
	params: RunProfileSectionUpdateParams,
	reason: string,
): Promise<{ rowId: string; replayed: boolean }> {
	const assertion = params.newAssertion.trim();
	const idempotencyKey = profileSafetyNetIdempotencyKey(params);
	const metadata = buildInsightMetadata(
		{ text: assertion, category: "episodic", timestamp: params.at },
		{
			l0_abstract: assertion,
			l1_overview: params.evidence?.trim() || `- ${assertion}`,
			l2_content: assertion,
			tier: "working",
			access_count: 0,
			confidence: 0.7,
			last_accessed_at: params.at,
			asserted_at: params.at,
			valid_from: params.at,
			...(params.source.sessionKey ? { source_session: params.source.sessionKey } : {}),
			...(params.source.messageId ? { source_message_id: params.source.messageId } : {}),
			state: "confirmed",
			source: params.source.source ?? "ambient-learning",
			injected_count: 0,
			bad_recall_count: 0,
			suppressed_until_turn: 0,
			idempotency_key: idempotencyKey,
		},
	);
	const stored = await params.store.store({
		text: assertion,
		category: "episodic",
		projectId: params.scope,
		importance: 0.7,
		timestamp: params.at,
		metadata: stringifyInsightMetadata(metadata),
	});
	log.warn("profile candidate routed to episodic safety net", {
		reason,
		rowId: stored.id,
	}, {
		event_name: "sno_station_mem.profile-section-writer.profile.candidate.routed.to.episodic.safety.net",
		file: "packages/sno-station-mem/src/engine/extraction/profile-section-writer.ts",
		function: "writeEpisodicSafetyNet",
		site_id: "profile-section-writer.writeEpisodicSafetyNet.ae69446388",
	});
	return { rowId: stored.id, replayed: stored.storeWriteOutcome === "existing" };
}

function profileSafetyNetIdempotencyKey(params: RunProfileSectionUpdateParams): string {
	return `profile_safety_net_${stableShortHash(
		JSON.stringify([
			tombstoneReplayIdentity(params),
			canonicalizeProfileSectionName(params.sectionName),
			normalizeExactAssertionText(params.newAssertion),
		]),
	)}`;
}

function tombstoneEventStoreInput(
	params: RunProfileSectionUpdateParams,
	closedProfileRowId: string,
): StoreInput {
	const assertion = params.newAssertion.trim();
	const metadata = buildInsightMetadata(
		{ text: assertion, category: "episodic", timestamp: params.at },
		{
			l0_abstract: assertion,
			l1_overview: `- ${assertion}`,
			l2_content: assertion,
			tier: "working",
			access_count: 0,
			confidence: 0.8,
			last_accessed_at: params.at,
			asserted_at: params.at,
			valid_from: params.at,
			...(params.source.sessionKey ? { source_session: params.source.sessionKey } : {}),
			...(params.source.messageId ? { source_message_id: params.source.messageId } : {}),
			state: "confirmed",
			source: params.source.source ?? "ambient-learning",
			injected_count: 0,
			bad_recall_count: 0,
			suppressed_until_turn: 0,
			section_name: params.sectionName,
			closed_profile_row_id: closedProfileRowId,
			profile_tombstone_verdict: "tombstone",
			idempotency_key: tombstoneEventIdempotencyKey(params),
			content_identity_key: tombstoneEventIdempotencyKey(params),
		},
	);
	return {
		text: assertion,
		category: "episodic",
		projectId: params.scope,
		importance: 0.7,
		timestamp: params.at,
		metadata: stringifyInsightMetadata(metadata),
	};
}

function tombstoneMarkerIdempotencyKey(params: RunProfileSectionUpdateParams): string {
	return `profile_tombstone_marker_${stableShortHash(
		[params.scope, params.sectionName, tombstoneReplayIdentity(params)].join("\0"),
	)}`;
}

function tombstoneEventIdempotencyKey(params: RunProfileSectionUpdateParams): string {
	return `profile_tombstone_event_${stableShortHash(
		[params.scope, params.sectionName, tombstoneReplayIdentity(params)].join("\0"),
	)}`;
}

async function tombstoneReplayResult(
	params: RunProfileSectionUpdateParams,
	factKey: string,
): Promise<{ outcome: "no-op"; rowId: string } | undefined> {
	if (
		!params.store.findByExtractionIdempotencyKey(
			params.scope,
			tombstoneEventIdempotencyKey(params),
		)
	) {
		return undefined;
	}
	const current = params.store.getByFactKey(params.scope, factKey);
	if (!current) return undefined;
	await resumeRetireByNamePending(current, params);
	return { outcome: "no-op", rowId: current.id };
}

function tombstoneReplayIdentity(params: RunProfileSectionUpdateParams): string {
	const messageId = params.source.messageId?.trim();
	if (messageId) return `message:${messageId}`;
	return [
		"fallback",
		params.source.sessionKey?.trim() ?? "",
		String(params.at),
		normalizeExactAssertionText(params.newAssertion),
	].join("\0");
}

function closeProfileMetadata(row: MemoryEntry, supersededBy: string, at: number): string {
	const metadata = parseInsightMetadata(row.metadata, row);
	// The codec silently DROPS invalidated_at when it is < valid_from, which
	// would leave a superseded row live next to its replacement on out-of-order
	// replay. Clamp forward: a row cannot be invalid before it existed.
	const invalidatedAt = Math.max(at, metadata.valid_from ?? at);
	return stringifyInsightMetadata(
		buildInsightMetadata(row, {
			...metadata,
			invalidated_at: invalidatedAt,
			superseded_by: supersededBy,
		}),
	);
}

interface ProfileConflictPlan {
	blockedBy?: MemoryEntry;
	closes: MemoryEntry[];
}

interface RetireByNameWorkItem {
	positions: string[];
	eventTime: number;
	triggeringEventIdentity: string;
	triggeringSessionIdentity?: string;
	excludedRowIds: string[];
	lifecycleClassification?: LifecycleRetirementContext;
}

interface RetireByNamePending {
	workItems: RetireByNameWorkItem[];
}

const retireByNameWorkItemSchema: z.ZodType<RetireByNameWorkItem> = z
	.object({
		positions: z.array(z.string()).min(1),
		eventTime: z.number(),
		triggeringEventIdentity: z.string(),
		triggeringSessionIdentity: z.string().optional(),
		excludedRowIds: z.array(z.string()),
		lifecycleClassification: z
			.object({
				incomingAssertion: z.string(),
				liveSiblingSectionNames: z.array(z.string()),
				attempts: z.number().int().nonnegative().optional(),
				lastFailure: z.enum(["malformed-answer", "transport"]).optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

const retireByNamePendingSchema: z.ZodType<RetireByNamePending> = z
	.object({ workItems: z.array(retireByNameWorkItemSchema).min(1) })
	.strict();

/**
 * Collect the pending queues of every row this write is folding into one. A conflict scan can
 * close a live row that carries unfinished retirement work, and only the current row is ever
 * resumed, so anything left behind on the closed row is unreachable for good.
 */
function mergeRetireByNamePending(
	sources: ReadonlyArray<RetireByNamePending | undefined>,
): RetireByNamePending | undefined {
	const workItems = sources.flatMap((source) => source?.workItems ?? []);
	return workItems.length === 0 ? undefined : { workItems };
}

function appendRetireByNameWork(
	pending: RetireByNamePending | undefined,
	positions: readonly string[],
	params: RunProfileSectionUpdateParams,
	excludedRowIds: string[],
	fallbackTriggeringEventIdentity: string,
	lifecycleClassification?: LifecycleRetirementContext,
): RetireByNamePending | undefined {
	const workItems = pending?.workItems ?? [];
	const triggeringEventIdentity =
		params.source.messageId ?? params.source.sessionKey ?? fallbackTriggeringEventIdentity;
	const carriedPositions = new Set(
		workItems
			.filter(
				(item) =>
					item.eventTime === params.at &&
					item.triggeringEventIdentity === triggeringEventIdentity &&
					item.triggeringSessionIdentity === params.source.sessionKey,
			)
			.flatMap((item) => item.positions.map(normalizeExactAssertionText)),
	);
	const newPositions = [...new Set(positions)].filter(
		(position) => !carriedPositions.has(normalizeExactAssertionText(position)),
	);
	if (newPositions.length === 0) {
		// The cap applies here too: merging a closed row's queue in can push the total over it
		// without adding a single new position.
		return workItems.length === 0
			? undefined
			: { workItems: capRetireByNameWorkItems(workItems, params) };
	}
	return {
		workItems: capRetireByNameWorkItems(
			[
				...workItems,
				{
					positions: newPositions,
					eventTime: params.at,
					triggeringEventIdentity,
					...(params.source.sessionKey
						? { triggeringSessionIdentity: params.source.sessionKey }
						: {}),
					excludedRowIds,
					...(lifecycleClassification ? { lifecycleClassification } : {}),
				},
			],
			params,
		),
	};
}

/**
 * The last stop against an unbounded marker. Only an ANSWER exhausts the per-item bound, so a
 * route that is ON and only ever times out defers each item forever while new ones keep arriving
 * per event. Past the cap the OLDEST item goes, and it goes LOUDLY: a permanently broken route
 * then costs one warning per event instead of a metadata blob that grows until writes crawl.
 * 16 is the recheck cap, and the largest general rewrite observed on the 2026-09-01 store retired
 * 9 clauses, so an ordinary day never reaches it. Owner ruling via CTS, 2026-09-02.
 */
function capRetireByNameWorkItems(
	workItems: readonly RetireByNameWorkItem[],
	params: RunProfileSectionUpdateParams,
): RetireByNameWorkItem[] {
	if (workItems.length <= RETIRE_BY_NAME_MAX_PENDING_WORK_ITEMS) return [...workItems];
	const dropped = workItems.slice(0, workItems.length - RETIRE_BY_NAME_MAX_PENDING_WORK_ITEMS);
	for (const item of dropped) {
		log.warn("retire-by-name work dropped at the pending cap", {
			scope: params.scope,
			section: params.sectionName,
			factKey: profileFactKey(params.sectionName),
			position: item.positions[0],
			positions: item.positions.length,
			failure: item.lifecycleClassification?.lastFailure,
			attempts: item.lifecycleClassification?.attempts,
		}, {
			event_name: "sno_station_mem.profile-section-writer.retire.by.name.work.dropped.at.the.pending.cap",
			file: "packages/sno-station-mem/src/engine/extraction/profile-section-writer.ts",
			function: "capRetireByNameWorkItems",
			site_id: "profile-section-writer.capRetireByNameWorkItems.3c47653418",
		});
	}
	return workItems.slice(dropped.length);
}

async function writeProfileRow(args: {
	params: RunProfileSectionUpdateParams;
	content: string;
	input: StoreInput;
	existing?: MemoryEntry;
	retiredPositions?: readonly string[];
	deferredLifecycleRetirement?: DeferredLifecycleRetirement;
	outcome: "appended" | "merged";
}): Promise<{ outcome: ProfileSectionOutcome; rowId: string }> {
	const plan = await planProfileConflicts(
		args.params,
		args.content,
		[args.existing?.id].filter((id): id is string => id !== undefined),
	);
	if (plan.blockedBy) {
		const safetyNet = await writeEpisodicSafetyNet(args.params, "superseded-by-existing");
		const blockingSection = parseInsightMetadata(
			plan.blockedBy.metadata,
			plan.blockedBy,
		).section_name;
		log.warn("profile conflict blocked candidate routed to episodic", {
			candidateRowId: safetyNet.rowId,
			blockingRowId: plan.blockedBy.id,
			incomingSection: args.params.sectionName,
			blockingSection,
			verdict: "replacement",
		}, {
			event_name: "sno_station_mem.profile-section-writer.profile.conflict.blocked.candidate.routed.to.episodic",
			file: "packages/sno-station-mem/src/engine/extraction/profile-section-writer.ts",
			function: "writeProfileRow",
			site_id: "profile-section-writer.writeProfileRow.3e3e26a255",
		});
		return {
			outcome: safetyNet.replayed ? "no-op" : "appended",
			rowId: safetyNet.rowId,
		};
	}
	const closeRows = uniqueRows(
		[args.existing, ...plan.closes].filter((row): row is MemoryEntry => row !== undefined),
	);
	const retainedClauses = new Set(
		splitExactClauses(args.content).map(normalizeExactAssertionText),
	);
	const conflictRetiredPositions = plan.closes.flatMap((row) => {
		const metadata = parseInsightMetadata(row.metadata, row);
		return splitExactClauses(metadata.l2_content ?? row.text).filter(
			(clause) => !retainedClauses.has(normalizeExactAssertionText(clause)),
		);
	});
	const conflictLifecycleRetirement: LifecycleRetirementClassification =
		conflictRetiredPositions.length === 0
			? { kind: "classified", positions: [] }
			: await lifecycleRetireByNamePositions(
					args.params,
					await listLiveSpecificSiblingSections(args.params),
					conflictRetiredPositions,
				);
	// Retiring by name is model-only work, so with no model none is created. Queuing it anyway
	// made the queue grow by one item per event for the whole life of a local-first store, where
	// a model never arrives to drain it. Work an earlier model-enabled run left is carried
	// forward untouched, because `readRetireByNamePending` still reads it.
	//
	// Each kind of work is gated by the label that will actually run it. A position that is
	// ALREADY classified only needs `retireRowsByName`, which judges under the section-judgment
	// label — gating it on the lifecycle label would throw away executable work whenever that one
	// route alone is off, and the stale rows it names would stay live with no way to rebuild it.
	// A position still needing classification needs both, so it is gated on both.
	const judgmentHasNoModel = profileMergeCallHasNoModel(
		args.params,
		PROFILE_SECTION_JUDGMENT_CALL_LABEL,
	);
	const lifecycleHasNoModel = profileMergeCallHasNoModel(
		args.params,
		PROFILE_SECTION_LIFECYCLE_RETIREMENT_CALL_LABEL,
	);
	const modelOnlyPositions = judgmentHasNoModel
		? []
		: [
				...(args.retiredPositions ?? []),
				...(conflictLifecycleRetirement.kind === "classified"
					? conflictLifecycleRetirement.positions
					: []),
			];
	// A row this write is closing may carry unfinished work of its own. Only the CURRENT row is
	// ever resumed, so work left on a row that is about to be invalidated is lost for good; it is
	// merged onto the replacement here, and `appendRetireByNameWork` de-duplicates the positions.
	const queueSourceRows = [...(args.existing ? [args.existing] : []), ...closeRows].filter(
		// The row being replaced is normally also one of the rows being closed. Reading it twice
		// would write its queue onto the replacement twice.
		(row, index, rows) => rows.findIndex((other) => other.id === row.id) === index,
	);
	let pending = mergeRetireByNamePending(queueSourceRows.map(readRetireByNamePending));
	pending = appendRetireByNameWork(
		pending,
		modelOnlyPositions,
		args.params,
		closeRows.map((row) => row.id),
		"profile-update",
	);
	const deferredRetirements = (
		judgmentHasNoModel || lifecycleHasNoModel
			? []
			: [
					args.deferredLifecycleRetirement,
					conflictLifecycleRetirement.kind === "deferred"
						? conflictLifecycleRetirement.work
						: undefined,
				]
	).filter((work): work is DeferredLifecycleRetirement => work !== undefined);
	for (const deferred of deferredRetirements) {
		pending = appendRetireByNameWork(
			pending,
			deferred.positions,
			args.params,
			closeRows.map((row) => row.id),
			"profile-update",
			deferred.context,
		);
	}
	const createInput =
		pending === undefined
			? args.input
			: { ...args.input, metadata: addRetireByNamePending(args.input.metadata, pending) };
	const created = await args.params.store.supersede({
		create: createInput,
		closes: closeRows.map((row) => ({
			id: row.id,
			buildMetadata: (createdId: string) => closeProfileMetadata(row, createdId, args.params.at),
		})),
		activeFactGuard: {
			factKey: profileFactKey(args.params.sectionName),
			expectedId: args.existing?.id ?? null,
		},
		reviveInvalidatedExisting: true,
		...(closeRows.length === 0
			? {}
			: {
					profileRecovery: {
						mutationAttemptId: currentMutationAttemptId(),
						sectionName: args.params.sectionName,
						removedAtMs: args.params.at,
					},
				}),
	});
	if (pending) await completeRetireByNamePending(created, args.params, pending);
	return { outcome: args.outcome, rowId: created.id };
}

function addRetireByNamePending(
	metadata: string | undefined,
	pending: RetireByNamePending,
): string {
	const parsed: unknown = JSON.parse(metadata ?? "{}");
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("profile-section-writer: profile metadata must be an object");
	}
	return JSON.stringify({ ...parsed, retire_by_name_pending: pending });
}

function readRetireByNamePending(entry: MemoryEntry): RetireByNamePending | undefined {
	const value = parseInsightMetadata(entry.metadata, entry).retire_by_name_pending;
	const parsed = retireByNamePendingSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

function classifiedRetireByNameWorkItem(
	workItem: RetireByNameWorkItem,
	positions: string[],
): RetireByNameWorkItem {
	return {
		positions,
		eventTime: workItem.eventTime,
		triggeringEventIdentity: workItem.triggeringEventIdentity,
		...(workItem.triggeringSessionIdentity
			? { triggeringSessionIdentity: workItem.triggeringSessionIdentity }
			: {}),
		excludedRowIds: workItem.excludedRowIds,
	};
}

async function completeRetireByNamePending(
	current: MemoryEntry,
	params: RunProfileSectionUpdateParams,
	pending: RetireByNamePending,
): Promise<void> {
	// Every step below needs a model. Without one, leave the queue exactly as it is: a run that
	// had a model may have filled it, and consuming it here would drop that work permanently.
	// Each half is gated by the label it actually calls, never by both: requiring both would drop
	// executable positions whenever the other label alone is off, and gating creation on only one
	// of them would queue work the consumer can never run. A work item still carrying a
	// classification needs the lifecycle label; `retireRowsByName` needs the judgment label.
	if (profileMergeCallHasNoModel(params, PROFILE_SECTION_JUDGMENT_CALL_LABEL)) return;
	const lifecycleHasNoModel = profileMergeCallHasNoModel(
		params,
		PROFILE_SECTION_LIFECYCLE_RETIREMENT_CALL_LABEL,
	);
	const judgmentBudget =
		params.retireByNameBudget ?? createRetireByNameRunBudget(params.timeoutMs);
	const deadlineMs = judgmentBudget.deadlineMs;
	let remainingWorkItems: RetireByNameWorkItem[] = [];
	workLoop: for (let workIndex = 0; workIndex < pending.workItems.length; workIndex += 1) {
		const workItem = pending.workItems[workIndex];
		if (!workItem) continue;
		let activeWorkItem = workItem;
		if (workItem.lifecycleClassification) {
			// No classifier, so this item cannot be advanced. Keep it and move on to the items
			// that can be: dropping it would lose work, and stopping would starve the rest.
			if (lifecycleHasNoModel) {
				remainingWorkItems.push(workItem);
				continue;
			}
			if (Date.now() >= deadlineMs) {
				remainingWorkItems = [...remainingWorkItems, ...pending.workItems.slice(workIndex)];
				break;
			}
			const remainingMs = Math.max(1, deadlineMs - Date.now());
			const classification = await lifecycleRetireByNamePositions(
				{
					...params,
					timeoutMs: Math.min(params.timeoutMs ?? remainingMs, remainingMs),
				},
				workItem.lifecycleClassification.liveSiblingSectionNames,
				workItem.positions,
				workItem.lifecycleClassification.incomingAssertion,
				workItem.lifecycleClassification.attempts ?? 0,
			);
			if (classification.kind === "deferred") {
				// Re-queue the item the deferral produced, not the one that was read: only that
				// one carries the raised attempt count, and without it the bound never trips.
				remainingWorkItems = [
					...remainingWorkItems,
					{ ...workItem, lifecycleClassification: classification.work.context },
					...pending.workItems.slice(workIndex + 1),
				];
				break;
			}
			if (classification.positions.length === 0) continue;
			activeWorkItem = classifiedRetireByNameWorkItem(workItem, classification.positions);
		}
		for (
			let positionIndex = 0;
			positionIndex < activeWorkItem.positions.length;
			positionIndex += 1
		) {
			const retiredPosition = activeWorkItem.positions[positionIndex];
			if (
				retiredPosition === undefined ||
				judgmentBudget.remaining <= 0 ||
				Date.now() >= deadlineMs
			) {
				remainingWorkItems = [
					...remainingWorkItems,
					{ ...activeWorkItem, positions: activeWorkItem.positions.slice(positionIndex) },
					...pending.workItems.slice(workIndex + 1),
				];
				break workLoop;
			}
			const judgedCandidateIds = new Set<string>();
			const result = await retireRowsByName({
				store: params.store,
				llm: params.llm,
				scope: params.scope,
				retiredPosition,
				currentPositionId: current.id,
				triggeringEventIdentity: activeWorkItem.triggeringEventIdentity,
				...(activeWorkItem.triggeringSessionIdentity
					? { triggeringSessionIdentity: activeWorkItem.triggeringSessionIdentity }
					: {}),
				eventTime: activeWorkItem.eventTime,
				excludedRowIds: activeWorkItem.excludedRowIds,
				...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
				...(params.signal === undefined ? {} : { signal: params.signal }),
				judgmentBudget,
				judgedCandidateIds,
				deadlineMs,
			});
			if (!result.completed) {
				const laterPositions = activeWorkItem.positions.slice(positionIndex + 1);
				remainingWorkItems = [
					...remainingWorkItems,
					{
						...activeWorkItem,
						positions: [retiredPosition],
						excludedRowIds: [
							...new Set([...activeWorkItem.excludedRowIds, ...judgedCandidateIds]),
						],
					},
					...(laterPositions.length === 0
						? []
						: [{ ...activeWorkItem, positions: laterPositions }]),
					...pending.workItems.slice(workIndex + 1),
				];
				break workLoop;
			}
		}
	}
	await writeRetireByNamePending(
		current,
		params.store,
		remainingWorkItems.length === 0 ? undefined : { workItems: remainingWorkItems },
	);
}

async function writeRetireByNamePending(
	current: MemoryEntry,
	store: MemoryStore,
	pending: RetireByNamePending | undefined,
): Promise<void> {
	let latest = current;
	for (let attempt = 0; attempt < CLEAR_RETIRE_BY_NAME_PENDING_ATTEMPTS; attempt += 1) {
		const parsed: unknown = JSON.parse(latest.metadata);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("profile-section-writer: profile metadata must be an object");
		}
		// JSON object validation above makes this the one controlled boundary assertion.
		const next = { ...(parsed as Record<string, unknown>) };
		if (pending) next["retire_by_name_pending"] = pending;
		else delete next["retire_by_name_pending"];
		try {
			const updated = await store.update(latest.id, {
				writerAuthority: "profile-writer",
				metadata: JSON.stringify(next),
				expectedContentHash: latest.contentHash,
				expectedMetadata: latest.metadata,
			});
			if (!updated) throw new Error("profile-section-writer: pending profile row is missing");
			return;
		} catch (error) {
			if (
				!(error instanceof StorageError) ||
				error.message !== `Cannot update changed memory '${latest.id}'`
			) {
				throw error;
			}
		}
		const refreshed = store.getById(latest.id);
		if (!refreshed) throw new Error("profile-section-writer: pending profile row is missing");
		if (!readRetireByNamePending(refreshed)) return;
		latest = refreshed;
	}
	throw new Error("profile-section-writer: pending profile row kept changing");
}

/**
 * Move a live profile row's `valid_from` forward to a repeat of the assertion it already
 * holds, so the out-of-order guard measures staleness from the LAST confirmation.
 *
 * Only forward, and only for a row that already carries the field: writing one where there
 * was none would arm a guard that has never been armed for that row.
 *
 * Returns the row as this call leaves it, so the caller's next step reads the metadata that is
 * now stored instead of the snapshot it came in with.
 */
async function advanceProfileConfirmation(
	current: MemoryEntry,
	currentValidFrom: number | undefined,
	params: RunProfileSectionUpdateParams,
): Promise<MemoryEntry> {
	if (typeof currentValidFrom !== "number" || params.at <= currentValidFrom) return current;
	let latest = current;
	for (let attempt = 0; attempt < ADVANCE_PROFILE_CONFIRMATION_ATTEMPTS; attempt += 1) {
		const parsed: unknown = JSON.parse(latest.metadata);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("profile-section-writer: profile metadata must be an object");
		}
		// JSON object validation above makes this the one controlled boundary assertion.
		const next = { ...(parsed as Record<string, unknown>), valid_from: params.at };
		try {
			const updated = await params.store.update(latest.id, {
				writerAuthority: "profile-writer",
				metadata: JSON.stringify(next),
				expectedContentHash: latest.contentHash,
				expectedMetadata: latest.metadata,
			});
			if (!updated) throw new Error("profile-section-writer: confirmed profile row is missing");
			return updated;
		} catch (error) {
			if (
				!(error instanceof StorageError) ||
				error.message !== `Cannot update changed memory '${latest.id}'`
			) {
				throw error;
			}
		}
		const refreshed = params.store.getById(latest.id);
		if (!refreshed) throw new Error("profile-section-writer: confirmed profile row is missing");
		const refreshedMetadata = parseInsightMetadata(refreshed.metadata, refreshed);
		// Someone closed the row while this repeat was in flight. A close only rewrites metadata,
		// so the content check below cannot see it, and carrying `valid_from` past the
		// `invalidated_at` the close wrote makes the codec DROP that field (see
		// closeProfileMetadata) — the retired value would read as live again beside its
		// replacement. A closed row is left exactly as the close left it.
		if (refreshedMetadata.invalidated_at !== undefined) return refreshed;
		// Someone else wrote the row first. If they carried it to this moment or past it the
		// bar is already where it belongs, and if they changed the content the row no longer
		// holds the assertion this confirmation repeats.
		const refreshedValidFrom = refreshedMetadata.valid_from;
		if (typeof refreshedValidFrom === "number" && refreshedValidFrom >= params.at) {
			return refreshed;
		}
		if (refreshed.contentHash !== latest.contentHash) return refreshed;
		latest = refreshed;
	}
	throw new Error("profile-section-writer: confirmed profile row kept changing");
}

async function resumeRetireByNamePending(
	current: MemoryEntry,
	params: RunProfileSectionUpdateParams,
): Promise<void> {
	const pending = readRetireByNamePending(current);
	if (pending) await completeRetireByNamePending(current, params, pending);
}

async function listLiveSpecificSiblingSections(
	params: RunProfileSectionUpdateParams,
): Promise<string[]> {
	return (await listLiveSpecificSiblings(params)).map((sibling) => sibling.name);
}

async function listLiveSpecificSiblings(
	params: RunProfileSectionUpdateParams,
): Promise<Array<{ name: string; content: string }>> {
	if (params.sectionName !== "preferences.general") return [];
	const sections = new Map<string, string>();
	for (let offset = 0; ; offset += MAX_LIST_LIMIT) {
		const page = await params.store.list({
			projectId: params.scope,
			category: "profile",
			limit: MAX_LIST_LIMIT,
			offset,
		});
		for (const row of page) {
			const metadata = parseInsightMetadata(row.metadata, row);
			const section = metadata.section_name;
			const content = metadata.l2_content ?? row.text;
			if (
				metadata.invalidated_at !== undefined ||
				typeof section !== "string" ||
				normalizeExactAssertionText(content) ===
					normalizeExactAssertionText(retiredProfileSectionMarker(section))
			) {
				continue;
			}
			if (section.startsWith("preferences.") && section !== "preferences.general") {
				sections.set(section, content);
			}
		}
		if (page.length < MAX_LIST_LIMIT) break;
	}
	return [...sections]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, content]) => ({ name, content }));
}

/**
 * True when a profile-merge call has no model behind it: no client at all, or a route that
 * resolves OFF. Both must be decided BEFORE the call, because an OFF route returns null rather
 * than throwing, which reads downstream as a malformed answer and defers the work forever. That
 * is what the 2026-09-01 run did all night: the lifecycle label was unregistered, so every
 * general-section classification deferred and retire-by-name never had a position to judge.
 */
function profileMergeCallHasNoModel(
	params: RunProfileSectionUpdateParams,
	callLabel: string,
): boolean {
	if (!params.llm) return true;
	if (!params.routing) return false;
	return "off" in resolveLlmRoute({ slot: "profile-merge", callLabel, config: params.routing });
}

/**
 * True when conflict adjudication resolves OFF. This is Local First (or an
 * invalid/retired route); live agent and Sno routes adjudicate inline.
 */
function conflictAdjudicationRoutedOff(params: RunProfileSectionUpdateParams): boolean {
	if (!params.routing) return false;
	const route = resolveLlmRoute({
		slot: "conflict-adjudication",
		callLabel: "conflict-adjudication",
		config: params.routing,
	});
	return "off" in route;
}

async function planProfileConflicts(
	params: RunProfileSectionUpdateParams,
	content: string,
	excludedIds: string[],
): Promise<ProfileConflictPlan> {
	if (conflictAdjudicationRoutedOff(params)) {
		log.debug("profile conflict scan routed off; conflicting rows both persist", {
			mode: params.routing?.mode,
		}, {
			event_name: "sno_station_mem.profile-section-writer.profile.conflict.scan.routed.off.conflicting.rows.both.persist",
			file: "packages/sno-station-mem/src/engine/extraction/profile-section-writer.ts",
			function: "planProfileConflicts",
			site_id: "profile-section-writer.planProfileConflicts.e5bcea94ce",
		});
		return { closes: [] };
	}
	try {
		const vector = await params.store.embedder.embed(content);
		const matches = await params.store.searchSemantic(vector, {
			projectIdFilter: [params.scope],
			category: "profile",
			excludeInvalidatedBefore: Number.MAX_SAFE_INTEGER,
			limit: PROFILE_CONFLICT_TOP_K + excludedIds.length,
		});
		const excluded = new Set(excludedIds);
		const candidates = matches
			.map((match) => match.entry)
			.filter((entry) => !excluded.has(entry.id))
			.slice(0, PROFILE_CONFLICT_TOP_K);
		const closes: MemoryEntry[] = [];
		for (const existing of candidates) {
			let existingMetadata: ReturnType<typeof parseInsightMetadata>;
			try {
				existingMetadata = parseInsightMetadata(existing.metadata, existing);
			} catch (error) {
				logProfileConflictFenceRejection(params, existing, {
					existingSection: null,
					existingFactKey: null,
					existingSessionKey: null,
					reason: "metadata-invalid",
					error,
				});
				continue;
			}
			const existingSection =
				existingMetadata.kind === "profile" ? existingMetadata.section_name : null;
			const existingContent = existingMetadata.l2_content ?? existing.text;
			if (
				typeof existingSection === "string" &&
				normalizeExactAssertionText(existingContent) ===
					normalizeExactAssertionText(retiredProfileSectionMarker(existingSection))
			) {
				continue;
			}
			if (existingSection !== params.sectionName) {
				logProfileConflictFenceRejection(params, existing, {
					existingSection,
					existingFactKey: existingMetadata.fact_key ?? null,
					existingSessionKey: existingMetadata.source_session ?? null,
					reason: "section-mismatch",
				});
				continue;
			}
			const pair = orderAdapterAPair(
				adapterAViewFromEntry(existing),
				prospectiveProfileView(content, params.at),
			);
			const verdict = await adjudicateSafely(pair, params, {
				purpose: "cross-row-profile-conflict",
				existingId: existing.id,
			});
			if (verdict === "uncertain") {
				log.warn("profile conflict adjudication uncertain; keeping both rows", {
					memory_id: existing.id,
					candidate_size: content.length,
				}, {
					event_name: "sno_station_mem.profile-section-writer.profile.conflict.adjudication.uncertain.keeping.both.rows",
					file: "packages/sno-station-mem/src/engine/extraction/profile-section-writer.ts",
					function: "planProfileConflicts",
					site_id: "profile-section-writer.planProfileConflicts.97b6a2e824",
				});
				continue;
			}
			if (verdict !== "replacement") continue;
			if (pair.candidateRole === "older") {
				return { blockedBy: existing, closes: [] };
			}
			closes.push(existing);
		}
		return { closes };
	} catch (error) {
		rethrowConflictCancellation(error);
		log.error("profile conflict scan failed; proceeding without adjudication", {
			error,
			candidate_size: content.length,
		}, {
			event_name: "sno_station_mem.profile-section-writer.profile.conflict.scan.failed.proceeding.without.adjudication",
			file: "packages/sno-station-mem/src/engine/extraction/profile-section-writer.ts",
			function: "planProfileConflicts",
			site_id: "profile-section-writer.planProfileConflicts.b4962bc7f0",
		});
		return { closes: [] };
	}
}

function logProfileConflictFenceRejection(
	params: RunProfileSectionUpdateParams,
	existing: MemoryEntry,
	details: {
		existingSection: string | null;
		existingFactKey: string | null;
		existingSessionKey: string | null;
		reason: "metadata-invalid" | "section-mismatch";
		error?: unknown;
	},
): void {
	log.warn("profile conflict candidate rejected by section fence", {
		incomingSection: params.sectionName,
		existingSection: details.existingSection,
		row_id: existing.id,
		incomingFactKey: profileFactKey(params.sectionName),
		existingFactKey: details.existingFactKey,
		incomingMessageId: params.source.messageId ?? null,
		incoming_session_reference: privateLogReference(params.source.sessionKey),
		existing_session_reference: privateLogReference(details.existingSessionKey ?? undefined),
		reason: details.reason,
		...(details.error ? { error: details.error } : {}),
	}, {
		event_name: "sno_station_mem.profile-section-writer.profile.conflict.candidate.rejected.by.section.fence",
		file: "packages/sno-station-mem/src/engine/extraction/profile-section-writer.ts",
		function: "logProfileConflictFenceRejection",
		site_id: "profile-section-writer.logProfileConflictFenceRejection.b0669b40b3",
	});
}

async function adjudicateSafely(
	pair: ReturnType<typeof orderAdapterAPair>,
	params: RunProfileSectionUpdateParams,
	context: Record<string, unknown>,
): Promise<AdapterAVerdict> {
	try {
		const route = params.routing
			? resolveLlmRoute({
					slot: "conflict-adjudication",
					callLabel: "conflict-adjudication",
					config: params.routing,
				})
			: undefined;
		if (!params.llm) return "uncertain";
		const prompt =
			route && !("off" in route) && route.tier === "snoRemMem"
				? renderAdapterAPrompt(pair.older, pair.newer)
				: renderAdapterAChatPrompt(pair);
		const response = await params.llm.completeText({
			prompt,
			callLabel: "conflict-adjudication",
			adapterSlot: "conflict-adjudication",
			...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
			...(params.signal ? { signal: params.signal } : {}),
		});
		return response ? parseAdapterAChatVerdict(response) : "uncertain";
	} catch (error) {
		rethrowConflictCancellation(error);
		log.error("Conflict adjudicator unavailable; keeping both rows", {
			...context,
			error,
		}, {
			event_name: "sno_station_mem.profile-section-writer.conflict.adjudicator.unavailable.keeping.both.rows",
			file: "packages/sno-station-mem/src/engine/extraction/profile-section-writer.ts",
			function: "adjudicateSafely",
			site_id: "profile-section-writer.adjudicateSafely.d3f7ab0ac5",
		});
		return "uncertain";
	}
}

function uniqueRows(rows: MemoryEntry[]): MemoryEntry[] {
	return [...new Map(rows.map((row) => [row.id, row])).values()];
}

function stableShortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function fallbackProfileMerge(existingText: string, newAssertion: string): string {
	return combineUniqueLines(existingText, newAssertion);
}

function splitPreferenceClauses(text: string): string[] {
	return text
		.split(/\n+|(?<=[.!?])\s+/)
		.map((item) => item.trim())
		.filter(Boolean);
}

function combineUniqueLines(...texts: string[]): string {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const text of texts) {
		for (const line of splitPreferenceClauses(text)) {
			const key = normalizeExactAssertionText(line);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			lines.push(line);
		}
	}
	return lines.join("\n");
}

/**
 * Whether the section already states everything the incoming assertion states,
 * measured with the same clause identity the deterministic merge uses: if
 * combining them adds no clause, there is nothing to write. This is the only
 * condition under which skipping the write loses no memory.
 */
function sectionAlreadyCovers(existingText: string, newAssertion: string): boolean {
	return combineUniqueLines(existingText, newAssertion) === combineUniqueLines(existingText);
}

function normalizeAssertionText(text: string): string {
	const normalized = text
		.toLowerCase()
		.normalize("NFC")
		.replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
		.trim()
		.replace(/\s+/g, " ");
	return normalized || stableShortHash(text);
}

function normalizeExactAssertionText(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function firstSentence(text: string): string {
	return text.split(/(?<=[.!?])\s+/)[0]?.trim() || text;
}
