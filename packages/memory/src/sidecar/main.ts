import { FIXED_MEMORY_SNO_EXTRACT_CHAT } from "../model/signed-registry-constants";
/** @file main.ts
 * @purpose Boots the standalone local REM sidecar process.
 * @boundary Process environment, sidecar lifecycle, and local request-log destination.
 */

import { addLogFileTarget, closeLogger, createLogger } from "@snoai/utils/logger";
import { emitRuntimeStartSnapshot, initializeRuntimeDiagnostics } from "../engine/observability/runtime-diagnostics";
import { getRemTraceLogPath, isRemTraceEnabled } from "./config";
import type { RunningRemSidecar } from "./server";

initializeRuntimeDiagnostics();
if (isRemTraceEnabled()) addLogFileTarget(getRemTraceLogPath());
emitRuntimeStartSnapshot({ runtimeMode: "sidecar", preset: FIXED_MEMORY_SNO_EXTRACT_CHAT,
	routing: { mode: "rem-enhanced", remEnhanced: { occasions: {
		memoryExtract: "snoRemMem", conflictAdjudication: "snoRemMem",
	} } } });

const { startRemSidecar } = await import("./server");
let sidecar: RunningRemSidecar;
try { sidecar = await startRemSidecar(); }
catch (error) {
	createLogger("sno-station-mem:sidecar").fatal("Memory sidecar startup failed", { outcome: "failed", error }, {
		event_name: "memory.sidecar.startup.failed", file: "packages/sno-station-mem/src/sidecar/main.ts",
		function: "<module>", site_id: "sidecar.main.startup.failed",
	});
	await closeLogger();
	throw error;
}
let stopping = false;

async function stop(): Promise<void> {
	if (stopping) return;
	stopping = true;
	try { await sidecar.stop(); }
	finally { await closeLogger(); }
}

process.once("SIGINT", () => {
	void stop().finally(() => process.exit(130));
});
process.once("SIGTERM", () => {
	void stop().finally(() => process.exit(143));
});
