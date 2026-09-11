import { createLogger as createDiagnosticLogger, privateLogReference } from "@snoai/utils/logger";
const diagnosticLog = createDiagnosticLogger("sno-station-mem:session-serial-guard");
/** @file session-serial-guard.ts
 * @purpose Serializes reflection runs per session via in-flight lock + post-completion debounce.
 * @boundary Reflection hook entry - called once per command:new / command:reset.
 * @see strategy-hook-runner.ts.
 */

import { setLruEntry } from "../shared/lru";

/**
 * Serial guard for reflection - see PRD section 4.3.
 *
 * Two distinct protections:
 *   (1) In-flight lock - boolean, no time bound, blocks parallel re-entry.
 *   (2) Post-completion debounce - 30s window after the previous run completed.
 *
 * State lives on `globalThis` via Symbol keys so the guard survives across
 * module reloads and is shared across plugin instances within a process.
 * On process crash both maps die with the process; no permanent lock risk.
 *
 * The single source of truth is `runWithSerialGuard`. Production code never
 * touches the in-flight Set or debounce Map directly.
 */

const REFLECTION_INFLIGHT = Symbol.for("sno-station-mem.reflection-inflight");
const REFLECTION_DEBOUNCE = Symbol.for("sno-station-mem.reflection-debounce");

export const SERIAL_WINDOW_MS = 30_000;

/**
 * Backstop cap on the debounce Map size. The primary leak mitigation is the
 * TTL sweep (any stamp older than `SERIAL_WINDOW_MS` is dead and removed on
 * every insert). This cap only takes effect in the pathological case where
 * more than `MAX_DEBOUNCE_ENTRIES` distinct sessions complete within a single
 * 30s window — a regime the gateway is not expected to sustain. Sized at 1000
 * so that under realistic fan-out the TTL sweep keeps the Map well under the
 * cap and no still-active stamp gets evicted prematurely.
 */
export const MAX_DEBOUNCE_ENTRIES = 1000;

/** Returns the in-flight Set, lazily creating it on first access. */
function getInflightSet(): Set<string> {
	const g = globalThis as Record<symbol, unknown>;
	if (!(g[REFLECTION_INFLIGHT] instanceof Set)) {
		g[REFLECTION_INFLIGHT] = new Set<string>();
	}
	return g[REFLECTION_INFLIGHT] as Set<string>;
}

/** Returns the debounce Map, lazily creating it on first access. */
function getDebounceMap(): Map<string, number> {
	const g = globalThis as Record<symbol, unknown>;
	if (!(g[REFLECTION_DEBOUNCE] instanceof Map)) {
		g[REFLECTION_DEBOUNCE] = new Map<string, number>();
	}
	return g[REFLECTION_DEBOUNCE] as Map<string, number>;
}

/**
 * Drops debounce stamps that have aged past `SERIAL_WINDOW_MS`. Such stamps
 * cannot gate any future call (the `Date.now() - last < SERIAL_WINDOW_MS`
 * check returns false past the window) so removing them is semantically a
 * no-op while it bounds Map growth.
 *
 * Map iteration is insertion-order; we walk in order and stop at the first
 * non-expired entry, since `setLruEntry` re-inserts at the tail so older
 * timestamps are always near the head.
 */
function pruneExpiredDebounceStamps(map: Map<string, number>, now: number): void {
	for (const [key, stamp] of map) {
		if (now - stamp < SERIAL_WINDOW_MS) return;
		map.delete(key);
	}
}

interface SerialGuardLogger {
	info: (msg: string) => void;
}

/**
 * Run `work` under the serial guard for the given session key.
 *
 * Returns `true` when `work` ran (even if `work` threw - callers must use
 * try/catch on the awaited result to observe the throw), `false` when the
 * call was skipped by either the in-flight lock or the debounce window.
 *
 * Invariants:
 * - The in-flight lock is acquired as the FIRST statement inside the try
 *   block so no synchronous code between acquire and try can leak it.
 * - The debounce stamp is set unconditionally in the finally block, even on
 *   throw. This prevents an early-failing reflection run from being retried
 *   in a tight loop.
 * - The in-flight lock is released unconditionally in the same finally.
 *
 * If `sessionKey` is falsy, the guard is bypassed and `work` runs
 * unconditionally - there is nothing to key the lock on.
 */
export async function runWithSerialGuard(
	sessionKey: string | undefined,
	work: () => Promise<void>,
	logger: SerialGuardLogger = { info: () => {} },
): Promise<boolean> {
	if (!sessionKey) {
		await work();
		return true;
	}

	if (getInflightSet().has(sessionKey)) {
		diagnosticLog.info("Reflection command already running", { outcome: "skipped", reason_code: "already_in_flight", session_reference: privateLogReference(sessionKey) }, { event_name: "memory.session_serial_guard.reflection.command.already.running", file: "packages/sno-station-mem/src/engine/reflection/session-serial-guard.ts", function: "runWithSerialGuard", site_id: "reflection.session-serial-guard.runWithSerialGuard.edb3193695" });
		return false;
	}

	const last = getDebounceMap().get(sessionKey);
	if (last !== undefined && Date.now() - last < SERIAL_WINDOW_MS) {
		diagnosticLog.info("Reflection command delayed by debounce", { outcome: "skipped", reason_code: "debounced", session_reference: privateLogReference(sessionKey) }, { event_name: "memory.session_serial_guard.reflection.command.delayed.by.debounce", file: "packages/sno-station-mem/src/engine/reflection/session-serial-guard.ts", function: "runWithSerialGuard", site_id: "reflection.session-serial-guard.runWithSerialGuard.2e95bc0994" });
		return false;
	}

	try {
		getInflightSet().add(sessionKey);
		await work();
	} finally {
		// Two-stage bound:
		//   (1) TTL sweep — drops every stamp older than SERIAL_WINDOW_MS. In
		//       steady state this keeps the Map sized to "sessions active in the
		//       last 30s", regardless of gateway lifetime.
		//   (2) `setLruEntry` size backstop — only kicks in if (1) leaves more
		//       than MAX_DEBOUNCE_ENTRIES distinct still-active sessions, an
		//       overload regime well above expected gateway concurrency. In that
		//       degraded case some still-active stamps may be evicted; the size
		//       cap bounds memory at the cost of weakened debounce under load,
		//       which is the conservative tradeoff.
		const now = Date.now();
		const debounce = getDebounceMap();
		pruneExpiredDebounceStamps(debounce, now);
		setLruEntry(debounce, sessionKey, now, MAX_DEBOUNCE_ENTRIES);
		getInflightSet().delete(sessionKey);
	}
	return true;
}
