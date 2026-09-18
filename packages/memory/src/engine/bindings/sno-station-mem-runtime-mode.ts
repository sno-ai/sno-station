import { createLogger as createDiagnosticLogger } from "@snoai/utils/logger";
const diagnosticLog = createDiagnosticLogger("sno-station-mem:sno-station-mem-runtime-mode");
/** @file sno-station-mem-runtime-mode.ts
 * @purpose Resolves runtime mode switches and hook agent identity decisions.
 * @boundary Environment/argv checks and scoped audit breadcrumbs only.
 */

import type { SnoStationMemPluginApi } from "./sno-station-mem-runtime-dependencies";
import { appendAuditEntry, isSystemBypassId } from "./sno-station-mem-runtime-dependencies";

/** Detects completion bootstrap mode so plugin startup can expose only completion wiring. */
export function isCompletionMode(): boolean {
	// Centralize the module behavior fallback value at the boundary of this helper.
	return process.argv.slice(1, 4).includes("completion");
}

/** Detects gateway mode before starting host services that are not needed there. */
export function isGatewayMode(): boolean {
	// Centralize the module behavior fallback value at the boundary of this helper.
	return process.argv.includes("gateway");
}

/**
 * Extracts an agent id from supported session-key formats while ignoring system bypass ids.
 */
export function parseAgentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
	const sk = (sessionKey ?? "").trim();
	const parts = sk.split(":");
	// Keep identity and boundary checks ahead of any privileged operation.
	if (parts.length >= 2 && (parts[0] === "agent" || parts[0] === "session")) {
		// Compute the normalized agent id once so later module behavior checks use one value.
		const agentId = parts[1]?.trim();
		// Keep identity and boundary checks ahead of any privileged operation.
		if (agentId && !isSystemBypassId(agentId)) return agentId;
	}
	// Signal an intentional miss with undefined instead of overloading an empty value.
	return undefined;
}

export async function runObserveLifecycleTask(
	label: string,
	logger: SnoStationMemPluginApi["logger"],
	timeoutMs: number,
	task: () => Promise<void>,
): Promise<void> {
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const run = Promise.resolve().then(task);
	run.catch(() => undefined);
	try {
		await Promise.race([
			run,
			new Promise<void>((resolve) => {
				timeoutHandle = setTimeout(() => {
					diagnosticLog.warn("Memory observation task timed out", { operation: label, timeout_ms: timeoutMs }, { event_name: "memory.sno-station-mem_runtime_mode.memory.observation.task.timed.out", file: "packages/sno-station-mem/src/engine/bindings/sno-station-mem-runtime-mode.ts", function: "runObserveLifecycleTask", site_id: "plugin.sno-station-mem-runtime-mode.runObserveLifecycleTask.d1856ccb13" });
					resolve();
				}, timeoutMs);
				const nodeTimeout = timeoutHandle as typeof timeoutHandle & {
					unref?: () => void;
				};
				nodeTimeout.unref?.();
			}),
		]);
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
	}
}

/**
 * Detects pure-digit agentIds that almost always come from a chat_id / user-id
 * extraction (e.g. Discord snowflake `657229412030480397`, Telegram numeric
 * user_id `5108601505`). Treating these as agent identities triggers spurious
 * recall lookups against ids that have no memory rows. Issue #492 / PR #516
 * Layer 2.
 *
 * Returns true only for non-empty strings that are exclusively ASCII digits.
 * Empty/whitespace inputs are handled separately by `resolveHookAgentId`.
 */
export function isChatIdBasedAgentId(agentId: string | undefined): boolean {
	if (typeof agentId !== "string") return false;
	const trimmed = agentId.trim();
	if (trimmed.length === 0) return false;
	return /^\d+$/.test(trimmed);
}

/**
 * Resolve the agentId for hook-level filtering: prefer an explicit ctx.agentId,
 * then fall back to parsing the sessionKey. Callers supply defaults when no identity is found.
 */
export type HookAgentResolutionSource = "explicit" | "sessionKey" | "missing";

/**
 * Derives the effective hook agent id with explicit then session-key ordering.
 */
export function resolveHookAgentId(
	explicitAgentId: unknown,
	sessionKey: unknown,
): { agentId?: string; source: HookAgentResolutionSource } {
	// Guard explicit agent id here so the remaining module behavior path works with normalized inputs.
	if (typeof explicitAgentId === "string" && explicitAgentId.trim()) {
		const agentId = explicitAgentId.trim();
		if (isSystemBypassId(agentId)) return { source: "missing" };
		// Return the normalized plugin lifecycle payload expected by callers.
		return { agentId, source: "explicit" };
	}
	// Guard session key here so the remaining module behavior path works with normalized inputs.
	if (typeof sessionKey === "string") {
		const parsed = parseAgentIdFromSessionKey(sessionKey);
		// Keep identity and boundary checks ahead of any privileged operation.
		if (parsed) return { agentId: parsed, source: "sessionKey" };
	}
	// Return the normalized plugin lifecycle payload expected by callers.
	return { source: "missing" };
}

/** Emits a scoped audit breadcrumb when hook metadata is missing or unparseable. */
export function auditMissingHookAgentIdentity(
	api: SnoStationMemPluginApi,
	hookName: "agent_end" | "before_prompt_build" | "before_reset",
	stateDir: string,
	event: "ambient_learning" | "auto_recall" | "session_summary",
): void {
	diagnosticLog.warn("Memory hook lacks agent identity", { operation: hookName, reason_code: "missing_agent_identity" }, { event_name: "memory.sno-station-mem_runtime_mode.memory.hook.lacks.agent.identity", file: "packages/sno-station-mem/src/engine/bindings/sno-station-mem-runtime-mode.ts", function: "auditMissingHookAgentIdentity", site_id: "plugin.sno-station-mem-runtime-mode.auditMissingHookAgentIdentity.f06795892a" });
	appendAuditEntry(stateDir, {
		event,
		hook: hookName,
		resultStatus: "skipped",
		decision: "rejected_missing_agent_identity",
	});
}
