/** @file with-tool-observability.ts
 * @purpose Wraps plugin tool execution with best-effort observe metadata.
 * @boundary Uses only OpenClaw public plugin tool registration contracts.
 */

import { createUUIDv7 } from "@snoai/common-core";
import { createLogger, currentLogContext, withLogContext } from "@snoai/utils/logger";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { appendAuditEntry } from "@snoai/memory/internal/engine/operations/runtime-audit-log";
import type { PluginObservability } from "@snoai/memory/internal/engine/observability/adapter";
import { bestEffortSync } from "@snoai/memory/internal/engine/observability/best-effort";

type SessionUuidProvider = () => string | undefined;
type ToolRegistration = Parameters<OpenClawPluginApi["registerTool"]>[0];
type ToolOptions = Parameters<OpenClawPluginApi["registerTool"]>[1];
type ToolFactory = Extract<ToolRegistration, (...args: never[]) => unknown>;
const log = createLogger("mem-claw:tool");

function stablePayload(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "null";
	} catch {
		return "[unserializable]";
	}
}

function isToolFactory(tool: ToolRegistration): tool is ToolFactory {
	return typeof tool === "function";
}

function toolResultIsError(result: unknown): boolean {
	return (
		typeof result === "object" &&
		result !== null &&
		"isError" in result &&
		(result as { isError?: unknown }).isError === true
	);
}

async function emitToolCall(
	observability: PluginObservability,
	sessionUuid: string | undefined,
	toolName: string,
	params: unknown,
	result: unknown,
	eventId: string,
	started: number,
): Promise<void> {
	await observability.emit({
		eventType: "tool.call",
		eventId,
		sessionUuid,
		payload: {
			tool_name: toolName,
			decision: "allow",
			input_hash: observability.hashText(stablePayload(params)) ?? eventId,
			output_hash: observability.hashText(stablePayload(result)) ?? eventId,
			latency_ms: Math.max(0, Math.round(Date.now() - started)),
		},
	});
}

function wrapTool(
	tool: AnyAgentTool,
	observability: PluginObservability,
	sessionUuidProvider: SessionUuidProvider,
	stateDir: string,
	requestSessionReference?: string,
): AnyAgentTool {
	const originalExecute = tool.execute;
	const executeWithToolThis = originalExecute as (
		this: AnyAgentTool,
		...args: Parameters<typeof originalExecute>
	) => ReturnType<typeof originalExecute>;
	return {
		...tool,
		async execute(toolCallId, params, signal, onUpdate) {
			const sessionReference = currentLogContext().session_reference.visibility === "unavailable"
				? requestSessionReference : undefined;
			return withLogContext({
				operation_id: currentLogContext().operation_id ?? createUUIDv7(),
				...(sessionReference ? { session_reference: sessionReference } : {}),
			}, async () => {
			const started = Date.now();
			const diagnosticStarted = performance.now();
			const eventId = createUUIDv7();
			let resultStatus: "ok" | "error" = "ok";
			try {
				const result = await executeWithToolThis.call(tool, toolCallId, params, signal, onUpdate);
				if (toolResultIsError(result)) {
					resultStatus = "error";
					const sessionUuid = sessionUuidProvider();
					observability.trackBestEffort("tool.call:throw", () =>
						observability.emitError("tool.call:throw", result, sessionUuid),
					);
				}
				observability.trackBestEffort("tool.call", () =>
					emitToolCall(observability, sessionUuidProvider(), tool.name, params, result, eventId, started),
				);
				return result;
			} catch (error) {
				resultStatus = "error";
				const sessionUuid = sessionUuidProvider();
				observability.trackBestEffort("tool.call", () =>
					emitToolCall(observability, sessionUuid, tool.name, params, error, eventId, started),
				);
				observability.trackBestEffort("tool.call:throw", () =>
					observability.emitError("tool.call:throw", error, sessionUuid),
				);
				throw error;
			} finally {
				log[resultStatus === "error" ? "error" : "info"]("Tool execution completed", {
					tool_name: tool.name,
					outcome: resultStatus,
					duration_ms: performance.now() - diagnosticStarted,
				}, {
					event_name: "tool.completed",
					file: "apps/mem-claw/src/tools/with-tool-observability.ts",
					function: "wrapTool.execute",
					site_id: "tool.execute.completed",
				});
				const sessionUuid = sessionUuidProvider();
				bestEffortSync(
					"costAggregator.record",
					() =>
						observability.aggregator.record("tool.call", sessionUuid, {
							tool_name: tool.name,
						}),
					undefined,
				);
				bestEffortSync(
					"appendAuditEntry",
					() =>
						appendAuditEntry(stateDir, {
							event: "tool_call",
							tool: tool.name,
							resultStatus,
							durationMs: Date.now() - started,
						}),
					undefined,
				);
			}
			});
		},
	};
}

function wrapToolResult(
	result: ReturnType<ToolFactory>,
	observability: PluginObservability,
	sessionUuidProvider: SessionUuidProvider,
	stateDir: string,
	requestSessionReference?: string,
): ReturnType<ToolFactory> {
	if (Array.isArray(result)) {
		return result.map((tool) => wrapTool(tool, observability, sessionUuidProvider, stateDir, requestSessionReference));
	}
	if (!result) return result;
	return wrapTool(result, observability, sessionUuidProvider, stateDir, requestSessionReference);
}

export function withToolObservabilityApi(
	api: OpenClawPluginApi,
	observability: PluginObservability,
	sessionUuidProvider: SessionUuidProvider,
	stateDir: string,
): OpenClawPluginApi {
	return new Proxy(api, {
		get(target, prop, receiver) {
			if (prop === "registerTool") {
				return (tool: ToolRegistration, opts?: ToolOptions): void => {
					if (isToolFactory(tool)) {
						const wrappedFactory: ToolFactory = (ctx) =>
							wrapToolResult(tool(ctx), observability, sessionUuidProvider, stateDir, ctx.sessionKey);
						api.registerTool(wrappedFactory, opts);
						return;
					}
					if ("contextVersion" in tool) {
						api.registerTool({ ...tool, create: (ctx) =>
							wrapToolResult(tool.create(ctx), observability, sessionUuidProvider, stateDir, ctx.sessionKey) }, opts);
						return;
					}
					api.registerTool(wrapTool(tool, observability, sessionUuidProvider, stateDir), opts);
				};
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as OpenClawPluginApi;
}
