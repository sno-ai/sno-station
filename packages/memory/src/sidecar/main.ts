import { setTimeout as delay } from "node:timers/promises";
import { MEMORY_RECONNECT_INTERVAL_MS } from "../contract/routes";
import { FIXED_MEMORY_SNO_EXTRACT_CHAT } from "../model/signed-registry-constants";
/** @file main.ts
 * @purpose Boots the standalone local REM sidecar process.
 * @boundary Process environment, sidecar lifecycle, and local request-log destination.
 */

import { addLogFileTarget, closeLogger, createLogger } from "@snoai/utils/logger";
import { emitRuntimeStartSnapshot, initializeRuntimeDiagnostics } from "../engine/observability/runtime-diagnostics";
import { getRemTraceLogPath, isRemTraceEnabled } from "./config";
import type { RunningRemSidecar } from "./server";

const { startRemSidecar, DuplicateSidecarError } = await import("./server");
let sidecar: RunningRemSidecar | undefined;
while (!sidecar) {
	try { sidecar = await startRemSidecar(); }
	catch (error) {
		if (error instanceof DuplicateSidecarError) { await closeLogger(); process.exit(0); }
		createLogger("sno-station-mem:sidecar").error("Memory sidecar startup failed; retrying", { error }, {
			event_name: "memory.sidecar.startup.failed", file: "packages/sno-station-mem/src/sidecar/main.ts",
			function: "<module>", site_id: "sidecar.main.startup.failed",
		});
		await delay(MEMORY_RECONNECT_INTERVAL_MS);
	}
}
initializeRuntimeDiagnostics();
if (isRemTraceEnabled()) addLogFileTarget(getRemTraceLogPath());
emitRuntimeStartSnapshot({ runtimeMode: "sidecar", preset: FIXED_MEMORY_SNO_EXTRACT_CHAT,
	routing: { mode: "rem-enhanced", remEnhanced: { occasions: {
		memoryExtract: "snoRemMem", conflictAdjudication: "snoRemMem",
	} } } });

let stopping = false;

async function stop(): Promise<void> {
	if (stopping) return;
	stopping = true;
	try { await sidecar?.stop(); }
	finally { await closeLogger(); }
}

process.once("SIGINT", async () => {
	try { await stop(); process.exit(0); }
	catch { process.exit(130); }
});
process.once("SIGTERM", async () => {
	try { await stop(); process.exit(0); }
	catch { process.exit(143); }
});
