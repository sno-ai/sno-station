import { FIXED_PROTOCOL_VALUE_79 } from "../../model/signed-registry-constants";
import { createLogger as createDiagnosticLogger, privateLogReference } from "@snoai/utils/logger";
const diagnosticLog = createDiagnosticLogger("sno-station-mem:reflection-injection-hooks");
/** @file reflection-injection-hooks.ts
 * @purpose Registers prompt injection hooks for reflection slices and error reminders.
 */


import type { ReflectionDerivedCache } from "./derived-line-cache";
import { getReflectionDerivedCacheEntry } from "./derived-line-cache";
import {
	deleteReflectionDerivedSuppression,
	getReflectionDerivedSuppression,
	type ReflectionDerivedSuppressionCache,
} from "./derived-suppression-cache";
import { isInternalReflectionSessionKey } from "./reflection-embedded-generator";
import type { ReflectionLineSource } from "./memory-entry-projector";
import type { ReflectionSliceLoader } from "./reflection-slice-loader";
import type { createErrorSignalTracker } from "../security/error-signals";
import type { createScopePolicy } from "../security/scopes";
import type { PluginConfig } from "../shared/types";
import type { MemoryTelemetryUsageOutbox } from "../telemetry/memory-telemetry-outbox";

type ReflectionInjectionSurface =
	| "reflection_inherited_rules"
	| "reflection_derived_focus"
	| "reflection_v3_slice";

export type ReflectionInjectionParams = {
	reflectionCfg: PluginConfig["memoryReflection"];
	scopePolicy: ReturnType<typeof createScopePolicy>;
	errorTracker: ReturnType<typeof createErrorSignalTracker>;
	derivedCache: ReflectionDerivedCache;
	derivedSuppressionCache: ReflectionDerivedSuppressionCache;
	derivedKey: (sessionKey: string) => string;
	doPrune: () => void;
	sliceLoader: ReflectionSliceLoader;
	telemetryUsage?: MemoryTelemetryUsageOutbox;
};
type RegisterReflectionInjectionHooksParams = ReflectionInjectionParams;







function appendPendingErrorBlock(
	params: RegisterReflectionInjectionHooksParams,
	sessionKey: string,
	blocks: string[],
): void {
	if (!sessionKey) return;
	const pending = params.errorTracker.getPendingSignals(
		sessionKey,
		params.reflectionCfg.errorReminderMaxEntries,
	);
	if (pending.length === 0) return;
	blocks.push(
		[
			"<error-detected>",
			"A tool error was detected. Consider logging this to `.learnings/ERRORS.md` if it is non-trivial or likely to recur.",
			"Recent error signals:",
			...pending.map((e, i) => `${i + 1}. [${e.toolName}] ${e.summary}`),
			"</error-detected>",
		].join("\n"),
	);
}



function recordReflectionInjectUsage(
	params: RegisterReflectionInjectionHooksParams,
	input: {
		agentId: string;
		sessionKey: string;
		turnId?: string;
		surface: ReflectionInjectionSurface;
		renderedLines: readonly string[];
		sources: readonly ReflectionLineSource[];
	},
): void {
	if (!params.telemetryUsage) return;
	for (const source of selectRenderedSources(input.renderedLines, input.sources)) {
		params.telemetryUsage.tryAcceptUsage({
			eventType: "inject",
			factId: source.factId,
			memoryKind: source.memoryKind,
			projectId: source.projectId,
			agentId: input.agentId,
			sessionUuid: input.sessionKey || undefined,
			turnId: input.turnId,
			retrievalRank: source.rank,
			retrievalScore: source.score,
			metadata: {
				injection_surface: input.surface,
				retrieval_rank: source.rank,
				retrieval_score: source.score,
				...(source.sourceAgentId !== input.agentId && { source_agent_id: source.sourceAgentId }),
			},
		});
	}
}

function selectRenderedSources(
	renderedLines: readonly string[],
	sources: readonly ReflectionLineSource[],
): ReflectionLineSource[] {
	const remaining = new Map<string, number>();
	for (const line of renderedLines) {
		remaining.set(line, (remaining.get(line) ?? 0) + 1);
	}
	const selected: ReflectionLineSource[] = [];
	for (const source of sources) {
		const count = remaining.get(source.line) ?? 0;
		if (count <= 0) continue;
		selected.push(source);
		if (count === 1) remaining.delete(source.line);
		else remaining.set(source.line, count - 1);
	}
	return selected;
}

function readTurnId(ctx: { sessionId?: unknown; turnId?: unknown }): string | undefined {
	if (typeof ctx.turnId === "string" && ctx.turnId.trim()) return ctx.turnId.trim();
	if (typeof ctx.sessionId === "string" && ctx.sessionId.trim()) return ctx.sessionId.trim();
	return undefined;
}

type ReflectionContext = { sessionKey?: string; sessionId?: string; agentId?: string; turnId?: string };

export function createReflectionInjectionHandler1(params: ReflectionInjectionParams): (_event: unknown, ctx: ReflectionContext) => Promise<{ prependContext: string } | undefined> {
 return async (_event: unknown, ctx: ReflectionContext) => {
			const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
			if (sessionKey.includes(":subagent:")) return;
			if (isInternalReflectionSessionKey(sessionKey)) return;
			try {
				params.doPrune();
				const agentId =
					typeof ctx.agentId === "string" && ctx.agentId.trim() ? ctx.agentId.trim() : "main";
				const scopes = params.scopePolicy.getAccessibleScopes(agentId);
				const slices = await params.sliceLoader.loadAgentReflectionSlices(agentId, scopes);
				if (slices.invariants.length === 0) return;
				const renderedLines = slices.invariants.slice(0, 6);
				const body = renderedLines
					.map((line, i) => `${i + 1}. ${line}`)
					.join("\n");
				recordReflectionInjectUsage(params, {
					agentId,
					sessionKey,
					turnId: readTurnId(ctx),
					surface: "reflection_inherited_rules",
					renderedLines,
					sources: slices.invariantSources,
				});
				return {
					prependContext: [
						"<inherited-rules>",
						FIXED_PROTOCOL_VALUE_79,
						body,
						"</inherited-rules>",
					].join("\n"),
				};
			} catch (err) {
				diagnosticLog.warn("Reflection inheritance injection failed", { error: err }, { event_name: "memory.reflection_injection_hooks.reflection.inheritance.injection.failed", file: "packages/sno-station-mem/src/engine/reflection/reflection-injection-hooks.ts", function: "registerInheritedRulesHook", site_id: "reflection.reflection-injection-hooks.registerInheritedRulesHook.43c14eb8b9" });
			}
		};
}

export function createReflectionInjectionHandler2(params: ReflectionInjectionParams): (_event: unknown, ctx: ReflectionContext) => Promise<{ prependContext: string } | undefined> {
 return async (_event: unknown, ctx: ReflectionContext) => {
			const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
			if (sessionKey.includes(":subagent:")) return;
			if (isInternalReflectionSessionKey(sessionKey)) return;
			const agentId =
				typeof ctx.agentId === "string" && ctx.agentId.trim() ? ctx.agentId.trim() : "main";
			params.doPrune();

			const blocks: string[] = [];
			try {
				const now = Date.now();
				const suppressionKey = sessionKey ? params.derivedKey(sessionKey) : "";
				const suppression = suppressionKey
					? getReflectionDerivedSuppression(params.derivedSuppressionCache, suppressionKey, now)
					: undefined;
				if (suppression) {
					diagnosticLog.debug("Reflection derived injection suppressed", { reason_code: suppression.reason, session_reference: privateLogReference(sessionKey) }, { event_name: "memory.reflection_injection_hooks.reflection.derived.injection.suppressed", file: "packages/sno-station-mem/src/engine/reflection/reflection-injection-hooks.ts", function: "registerDerivedFocusHook", site_id: "reflection.reflection-injection-hooks.registerDerivedFocusHook.d23bb07c04" });
				} else {
					if (suppressionKey) {
						deleteReflectionDerivedSuppression(params.derivedSuppressionCache, suppressionKey);
					}
					const scopes = params.scopePolicy.getAccessibleScopes(agentId);
					const cachedDerived = sessionKey
						? getReflectionDerivedCacheEntry(params.derivedCache, params.derivedKey(sessionKey))
						: undefined;
					const loadedSlices = cachedDerived?.derived?.length
						? undefined
						: await params.sliceLoader.loadAgentReflectionSlices(agentId, scopes);
					const derivedLines = cachedDerived?.derived?.length
						? cachedDerived.derived
						: (loadedSlices?.derived ?? []);
					if (derivedLines.length > 0) {
						const renderedLines = derivedLines.slice(0, 6);
						blocks.push(
							[
								"<derived-focus>",
								"Latest derived execution deltas from reflection memory:",
								...renderedLines.map((line, i) => `${i + 1}. ${line}`),
								"</derived-focus>",
							].join("\n"),
						);
						recordReflectionInjectUsage(params, {
							agentId,
							sessionKey,
							turnId: readTurnId(ctx),
							surface: "reflection_derived_focus",
							renderedLines,
							sources: cachedDerived?.derivedSources ?? loadedSlices?.derivedSources ?? [],
						});
					}
				}
			} catch (err) {
				diagnosticLog.warn("Reflection derived injection failed", { error: err }, { event_name: "memory.reflection_injection_hooks.reflection.derived.injection.failed", file: "packages/sno-station-mem/src/engine/reflection/reflection-injection-hooks.ts", function: "registerDerivedFocusHook", site_id: "reflection.reflection-injection-hooks.registerDerivedFocusHook.bbe1a0ae1e" });
			}

			appendPendingErrorBlock(params, sessionKey, blocks);
			if (blocks.length === 0) return;
			return { prependContext: blocks.join("\n\n") };
		};
}

export function createReflectionInjectionHandler3(params: ReflectionInjectionParams): (_event: unknown, ctx: ReflectionContext) => Promise<{ prependContext: string } | undefined> {
 return async (_event: unknown, ctx: ReflectionContext) => {
			const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
			if (sessionKey.includes(":subagent:")) return;
			if (isInternalReflectionSessionKey(sessionKey)) return;
			const agentId =
				typeof ctx.agentId === "string" && ctx.agentId.trim() ? ctx.agentId.trim() : "main";
			try {
				params.doPrune();
				const scopes = params.scopePolicy.getAccessibleScopes(agentId);
				const slices = await params.sliceLoader.loadAgentReflectionSlices(agentId, scopes);
				const blocks: string[] = [];
				if (slices.invariants.length > 0) {
					blocks.push(
						[
							"<reflection-invariants>",
							...slices.invariants.map((line) => `- ${line}`),
							"</reflection-invariants>",
						].join("\n"),
					);
					recordReflectionInjectUsage(params, {
						agentId,
						sessionKey,
						turnId: readTurnId(ctx),
						surface: "reflection_v3_slice",
						renderedLines: slices.invariants,
						sources: slices.invariantSources,
					});
				}
				const now = Date.now();
				const suppressionKey = sessionKey ? params.derivedKey(sessionKey) : "";
				const suppression = suppressionKey
					? getReflectionDerivedSuppression(params.derivedSuppressionCache, suppressionKey, now)
					: undefined;
				if (suppression) {
					diagnosticLog.debug("Reflection derived injection suppressed", { reason_code: suppression.reason, session_reference: privateLogReference(sessionKey) }, { event_name: "memory.reflection_injection_hooks.reflection.derived.injection.suppressed", file: "packages/sno-station-mem/src/engine/reflection/reflection-injection-hooks.ts", function: "registerV3SliceHook", site_id: "reflection.reflection-injection-hooks.registerV3SliceHook.d23bb07c04" });
				} else {
					if (suppressionKey) {
						deleteReflectionDerivedSuppression(params.derivedSuppressionCache, suppressionKey);
					}
					if (slices.derived.length > 0) {
						blocks.push(
							[
								"<reflection-derived>",
								...slices.derived.map((line) => `- ${line}`),
								"</reflection-derived>",
							].join("\n"),
						);
						recordReflectionInjectUsage(params, {
							agentId,
							sessionKey,
							turnId: readTurnId(ctx),
							surface: "reflection_v3_slice",
							renderedLines: slices.derived,
							sources: slices.derivedSources,
						});
					}
				}
				if (blocks.length === 0) return;
				return { prependContext: blocks.join("\n\n") };
			} catch (err) {
				diagnosticLog.warn("Reflection slice injection failed", { error: err }, { event_name: "memory.reflection_injection_hooks.reflection.slice.injection.failed", file: "packages/sno-station-mem/src/engine/reflection/reflection-injection-hooks.ts", function: "registerV3SliceHook", site_id: "reflection.reflection-injection-hooks.registerV3SliceHook.1800747d30" });
			}
		};
}
