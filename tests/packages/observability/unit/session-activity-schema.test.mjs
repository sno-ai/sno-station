// session.activity: counts only, on the memory lane, exactly the eight agreed fields.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InvalidEventPayloadError } from "../../../../packages/observability/dist/internal/errors.js";
import { laneForEventType } from "../../../../packages/observability/dist/index.js";
import { parseEventInput } from "../../../../packages/observability/dist/internal/schemas.js";

const payload = {
	harness: "claude-code",
	window_start_ms: 1790826406783,
	window_end_ms: 1790901970745,
	active_ms: 37176343,
	team_driven_ms: 0,
	runs_over_12h: 0,
	longest_run_ms: 16644214,
	human_messages: 178,
};
const event = (changes) => ({ event_type: "session.activity", lane: "memory", agent_id: "claude-code", payload: { ...payload, ...changes } });

describe("session.activity schema", () => {
	it("accepts the eight fields on the memory lane", () => {
		assert.equal(laneForEventType("session.activity"), "memory");
		const parsed = parseEventInput(event({}));
		assert.equal(parsed.eventType, "session.activity");
		assert.deepEqual(parsed.payload, payload);
		assert.equal(parseEventInput(event({ harness: "codex" })).payload.harness, "codex");
	});

	it("refuses text, a session id, a missing field, a negative or fractional count, and an unknown harness", () => {
		for (const extra of [{ session_uuid: "018f7d0c-fd8b-7ccf-9b9b-0a2ea938ad0d" }, { text: "hello" }, { prompt: "x" }]) {
			assert.throws(() => parseEventInput(event(extra)), InvalidEventPayloadError);
		}
		const { human_messages, ...missing } = payload;
		assert.throws(() => parseEventInput({ ...event({}), payload: missing }), InvalidEventPayloadError);
		for (const bad of [{ active_ms: -1 }, { human_messages: 1.5 }, { harness: "vim" }, { longest_run_ms: "9" }]) {
			assert.throws(() => parseEventInput(event(bad)), InvalidEventPayloadError);
		}
	});
});
