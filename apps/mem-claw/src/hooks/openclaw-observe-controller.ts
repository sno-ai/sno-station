import { createLogger as createDiagnosticLogger, privateLogReference } from "@snoai/utils/logger";
const diagnosticLog = createDiagnosticLogger("mem-claw:openclaw-observe-controller");
/** @file openclaw-observe-controller.ts
 * @purpose Owns OpenClaw runtime observability sessions, prompts, snapshots, and finalization.
 * @boundary Observability correlation only; memory hooks and service lifecycle live elsewhere.
 */

import type { PluginHookAgentContext } from "@snoai/memory/internal/engine/bindings/sno-station-mem-hook-types";
import { AsyncLocalStorage } from "node:async_hooks";
import { ObserveSessionRegistry } from "@snoai/memory/internal/engine/observability/session-registry";
import type { OpenClawPluginApi as SnoStationMemPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginConfig } from "@snoai/memory/internal/config/plugin-config-schema";
import type { PluginObservability } from "@snoai/memory/internal/engine/observability/adapter";
import { SNO_OBSERVE_FLUSH_TIMEOUT_MS } from "@snoai/memory/internal/config/index";
import { withToolObservabilityApi } from "../tools/with-tool-observability";
import {
	resolveObserveRuntimeSessionId,
	resolveObserveRuntimeSessionIds,
} from "@snoai/memory/internal/engine/bindings/sno-station-mem-session-state";

type RuntimeObserveControllerArgs = {
	api: SnoStationMemPluginApi;
	config: PluginConfig;
	stateDir: string;
	observability: PluginObservability;

};

type FinalizationProgress = {
	sessionEndEmitted: boolean;
	costSummaryEmitted: boolean;
};

export type RuntimeObserveController = {
	observedApi: SnoStationMemPluginApi;
	observeSessionUuid: () => string | undefined;
	runInObserveSession: <T>(sessionUuid: string, operation: () => Promise<T>) => Promise<T>;
	lookupActiveObserveSession: (ctx: PluginHookAgentContext) => string | undefined;
	startObserveSession: (
		ctx: PluginHookAgentContext,
		prompt?: string,
	) => Promise<string | undefined>;
	finalizeObserveSession: (ctx: PluginHookAgentContext, durationMs?: number) => Promise<void>;
};

/** Creates the observability session controller used by runtime hooks and tools. */
export function createRuntimeObservabilityController({
	api,
	config,
	stateDir,
	observability,
}: RuntimeObserveControllerArgs): RuntimeObserveController {
	const observeSessions = new ObserveSessionRegistry();
	const startedObserveSessions = new Set<string>();
	const finalizedObserveSessions = new Set<string>();
	const finalizationProgress = new Map<string, FinalizationProgress>();
	const observeSessionContext = new AsyncLocalStorage<string>();
	const observeSessionUuid = () => observeSessionContext.getStore();
	const runInObserveSession = <T>(sessionUuid: string, operation: () => Promise<T>): Promise<T> =>
		observeSessionContext.run(sessionUuid, operation);
	const observedApi = withToolObservabilityApi(api, observability, observeSessionUuid, stateDir);
	const resolveObserveSession = (
		ctx: PluginHookAgentContext,
	): { runtimeSessionId: string; sessionUuid: string } | undefined => {
		const runtimeSessionId = resolveObserveRuntimeSessionId(ctx);
		if (!runtimeSessionId) return undefined;
		const sessionUuid = observeSessions.resolve(runtimeSessionId);
		for (const alias of resolveObserveRuntimeSessionIds(ctx)) {
			observeSessions.link(alias, sessionUuid);
		}
		return { runtimeSessionId, sessionUuid };
	};
	const lookupActiveObserveSession = (ctx: PluginHookAgentContext): string | undefined => {
		const runtimeSessionId = resolveObserveRuntimeSessionId(ctx);
		const sessionUuid = observeSessions.lookup(runtimeSessionId);
		if (!sessionUuid) return undefined;
		if (!startedObserveSessions.has(sessionUuid)) return undefined;
		if (finalizedObserveSessions.has(sessionUuid)) return undefined;
		return sessionUuid;
	};
	const emitPromptSubmit = async (prompt: string, sessionUuid: string): Promise<void> => {
		const promptHash = observability.hashText(prompt);
		if (!promptHash) return;
		await observability.emit({
			eventType: "prompt.submit",
			sessionUuid,
			payload: {
				prompt_hash: promptHash,
				byte_len: Buffer.byteLength(prompt, "utf8"),
			},
		});
	};
	const startObserveSession = async (
		ctx: PluginHookAgentContext,
		prompt?: string,
	): Promise<string | undefined> => {
		const resolved = resolveObserveSession(ctx);
		if (!resolved) return undefined;
		const { sessionUuid } = resolved;
		if (!startedObserveSessions.has(sessionUuid)) {
			finalizedObserveSessions.delete(sessionUuid);
			startedObserveSessions.add(sessionUuid);
			observability.aggregator.start(sessionUuid);
			await observability.emit({
				eventType: "session.start",
				sessionUuid,
				payload: { session_uuid: sessionUuid },
			});
		}
		if (prompt !== undefined) {
			await emitPromptSubmit(prompt, sessionUuid);
		}
		return sessionUuid;
	};
	const finalizeObserveSession = async (
		ctx: PluginHookAgentContext,
		durationMs?: number,
	): Promise<void> => {
		const runtimeSessionId = resolveObserveRuntimeSessionId(ctx);
		const sessionUuid = observeSessions.lookup(runtimeSessionId);
		if (!sessionUuid || !startedObserveSessions.has(sessionUuid)) return;
		if (finalizedObserveSessions.has(sessionUuid) && !finalizationProgress.has(sessionUuid)) {
			return;
		}
		finalizedObserveSessions.add(sessionUuid);
		const progress = finalizationProgress.get(sessionUuid) ?? {
			sessionEndEmitted: false,
			costSummaryEmitted: false,
		};
		finalizationProgress.set(sessionUuid, progress);
		try {
			await observability.drain({
				timeoutMs: SNO_OBSERVE_FLUSH_TIMEOUT_MS,
			});
			if (!progress.sessionEndEmitted) {
				await observability.emit({
					eventType: "session.end",
					sessionUuid,
					payload: {
						session_uuid: sessionUuid,
						...(durationMs !== undefined ? { duration_ms: Math.max(0, Math.round(durationMs)) } : {}),
					},
				});
				progress.sessionEndEmitted = true;
			}
			if (!progress.costSummaryEmitted) {
				const summary = observability.aggregator.summary(sessionUuid);
				await observability.emit({
					eventType: "cost.summary",
					sessionUuid,
					payload: summary,
				});
				progress.costSummaryEmitted = true;
			}
			await observability.drainBuffer({
				timeoutMs: SNO_OBSERVE_FLUSH_TIMEOUT_MS,
			});
			// Only clear per-session bookkeeping once every stage has actually
			// succeeded. `progress` exists specifically so a retry can resume
			// from the first stage that didn't complete — clearing it
			// unconditionally (the old `finally`) discarded that on every
			// transient failure, permanently losing session.end / cost.summary /
			// memory.snapshot telemetry (codex adversarial review 2026-07-13).
			observability.aggregator.delete(sessionUuid);
			finalizationProgress.delete(sessionUuid);
			observeSessions.deleteSession(sessionUuid);
			startedObserveSessions.delete(sessionUuid);
			finalizedObserveSessions.delete(sessionUuid);
		} catch (error) {
			diagnosticLog.error("Memory session finalization failed", { error, session_reference: privateLogReference(sessionUuid) }, { event_name: "memory.openclaw_observe_controller.memory.session.finalization.failed", file: "apps/mem-claw/src/hooks/openclaw-observe-controller.ts", function: "finalizeObserveSession", site_id: "plugin.openclaw-observe-controller.finalizeObserveSession.8cc8e6a683" });
		}
	};

	return {
		observedApi,
		observeSessionUuid,
		runInObserveSession,
		lookupActiveObserveSession,
		startObserveSession,
		finalizeObserveSession,
	};
}
