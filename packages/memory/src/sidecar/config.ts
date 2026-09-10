/** @file config.ts
 * @purpose Centralizes the standalone REM sidecar's paths, protocol constants, and boot settings.
 * @boundary Environment and filesystem configuration for CLI discovery and local REM state.
 */

import { homedir } from "node:os";
import path from "node:path";
import {
	parseRemOperationalConfiguration,
	type RemOperationalConfiguration,
} from "../engine/rem/index.js";
import { getMemClawStateDir, getStateDir } from "../engine/shared/paths";

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

const SNO_PROFILE_DIR_ENV = "SNO_PROFILE_DIR";
const SNO_REM_TEST_HOLD_MS_ENV = "SNO_STATION_MEM_REM_TEST_HOLD_MS";
const SNO_REM_TRACE_ENV = "SNO_STATION_MEM_REM_TRACE";
const SNO_REM_CONFIG_JSON_ENV = "SNO_STATION_MEM_REM_CONFIG_JSON";
const DISCOVERY_RELATIVE_PATH = path.join("station", "sidecar.json");
const REM_JOB_JOURNAL_NAME = "rem-wave-jobs.jsonl";
const REM_SIDECAR_LOCK_NAME = "rem-sidecar";
const REM_TRACE_LOG_NAME = "rem-trace.jsonl";
const REM_CHASSIS_JOURNAL_NAME = "rem-chassis-journal.jsonl";
export function getSnoProfileDir(): string {
	return process.env[SNO_PROFILE_DIR_ENV] ?? path.join(homedir(), ".sno");
}

export function getRemDiscoveryPath(): string {
	return path.join(getSnoProfileDir(), DISCOVERY_RELATIVE_PATH);
}

export function getRemJobJournalPath(): string {
	return path.join(getMemClawStateDir(), REM_JOB_JOURNAL_NAME);
}

export function getRemChassisJournalPath(): string {
	return path.join(getMemClawStateDir(), REM_CHASSIS_JOURNAL_NAME);
}

export function getRemSidecarLockKey(): string {
	return path.join(getMemClawStateDir(), REM_SIDECAR_LOCK_NAME);
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
		throw new Error(`${SNO_REM_TEST_HOLD_MS_ENV} must be a non-negative integer`);
	}
	return value;
}

export function readRemConfigSource(): string | undefined {
	return process.env[SNO_REM_CONFIG_JSON_ENV];
}

export function readRemOperationalConfig(): RemOperationalConfiguration {
	const raw = process.env[SNO_REM_CONFIG_JSON_ENV];
	if (raw === undefined) throw new Error(`${SNO_REM_CONFIG_JSON_ENV} is required`);
	if (raw.trim().length === 0) throw new Error(`${SNO_REM_CONFIG_JSON_ENV} must not be blank`);
	let decoded: unknown;
	try {
		decoded = JSON.parse(raw);
	} catch {
		throw new Error(`${SNO_REM_CONFIG_JSON_ENV} must contain valid JSON`);
	}
	return parseRemOperationalConfiguration(decoded);
}
