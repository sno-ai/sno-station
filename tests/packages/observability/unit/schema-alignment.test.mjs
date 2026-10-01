import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InvalidEventPayloadError } from "../../../../packages/observability/dist/internal/errors.js";
import { parseEventInput } from "../../../../packages/observability/dist/internal/schemas.js";
import { EVENT_LANES, EVENT_TYPES } from "../../../../packages/observability/dist/internal/types.js";

const uuidV7 = "018f7d0c-fd8b-7ccf-9b9b-0a2ea938ad0d";
const uppercaseUuidV7 = uuidV7.toUpperCase();
const hashA = "a".repeat(64);

function memoryWrite(tokens_method) {
	return {
		event_type: "memory.write",
		lane: "memory",
		agent_id: "codex",
		payload: {
			key_hash: hashA,
			byte_len: 12,
			content_tokens: 3,
			tokens_method,
		},
	};
}

describe("schema alignment", () => {
	it("requires a valid envelope lane and accepts all M1 lanes", () => {
		for (const lane of ["memory", "llm", "skill", "security"]) {
			const parsed = parseEventInput({ ...memoryWrite("qwen_tokenizer"), lane });
			assert.equal(parsed.lane, lane);
		}
		for (const lane of ["squad", "rsi"]) {
			assert.equal(EVENT_LANES.includes(lane), true);
			assert.throws(
				() => parseEventInput({ ...memoryWrite("qwen_tokenizer"), lane }),
				InvalidEventPayloadError,
			);
		}
		assert.equal(
			parseEventInput({
				event_type: "handoff.release",
				lane: "squad",
				agent_id: "codex",
				payload: { attempt: 1, seconds_since_trigger: 42 },
			}).lane,
			"squad",
		);
		assert.equal(
			parseEventInput({ event_type: "rsi.lesson", lane: "rsi", agent_id: "codex", payload: { count: 1 } })
				.lane,
			"rsi",
		);

		assert.throws(
			() => parseEventInput({ event_type: "memory.write", agent_id: "codex", payload: {} }),
			InvalidEventPayloadError,
		);
		assert.throws(
			() => parseEventInput({ ...memoryWrite("qwen_tokenizer"), lane: "audit" }),
			InvalidEventPayloadError,
		);
	});

	it("locks the SDK-emittable event catalog", () => {
		assert.equal(EVENT_TYPES.includes("memory.snapshot"), true);
		assert.equal(EVENT_TYPES.includes("memory.telemetry"), true);
		assert.equal(EVENT_TYPES.includes("audit.anchor"), false);
		assert.deepEqual([...EVENT_TYPES], [
			"agent.identify",
			"memory.write",
			"memory.read",
			"memory.snapshot",
			"memory.telemetry",
			"llm.call",
			"tool.call",
			"session.start",
			"session.end",
			"prompt.submit",
			"permission.request",
			"consent.change",
			"error",
			"cost.summary",
			"reach.register",
			"reach.message",
			"handoff.trigger",
			"handoff.brief",
			"handoff.release",
			"handoff.pause",
			"handoff.complete",
			"handoff.quota",
			"review.run",
			"review.fix",
			"rsi.run",
			"rsi.proposal",
			"rsi.verdict",
			"rsi.impact",
			"rsi.lesson",
			"skill.run",
			"skill.install",
		]);
	});

	it("accepts only the four locked token methods", () => {
		for (const method of [
			"qwen_tokenizer",
			"tiktoken",
			"provider_reported",
			"char_approximation",
		]) {
			const parsed = parseEventInput(memoryWrite(method));
			assert.equal(parsed.payload["tokens_method"], method);
		}

		for (const method of ["bpe", "fast", "unknown"]) {
			assert.throws(() => parseEventInput(memoryWrite(method)), InvalidEventPayloadError);
		}
	});

	it("requires cost.summary lowercase canonical UUID-v7 and current counter fields", () => {
		const payload = {
			session_uuid: uuidV7,
			tokens_in: 10,
			tokens_out: 3,
			llm_calls: 1,
			memory_writes: 2,
			memory_reads: 1,
			tool_calls: 4,
			host_agent_prompt_tokens: 7,
			host_agent_completion_tokens: 2,
			plugin_internal_prompt_tokens: 3,
			plugin_internal_completion_tokens: 1,
			local_memory_input_tokens: 11,
			local_memory_output_tokens: 5,
		};
		const parsed = parseEventInput({
			event_type: "cost.summary",
			lane: "memory",
			agent_id: "codex",
			payload,
		});
		assert.deepEqual(parsed.payload, payload);

		parseEventInput({
			event_type: "cost.summary",
			lane: "memory",
			agent_id: "codex",
			payload: { ...payload, event_count: 9 },
		});

		assert.throws(
			() =>
				parseEventInput({
					event_type: "cost.summary",
					lane: "memory",
					agent_id: "codex",
					payload: { ...payload, session_uuid: "session-1" },
				}),
			InvalidEventPayloadError,
		);
		assert.throws(
			() =>
				parseEventInput({
					event_type: "cost.summary",
					lane: "memory",
					agent_id: "codex",
					payload: { ...payload, session_uuid: uppercaseUuidV7 },
				}),
			InvalidEventPayloadError,
		);
		assert.throws(
			() =>
				parseEventInput({
					event_type: "cost.summary",
					lane: "memory",
					agent_id: "codex",
					payload: {
						...payload,
						plugin_internal_prompt_tokens: undefined,
					},
				}),
			InvalidEventPayloadError,
		);
	});

	it("requires llm.call token_source for paid token attribution", () => {
		const payload = {
			model: "gpt-4o",
			prompt_tokens: 10,
			completion_tokens: 3,
			latency_ms: 120,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
			token_source: "host_agent_paid",
		};
		const parsed = parseEventInput({
			event_type: "llm.call",
			lane: "memory",
			agent_id: "openclaw",
			payload,
		});
		assert.equal(parsed.payload.token_source, "host_agent_paid");
		parseEventInput({
			event_type: "llm.call",
			lane: "memory",
			agent_id: "openclaw",
			payload: { ...payload, token_source: "plugin_internal_paid" },
		});
		assert.throws(
			() =>
				parseEventInput({
					event_type: "llm.call",
					lane: "memory",
					agent_id: "openclaw",
					payload: { ...payload, token_source: undefined },
				}),
			InvalidEventPayloadError,
		);
		assert.throws(
			() =>
				parseEventInput({
					event_type: "llm.call",
					lane: "memory",
					agent_id: "openclaw",
					payload: { ...payload, token_source: "cache" },
				}),
			InvalidEventPayloadError,
		);
	});

	it("requires lowercase canonical UUID-v7 payload session IDs", () => {
		for (const event_type of ["session.start", "session.end"]) {
			parseEventInput({
				event_type,
				lane: "memory",
				agent_id: "codex",
				payload: { session_uuid: uuidV7 },
			});

			assert.throws(
				() =>
					parseEventInput({
						event_type,
						lane: "memory",
						agent_id: "codex",
						payload: { session_uuid: "session-1" },
				}),
				InvalidEventPayloadError,
			);
			assert.throws(
				() =>
					parseEventInput({
						event_type,
						lane: "memory",
						agent_id: "codex",
						payload: { session_uuid: uppercaseUuidV7 },
					}),
				InvalidEventPayloadError,
			);
		}
	});

	it("requires lowercase canonical UUID-v7 envelope and identity IDs", () => {
		assert.throws(
			() => parseEventInput({ ...memoryWrite("qwen_tokenizer"), event_id: uppercaseUuidV7 }),
			InvalidEventPayloadError,
		);
		assert.throws(
			() => parseEventInput({ ...memoryWrite("qwen_tokenizer"), scope: { session_uuid: uppercaseUuidV7 } }),
			InvalidEventPayloadError,
		);
		assert.throws(
			() =>
				parseEventInput({
					event_type: "agent.identify",
					lane: "memory",
					agent_id: "codex",
					payload: {
						agent_id: "codex",
						machine_id: uppercaseUuidV7,
						sdk_version: "0.1.0",
					},
				}),
			InvalidEventPayloadError,
		);
	});
});
