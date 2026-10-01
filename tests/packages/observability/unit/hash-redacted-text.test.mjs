import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSnoObserve, snoObserve } from "../../../../packages/observability/dist/index.js";
import { sha256Hex } from "../../../../packages/observability/dist/internal/hash.js";

describe("hashRedactedText", () => {
	it("is publicly exported on default and instance APIs", () => {
		assert.equal(typeof snoObserve.hashRedactedText, "function");
		assert.equal(typeof createSnoObserve().hashRedactedText, "function");
	});

	it("returns deterministic lowercase SHA-256 hex", () => {
		const api = createSnoObserve();
		const hash = api.hashRedactedText("plain text");
		assert.equal(hash, api.hashRedactedText("plain text"));
		assert.match(hash, /^[0-9a-f]{64}$/u);
	});

	it("redacts email and secret before hashing", () => {
		const api = createSnoObserve();
		const input = `contact owner@example.test with key sk_live_${"abcdefghijklmnop"}`;
		const redacted = "contact <email> with key <api-key>";
		assert.equal(api.hashRedactedText(input), sha256Hex(Buffer.from(redacted, "utf8")));
		assert.notEqual(api.hashRedactedText(input), sha256Hex(Buffer.from(input, "utf8")));
	});

	it("matches the default singleton", () => {
		const api = createSnoObserve();
		assert.equal(api.hashRedactedText("a@b.com"), snoObserve.hashRedactedText("a@b.com"));
	});
});
