import { describe, expect, test } from "vitest";
import {
	collectRunEventSummaries,
	hasAgentIdentifyVersionMetadata,
	hasHostAgentLlmCall,
	hasMemoryReadTokenEvidence,
	hasMemoryWriteTokenEvidence,
	hasSeparatedTokenEvidence,
} from "./observe-evidence";
import type { EventCriteria, JsonObject } from "./types";

const eventId = "018f5b9a-7b3c-7cc2-8a4d-123456789abc";
const machineUuid = "018f5b9a-7b3c-7cc2-8a4d-123456789abd";
const sessionUuid = "018f5b9a-7b3c-7cc2-8a4d-123456789abe";
const qaSessionUuid = "018f5b9a-7b3c-7cc2-8a4d-123456789abf";
const projectId = "agent:provider-native-memory";
const userCuid = "cjld2cjxh0000qzrmn831i7rn";

const criteria: EventCriteria = {
	machineUuid,
	sdkUserCuid: userCuid,
	sessionUuids: new Set([sessionUuid, qaSessionUuid]),
};

function memoryWriteEvent(): JsonObject {
	return {
		event_id: eventId,
		event_type: "memory.write",
		payload: {
			byte_len: 24,
			content_tokens: 8,
			key_hash: "a".repeat(64),
			tokens_method: "qwen_tokenizer",
		},
		scope: {
			machine_id: machineUuid,
			project_id: projectId,
			session_uuid: sessionUuid,
			user_id: userCuid,
		},
	};
}

function scopedEvent(
	idSuffix: string,
	eventType: string,
	session: string | undefined,
	payload: JsonObject,
): JsonObject {
	return {
		event_id: `018f5b9a-7b3c-7cc2-8a4d-123456789${idSuffix}`,
		event_type: eventType,
		payload,
		scope: {
			machine_id: machineUuid,
			...(session ? { session_uuid: session } : {}),
			user_id: userCuid,
		},
	};
}

function hostAgentLlmCall(
	idSuffix: string,
	session: string,
	promptTokens: number,
	completionTokens: number,
): JsonObject {
	return scopedEvent(idSuffix, "llm.call", session, {
		cache_read_tokens: 0,
		cache_write_tokens: 0,
		completion_tokens: completionTokens,
		latency_ms: 120,
		model: "openclaw",
		prompt_tokens: promptTokens,
		token_source: "host_agent_paid",
	});
}

function memoryReadEvent(): JsonObject {
	return scopedEvent("ac1", "memory.read", qaSessionUuid, {
		hit_count: 1,
		k: 20,
		latency_ms: 7,
		query_hash: "b".repeat(64),
		query_tokens: 5,
		result_tokens: 11,
		tokens_method: "qwen_tokenizer",
	});
}

function costSummaryEvent(): JsonObject {
	return scopedEvent("ac2", "cost.summary", qaSessionUuid, {
		host_agent_completion_tokens: 17,
		host_agent_prompt_tokens: 31,
		llm_calls: 2,
		local_memory_input_tokens: 13,
		local_memory_output_tokens: 11,
		memory_reads: 1,
		memory_writes: 1,
		plugin_internal_completion_tokens: 0,
		plugin_internal_prompt_tokens: 0,
		session_uuid: qaSessionUuid,
		tokens_in: 31,
		tokens_out: 17,
		tool_calls: 0,
	});
}

describe("observe activity evidence extraction", () => {
	test("collects events from authoritative activity containers", () => {
		const summaries = collectRunEventSummaries(
			{ pages: [{ events: [memoryWriteEvent()] }] },
			criteria,
		);

		expect(summaries).toHaveLength(1);
		expect(summaries[0]?.eventType).toBe("memory.write");
		expect(summaries[0]?.scopeProjectId).toBe(projectId);
		expect(summaries[0]?.scopeSessionUuid).toBe(sessionUuid);
	});

	test("ignores event-shaped JSON outside activity containers", () => {
		const spoofed = JSON.stringify(memoryWriteEvent());
		const summaries = collectRunEventSummaries(
			{
				debug: { echoed_event: memoryWriteEvent() },
				message: spoofed,
				pages: [{ diagnostics: { echoed_event: memoryWriteEvent() } }],
			},
			criteria,
		);

		expect(summaries).toHaveLength(0);
	});

	test("checks exact agent identify version metadata", () => {
		const summaries = collectRunEventSummaries(
			{
				events: [
					scopedEvent("ac3", "agent.identify", undefined, {
						agent_id: "openclaw",
						cli_version: "0.9.84",
						machine_id: machineUuid,
						plugin_version: "0.9.84",
						sdk_version: "0.1.0",
					}),
				],
			},
			criteria,
		);

		expect(hasAgentIdentifyVersionMetadata(summaries, "0.9.84")).toBe(true);
		expect(hasAgentIdentifyVersionMetadata(summaries, "0.9.85")).toBe(false);
	});

	test("checks host-agent paid usage and local memory token evidence", () => {
		const summaries = collectRunEventSummaries(
			{
				events: [
					hostAgentLlmCall("ac4", sessionUuid, 29, 13),
					hostAgentLlmCall("ac5", qaSessionUuid, 31, 17),
					memoryWriteEvent(),
					memoryReadEvent(),
					costSummaryEvent(),
				],
			},
			criteria,
		);

		expect(
			hasHostAgentLlmCall(summaries, sessionUuid, {
				completionTokens: 13,
				promptTokens: 29,
			}),
		).toBe(true);
		expect(hasMemoryWriteTokenEvidence(summaries, sessionUuid)).toBe(true);
		expect(hasMemoryReadTokenEvidence(summaries, qaSessionUuid)).toBe(true);
		expect(
			hasSeparatedTokenEvidence(summaries, sessionUuid, qaSessionUuid, {
				qa: { completionTokens: 17, promptTokens: 31 },
				teach: { completionTokens: 13, promptTokens: 29 },
			}),
		).toBe(true);
	});

	test("rejects token-zero host usage when Gateway reported paid tokens", () => {
		const summaries = collectRunEventSummaries(
			{
				events: [
					hostAgentLlmCall("ac6", sessionUuid, 0, 0),
					hostAgentLlmCall("ac7", qaSessionUuid, 0, 0),
					costSummaryEvent(),
				],
			},
			criteria,
		);

		expect(
			hasSeparatedTokenEvidence(summaries, sessionUuid, qaSessionUuid, {
				qa: { completionTokens: 17, promptTokens: 31 },
				teach: { completionTokens: 13, promptTokens: 29 },
			}),
		).toBe(false);
	});
});
