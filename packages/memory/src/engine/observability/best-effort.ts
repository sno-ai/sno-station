/** @file best-effort.ts
 * @purpose Keeps cloud observability failures out of plugin control flow.
 * @boundary Telemetry-only error handling.
 */

import { createLogger } from "@snoai/utils/logger";

const log = createLogger("sno-station-mem:best-effort");

export type ObserveLogger = {
	warn(message: string): void;
};

export async function bestEffort(
	label: string,
	fn: () => void | Promise<void>,
	logger?: ObserveLogger,
): Promise<void> {
	try {
		await fn();
	} catch (error) {
		if (logger) log.warn("Background observability action failed", { action: label, error }, {
			event_name: "observability.action.failed",
			file: "packages/sno-station-mem/src/engine/observability/best-effort.ts",
			function: "bestEffort",
			site_id: "observability.bestEffort.failed",
		});
	}
}

export function bestEffortSync<T>(
	label: string,
	fn: () => T,
	logger?: ObserveLogger,
): T | undefined {
	try {
		return fn();
	} catch (error) {
		if (logger) log.warn("Synchronous observability action failed", { action: label, error }, {
			event_name: "observability.action.failed",
			file: "packages/sno-station-mem/src/engine/observability/best-effort.ts",
			function: "bestEffortSync",
			site_id: "observability.bestEffortSync.failed",
		});
		return undefined;
	}
}
