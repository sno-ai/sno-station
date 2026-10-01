/**
 * Reflection retry module — integration tests.
 * Pure function tests with dependency injection. No DB, no embeddings, no mocking.
 */

import { describe, expect, it } from "vitest";
import {
	classifyReflectionRetry,
	computeReflectionRetryDelayMs,
	isReflectionNonRetryError,
	isTransientReflectionUpstreamError,
	runWithReflectionTransientRetryOnce,
} from "../../../../packages/memory/src/engine/reflection/transient-generation-retry.ts";

// ---------------------------------------------------------------------------
// 1-2: isTransientReflectionUpstreamError
// ---------------------------------------------------------------------------
describe("isTransientReflectionUpstreamError", () => {
	it("recognizes EOF, ECONNRESET, 502/503/504, timeout, socket hang up as transient", () => {
		const transientMessages = [
			"unexpected EOF while reading upstream response",
			"read ECONNRESET from provider",
			"HTTP 502 Bad Gateway",
			"status 503 Service Unavailable",
			"upstream returned status 504",
			"request timed out after 30s",
			"socket hang up during inference",
			"ECONNABORTED: connection aborted by host",
			"ETIMEDOUT: connect timed out",
			"connection reset by peer",
			"gateway timeout from inference server",
			"fetch failed: network error",
		];

		for (const msg of transientMessages) {
			expect(isTransientReflectionUpstreamError(new Error(msg))).toBe(true);
		}

		// Also handles plain strings
		expect(isTransientReflectionUpstreamError("unexpected eof")).toBe(true);
	});

	it("rejects non-transient errors", () => {
		const nonTransient = [
			"something went wrong",
			"internal server error",
			"unknown failure in module X",
			"assertion failed: expected 5 got 3",
			"null pointer dereference",
		];

		for (const msg of nonTransient) {
			expect(isTransientReflectionUpstreamError(new Error(msg))).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// 3-4: isReflectionNonRetryError
// ---------------------------------------------------------------------------
describe("isReflectionNonRetryError", () => {
	it("recognizes auth, billing, model not found, context length, session expired, refusal/content policy", () => {
		const nonRetryMessages = [
			"401 unauthorized: invalid api key",
			"insufficient credits for this request",
			"billing account suspended",
			"model gpt-x not found",
			"no such model: o3-mini-turbo",
			"context length exceeded (128k tokens)",
			"too many tokens in request",
			"session expired, please re-authenticate",
			"refusal due to safety policy",
			"content policy violation detected",
			"content filter triggered",
			"disallowed: harmful content",
			"quota exceeded for today",
			"payment required",
			"request too large for this endpoint",
		];

		for (const msg of nonRetryMessages) {
			expect(isReflectionNonRetryError(new Error(msg))).toBe(true);
		}
	});

	it("rejects transient errors (not a non-retry error)", () => {
		const transient = [
			"unexpected EOF while reading upstream response",
			"socket hang up",
			"ECONNRESET from provider",
			"gateway timeout",
			"service unavailable 503",
		];

		for (const msg of transient) {
			expect(isReflectionNonRetryError(new Error(msg))).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// 5-9: classifyReflectionRetry
// ---------------------------------------------------------------------------
describe("classifyReflectionRetry", () => {
	it("transient error in reflection scope with retryCount=0 is retryable", () => {
		const result = classifyReflectionRetry({
			inReflectionScope: true,
			retryCount: 0,
			usefulOutputChars: 0,
			error: new Error("upstream temporarily unavailable (503)"),
		});

		expect(result.retryable).toBe(true);
		expect(result.reason).toBe("transient_upstream_failure");
		expect(result.normalizedError).toContain("upstream temporarily unavailable");
	});

	it("not in reflection scope returns not_reflection_scope", () => {
		const result = classifyReflectionRetry({
			inReflectionScope: false,
			retryCount: 0,
			usefulOutputChars: 0,
			error: new Error("unexpected EOF"),
		});

		expect(result.retryable).toBe(false);
		expect(result.reason).toBe("not_reflection_scope");
	});

	it("useful output present returns useful_output_present", () => {
		const result = classifyReflectionRetry({
			inReflectionScope: true,
			retryCount: 0,
			usefulOutputChars: 42,
			error: new Error("unexpected EOF"),
		});

		expect(result.retryable).toBe(false);
		expect(result.reason).toBe("useful_output_present");
	});

	it("retry already used returns retry_already_used", () => {
		const result = classifyReflectionRetry({
			inReflectionScope: true,
			retryCount: 1,
			usefulOutputChars: 0,
			error: new Error("unexpected EOF"),
		});

		expect(result.retryable).toBe(false);
		expect(result.reason).toBe("retry_already_used");
	});

	it("non-retry error returns non_retry_error", () => {
		const result = classifyReflectionRetry({
			inReflectionScope: true,
			retryCount: 0,
			usefulOutputChars: 0,
			error: new Error("invalid api key"),
		});

		expect(result.retryable).toBe(false);
		expect(result.reason).toBe("non_retry_error");
	});
});

// ---------------------------------------------------------------------------
// 10: computeReflectionRetryDelayMs
// ---------------------------------------------------------------------------
describe("computeReflectionRetryDelayMs", () => {
	it("jitter range: random=0 gives 1000ms, random=0.5 gives 2000ms, random=1 gives 3000ms", () => {
		expect(computeReflectionRetryDelayMs(() => 0)).toBe(1000);
		expect(computeReflectionRetryDelayMs(() => 0.5)).toBe(2000);
		expect(computeReflectionRetryDelayMs(() => 1)).toBe(3000);
	});
});

// ---------------------------------------------------------------------------
// 11-12: runWithReflectionTransientRetryOnce
// ---------------------------------------------------------------------------
describe("runWithReflectionTransientRetryOnce", () => {
	it("retries once on transient error and succeeds (inject sleep and random)", async () => {
		let attempts = 0;
		const sleeps: number[] = [];
		const logs: Array<{ level: string; message: string }> = [];
		const retryState = { count: 0 };

		const result = await runWithReflectionTransientRetryOnce({
			scope: "reflection",
			runner: "embedded",
			retryState,
			execute: async () => {
				attempts += 1;
				if (attempts === 1) {
					throw new Error("unexpected EOF from provider");
				}
				return "ok";
			},
			random: () => 0,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			onLog: (level, message) => logs.push({ level, message }),
		});

		expect(result).toBe("ok");
		expect(attempts).toBe(2);
		expect(retryState.count).toBe(1);
		expect(sleeps).toEqual([1000]);
		expect(logs.length).toBe(2);
		expect(logs[0]!.level).toBe("warn");
		expect(logs[0]!.message).toMatch(/transient upstream failure detected/i);
		expect(logs[0]!.message).toMatch(/retrying once in 1000ms/i);
		expect(logs[1]!.level).toBe("info");
		expect(logs[1]!.message).toMatch(/retry succeeded/i);
	});

	it("does NOT retry non-transient errors (invalid api key throws immediately, attempts=1)", async () => {
		let attempts = 0;
		const retryState = { count: 0 };

		await expect(
			runWithReflectionTransientRetryOnce({
				scope: "reflection",
				runner: "cli",
				retryState,
				execute: async () => {
					attempts += 1;
					throw new Error("invalid api key");
				},
				sleep: async () => {},
			}),
		).rejects.toThrow(/invalid api key/i);

		expect(attempts).toBe(1);
		expect(retryState.count).toBe(0);
	});
});
