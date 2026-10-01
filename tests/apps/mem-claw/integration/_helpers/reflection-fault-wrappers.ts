/**
 * Sanctioned fault-injection wrappers for reflection v3 behavioral tests.
 * Per PRD §5: input-scoped fault injection only — passthrough on every input
 * except the explicit sentinel. Not module-replacement mocks.
 *
 * Real LLM API required. No mocking. Missing keys = FAIL.
 *
 * Design: the production embedder + store are owned by the plugin runtime
 * (closed over inside `registerRuntime`). Tests cannot inject a wrapper
 * object after register; they must MUTATE the live methods in place. Each
 * wrapper returns a `restore()` that puts the original method back, so a
 * `try/finally` block in the test keeps cross-test isolation safe.
 */

import type { Embedder } from "../../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import type { MemoryStore, SearchOptions } from "../../../../../packages/memory/src/store/store.ts";

export interface RestoreHandle {
	restore: () => void;
}

/**
 * Sentinel-throw wrapper around `embedder.embed`. Throws synchronously
 * when the input text matches the sentinel exactly. Passthrough everywhere
 * else. Used by Tests 9 and 12b.
 */
export function wrapEmbedderWithSentinelThrow(
	real: Embedder,
	sentinelText: string,
): RestoreHandle {
	const original = real.embed.bind(real);
	(real as { embed: Embedder["embed"] }).embed = async (
		text: string,
	) => {
		if (text === sentinelText) {
			throw new Error(`sentinel-throw embed for ${sentinelText}`);
		}
		return original(text);
	};
	return {
		restore: () => {
			(real as { embed: Embedder["embed"] }).embed =
				original;
		},
	};
}

/**
 * Sentinel-delay wrapper around `embedder.embed`. Awaits delayMs before
 * passthrough when the input matches the sentinel. Passthrough on every other
 * input. Used by Test 11b (delay > SERIAL_WINDOW_MS forces in-flight lock path).
 */
export function wrapEmbedderWithSentinelDelay(
	real: Embedder,
	sentinelText: string,
	delayMs: number,
): RestoreHandle {
	const original = real.embed.bind(real);
	(real as { embed: Embedder["embed"] }).embed = async (
		text: string,
	) => {
		if (text === sentinelText) {
			await new Promise((r) => setTimeout(r, delayMs));
		}
		return original(text);
	};
	return {
		restore: () => {
			(real as { embed: Embedder["embed"] }).embed =
				original;
		},
	};
}

/**
 * Sentinel-throw wrapper around `store.searchSemantic`. Throws when the
 * vector matches the predicate; passthrough on every other vector. Used by
 * Test 9b.
 */
export function wrapStoreWithSentinelThrow(
	real: MemoryStore,
	matchFn: (vector: Float32Array) => boolean,
): RestoreHandle {
	const original = real.searchSemantic.bind(real);
	(real as { searchSemantic: MemoryStore["searchSemantic"] }).searchSemantic =
		async (vector: Float32Array, options?: SearchOptions) => {
			if (matchFn(vector)) {
				throw new Error("sentinel-throw searchSemantic");
			}
			return original(vector, options ?? {});
		};
	return {
		restore: () => {
			(real as { searchSemantic: MemoryStore["searchSemantic"] }).searchSemantic =
				original;
		},
	};
}

/**
 * Call-counter wrapper around `embedder.embed`. Records call count
 * with zero behavioral change. Used by Tests 10a/10b/10c — row counts alone
 * pass even when the cap is in the wrong place.
 *
 * Optional `predicate(text)` filter scopes the count to only the calls that
 * the test cares about. Tests 10a/b/c assert the mapped-memory loop's embed
 * count. The same reflection run also drives the layered-store path
 * (`storeReflectionEntries`) which embeds 1 event row + N invariant + N
 * derived rows, plus internal chunk-embeds inside `MemoryStore.store`. Without
 * a predicate, the counter reports the union of ALL embed paths — which is
 * neither what PRD §5 Group 3 specifies nor what the test author intended.
 * Pass a predicate that matches the mapped-bullet text shape (e.g.
 * `(t) => t.startsWith("The user prefers concise")`) so the count reflects
 * the loop under test.
 */
export interface CallCounter extends RestoreHandle {
	readonly count: { embed: number };
	reset(): void;
}

export function wrapEmbedderWithCallCounter(
	real: Embedder,
	predicate?: (text: string) => boolean,
): CallCounter {
	const counter = { embed: 0 };
	const original = real.embed.bind(real);
	(real as { embed: Embedder["embed"] }).embed = async (
		text: string,
	) => {
		if (!predicate || predicate(text)) {
			counter.embed++;
		}
		return original(text);
	};
	return {
		count: counter,
		reset: () => {
			counter.embed = 0;
		},
		restore: () => {
			(real as { embed: Embedder["embed"] }).embed =
				original;
		},
	};
}
