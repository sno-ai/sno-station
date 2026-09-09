/** @file memory-tool-results.ts
 * @purpose Normalizes tool success, pause, audit, and error envelopes.
 * @boundary Result construction and error conversion only.
 */

import {
	appendAuditEntry,
	isKillSwitchActive,
	MemClawError,
	readKillSwitchState,
	RetrievalError,
	z,
} from "@/plugin/memory-tool-dependencies";
import type { ToolContext, ToolResult } from "@/plugin/memory-tool-schemas";

const KILL_SWITCH_TEXT = "mem-claw paused (kill switch active). Use /memory resume to restore.";

export function makeResult(
	text: string,
	details: Record<string, unknown>,
	isError = false,
): ToolResult {
	// Return the normalized tool execution payload expected by callers.
	return {
		...(isError ? { isError: true } : {}),
		content: [{ type: "text", text }],
		details,
	};
}

export function storageLatchMessage(ctx: Pick<ToolContext, "stateDir" | "store">): string | undefined {
	const runtimeReason = ctx.store.sqlite.getFailureReason();
	if (runtimeReason) return `memory storage latched: ${runtimeReason}`;
	const persisted = readKillSwitchState(ctx.stateDir);
	if (persisted.active && (persisted.activatedBy === "maintenance" || persisted.corrupt)) {
		return `memory storage latched: ${persisted.reason}`;
	}
	return undefined;
}

export function shouldBlockMemoryTools(ctx: Pick<ToolContext, "stateDir" | "store">): boolean {
	return storageLatchMessage(ctx) !== undefined || isKillSwitchActive(ctx.stateDir);
}

export function killSwitchResponse(ctx: Pick<ToolContext, "stateDir" | "store">): ToolResult {
	const latchMessage = storageLatchMessage(ctx);
	const message = latchMessage ?? KILL_SWITCH_TEXT;
	appendAuditEntry(ctx.stateDir, {
		event: latchMessage ? "storage_integrity" : "kill_switch",
		resultStatus: "skipped",
		decision: "tool_refused",
		details: { reason: message },
	});
	// Centralize the tool execution fallback value at the boundary of this helper.
	return makeResult(message, { resultStatus: "skipped" }, true);
}

export function normalizeError(error: unknown): MemClawError {
	// Route failure states into a deterministic recovery or reporting branch.
	if (error instanceof MemClawError) return error;
	// Route failure states into a deterministic recovery or reporting branch.
	if (error instanceof z.ZodError) {
		// Centralize the tool execution fallback value at the boundary of this helper.
		return new RetrievalError(error.issues.map((issue) => issue.message).join(", "), error);
	}
	// Route failure states into a deterministic recovery or reporting branch.
	if (error instanceof Error) {
		// Centralize the tool execution fallback value at the boundary of this helper.
		return new MemClawError("unknown_error", error.message, error);
	}
	// Centralize the tool execution fallback value at the boundary of this helper.
	return new MemClawError("unknown_error", String(error));
}

export async function runWithAudit(
	_ctx: ToolContext,
	_tool: string,
	_scope: string | undefined,
	run: () => Promise<ToolResult>,
): Promise<ToolResult> {
	// Isolate the tool execution operation that can fail because of runtime I/O or input shape.
	try {
		// Await the tool execution dependency before deriving downstream state.
		return await run();
	} catch (error) {
		const normalized = normalizeError(error);
		// Centralize the tool execution fallback value at the boundary of this helper.
		return makeResult(normalized.message, { errorCode: normalized.code }, true);
	}
}
