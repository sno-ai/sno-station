/** @file reflection-lifecycle-hooks.ts
 * @purpose Tracks reflection error signals and clears per-session state.
 */


import { DEFAULT_REFLECTION_ERROR_SCAN_MAX_CHARS } from "../../../config/index";
import type { ReflectionDerivedCache } from "./derived-line-cache";
import {
	deleteReflectionDerivedSuppression,
	type ReflectionDerivedSuppressionCache,
} from "./derived-suppression-cache";
import { isInternalReflectionSessionKey } from "./reflection-embedded-generator";
import {
	containsErrorSignal,
	type createErrorSignalTracker,
	extractTextFromToolResult,
	normalizeErrorSignature,
	sha256Hex,
	summarizeErrorText,
} from "../security/error-signals";
import type { PluginConfig } from "../shared/types";



export type ReflectionLifecycleParams = {
	reflectionCfg: PluginConfig["memoryReflection"];
	errorTracker: ReturnType<typeof createErrorSignalTracker>;
	derivedCache: ReflectionDerivedCache;
	derivedSuppressionCache: ReflectionDerivedSuppressionCache;
	derivedKey: (sessionKey: string) => string;
	doPrune: () => void;
};

type ReflectionContext = { sessionKey?: string; sessionId?: string; agentId?: string; turnId?: string };

export function createReflectionLifecycleHandler1(params: ReflectionLifecycleParams): (event: { toolName?: string; error?: unknown; result?: unknown }, ctx: ReflectionContext) => void {
 return (event: { toolName?: string; error?: unknown; result?: unknown }, ctx: ReflectionContext) => {
			const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
			if (isInternalReflectionSessionKey(sessionKey)) return;
			if (!sessionKey) return;
			params.doPrune();

			// A successful `exec` invocation often surfaces text like
			// "exit code 0" or "Command exited: 0" in its stdout/stderr (and
			// occasionally in `event.error` for tools that populate it on
			// non-zero only). Without this guard, the generic error-pattern
			// scan downstream classifies those as errors and feeds them into
			// the reflection error-injection block — a false positive that
			// confuses the agent. Short-circuit before either the event.error
			// branch or the result-text scan.
			if (event.toolName === "exec") {
				const execText =
					extractTextFromToolResult(event.result) ||
					(typeof event.error === "string" ? event.error : "");
				const exitCodeMatch = execText.match(
					/(?:\bexit(?:\s+code)?|Command\s+exited)\s*[;:\s](\d+)\b/i,
				);
				const captured = exitCodeMatch?.[1];
				if (captured !== undefined && Number.parseInt(captured, 10) === 0) {
					return;
				}
			}

			if (typeof event.error === "string" && event.error.trim().length > 0) {
				const signature = normalizeErrorSignature(event.error);
				params.errorTracker.addSignal(
					sessionKey,
					{
						at: Date.now(),
						toolName: event.toolName || "unknown",
						summary: summarizeErrorText(event.error),
						source: "tool_error",
						signature,
						signatureHash: sha256Hex(signature).slice(0, 16),
					},
					params.reflectionCfg.dedupeErrorSignals,
				);
				return;
			}

			const resultTextRaw = extractTextFromToolResult(event.result);
			const resultText =
				resultTextRaw.length > DEFAULT_REFLECTION_ERROR_SCAN_MAX_CHARS
					? resultTextRaw.slice(0, DEFAULT_REFLECTION_ERROR_SCAN_MAX_CHARS)
					: resultTextRaw;
			if (!resultText || !containsErrorSignal(resultText)) return;

			const signature = normalizeErrorSignature(resultText);
			params.errorTracker.addSignal(
				sessionKey,
				{
					at: Date.now(),
					toolName: event.toolName || "unknown",
					summary: summarizeErrorText(resultText),
					source: "tool_output",
					signature,
					signatureHash: sha256Hex(signature).slice(0, 16),
				},
				params.reflectionCfg.dedupeErrorSignals,
			);
		};
}

export function createReflectionLifecycleHandler2(params: ReflectionLifecycleParams): (_event: unknown, ctx: ReflectionContext) => void {
 return (_event: unknown, ctx: ReflectionContext) => {
			const ctxRecord = ctx as Record<string, unknown>;
			const sessionKey =
				typeof ctxRecord.sessionKey === "string" ? ctxRecord.sessionKey.trim() : "";
			const sessionId = typeof ctx.sessionId === "string" ? ctx.sessionId.trim() : "";
			if (sessionKey) {
				params.errorTracker.clearSession(sessionKey);
				params.derivedCache.delete(params.derivedKey(sessionKey));
				deleteReflectionDerivedSuppression(
					params.derivedSuppressionCache,
					params.derivedKey(sessionKey),
				);
			}
			if (sessionId && sessionId !== sessionKey) {
				params.errorTracker.clearSession(sessionId);
				params.derivedCache.delete(params.derivedKey(sessionId));
				deleteReflectionDerivedSuppression(
					params.derivedSuppressionCache,
					params.derivedKey(sessionId),
				);
			}
			params.doPrune();
		};
}
