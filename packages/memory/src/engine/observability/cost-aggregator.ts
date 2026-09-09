/** @file cost-aggregator.ts
 * @purpose Maintains wrapper-fed per-session counters for cost.summary events.
 * @boundary Cloud observability accounting; not used by local memory behavior.
 */

import type { EventType, JsonObject } from "@snoai/sno-observe";

export type CostSummaryPayload = JsonObject & {
	session_uuid: string;
	tokens_in: number;
	tokens_out: number;
	llm_calls: number;
	memory_writes: number;
	memory_reads: number;
	tool_calls: number;
	host_agent_prompt_tokens: number;
	host_agent_completion_tokens: number;
	plugin_internal_prompt_tokens: number;
	plugin_internal_completion_tokens: number;
	local_memory_input_tokens: number;
	local_memory_output_tokens: number;
};

type Counters = {
	hostAgentPromptTokens: number;
	hostAgentCompletionTokens: number;
	pluginInternalPromptTokens: number;
	pluginInternalCompletionTokens: number;
	localMemoryInputTokens: number;
	localMemoryOutputTokens: number;
	llmCalls: number;
	memoryWrites: number;
	memoryReads: number;
	toolCalls: number;
};

function emptyCounters(): Counters {
	return {
		hostAgentPromptTokens: 0,
		hostAgentCompletionTokens: 0,
		pluginInternalPromptTokens: 0,
		pluginInternalCompletionTokens: 0,
		localMemoryInputTokens: 0,
		localMemoryOutputTokens: 0,
		llmCalls: 0,
		memoryWrites: 0,
		memoryReads: 0,
		toolCalls: 0,
	};
}

function numberFromPayload(payload: JsonObject, key: string): number {
	const value = payload[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export class CostAggregator {
	private readonly sessions = new Map<string, Counters>();

	start(sessionUuid: string): void {
		if (!this.sessions.has(sessionUuid)) {
			this.sessions.set(sessionUuid, emptyCounters());
		}
	}

	record(eventType: EventType, sessionUuid: string | undefined, payload: JsonObject): void {
		if (!sessionUuid) return;
		const counters = this.sessions.get(sessionUuid) ?? emptyCounters();
		let changed = true;
		if (eventType === "memory.write") {
			counters.memoryWrites += 1;
			counters.localMemoryInputTokens += numberFromPayload(payload, "content_tokens");
		} else if (eventType === "memory.read") {
			counters.memoryReads += 1;
			counters.localMemoryInputTokens += numberFromPayload(payload, "query_tokens");
			counters.localMemoryOutputTokens += numberFromPayload(payload, "result_tokens");
		} else if (eventType === "llm.call") {
			counters.llmCalls += 1;
			if (payload.token_source === "plugin_internal_paid") {
				counters.pluginInternalPromptTokens += numberFromPayload(payload, "prompt_tokens");
				counters.pluginInternalCompletionTokens += numberFromPayload(payload, "completion_tokens");
			} else {
				counters.hostAgentPromptTokens += numberFromPayload(payload, "prompt_tokens");
				counters.hostAgentCompletionTokens += numberFromPayload(payload, "completion_tokens");
			}
		} else if (eventType === "tool.call") {
			counters.toolCalls += 1;
		} else {
			changed = false;
		}
		if (changed) {
			this.sessions.set(sessionUuid, counters);
		}
	}

	summary(sessionUuid: string): CostSummaryPayload {
		const counters = this.sessions.get(sessionUuid) ?? emptyCounters();
		const tokensIn = counters.hostAgentPromptTokens + counters.pluginInternalPromptTokens;
		const tokensOut = counters.hostAgentCompletionTokens + counters.pluginInternalCompletionTokens;
		return {
			session_uuid: sessionUuid,
			tokens_in: tokensIn,
			tokens_out: tokensOut,
			llm_calls: counters.llmCalls,
			memory_writes: counters.memoryWrites,
			memory_reads: counters.memoryReads,
			tool_calls: counters.toolCalls,
			host_agent_prompt_tokens: counters.hostAgentPromptTokens,
			host_agent_completion_tokens: counters.hostAgentCompletionTokens,
			plugin_internal_prompt_tokens: counters.pluginInternalPromptTokens,
			plugin_internal_completion_tokens: counters.pluginInternalCompletionTokens,
			local_memory_input_tokens: counters.localMemoryInputTokens,
			local_memory_output_tokens: counters.localMemoryOutputTokens,
		};
	}

	delete(sessionUuid: string): void {
		this.sessions.delete(sessionUuid);
	}

	summaryAndDelete(sessionUuid: string): CostSummaryPayload {
		const summary = this.summary(sessionUuid);
		this.delete(sessionUuid);
		return summary;
	}

	clear(): void {
		this.sessions.clear();
	}
}
