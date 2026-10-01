import { ContractError, type ScopeCtx } from "@snoai/memory/client";
import { z } from "zod";
import { SnoStationMemError } from "@snoai/memory/internal/engine/shared/errors";
import { resolveAgentId } from "@snoai/memory/internal/engine/bindings/memory-tool-access";
import type { HostMemoryContext } from "../install/memory-connection";
import type { ToolContext, ToolResult } from "./memory-tool-schemas";
import { readPluginSettings } from "../install/settings";

const nonempty = z.string().refine(value => value.trim().length > 0);

export function toolHostContext(value: unknown): HostMemoryContext {
	return z.object({ agentId: z.string().optional(), sessionKey: z.string().optional(),
		sessionId: z.string().optional(), workspaceDir: z.string().optional(),
		sessionTimezone: z.string().optional(), gatewayClientScopes: z.array(z.string()).optional(),
	}).parse(value ?? {});
}

export async function executeMemoryRecallTool(ctx: ToolContext, access: HostMemoryContext,
	_id: unknown, params: unknown, _options?: unknown): Promise<ToolResult> {
	return withToolErrors(async () => {
		const input = z.strictObject({ query: nonempty }).parse(params);
		const client = await ctx.connection.ready();
		const result = await client.getRecall(input.query, await toolScope(ctx, access), {
			source: "manual", limit: readPluginSettings().recall.explicitLimit, includeMetadata: true,
		});
		if (result.degraded) throw new ContractError(result.reason, result.error);
		if (result.unavailable) throw new ContractError("engine-failed", result.unavailable);
		if (!result.toolResult) throw new ContractError("engine-failed");
		return { ...result.toolResult, content: [{ type: "text", text: result.contextText }] };
	});
}

export async function executeMemoryGetTool(ctx: ToolContext, access: HostMemoryContext,
	_id: unknown, params: unknown): Promise<ToolResult> {
	return withToolErrors(async () => {
		const input = z.strictObject({ id: nonempty }).parse(params);
		const client = await ctx.connection.ready();
		const result = await client.inspect({ op: "get", id: input.id }, await toolScope(ctx, access));
		if (result.degraded) throw new ContractError(result.reason, result.error);
		if (result.result.op !== "get") throw new ContractError("engine-failed");
		if (!result.result.entry) return { isError: true,
			content: [{ type: "text", text: "not-found" }], details: { errorCode: "not-found" } };
		const entry = result.result.entry;
		return { content: [{ type: "text", text: `${entry.id}\n${entry.text}` }], details: { id: entry.id } };
	});
}

export async function executeMemorySaveTool(ctx: ToolContext, access: HostMemoryContext,
	_id: unknown, params: unknown): Promise<ToolResult> {
	return withToolErrors(async () => {
		const input = z.strictObject({ content: nonempty }).parse(params);
		const client = await ctx.connection.ready();
		const stored = await client.mutate({ op: "store", content: input.content, category: "episodic" },
			await toolScope(ctx, access));
		if (stored.degraded) throw new ContractError(stored.reason, stored.error);
		if (stored.result.isError) return stored.result;
		const id = stored.result.details["id"];
		if (typeof id !== "string" || !id) throw new ContractError("engine-failed");
		return { ...stored.result, isError: false, content: [{ type: "text", text: id }] };
	});
}

export async function executeMemoryCorrectTool(ctx: ToolContext, access: HostMemoryContext,
	_id: unknown, params: unknown): Promise<ToolResult> {
	return withToolErrors(async () => {
		const input = z.strictObject({ id: nonempty, content: nonempty }).parse(params);
		const client = await ctx.connection.ready();
		const result = await client.mutate({ op: "correct", ...input }, await toolScope(ctx, access));
		if (result.degraded) throw new ContractError(result.reason, result.error);
		return result.result;
	});
}

/** Keep the existing host identity rule at the service boundary. */
async function toolScope(ctx: ToolContext, access: HostMemoryContext): Promise<ScopeCtx> {
	const systemCaller = access.gatewayClientScopes?.includes("operator.admin") ?? false;
	const agentId = resolveAgentId(access.agentId, access.sessionKey?.match(/^agent:([^:]+):/)?.[1]);
	if (agentId === undefined && !systemCaller) throw new ContractError("invalid-input");
	return ctx.connection.scope(access);
}

async function withToolErrors(run: () => Promise<ToolResult>): Promise<ToolResult> {
	try { return await run(); }
	catch (error) {
		if (error instanceof z.ZodError) return { isError: true,
			content: [{ type: "text", text: "invalid-input" }], details: { errorCode: "invalid-input" } };
		if (error instanceof Error && error.message.startsWith("settings unavailable:")) {
			return { isError: true, content: [{ type: "text", text: error.message }], details: {} };
		}
		if (!(error instanceof SnoStationMemError) && !(error instanceof ContractError)) throw error;
		const reason = error instanceof ContractError ? error.reason : error.code;
		return { isError: true, content: [{ type: "text", text: error.message }], details: { errorCode: reason } };
	}
}
