/** @file sno-station-mem-ambient-learning-hook.ts
 * @purpose Routes successful agent conversations through atomic memory extraction.
 * @boundary The agent_end hook path only; registration and service lifecycle are elsewhere.
 */

import { unresolvedMemoryDate } from "../extraction/date-resolution";
import { randomUUID } from "node:crypto";
import { createLogger, currentLogContext, withLogContext } from "@snoai/utils/logger";
import {
	buildConversationText,
	deriveSessionDateTime,
	extractAllMessageTexts,
	isAmbientLearningMessage,
	transcriptSessionDateTime,
} from "./sno-station-mem-message-transcript";
import type { PluginHookAgentContext, PluginHookAgentEndEvent } from "./sno-station-mem-hook-types";
import {
	appendAuditEntry,
	type AtomicInsightDistiller,
	type createScopePolicy,
	DEFAULT_IMPORTANCE,
	type Embedder,
	isKillSwitchActive,
	type MemoryStore,
	normalizeAmbientLearningText,
	type SnoStationMemPluginApi,
	type PluginConfig,
	parseSessionTimestamp,
	redactSecrets,
	serializeIntervalMetadata,
	shouldSkipReflectionMessage,
} from "./sno-station-mem-runtime-dependencies";
import {
	auditMissingHookAgentIdentity,
	isChatIdBasedAgentId,
	resolveHookAgentId,
} from "./sno-station-mem-runtime-mode";
const log = createLogger("sno-station-mem:ambient-learning");

async function runLocalFirstCapture(input: {
	api: SnoStationMemPluginApi;
	config: PluginConfig;
	store: MemoryStore;
	event: PluginHookAgentEndEvent;
	ctx: PluginHookAgentContext;
	stateDir: string;
	scope: string;
	sessionKey: string;
}): Promise<void> {
	const { api, config, store, event, ctx, stateDir, scope, sessionKey } = input;
	const entries = event.messages.flatMap((message) => {
		if (!isAmbientLearningMessage(message)) return [];
		if (message.role === "assistant" && !config.captureAssistant) return [];
		return extractAllMessageTexts(message).flatMap((raw) => {
			const normalized = normalizeAmbientLearningText(
				message.role,
				raw,
				shouldSkipReflectionMessage,
			);
			return normalized ? [{ role: message.role, text: normalized.trim() }] : [];
		});
	});

	const seen = new Set<string>();
	const sessionDateTime =
		transcriptSessionDateTime(event.messages) ??
		deriveSessionDateTime(event.messages, config.captureAssistant);
	const sessionTimestamp = parseSessionTimestamp(sessionDateTime);
	let stored = 0;
	let failures = 0;
	for (const entry of entries) {
		if (!entry.text || seen.has(entry.text)) continue;
		seen.add(entry.text);
		try {
			const date = unresolvedMemoryDate({
				text: entry.text,
				sessionDateTime,
				sessionTimezone: ctx.sessionTimezone,
				locale: config.language,
			});
			await store.store({
				text: entry.text,
				category: "episodic",
				projectId: scope,
				importance: DEFAULT_IMPORTANCE,
				...(date.timestamp !== undefined
					? { timestamp: date.timestamp }
					: sessionTimestamp !== undefined
						? { timestamp: sessionTimestamp }
						: {}),
				timezone: date.timezone,
				metadata: JSON.stringify({
					memory_category: "episodic",
					capture_mode: "local-first",
					role: entry.role,
					...(sessionKey ? { session_key: sessionKey } : {}),
					...serializeIntervalMetadata("episodic", date.interval),
				}),
			});
			stored += 1;
		} catch (error) {
			failures += 1;
			log.warn("Local capture write failed", { error }, { event_name: "memory.capture.write.failed", file: "packages/sno-station-mem/src/engine/bindings/sno-station-mem-ambient-learning-hook.ts", function: "runLocalFirstCapture", site_id: "memory.capture.local.write.failed" });
		}
	}
	appendAuditEntry(stateDir, {
		event: "hook_trigger",
		hook: "agent_end",
		resultStatus: failures === 0 ? "ok" : "partial",
		details: { mode: config.mode, candidates: entries.length, stored, failures },
	});
	log.info("Local memory capture completed", { outcome: failures ? "partial" : stored ? "success" : "empty_success",
		persisted_count: stored, failed_count: failures, input_count: entries.length },
		{ event_name: "memory.capture.completed", file: "packages/sno-station-mem/src/engine/bindings/sno-station-mem-ambient-learning-hook.ts", function: "runLocalFirstCapture", site_id: "memory.capture.local.completed" });
}

/** Runs atomic extraction after a successful top-level agent conversation. */
export type AmbientCaptureOutcome = "skipped" | "success" | "partial" | "failed";

export async function onAgentEnd(
	api: SnoStationMemPluginApi,
	config: PluginConfig,
	store: MemoryStore,
	_embedder: Embedder,
	scopePolicy: ReturnType<typeof createScopePolicy>,
	insightDistiller: AtomicInsightDistiller | undefined,
	event: PluginHookAgentEndEvent,
	ctx: PluginHookAgentContext,
	stateDir: string,
): Promise<AmbientCaptureOutcome> {
	const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
	return withLogContext({ operation_id: currentLogContext().operation_id ?? randomUUID(), session_reference: sessionKey }, async () => {
	const started = performance.now();
	let outcome: AmbientCaptureOutcome = "skipped";
	let reason = "guard_not_admitted";
	try {
	if (isKillSwitchActive(stateDir) || !config.ambientLearning) return outcome;
	if (sessionKey.includes(":subagent:")) {
		appendAuditEntry(stateDir, {
			event: "ambient_learning",
			hook: "agent_end",
			resultStatus: "skipped",
			decision: "skipped_subagent",
			details: { sessionKey },
		});
		return outcome;
	}
	if (!event.success) {
		reason = "agent_run_failed";
		return outcome;
	}

	const { agentId: resolvedAgentId, source: agentResolutionSource } = resolveHookAgentId(
		ctx.agentId,
		sessionKey,
	);
	if (agentResolutionSource === "missing" || !resolvedAgentId) {
		auditMissingHookAgentIdentity(api, "agent_end", stateDir, "ambient_learning");
		return outcome;
	}
	if (isChatIdBasedAgentId(resolvedAgentId)) {
		appendAuditEntry(stateDir, {
			event: "ambient_learning",
			hook: "agent_end",
			resultStatus: "skipped",
			decision: "rejected_chatid_agent_format",
			details: { resolvedAgentId },
		});
		return outcome;
	}

	const scope = scopePolicy.getDefaultScope(resolvedAgentId);
	if (!scopePolicy.validateScope(scope) || !scopePolicy.isAccessible(scope, resolvedAgentId)) {
		reason = "scope_inaccessible";
		return outcome;
	}
	if (config.mode === "local-first") {
		await runLocalFirstCapture({ api, config, store, event, ctx, stateDir, scope, sessionKey });
		outcome = "success";
		return outcome;
	}
	if (!insightDistiller) {
		appendAuditEntry(stateDir, {
			event: "ambient_learning",
			hook: "agent_end",
			resultStatus: "skipped",
			decision: "atomic_extractor_unavailable",
			details: { mode: config.mode },
		});
		return outcome;
	}

	const conversationText = buildConversationText(
		event.messages,
		config.captureAssistant,
	).text;
	const sessionDateTime =
		transcriptSessionDateTime(event.messages) ??
		deriveSessionDateTime(event.messages, config.captureAssistant);
	if (!conversationText.trim()) {
		appendAuditEntry(stateDir, {
			event: "ambient_learning",
			hook: "agent_end",
			resultStatus: "skipped",
			decision: "rejected_empty_conversation",
			details: { mode: config.mode },
		});
		return outcome;
	}

	try {
		const stats = await insightDistiller.extractAndPersist(conversationText, sessionKey, {
			scope,
			sessionDateTime,
			sessionTimezone: ctx.sessionTimezone,
		});
		const partial = (stats.llmFailures ?? 0) > 0;
		outcome = partial ? "partial" : "success";
		reason = "extraction_returned";
		const details = partial
			? {
					created: stats.created,
					merged: stats.merged,
					skipped: stats.skipped,
					llmFailures: stats.llmFailures,
					todoTransitionsWithoutSourceCount: stats.todoTransitionsWithoutSourceCount,
					fallback: "disabled",
				}
			: {
					created: stats.created,
					merged: stats.merged,
					skipped: stats.skipped,
					todoTransitionsWithoutSourceCount: stats.todoTransitionsWithoutSourceCount,
					conversationChars: conversationText.length,
					sessionDateTime,
					sessionTimezone: ctx.sessionTimezone,
				};
		appendAuditEntry(stateDir, {
			event: "ambient_learning",
			hook: "agent_end",
			resultStatus: partial ? "partial" : "ok",
			decision: partial ? "llm_distill_failed" : "llm_distill_extracted",
			details,
		});
	} catch (error) {
		const rawMessage = error instanceof Error ? error.message : String(error);
		const safeMessage = redactSecrets(rawMessage).slice(0, 200);
		outcome = "failed";
		reason = "extraction_failed";
		log.warn("Ambient extraction failed", { error }, { event_name: "memory.capture.hook.failed", file: "packages/sno-station-mem/src/engine/bindings/sno-station-mem-ambient-learning-hook.ts", function: "onAgentEnd", site_id: "memory.capture.hook.failed" });
		appendAuditEntry(stateDir, {
			event: "ambient_learning",
			hook: "agent_end",
			resultStatus: "partial",
			decision: "llm_distill_failed",
			details: { error: safeMessage, fallback: "disabled" },
		});
	}
	} finally {
		log.info("Ambient capture hook completed", { outcome, reason_code: reason, duration_ms: performance.now() - started },
			{ event_name: "memory.capture.hook.completed", file: "packages/sno-station-mem/src/engine/bindings/sno-station-mem-ambient-learning-hook.ts", function: "onAgentEnd", site_id: "memory.capture.hook.completed" });
	}
	return outcome;
	});
}
