import { createLogger } from "@snoai/utils/logger";
/** @file config.ts
 * @purpose Centralizes the standalone REM sidecar's paths, protocol constants, and boot settings.
 * @boundary Environment and filesystem configuration for CLI discovery and local REM state.
 */

import path from "node:path";
import {
	parseRemOperationalConfiguration,
	type RemOperationalConfiguration,
} from "../engine/rem/index.js";
import { getSnoStationMemStateDir, getStateDir } from "../engine/shared/paths";

export const REM_SIDECAR_HOST = "127.0.0.1";
export const REM_SIDECAR_ORIGIN = "http://127.0.0.1";
export const REM_SIDECAR_TOKEN_HEADER = "x-sidecar-token";
export const REM_CORRELATION_ID_HEADER = "x-rem-correlation-id";
export const REM_RUN_PATH = "/rem/run";
export const REM_JOBS_PATH_PREFIX = "/rem/jobs/";
export const HEALTH_PATH = "/healthz";
export const REM_SOURCE = "sidecar";
export const REM_ASYNC_START_DELAY_MS = 100;
export const REM_REQUEST_BODY_LIMIT_BYTES: number = 64 * 1024;
export const REM_MODEL_OUTPUT_TOKEN_CAP = 4096;
export const MEMORY_USAGE_FLUSH_INTERVAL_MS: number = 5 * 60_000;

import { getDiscoveryPath } from "../contract/profile";
const SNO_REM_TEST_HOLD_MS_ENV = "SNO_STATION_MEM_REM_TEST_HOLD_MS";
const SNO_REM_TRACE_ENV = "SNO_STATION_MEM_REM_TRACE";
const SNO_REM_CONFIG_JSON_ENV = "SNO_STATION_MEM_REM_CONFIG_JSON";
const REM_JOB_JOURNAL_NAME = "rem-wave-jobs.jsonl";
const REM_TRACE_LOG_NAME = "rem-trace.jsonl";
const REM_CHASSIS_JOURNAL_NAME = "rem-chassis-journal.jsonl";
export function getSnoProfileDir(): string {
	return getStateDir();
}

export function getRemDiscoveryPath(): string {
	return getDiscoveryPath();
}

export function getRemJobJournalPath(): string {
	return path.join(getSnoStationMemStateDir(), REM_JOB_JOURNAL_NAME);
}

export function getRemChassisJournalPath(): string {
	return path.join(getSnoStationMemStateDir(), REM_CHASSIS_JOURNAL_NAME);
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

export function readRemConfigSource(): string | undefined {
	return process.env[SNO_REM_CONFIG_JSON_ENV];
}

const DEFAULT_REM_CONFIGURATION: RemOperationalConfiguration = {
	profileId: "default", operations: { "rem-replace": true, "rem-update": true, "rem-distill": true, "rem-retire": true },
	budgets: { maxPairs: 10 }, retrieval: { neighborLimit: 10, similarityThreshold: 0.8 },
	coverage: { accuracyFloor: null }, retries: { liveContentionRetries: 1 },
	modelRoute: "http://localhost:8070/codex/v1/chat/completions",
	facetPolicy: { aggregationGrammar: "current-first-v1", historyGrammar: "history-evidence-v1" },
	calibration: { minimumPublishableScoreEffect: null, minimumTargetCount: null, minimumTargetPercent: null },
	enableGateDigests: { "p5-production-config": "0".repeat(64), "p6-monthly-non-regression": "0".repeat(64),
		"p7-detector-gate-verdict": "0".repeat(64), "population-routing": "0".repeat(64), "rem-update": "0".repeat(64), "rem-replace": "0".repeat(64) },
};

function reportConfigFailure(error: unknown): void {
	createLogger("sno-station-mem:config").error("sidecar.config.failed", { error }, {
		event_name: "sidecar.config.failed", file: "packages/sno-station-mem/src/sidecar/config.ts",
		function: "reportConfigFailure", site_id: "sidecar.config.failed",
	});
}

export function readRemOperationalConfig(source: string | undefined = readRemConfigSource()): RemOperationalConfiguration {
	if (source === undefined) return DEFAULT_REM_CONFIGURATION;
	try { return parseRemOperationalConfiguration(JSON.parse(source)); }
	catch (error) { reportConfigFailure(error); return DEFAULT_REM_CONFIGURATION; }
}

export const MAINTENANCE_INTERVAL_ENV = "SNO_STATION_MEM_MAINTENANCE_INTERVAL_MS";
export const REM_CLOCK_OVERRIDE_ENV = "SNO_STATION_MEM_REM_CLOCK_OVERRIDE";
export const REM_VOLUME_THRESHOLD_ENV = "SNO_STATION_MEM_REM_VOLUME_THRESHOLD";

export function readMaintenanceOverrides(): { intervalMs?: number; now?: Date; volumeThreshold?: number } {
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
	return { intervalMs: positive(MAINTENANCE_INTERVAL_ENV), now, volumeThreshold: positive(REM_VOLUME_THRESHOLD_ENV) };
}
