import { setTimeout as delay } from "node:timers/promises";
import { MEMORY_RECONNECT_INTERVAL_MS } from "../contract/routes";
/** @file main.ts
 * @purpose Boots the standalone local REM sidecar process.
 * @boundary Process environment, sidecar lifecycle, and local request-log destination.
 */

import { addLogFileTarget, closeLogger, createLogger } from "@snoai/utils/logger";
import { getRemTraceLogPath, isRemTraceEnabled } from "./config";
import { SettingsUnavailableError } from "../contract/profile";
import type { RunningRemSidecar } from "./server";

const { startRemSidecar, DuplicateSidecarError } = await import("./server");
let sidecar: RunningRemSidecar | undefined;
for (let attempt = 1; !sidecar; attempt++) {
	try { sidecar = await startRemSidecar(); }
	catch (error) {
		if (error instanceof DuplicateSidecarError) { await closeLogger(); process.exit(0); }
		if (error instanceof SettingsUnavailableError) throw error;
		createLogger("sno-station-mem:sidecar").error(attempt >= 3 ? "Memory service startup failed after three attempts; stopping" : "Memory service startup failed; retrying", { error, attempt }, {
			event_name: "memory.sidecar.startup.failed", file: "packages/memory/src/sidecar/main.ts",
			function: "<module>", site_id: "sidecar.main.startup.failed",
		});
		if (attempt >= 3) { await closeLogger(); process.exit(1); }
		await delay(MEMORY_RECONNECT_INTERVAL_MS);
	}
}
if (isRemTraceEnabled()) addLogFileTarget(getRemTraceLogPath());
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
