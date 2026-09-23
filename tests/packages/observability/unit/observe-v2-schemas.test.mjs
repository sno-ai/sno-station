// Observe v2 (QCG-3): the seventeen squad/rsi/skill types validate against strict schemas that
// mirror the server's kinds, and `error` gains mandatory `component` and `context`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InvalidEventPayloadError } from "../../../../packages/observability/dist/internal/errors.js";
import { parseEventInput } from "../../../../packages/observability/dist/internal/schemas.js";
import { EVENT_LANES, EVENT_TYPES } from "../../../../packages/observability/dist/internal/types.js";

const hex64 = "3f".repeat(32);

/** One conforming payload per new type, with the lane of PRD section 5.1. */
const conforming = {
	"reach.register": ["squad", { harness: "claude-code", action: "register" }],
	"reach.message": [
		"squad",
		{ kind: "call", from_harness: "claude-code", to_harness: "codex", outcome: "ok", latency_ms: 812 },
	],
	"handoff.trigger": [
		"squad",
		{ from_harness: "claude-code", to_harness: "codex", remaining_pct: 1, threshold_pct: 2 },
	],
	"handoff.brief": ["squad", { byte_len: 4096, brief_hash: hex64, tasks_done: 3, tasks_total: 5 }],
	"handoff.release": ["squad", { attempt: 1, seconds_since_trigger: 42 }],
	"handoff.pause": ["squad", { reason: "early_write" }],
	"handoff.complete": [
		"squad",
		{ total_seconds: 600, sender_remaining_pct: 1, commits_before: 10, commits_after: 12 },
	],
	"handoff.quota": ["squad", { harness: "claude-code", remaining_pct: 1, reset_in_s: 3600 }],
	"review.run": [
		"squad",
		{
			author_harness: "claude-code",
			reviewer_harness: "codex",
			findings_p1: 0,
			findings_p2: 1,
			findings_p3: 2,
			empty: false,
			duration_ms: 90000,
		},
	],
	"review.fix": ["squad", { fixed: 1, dismissed: 0 }],
	"rsi.run": ["rsi", { sessions_read: 12, duration_ms: 4400, trigger: "timer", outcome: "ok" }],
	"rsi.proposal": ["rsi", { proposal_count: 2, skills_touched: 1 }],
	"rsi.verdict": ["rsi", { accepted: 1, rejected: 0, tbd: 0 }],
	"rsi.impact": [
		"rsi",
		{ skill_name: "peer-review", before_sessions: 10, before_failures: 2, after_sessions: 8, after_failures: 0 },
	],
	"rsi.lesson": ["rsi", { count: 1 }],
	"skill.run": [
		"skill",
		{
			harness: "claude-code",
			skill_name: "peer-review",
			skill_version: "local",
			category: "J",
			duration_ms: 1,
			outcome: "ok",
		},
	],
	"skill.install": ["skill", { skill_name: "peer-review", skill_version: "0123abc", action: "install" }],
};

function event(event_type, payload, lane = conforming[event_type][0]) {
	return { event_type, lane, agent_id: "claude-code", payload };
}

function rejectsPayload(input, token) {
	assert.throws(
		() => parseEventInput(input),
		(error) => error instanceof InvalidEventPayloadError && error.message.includes(token),
		`${input.event_type} must be refused naming ${token}`,
	);
}

describe("observe v2 event schemas", () => {
	it("accepts one conforming event for each of the seventeen new types on its lane", () => {
		assert.equal(Object.keys(conforming).length, 17);
		assert.equal(EVENT_LANES.includes("squad"), true);
		assert.equal(EVENT_LANES.includes("rsi"), true);
		for (const [type, [lane, payload]] of Object.entries(conforming)) {
			assert.equal(EVENT_TYPES.includes(type), true, `${type} in EVENT_TYPES`);
			const parsed = parseEventInput(event(type, payload));
			assert.equal(parsed.eventType, type);
			assert.equal(parsed.lane, lane);
			assert.deepEqual(parsed.payload, payload);
		}
	});

	it("rejects each new type carrying one extra payload key", () => {
		for (const [type, [, payload]] of Object.entries(conforming)) {
			rejectsPayload(event(type, { ...payload, unexpected_field: 1 }), "unexpected_field");
		}
	});

	it("rejects field values outside their kind", () => {
		const message = conforming["reach.message"][1];
		rejectsPayload(event("reach.message", { ...message, latency_ms: "812" }), "latency_ms");
		rejectsPayload(event("reach.message", { ...message, outcome: "error" }), "outcome");
		rejectsPayload(event("reach.message", { ...message, kind: "send" }), "kind");
		rejectsPayload(
			event("handoff.trigger", { ...conforming["handoff.trigger"][1], remaining_pct: 101 }),
			"remaining_pct",
		);
	});

	it("requires error component and context", () => {
		const base = { kind: "memory.write:throw", message_hash: hex64, recoverable: false };
		rejectsPayload({ event_type: "error", lane: "memory", agent_id: "claude-code", payload: base }, "component");
		const parsed = parseEventInput({
			event_type: "error",
			lane: "memory",
			agent_id: "claude-code",
			payload: { ...base, component: "mem-claude", context: "memory.write" },
		});
		assert.deepEqual(parsed.payload, { ...base, component: "mem-claude", context: "memory.write" });
	});

	it("accepts skill.run with the optional input_hash and output_hash", () => {
		const payload = { ...conforming["skill.run"][1], input_hash: hex64, output_hash: "0".repeat(64) };
		assert.deepEqual(parseEventInput(event("skill.run", payload)).payload, payload);
	});

	it("requires skill.run harness from the six-value harness list", () => {
		const { harness, ...withoutHarness } = conforming["skill.run"][1];
		assert.equal(harness, "claude-code");
		rejectsPayload(event("skill.run", withoutHarness), "harness");
		rejectsPayload(event("skill.run", { ...withoutHarness, harness: "sno-cli" }), "harness");
	});

	it("rejects a squad lane on memory.write", () => {
		const payload = { key_hash: hex64, byte_len: 12, content_tokens: 3, tokens_method: "tiktoken" };
		assert.throws(
			() => parseEventInput({ event_type: "memory.write", lane: "squad", agent_id: "codex", payload }),
			InvalidEventPayloadError,
		);
	});
});
