import { describe, expect, it } from "vitest";
import {
	classifyReflectionRetry,
	computeReflectionRetryDelayMs,
	isReflectionNonRetryError,
	isTransientReflectionUpstreamError,
	type RetryClassifierInput,
	type RetryClassifierResult,
	type RetryRunnerParams,
	runWithReflectionTransientRetryOnce,
} from "../../../../apps/mem-claw/src/reflection/transient-generation-retry.ts";

describe("reflection transient retry golden parity", () => {
	it("classifies retry precedence cases with stable reasons", () => {
		const cases: Array<{
			input: RetryClassifierInput;
			expected: RetryClassifierResult;
		}> = [
			{
				input: {
					inReflectionScope: false,
					retryCount: 0,
					usefulOutputChars: 0,
					error: "unexpected EOF",
				},
				expected: {
					retryable: false,
					reason: "not_reflection_scope",
					normalizedError: "unexpected EOF",
				},
			},
			{
				input: {
					inReflectionScope: true,
					retryCount: 1,
					usefulOutputChars: 0,
					error: "unexpected EOF",
				},
				expected: {
					retryable: false,
					reason: "retry_already_used",
					normalizedError: "unexpected EOF",
				},
			},
			{
				input: {
					inReflectionScope: true,
					retryCount: 0,
					usefulOutputChars: 12,
					error: "unexpected EOF",
				},
				expected: {
					retryable: false,
					reason: "useful_output_present",
					normalizedError: "unexpected EOF",
				},
			},
			{
				input: {
					inReflectionScope: true,
					retryCount: 0,
					usefulOutputChars: 0,
					error: "invalid api key",
				},
				expected: {
					retryable: false,
					reason: "non_retry_error",
					normalizedError: "invalid api key",
				},
			},
			{
				input: {
					inReflectionScope: true,
					retryCount: 0,
					usefulOutputChars: 0,
					error: "upstream returned status 503",
				},
				expected: {
					retryable: true,
					reason: "transient_upstream_failure",
					normalizedError: "upstream returned status 503",
				},
			},
			{
				input: {
					inReflectionScope: true,
					retryCount: 0,
					usefulOutputChars: 0,
					error: "schema validation failed",
				},
				expected: {
					retryable: false,
					reason: "non_transient_error",
					normalizedError: "schema validation failed",
				},
			},
		];

		for (const { input, expected } of cases) {
			expect(classifyReflectionRetry(input)).toEqual(expected);
		}
	});

	it("detects representative transient and non-retry errors", () => {
		expect(isTransientReflectionUpstreamError("socket hang up")).toBe(true);
		expect(
			isTransientReflectionUpstreamError("upstream returned HTTP 502"),
		).toBe(true);
		expect(
			isTransientReflectionUpstreamError("fetch failed: network error"),
		).toBe(true);
		expect(isTransientReflectionUpstreamError("validation failed")).toBe(false);

		expect(isReflectionNonRetryError("invalid api key")).toBe(true);
		expect(isReflectionNonRetryError("insufficient credits")).toBe(true);
		expect(isReflectionNonRetryError("context length exceeded")).toBe(true);
		expect(isReflectionNonRetryError("content policy refusal")).toBe(true);
		expect(isReflectionNonRetryError("socket hang up")).toBe(false);
	});

	it("normalizes multiline and long error messages into one clipped line", () => {
		const result = classifyReflectionRetry({
			inReflectionScope: true,
			retryCount: 0,
			usefulOutputChars: 0,
			error: new Error(`first line\n${"x".repeat(320)}`),
		});

		expect(result.retryable).toBe(false);
		expect(result.reason).toBe("non_transient_error");
		expect(result.normalizedError).not.toContain("\n");
		expect(result.normalizedError).toHaveLength(260);
		expect(result.normalizedError.startsWith("Error: first line ")).toBe(true);
		expect(result.normalizedError.endsWith("...")).toBe(true);
	});

	it("computes deterministic retry delay jitter and clamps invalid random values", () => {
		expect(computeReflectionRetryDelayMs(() => 0)).toBe(1000);
		expect(computeReflectionRetryDelayMs(() => 0.5)).toBe(2000);
		expect(computeReflectionRetryDelayMs(() => 1)).toBe(3000);
		expect(computeReflectionRetryDelayMs(() => -1)).toBe(1000);
		expect(computeReflectionRetryDelayMs(() => Number.NaN)).toBe(1000);
		expect(computeReflectionRetryDelayMs(() => 2)).toBe(3000);
	});

	it.each([
		"reflection",
		"distiller",
	] as const)("retries transient %s failures once and preserves observable runner state", async (scope) => {
		let attempts = 0;
		const sleeps: number[] = [];
		const logLevels: Array<"info" | "warn"> = [];
		const retryState = { count: 0 };

		const result = await runWithReflectionTransientRetryOnce({
			scope,
			runner: "embedded",
			retryState,
			random: () => 0,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			onLog: (level) => {
				logLevels.push(level);
			},
			execute: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("unexpected EOF");
				return "ok";
			},
		});

		expect(result).toBe("ok");
		expect(attempts).toBe(2);
		expect(sleeps).toEqual([1000]);
		expect(retryState.count).toBe(1);
		expect(logLevels).toEqual(["warn", "info"]);
	});

	it("throws the second transient error after one retry without incrementing twice", async () => {
		let attempts = 0;
		const sleeps: number[] = [];
		const logLevels: Array<"info" | "warn"> = [];
		const retryState = { count: 0 };
		const secondError = new Error("status 504 on retry");

		const run = runWithReflectionTransientRetryOnce({
			scope: "reflection",
			runner: "cli",
			retryState,
			random: () => 0.5,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			onLog: (level) => {
				logLevels.push(level);
			},
			execute: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("status 503");
				throw secondError;
			},
		});

		await expect(run).rejects.toBe(secondError);
		expect(attempts).toBe(2);
		expect(sleeps).toEqual([2000]);
		expect(retryState.count).toBe(1);
		expect(logLevels).toEqual(["warn", "warn"]);
	});

	it("throws non-retry errors immediately without sleep or retry-state mutation", async () => {
		let attempts = 0;
		const sleeps: number[] = [];
		const retryState = { count: 0 };
		const authError = new Error("invalid api key");
		const params: RetryRunnerParams<string> = {
			scope: "reflection",
			runner: "embedded",
			retryState,
			random: () => 1,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			execute: async () => {
				attempts += 1;
				throw authError;
			},
		};

		await expect(runWithReflectionTransientRetryOnce(params)).rejects.toBe(
			authError,
		);
		expect(attempts).toBe(1);
		expect(sleeps).toEqual([]);
		expect(retryState.count).toBe(0);
	});

	it("does not retry transient failures after useful output has been produced", async () => {
		let attempts = 0;
		let usefulChars = 0;
		const sleeps: number[] = [];
		const retryState = { count: 0 };
		const transientError = new Error("unexpected EOF");

		await expect(
			runWithReflectionTransientRetryOnce({
				scope: "reflection",
				runner: "embedded",
				retryState,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
				usefulOutputChars: () => usefulChars,
				execute: async () => {
					attempts += 1;
					usefulChars = 17;
					throw transientError;
				},
			}),
		).rejects.toBe(transientError);

		expect(attempts).toBe(1);
		expect(sleeps).toEqual([]);
		expect(retryState.count).toBe(0);
	});
});
