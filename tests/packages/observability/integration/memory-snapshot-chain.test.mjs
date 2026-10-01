import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BufferStore, decodeEnvelope } from "../../../../packages/observability/dist/internal/buffer-store.js";
import {
	canonicalPreimage,
	computeSelfHash,
} from "../../../../packages/observability/dist/internal/canonical-hash.js";
import { scope, validPayloads } from "../fixtures/temp-env.mjs";

const vector = JSON.parse(
	readFileSync(new URL("../fixtures/memory-snapshot-vector.json", import.meta.url), "utf8"),
);
const vectorBytes = readFileSync(
	new URL("../fixtures/memory-snapshot-vector.txt", import.meta.url),
	"utf8",
).trimEnd();

describe("memory.snapshot hash chain", () => {
	it("matches the reference canonical hash vector", () => {
		assert.equal(canonicalPreimage(vector.input), vectorBytes);
		assert.equal(computeSelfHash(vector.input), vector.expected_self_hash);
	});

	it("stores memory.snapshot envelopes with lane outside the hash preimage", () => {
		const dir = mkdtempSync(join(tmpdir(), "sno-observe-snapshot-chain-"));
		const store = new BufferStore(join(dir, "buffer.db"));
		try {
			store.append({
				eventId: "identify-1",
				eventType: "agent.identify",
				lane: "memory",
				tsEdgeMs: 1730000000000,
				consentLevel: "metadata-only",
				redacted: false,
				scope,
				payload: validPayloads["agent.identify"],
				terminal: false,
			});

			const appended = store.append({
				eventId: vector.input.eventId,
				eventType: "memory.snapshot",
				lane: "memory",
				tsEdgeMs: vector.input.tsEdgeMs,
				consentLevel: "metadata-only",
				redacted: false,
				scope: vector.input.scope,
				payload: vector.input.payload,
				terminal: false,
			});

			const envelope = decodeEnvelope(store.getByEventId(vector.input.eventId).payload);
			assert.equal(appended.seq, 1);
			assert.equal(envelope.event_type, "memory.snapshot");
			assert.equal(envelope.lane, "memory");
			assert.equal(envelope.hash_chain.self, appended.selfHash);
			assert.equal(store.verifyLocalChain(), true);

			const expectedSelf = computeSelfHash({
				...vector.input,
				prev: appended.envelope.hash_chain.prev,
			});
			assert.equal(appended.selfHash, expectedSelf);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
