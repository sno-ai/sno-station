// Unit tests for schemas / public surface gaps not covered by legacy umbrella.
// Covers tasks: 30a.6 prompt.submit consent gating, 30.3 type-resolution, public-API shape.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	InvalidEventPayloadError,
	InvalidEventTypeError,
} from "../../../../packages/sno-observe/dist/internal/errors.js";
import { parseEventInput } from "../../../../packages/sno-observe/dist/internal/schemas.js";
import {
	AGENT_IDS,
	EVENT_TYPES,
} from "../../../../packages/sno-observe/dist/internal/types.js";

const hashA = "a".repeat(64);

describe("schemas — extras", () => {
	it("rejects audit.anchor at the SDK boundary (server-only event)", () => {
		// Per design.md §0 / spec §5: SDK MUST NOT emit audit.anchor.
		assert.throws(
			() =>
				parseEventInput({
					event_type: "audit.anchor",
					lane: "memory",
					agent_id: "codex",
					payload: {},
				}),
			InvalidEventTypeError,
		);
	});

	it("EVENT_TYPES is exactly the 14 SDK-emittable event types", () => {
		// Per plugin-integration-spec.md §5 plus memory telemetry extension: audit.anchor excluded.
		assert.equal(EVENT_TYPES.length, 14);
		assert.equal(EVENT_TYPES.includes("memory.telemetry"), true);
		assert.equal(EVENT_TYPES.includes("audit.anchor"), false);
	});

	it("AGENT_IDS is the strict closed enum from the API contract §2.1", () => {
		assert.deepEqual([...AGENT_IDS].sort(), ["claude-code", "codex", "hermes", "openclaw"].sort());
	});

	it("prompt.submit rejects raw prompt_text at every consent level", () => {
		for (const consent of ["metadata-only", "off", "full"]) {
			assert.throws(
				() =>
					parseEventInput({
						event_type: "prompt.submit",
						lane: "memory",
						agent_id: "codex",
						consent_level: consent,
						payload: { prompt_hash: hashA, byte_len: 1, prompt_text: "raw" },
					}),
				InvalidEventPayloadError,
			);
		}
	});

	it("error event rejects raw `message` field at metadata-only", () => {
		assert.throws(
			() =>
				parseEventInput({
					event_type: "error",
					lane: "memory",
					agent_id: "codex",
					consent_level: "metadata-only",
					payload: {
						kind: "recoverable",
						message_hash: hashA,
						recoverable: true,
						message: "raw",
					},
				}),
			InvalidEventPayloadError,
		);
	});

	it("rejects unknown agent_id strings (closed enum per §2.1)", () => {
		// claude-cli is a plausible-looking but not-in-enum value.
		assert.throws(
			() =>
				parseEventInput({
					event_type: "session.start",
					lane: "memory",
					agent_id: "claude-cli",
					payload: { session_uuid: "018f7d0c-fd8b-7ccf-9b9b-0a2ea938ad0d" },
				}),
		);
	});
});
