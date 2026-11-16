import { createLogger } from "@snoai/utils/logger";
/** @file config.ts
 * @purpose Centralizes the standalone REM sidecar's paths, protocol constants, and boot settings.
 * @boundary Environment and filesystem configuration for CLI discovery and local REM state.
 */

import path from "node:path";
import { getSnoStationMemStateDir, getStateDir } from "../engine/shared/paths";

export const REM_SIDECAR_HOST = "127.0.0.1";
export const REM_SIDECAR_ORIGIN = "http://127.0.0.1";
export const REM_CORRELATION_ID_HEADER = "x-rem-correlation-id";
export const REM_RUN_PATH = "/rem/run";
export const REM_JOBS_PATH_PREFIX = "/rem/jobs/";
export const HEALTH_PATH = "/healthz";
export const REM_SOURCE = "sidecar";
export const MEMORY_USAGE_FLUSH_INTERVAL_MS: number = 5 * 60_000;

import { getDiscoveryPath } from "../contract/profile";
const SNO_REM_TEST_HOLD_MS_ENV = "SNO_STATION_MEM_REM_TEST_HOLD_MS";
const SNO_REM_TRACE_ENV = "SNO_STATION_MEM_REM_TRACE";
const REM_JOB_JOURNAL_NAME = "rem-wave-jobs.jsonl";
const REM_TRACE_LOG_NAME = "rem-trace.jsonl";
export function getSnoProfileDir(): string {
	return getStateDir();
}

export function getRemDiscoveryPath(): string {
	return getDiscoveryPath();
}

export function getRemJobJournalPath(): string {
	return path.join(getSnoStationMemStateDir(), REM_JOB_JOURNAL_NAME);
}

export function getRemTraceLogPath(stateRoot: string = getStateDir()): string {
	return path.join(stateRoot, "sno-station-mem", REM_TRACE_LOG_NAME);
}

export function isRemTraceEnabled(): boolean {
	return !["0", "false", "off"].includes(
		(process.env[SNO_REM_TRACE_ENV] ?? "1").toLowerCase(),
	);
}

export function readRemTestHoldMs(): number {
	const raw = process.env[SNO_REM_TEST_HOLD_MS_ENV];
	if (raw === undefined) return 0;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) {
		reportConfigFailure(new Error(`${SNO_REM_TEST_HOLD_MS_ENV} must be a non-negative integer`));
		return 0;
	}
	return value;
}

function reportConfigFailure(error: unknown): void {
	createLogger("sno-station-mem:config").error("sidecar.config.failed", { error }, {
		event_name: "sidecar.config.failed", file: "packages/memory/src/sidecar/config.ts",
		function: "reportConfigFailure", site_id: "sidecar.config.failed",
	});
}

export const MAINTENANCE_INTERVAL_ENV = "SNO_STATION_MEM_MAINTENANCE_INTERVAL_MS";
export const REM_CLOCK_OVERRIDE_ENV = "SNO_STATION_MEM_REM_CLOCK_OVERRIDE";

export function readMaintenanceOverrides(): { intervalMs?: number; now?: Date } {
	const positive = (name: string): number | undefined => {
		const raw = process.env[name];
		if (raw === undefined) return undefined;
		const value = Number(raw);
		if (!Number.isSafeInteger(value) || value < 1) { reportConfigFailure(new Error(`${name} must be a positive integer`)); return undefined; }
		return value;
	};
	const rawClock = process.env[REM_CLOCK_OVERRIDE_ENV];
	const now = rawClock === undefined ? undefined : new Date(rawClock);
	if (now && Number.isNaN(now.getTime())) { reportConfigFailure(new Error(`${REM_CLOCK_OVERRIDE_ENV} must be an ISO timestamp`)); return {}; }
	return { intervalMs: positive(MAINTENANCE_INTERVAL_ENV), now };
}
