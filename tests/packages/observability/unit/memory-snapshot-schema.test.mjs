import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InvalidEventPayloadError } from "../../../../packages/observability/dist/internal/errors.js";
import { parseEventInput } from "../../../../packages/observability/dist/internal/schemas.js";

const uuidV7 = "018f7d0c-fd8b-7ccf-9b9b-0a2ea938ad0d";
const uppercaseUuidV7 = uuidV7.toUpperCase();

function snapshot(payload) {
	return {
		event_type: "memory.snapshot",
		lane: "memory",
		agent_id: "codex",
		payload,
	};
}

const nonEmptyPayload = {
	session_uuid: uuidV7,
	snapshot_reason: "session_end",
	total_entries: 2,
	total_bytes: 256,
	oldest_entry_ts_ms: 1730000000000,
	newest_entry_ts_ms: 1730000001000,
};

describe("memory.snapshot schema", () => {
	it("accepts non-empty snapshots with UUID-v7 and timestamps", () => {
		const parsed = parseEventInput(snapshot(nonEmptyPayload));
		assert.deepEqual(parsed.payload, nonEmptyPayload);
	});

	it("accepts legacy total_tokens during rolling upgrades", () => {
		const payload = { ...nonEmptyPayload, total_tokens: 42 };
		const parsed = parseEventInput(snapshot(payload));
		assert.deepEqual(parsed.payload, payload);
	});

	it("accepts empty-store snapshots only when timestamps are omitted", () => {
		const payload = {
			session_uuid: uuidV7,
			snapshot_reason: "startup",
			total_entries: 0,
			total_bytes: 0,
		};
		const parsed = parseEventInput(snapshot(payload));
		assert.deepEqual(parsed.payload, payload);
	});

	it("accepts periodic at the SDK boundary", () => {
		const parsed = parseEventInput(
			snapshot({
				...nonEmptyPayload,
				snapshot_reason: "periodic",
			}),
		);
		assert.equal(parsed.payload["snapshot_reason"], "periodic");
	});

	it("rejects non-lowercase-canonical UUID-v7 session IDs", () => {
		assert.throws(
			() => parseEventInput(snapshot({ ...nonEmptyPayload, session_uuid: "session-1" })),
			InvalidEventPayloadError,
		);
		assert.throws(
			() => parseEventInput(snapshot({ ...nonEmptyPayload, session_uuid: uppercaseUuidV7 })),
			InvalidEventPayloadError,
		);
	});

	it("rejects timestamps on empty stores", () => {
		assert.throws(
			() =>
				parseEventInput(
					snapshot({
						session_uuid: uuidV7,
						snapshot_reason: "startup",
						total_entries: 0,
						total_bytes: 0,
						oldest_entry_ts_ms: 1730000000000,
						newest_entry_ts_ms: 1730000001000,
					}),
				),
			InvalidEventPayloadError,
		);
	});

	it("rejects missing non-empty timestamps", () => {
		const { oldest_entry_ts_ms: _oldest, ...missingOldest } = nonEmptyPayload;
		const { newest_entry_ts_ms: _newest, ...missingNewest } = nonEmptyPayload;
		assert.throws(() => parseEventInput(snapshot(missingOldest)), InvalidEventPayloadError);
		assert.throws(() => parseEventInput(snapshot(missingNewest)), InvalidEventPayloadError);
	});

	it("rejects explicit null timestamps and negative counters", () => {
		assert.throws(
			() => parseEventInput(snapshot({ ...nonEmptyPayload, oldest_entry_ts_ms: null })),
			InvalidEventPayloadError,
		);
		for (const field of ["total_entries", "total_bytes"]) {
			assert.throws(
				() => parseEventInput(snapshot({ ...nonEmptyPayload, [field]: -1 })),
				InvalidEventPayloadError,
			);
		}
	});
});
