/** @file memory-tool-results.ts
 * @purpose Normalizes tool success, audit, and error envelopes.
 * @boundary Result construction and error conversion only.
 */

import { createLogger } from "@snoai/utils/logger";

const log = createLogger("sno-station-mem:memory-tools");

import {
	SnoStationMemError,
	RetrievalError,
	z,
} from "./memory-tool-dependencies";
import type { ToolContext, ToolResult } from "./memory-tool-schemas";

export function makeResult(
	text: string,
	details: Record<string, unknown>,
	isError = false,
): ToolResult {
	if (isError) log.error("Memory operation failed; later requests remain available", { cause: text }, {
		event_name: "memory.tool.operation.failed", file: "packages/sno-station-mem/src/engine/bindings/memory-tool-results.ts",
		function: "makeResult", site_id: "memory.tool.operation.failed",
	});
	// Return the normalized tool execution payload expected by callers.
	return {
		...(isError ? { isError: true } : {}),
		content: [{ type: "text", text }],
		details,
	};
}

export function normalizeError(error: unknown): SnoStationMemError {
	// Route failure states into a deterministic recovery or reporting branch.
	if (error instanceof SnoStationMemError) return error;
	// Route failure states into a deterministic recovery or reporting branch.
	if (error instanceof z.ZodError) {
		// Centralize the tool execution fallback value at the boundary of this helper.
		return new RetrievalError(error.issues.map((issue) => issue.message).join(", "), error);
	}
	// Route failure states into a deterministic recovery or reporting branch.
	if (error instanceof Error) {
		// Centralize the tool execution fallback value at the boundary of this helper.
		return new SnoStationMemError("unknown_error", error.message, error);
	}
	// Centralize the tool execution fallback value at the boundary of this helper.
	return new SnoStationMemError("unknown_error", String(error));
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
