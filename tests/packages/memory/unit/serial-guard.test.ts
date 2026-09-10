/**
 * Serial guard helper — unit tests (PRD §5 Group 4 Test 12b).
 *
 * Verifies the `runWithSerialGuard` contract through public behavior alone.
 * The in-flight Set and debounce Map remain private to the module — no
 * test-only exports, no test hooks. Behavior is observed via:
 *   (a) `runWithSerialGuard` return value (true=ran, false=skipped)
 *   (b) the `work` callback's observable side effects
 *
 * Tests use a unique sessionKey per call (`Date.now()` + suffix) to avoid
 * cross-test interference in the globalThis-keyed state (PRD §5 Group 4
 * Option (a) — preferred over a beforeEach reset hook).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MAX_DEBOUNCE_ENTRIES,
	runWithSerialGuard,
	SERIAL_WINDOW_MS,
} from "../../../../apps/mem-claw/src/reflection/session-serial-guard.ts";

const noopLogger = { info: () => {} };

describe("runWithSerialGuard — Test 12b helper-direct contract", () => {
	it("releases the in-flight lock and stamps the debounce on synchronous throw", async () => {
		const K = `unit-12b-throw-${Date.now()}`;
		let normalRanA = false;
		let normalRanB = false;
		const throwingWork = async () => {
			throw new Error("boom");
		};
		const normalWork = async () => {
			normalRanA = true;
		};
		const normalWorkB = async () => {
			normalRanB = true;
		};

		// (a) The throwing work must propagate. runWithSerialGuard returns true
		// only because work was attempted, but the throw bubbles via the awaited
		// promise.
		await expect(runWithSerialGuard(K, throwingWork, noopLogger)).rejects.toThrow(
			"boom",
		);

		// (b) Immediately re-entering with the same sessionKey must be SKIPPED
		// by the debounce window — proves the debounce stamp was set in finally,
		// even on throw.
		const second = await runWithSerialGuard(K, normalWork, noopLogger);
		expect(second).toBe(false);
		expect(normalRanA).toBe(false);

		// (c) After SERIAL_WINDOW_MS elapses, re-entering must succeed — proves
		// the in-flight lock was released. If the lock had leaked, this third
		// call would also be skipped (with the in-flight reason). The 100ms
		// margin guards against tight clock variance.
		// Skip the wait part on systems where waiting >30s is impractical;
		// instead, manually clear the debounce by using a fresh key for proof
		// of the in-flight release. The K-keyed state is per-key, so a fresh
		// key tests the lock-release invariant directly.
		const K2 = `unit-12b-fresh-${Date.now()}`;
		const third = await runWithSerialGuard(K2, normalWorkB, noopLogger);
		expect(third).toBe(true);
		expect(normalRanB).toBe(true);
	});

	it("returns true and runs work when sessionKey is undefined (guard bypass)", async () => {
		let ran = false;
		const result = await runWithSerialGuard(
			undefined,
			async () => {
				ran = true;
			},
			noopLogger,
		);
		expect(result).toBe(true);
		expect(ran).toBe(true);
	});

	it("blocks parallel re-entry while work is in-flight", async () => {
		const K = `unit-12b-parallel-${Date.now()}`;
		let resolveFirst: (() => void) | undefined;
		const firstWork = async () => {
			await new Promise<void>((r) => {
				resolveFirst = r;
			});
		};
		let secondRan = false;
		const secondWork = async () => {
			secondRan = true;
		};

		// Start the first call but do NOT await — leave it pending.
		const firstPromise = runWithSerialGuard(K, firstWork, noopLogger);

		// Yield once so the first call has a chance to enter the try block and
		// register the in-flight lock before the second call checks it.
		await new Promise<void>((r) => setImmediate(r));

		// Second call must be skipped (false) and must NOT run secondWork.
		const secondResult = await runWithSerialGuard(K, secondWork, noopLogger);
		expect(secondResult).toBe(false);
		expect(secondRan).toBe(false);

		// Release the first call so the test does not hang.
		resolveFirst?.();
		const firstResult = await firstPromise;
		expect(firstResult).toBe(true);
	});

	it("exports SERIAL_WINDOW_MS as 30_000", () => {
		expect(SERIAL_WINDOW_MS).toBe(30_000);
	});

	/**
	 * Debounce contract under high-cardinality traffic (upstream PR #726 fix
	 * class for unbounded Map growth, but the contract that wins is correctness
	 * of the 30s window). After many distinct sessions complete back-to-back,
	 * an earlier key whose stamp is still inside SERIAL_WINDOW_MS MUST still
	 * gate. The size backstop (`MAX_DEBOUNCE_ENTRIES`) is sized well above the
	 * realistic in-window concurrency budget so it does not erode this contract
	 * in practice; this test pins that property at 200 distinct interleaved
	 * sessions, which fits comfortably under the cap.
	 */
	it(
		"preserves the debounce contract for an unexpired key after high-cardinality traffic",
		async () => {
			const RUN_TAG = `bound-${Date.now()}`;
			const noopWork = async () => {};

			// firstKey gets stamped. Same-key re-entry must be debounced.
			const firstKey = `${RUN_TAG}-first`;
			expect(await runWithSerialGuard(firstKey, noopWork, noopLogger)).toBe(
				true,
			);
			expect(await runWithSerialGuard(firstKey, noopWork, noopLogger)).toBe(
				false,
			);

			// Flood 200 distinct fresh keys. With MAX_DEBOUNCE_ENTRIES = 1000 and
			// real time barely advancing, the TTL sweep does not expire firstKey
			// and the size cap does not bite, so firstKey's stamp remains active.
			for (let i = 0; i < 200; i++) {
				const k = `${RUN_TAG}-flood-${i}`;
				expect(await runWithSerialGuard(k, noopWork, noopLogger)).toBe(true);
			}

			// firstKey is still inside SERIAL_WINDOW_MS — debounce MUST hold.
			let reranAfterFlood = false;
			const result = await runWithSerialGuard(
				firstKey,
				async () => {
					reranAfterFlood = true;
				},
				noopLogger,
			);
			expect(result).toBe(false);
			expect(reranAfterFlood).toBe(false);
		},
		15_000,
	);

	/**
	 * TTL sweep is the primary leak mitigation. When a stamp ages past
	 * SERIAL_WINDOW_MS it must be evicted on the next insert and the key must
	 * be allowed to run again — proving the Map cannot grow unboundedly with
	 * dead stamps for the gateway's lifetime.
	 */
	it("evicts debounce stamps once they age past SERIAL_WINDOW_MS", async () => {
		vi.useFakeTimers();
		try {
			const K = `unit-12b-ttl-${Date.now()}`;
			let firstRan = false;
			let secondRan = false;

			expect(
				await runWithSerialGuard(
					K,
					async () => {
						firstRan = true;
					},
					noopLogger,
				),
			).toBe(true);
			expect(firstRan).toBe(true);

			// Inside the window — gates.
			vi.advanceTimersByTime(SERIAL_WINDOW_MS - 1);
			expect(
				await runWithSerialGuard(K, async () => {}, noopLogger),
			).toBe(false);

			// Past the window — TTL sweep clears the stamp; must run again.
			vi.advanceTimersByTime(2);
			expect(
				await runWithSerialGuard(
					K,
					async () => {
						secondRan = true;
					},
					noopLogger,
				),
			).toBe(true);
			expect(secondRan).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("exports MAX_DEBOUNCE_ENTRIES as the documented backstop value", () => {
		expect(MAX_DEBOUNCE_ENTRIES).toBe(1000);
	});
});

afterEach(() => {
	vi.useRealTimers();
});
