import { checkMemoryOperation } from "../operation-cancellation";
import { FIXED_PROTOCOL_VALUE_78 } from "../../model/signed-registry-constants";
import { createLogger as createDiagnosticLogger, privateLogReference, currentLogContext, withLogContext } from "@snoai/utils/logger";
import { randomUUID } from "node:crypto";
const diagnosticLog = createDiagnosticLogger("sno-station-mem:reflection-command-hooks");
/** @file reflection-command-hooks.ts
 * @purpose Registers command hooks that write reflection logs and memories.
 */


import { appendSelfImprovementEntry } from "../operations/learning-file-maintenance";
import {
	generateReflectionText,
	readSessionConversationWithResetFallback,
	writeReflectionToFilesystem,
} from "./daily-log-generator";
import {
	type ReflectionDerivedCache,
	setReflectionDerivedCacheEntry,
} from "./derived-line-cache";
import {
	DEFAULT_REFLECTION_BOUNDARY_DERIVED_SUPPRESSION_MS,
	isSessionBoundaryReflectionAction,
	type ReflectionDerivedSuppressionCache,
	setReflectionDerivedSuppression,
} from "./derived-suppression-cache";
import { createReflectionEventId } from "./event-payload-builder";
import { extractReflectionLearningGovernanceCandidates } from "./markdown-slice-parser";
import { storeReflectionEntries } from "./memory-entry-projector";
import type { ReflectionDeps } from "./reflection-deps";
import {
	DEFAULT_MEMORY_LLM_CONFIG,
	createReflectionGenerator,
	resolveWorkspaceDirFromEvent,
} from "./reflection-embedded-generator";
import {
	governanceEntryType,
	runMappedMemoryLoop,
} from "./reflection-mapped-memory-loop";
import { runWithSerialGuard } from "./session-serial-guard";
import type { createErrorSignalTracker } from "../security/error-signals";
import { createLlmClient } from "../../model/llm-client";
import { pickLlmRoutingConfig } from "../../model/llm-mode-routing";
import type { PluginConfig } from "../shared/types";
import { getSnoStationMemDataDir } from "../../store/data-paths";

interface ReflectionDiagnostics {
	outcome: string;
	reason: string;
	inputSize: number;
	modelMs: number;
	writeMs: number;
	persisted: number;
	replayed: number;
	unclassifiedWrites: number;
	rowIds: string[];
	fileWritten: boolean;
	eventId?: string;
}



export function createRunMemoryReflection(params: ReflectionCommandParams): (event: { sessionKey: string; context: Record<string, unknown>; action?: string; timestamp?: Date | number }) => Promise<void> {
	return async (event: {
		sessionKey: string;
		context: Record<string, unknown>;
		action?: string;
		timestamp?: Date | number;
	}) => {
		const sessionKey = typeof event.sessionKey === "string" ? event.sessionKey : "";
		return withLogContext({ operation_id: currentLogContext().operation_id ?? randomUUID(), session_reference: sessionKey }, async () => {
		const started = performance.now();
		const diagnostics: ReflectionDiagnostics = { outcome: "skipped", reason: "no_session_input", inputSize: 0,
			modelMs: 0, writeMs: 0, persisted: 0, replayed: 0, unclassifiedWrites: 0, rowIds: [], fileWritten: false };
		const action = String(event.action ?? "unknown");
		const isBoundary = isSessionBoundaryReflectionAction(action);
		// Mark suppression eagerly so a concurrent before_prompt_build that races
		// the reflection body (or the body's own dedup/serial-guard short-circuit)
		// still drops the leaking derived block.
		if (sessionKey && isBoundary) {
			armDerivedSuppression(params, sessionKey, action);
		}
		try {
			const ran = await runWithSerialGuard(
				sessionKey,
				async () => {
					const context = event.context ?? {};
					const workspaceDir = resolveWorkspaceDirFromEvent(context);
					const sessionEntry = (context.previousSessionEntry ?? context.sessionEntry ?? {}) as Record<
						string,
						unknown
					>;
					const currentSessionFile =
						typeof sessionEntry.sessionFile === "string" ? sessionEntry.sessionFile : undefined;
					if (!currentSessionFile) return;

					const conversation = await readSessionConversationWithResetFallback(
						currentSessionFile,
						params.reflectionCfg.messageCount,
					);
					if (!conversation) return;

					diagnostics.inputSize = conversation.length;
					await runMemoryReflectionBody(params, event, conversation, workspaceDir, diagnostics);
				},
				params.logger,
			);
			if (!ran) diagnostics.reason = "serial_guard";
		} catch (error) {
			diagnostics.outcome = "failed";
			diagnostics.reason = "command_failed";
			throw error;
		} finally {
			// Re-arm suppression after the body — `maybeStoreReflection` may have
			// just refreshed `derivedCache` with the about-to-be-closed session's
			// new derived deltas; the fresh-prompt window must still skip them.
			if (sessionKey && isBoundary) {
				armDerivedSuppression(params, sessionKey, action);
			}
			diagnosticLog[diagnostics.outcome === "failed" ? "error" : "info"]("Reflection command completed", {
				outcome: diagnostics.outcome, reason_code: diagnostics.reason, duration_ms: performance.now() - started,
				input_size: diagnostics.inputSize, model_duration_ms: diagnostics.modelMs,
				model_duration_reason: "reflection_generation_calls_only",
				write_duration_ms: diagnostics.writeMs,
				persisted_count: diagnostics.unclassifiedWrites > 0 ? "unavailable" : diagnostics.persisted,
				known_created_count: diagnostics.persisted, replayed_count: diagnostics.replayed,
				unclassified_write_count: diagnostics.unclassifiedWrites,
				write_duration_reason: "layered_store_calls_only",
				persisted_reason: diagnostics.unclassifiedWrites > 0 ? "store_write_outcome_unavailable" : "store_reported_created",
				row_ids: diagnostics.rowIds.slice(0, 128), file_written: diagnostics.fileWritten,
				reflection_event_reference: diagnostics.eventId ?? "unavailable",
				mapped_persisted_count: "unavailable", mapped_persisted_reason: "mapped_writer_does_not_return_durable_count",
				store_reference: privateLogReference(params.deps.store.dbPath),
			}, { event_name: "memory.reflection.completed", file: "packages/sno-station-mem/src/engine/reflection/reflection-command-hooks.ts", function: "createRunMemoryReflection", site_id: "memory.reflection.command.completed" });
		}
		});
	};
}

function armDerivedSuppression(
	params: ReflectionCommandParams,
	sessionKey: string,
	action: string,
): void {
	const key = params.derivedKey(sessionKey);
	params.derivedCache.delete(key);
	const now = Date.now();
	setReflectionDerivedSuppression(params.derivedSuppressionCache, key, {
		updatedAt: now,
		until: now + DEFAULT_REFLECTION_BOUNDARY_DERIVED_SUPPRESSION_MS,
		reason: action,
	});
}

async function runMemoryReflectionBody(
	params: ReflectionCommandParams,
	event: {
		sessionKey: string;
		context: Record<string, unknown>;
		action?: string;
		timestamp?: Date | number;
	},
	conversation: string,
	workspaceDir: string,
	diagnostics: ReflectionDiagnostics,
): Promise<void> {
	const sessionKey = typeof event.sessionKey === "string" ? event.sessionKey : "";
	let reflectionCompleted = false;
	try {
		params.doPrune();
		const sessionEntry = (event.context.previousSessionEntry ??
			event.context.sessionEntry ??
			{}) as Record<string, unknown>;
		const currentSessionId =
			typeof sessionEntry.sessionId === "string" ? sessionEntry.sessionId : "unknown";
		const nowTs =
			typeof event.timestamp === "number"
				? event.timestamp
				: event.timestamp instanceof Date
					? event.timestamp.getTime()
					: Date.now();
		const sourceAgentId = params.deps.parseAgentIdFromSessionKey(sessionKey) || "main";
		const command = String(event.action ?? "unknown");
		// Terminal per-session read: the daily-log reflection wants the full recent error set,
		// not just signals since the last prompt-injection marker. getPendingSignals drains that
		// marker (owned by the per-turn injection hook), so read raw entries here instead — this
		// hook clearSession()s below, so it has no repeat-read concern of its own.
		const errorReminderMax = params.reflectionCfg.errorReminderMaxEntries;
		const toolErrorSignals =
			sessionKey && errorReminderMax > 0
				? params.errorTracker.getState(sessionKey).entries.slice(-errorReminderMax)
				: [];
		const generate = createReflectionGenerator(
			params.config.extraction.llm ?? DEFAULT_MEMORY_LLM_CONFIG,
			pickLlmRoutingConfig(params.config),
			params.deps.agentPort,
		);
		const reflectionResult = await generateReflectionText({
			conversation,
			maxInputChars: params.reflectionCfg.maxInputChars,
			timeoutMs: params.reflectionCfg.timeoutMs,
			toolErrorSignals,
			generate: async (...args) => {
				const started = performance.now();
				try { return await generate(...args); }
				finally { diagnostics.modelMs += performance.now() - started; }
			},
			logger: params.logger,
		});

		if (reflectionResult.usedFallback) {
			diagnosticLog.warn("Reflection generation used fallback", { outcome: "partial", error: reflectionResult.error, session_reference: privateLogReference(currentSessionId) }, { event_name: "memory.reflection_command_hooks.reflection.generation.used.fallback", file: "packages/sno-station-mem/src/engine/reflection/reflection-command-hooks.ts", function: "runMemoryReflectionBody", site_id: "reflection.reflection-command-hooks.runMemoryReflectionBody.be803e8310" });
		}

		checkMemoryOperation();
		const relPath = await writeReflectionToFilesystem({
			workspaceDir,
			reflectionText: reflectionResult.text,
			sessionKey,
			sessionId: currentSessionId,
			agentId: sourceAgentId,
			command,
			toolErrorSignals,
			nowTs,
		});
		diagnostics.fileWritten = true;

		await maybeStoreReflection({
			...params,
			reflectionText: reflectionResult.text,
			usedFallback: reflectionResult.usedFallback,
			sourceAgentId,
			sessionKey,
			sessionId: currentSessionId,
			command,
			toolErrorSignals,
			nowTs,
		}, diagnostics);
		reflectionCompleted = true;
		diagnostics.outcome = reflectionResult.usedFallback ? "partial" : "success";
		diagnostics.reason = reflectionResult.usedFallback ? "generation_fallback" : "completed";
		diagnosticLog.info("Reflection file written", { artifact_reference: privateLogReference(relPath), session_reference: privateLogReference(currentSessionId) }, { event_name: "memory.reflection_command_hooks.reflection.file.written", file: "packages/sno-station-mem/src/engine/reflection/reflection-command-hooks.ts", function: "runMemoryReflectionBody", site_id: "reflection.reflection-command-hooks.runMemoryReflectionBody.2a047c8826" });
	} catch (err) {
		checkMemoryOperation();
		diagnostics.outcome = diagnostics.fileWritten || diagnostics.persisted > 0 ? "partial" : "failed";
		diagnostics.reason = "reflection_failed";
		diagnosticLog.warn("Reflection command failed", { error: err }, { event_name: "memory.reflection_command_hooks.reflection.command.failed", file: "packages/sno-station-mem/src/engine/reflection/reflection-command-hooks.ts", function: "runMemoryReflectionBody", site_id: "reflection.reflection-command-hooks.runMemoryReflectionBody.55c5adf2a5" });
	} finally {
		if (sessionKey && reflectionCompleted) {
			params.errorTracker.clearSession(sessionKey);
		}
		params.doPrune();
	}
}

async function maybeStoreReflection(
	params: ReflectionCommandParams & {
		reflectionText: string;
		usedFallback: boolean;
		sourceAgentId: string;
		sessionKey: string;
		sessionId: string;
		command: string;
		toolErrorSignals: Array<{ signatureHash: string }>;
		nowTs: number;
	},
	diagnostics: ReflectionDiagnostics,
): Promise<void> {
	if (!params.reflectionCfg.storeToDb || params.usedFallback) {
		if (params.sessionKey && params.usedFallback) {
			params.derivedCache.delete(`${params.sourceAgentId}::${params.sessionKey}`);
		}
		return;
	}
	const targetScope = params.deps.scopePolicy.getDefaultScope(params.sourceAgentId);
	const eventId = createReflectionEventId({
		runAt: params.nowTs,
		sessionKey: params.sessionKey,
		sessionId: params.sessionId,
		agentId: params.sourceAgentId,
		command: params.command,
	});
	diagnostics.eventId = eventId;
	try {
		const llmCfg = params.config.extraction.llm ?? DEFAULT_MEMORY_LLM_CONFIG;
		const mappedLlm = createLlmClient({
			preset: llmCfg.preset,
			...(llmCfg.apiKey ? { apiKey: llmCfg.apiKey } : {}),
			...(llmCfg.baseURL ? { baseURL: llmCfg.baseURL } : {}),
			...(llmCfg.heliconeApiKey ? { heliconeApiKey: llmCfg.heliconeApiKey } : {}),
			timeoutMs: llmCfg.timeoutMs,
			routing: pickLlmRoutingConfig(params.config),
			...(params.deps.agentPort ? { agentPort: params.deps.agentPort } : {}),
		});
		const layered = await storeReflectionEntries({
			reflectionText: params.reflectionText,
			sessionKey: params.sessionKey,
			sessionId: params.sessionId,
			agentId: params.sourceAgentId,
			command: params.command,
			scope: targetScope,
			toolErrorSignals: params.toolErrorSignals,
			runAt: params.nowTs,
			usedFallback: params.usedFallback,
			eventId,
			writeLegacyCombined: false,
			dedupeThreshold: 0.97,
			embed: (text) => params.deps.embedder.embed(text),
			searchSemantic: (vector, options) => params.deps.store.searchSemantic(vector, options),
			store: async (entry) => {
				const started = performance.now();
				try {
					const result = await params.deps.store.store({
						...entry,
						offlineFamily: true,
					});
					if (result.storeWriteOutcome === "created") {
						diagnostics.persisted += 1;
						diagnostics.rowIds.push(result.id);
					} else if (result.storeWriteOutcome === "existing") {
						diagnostics.replayed += 1;
					} else {
						diagnostics.unclassifiedWrites += 1;
					}
					return {
						id: result.id,
						factId: result.factId,
						category: result.category,
						projectId: result.projectId,
					};
				} finally { diagnostics.writeMs += performance.now() - started; }
			},
		});
		await runMappedMemoryLoop({
			reflectionText: params.reflectionText,
			store: params.deps.store,
			embedder: params.deps.embedder,
			llm: mappedLlm,
			routing: pickLlmRoutingConfig(params.config),
			targetScope,
			sourceAgentId: params.sourceAgentId,
			sessionKey: params.sessionKey,
			sessionId: params.sessionId,
			runAt: params.nowTs,
			usedFallback: params.usedFallback,
			toolErrorSignals: params.toolErrorSignals,
			eventId,
			logger: params.logger,
		});
		await appendGovernanceEntries(params, eventId);
		if (
			params.sessionKey &&
			layered.slices.derived.length > 0 &&
			!isSessionBoundaryReflectionAction(params.command)
		) {
			setReflectionDerivedCacheEntry(
				params.derivedCache,
				`${params.sourceAgentId}::${params.sessionKey}`,
				{
					updatedAt: params.nowTs,
					derived: layered.slices.derived,
					derivedSources: layered.derivedSources,
				},
			);
		}
	} finally {
		if (params.sourceAgentId === "main") params.clearAllSliceCache();
		else params.clearSliceCacheForAgent(params.sourceAgentId);
	}
}

async function appendGovernanceEntries(
	params: Parameters<typeof maybeStoreReflection>[0],
	eventId: string,
): Promise<void> {
	const governance = extractReflectionLearningGovernanceCandidates(params.reflectionText);
	if (governance.length === 0) return;
	const baseDir = getSnoStationMemDataDir();
	for (const entry of governance) {
		try {
			await appendSelfImprovementEntry({
				baseDir,
				type: governanceEntryType(entry.area),
				summary: entry.summary,
				details: entry.details ?? "",
				suggestedAction: entry.suggestedAction ?? "",
				...(entry.area !== undefined ? { area: entry.area } : {}),
				...(entry.priority !== undefined ? { priority: entry.priority } : {}),
				...(entry.status !== undefined ? { status: entry.status } : {}),
				source: `${FIXED_PROTOCOL_VALUE_78}${eventId}`,
			});
		} catch (err) {
		checkMemoryOperation();
			diagnosticLog.warn("Reflection learning append failed", { error: err }, { event_name: "memory.reflection_command_hooks.reflection.learning.append.failed", file: "packages/sno-station-mem/src/engine/reflection/reflection-command-hooks.ts", function: "appendGovernanceEntries", site_id: "reflection.reflection-command-hooks.appendGovernanceEntries.805fa046d0" });
		}
	}
}

export type ReflectionCommandParams = {
	logger: { info(message: string): void; warn(message: string): void; error(message: string): void; debug?(message: string): void };
	config: PluginConfig;
	reflectionCfg: PluginConfig["memoryReflection"];
	deps: ReflectionDeps;
	errorTracker: ReturnType<typeof createErrorSignalTracker>;
	derivedCache: ReflectionDerivedCache;
	derivedSuppressionCache: ReflectionDerivedSuppressionCache;
	derivedKey: (sessionKey: string) => string;
	doPrune: () => void;
	clearSliceCacheForAgent: (agentId: string) => void;
	clearAllSliceCache: () => void;
};
