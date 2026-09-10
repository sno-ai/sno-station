/** @file strategy-hook-runner.ts
 * @purpose Connects runtime events to reflection storage and learning workflows.
 * @boundary Plugin hooks, reflection analysis, and self-improvement integration.
 * @see daily-log-generator.ts, learning-file-hooks.ts, sno-station-mem-plugin-runtime.ts.
 */

import { createLogger as createDiagnosticLogger } from "@snoai/utils/logger";
const diagnosticLog = createDiagnosticLogger("sno-station-mem:strategy-hook-runner");

import {
	DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS,
	DEFAULT_REFLECTION_SESSION_TTL_MS,
} from "../../../config/index";
import type { ReflectionDerivedCache } from "./derived-line-cache";
import type { ReflectionDerivedSuppressionCache } from "./derived-suppression-cache";

import type { ReflectionDeps } from "./reflection-deps";
import {
	isInternalReflectionSessionKey,
	pruneReflectionState,
} from "./reflection-embedded-generator";


import { createReflectionSliceLoader } from "./reflection-slice-loader";
import { createErrorSignalTracker } from "../security/error-signals";
import type { PluginConfig } from "../shared/types";

export type { ReflectionDeps } from "./reflection-deps";
export { isInternalReflectionSessionKey };

export function createReflectionStrategyState(config: PluginConfig, deps: ReflectionDeps): ReflectionStrategyState {
	const reflectionCfg = config.memoryReflection;
	const errorTracker = createErrorSignalTracker({
		maxTrackedSessions: DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS,
	});
	const derivedCache: ReflectionDerivedCache = new Map();
	const derivedSuppressionCache: ReflectionDerivedSuppressionCache = new Map();
	const derivedKey = (sessionKey: string) =>
		`${deps.parseAgentIdFromSessionKey(sessionKey) || "main"}::${sessionKey}`;
	const doPrune = () =>
		pruneReflectionState(
			errorTracker,
			derivedCache,
			derivedSuppressionCache,
			DEFAULT_REFLECTION_SESSION_TTL_MS,
			DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS,
		);

	

	const sliceLoader = createReflectionSliceLoader({
		store: deps.store,
		scopePolicy: deps.scopePolicy,
	});
	deps.onSliceCacheReady?.(sliceLoader.clearAll);
	
	

	
return { lifecycle: {
		reflectionCfg,
		errorTracker,
		derivedCache,
		derivedSuppressionCache,
		derivedKey,
		doPrune,
	}, injection: {
		reflectionCfg,
		scopePolicy: deps.scopePolicy,
		errorTracker,
		derivedCache,
		derivedSuppressionCache,
		derivedKey,
		doPrune,
		sliceLoader,
		telemetryUsage: deps.telemetryUsage,
	}, command: {
		config,
		reflectionCfg,
		deps,
		errorTracker,
		derivedCache,
		derivedSuppressionCache,
		derivedKey,
		doPrune,
		clearSliceCacheForAgent: sliceLoader.clearAgent,
		clearAllSliceCache: sliceLoader.clearAll,
	} };
}

export type ReflectionStrategyState = { lifecycle: import("./reflection-lifecycle-hooks").ReflectionLifecycleParams; injection: import("./reflection-injection-hooks").ReflectionInjectionParams; command: Omit<import("./reflection-command-hooks").ReflectionCommandParams, "logger"> };
