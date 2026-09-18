import type { DegradedReason } from "./error";
import type { ContractMethod } from "./index";

export const MEMORY_ROUTES: Readonly<Record<ContractMethod, { path: string; timeoutMs: number }>> = {
	init: { path: "/v1/init", timeoutMs: 30_000 },
	getRecall: { path: "/v1/get-recall", timeoutMs: 120_000 },
	capture: { path: "/v1/capture", timeoutMs: 900_000 },
	mutate: { path: "/v1/mutate", timeoutMs: 900_000 },
	inspect: { path: "/v1/inspect", timeoutMs: 30_000 },
	recordUsage: { path: "/v1/record-usage", timeoutMs: 30_000 },
	onSessionEnd: { path: "/v1/on-session-end", timeoutMs: 900_000 },
	staticBlock: { path: "/v1/static-block", timeoutMs: 30_000 },
};
export const MEMORY_BODY_LIMIT_BYTES: number = 8 * 1024 * 1024;
export const MEMORY_SKIN_HEADER = "x-sno-station-mem-skin";
export const MEMORY_HEALTH_TIMEOUT_MS = 5_000;
export const MEMORY_START_TIMEOUT_MS = 30_000;

export function memoryMethod(pathname: string): ContractMethod | undefined {
	return (Object.keys(MEMORY_ROUTES) as ContractMethod[]).find(method => MEMORY_ROUTES[method].path === pathname);
}

export const MEMORY_ERROR_STATUS: Readonly<Record<DegradedReason, number>> = {
	"sidecar-unreachable": 503, "sidecar-unresponsive": 503, "principal-mismatch": 403,
	"store-mismatch": 409, "no-agent-endpoint": 503, "invalid-input": 400, timeout: 504,
	"storage-unavailable": 503, "engine-failed": 500,
};

export const MEMORY_RECONNECT_INTERVAL_MS = 1_000;

export const MEMORY_DEFAULT_SKIN_ID = "default";
