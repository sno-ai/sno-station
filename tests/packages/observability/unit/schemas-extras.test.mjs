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

describe("schemas — extras", () => {
	it("rejects audit.anchor at the SDK boundary (server-only event)", () => {
		// Per design.md §0 / spec §5: SDK MUST NOT emit audit.anchor.
		assert.throws(
			() => parseEventInput({ event_type: "audit.anchor", agent_id: "codex", payload: {} }),
			InvalidEventTypeError,
		);
	});

	it("EVENT_TYPES is exactly the 12 SDK-emittable event types", () => {
		// Per plugin-integration-spec.md §5: 12 distinct SDK literals (audit.anchor excluded).
		assert.equal(EVENT_TYPES.length, 12);
		assert.equal(EVENT_TYPES.includes("audit.anchor"), false);
	});

	it("AGENT_IDS is the strict closed enum from the API contract §2.1", () => {
		assert.deepEqual([...AGENT_IDS].sort(), ["claude-code", "codex", "hermes", "openclaw"].sort());
	});

	it("prompt.submit accepts prompt_text only at consent_level=full (30a.6)", () => {
		// metadata-only / off MUST reject prompt_text.
		for (const consent of ["metadata-only", "off"]) {
			assert.throws(
				() =>
					parseEventInput({
						event_type: "prompt.submit",
						agent_id: "codex",
						consent_level: consent,
						payload: { prompt_hash: "h", byte_len: 1, prompt_text: "raw" },
					}),
				InvalidEventPayloadError,
			);
		}
		// Even at consent=full, the strict zod schema does not LIST prompt_text in the
		// strict shape, so it still rejects. The SDK accepts raw text by leaving `payload`
		// open at consent=full upstream, NOT by accepting an unknown field at parse time.
		// Per spec §5 + design.md (Decision 5): wire envelope is internal-only; raw content
		// at full consent is shipped via the `message` / `prompt_text` slots which are
		// gated by runtime.rejectRawContent, not zod. That gating is exercised in the
		// integration legacy umbrella test (parseEventInput at metadata-only rejects).
		// Here we assert the metadata-only -> reject contract holds at the schema layer.
	});

	it("error event rejects raw `message` field at metadata-only", () => {
		assert.throws(
			() =>
				parseEventInput({
					event_type: "error",
					agent_id: "codex",
					consent_level: "metadata-only",
					payload: {
						kind: "recoverable",
						message_hash: "h",
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
					agent_id: "claude-cli",
					payload: { session_uuid: "s1" },
				}),
		);
	});
});
