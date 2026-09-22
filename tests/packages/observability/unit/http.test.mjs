import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { postEvent } from "../../../../packages/observability/dist/internal/http.js";

describe("postEvent", () => {
	it("uses a caller-supplied abort signal", async () => {
		const controller = new AbortController();
		let sentSignal;
		const fetchImpl = async (_url, init) => {
			sentSignal = init?.signal;
			return new Response("", { status: 202 });
		};

		await postEvent("https://sno.test", "{}", undefined, fetchImpl, controller.signal);

		assert.notEqual(sentSignal, undefined);
		assert.notEqual(sentSignal, controller.signal);
		assert.equal(sentSignal.aborted, false);
		controller.abort();
		assert.equal(sentSignal.aborted, true);
	});

	it("rejects plaintext non-localhost URLs before sending bearer credentials", async () => {
		let called = false;
		const fetchImpl = async () => {
			called = true;
			return new Response("", { status: 202 });
		};

		await assert.rejects(
			() => postEvent("http://example.com", "{}", "machine-secret", fetchImpl),
			/must use https:\/\//u,
		);

		assert.equal(called, false);
	});
});
