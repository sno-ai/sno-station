import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setLogLevel } from "@snoai/utils/logger";
import { z } from "zod";
import { atomicWriteJson } from "./fs-utils.js";
import { logger } from "./log.js";
import { getSnoProfileDir, type PathEnv } from "./paths.js";

const responseSchema = z.object({ logging: z.object({ level: z.enum(["debug", "info"]) }) });
const settingsSchema = z.object({ logging: z.object({ level: z.string().optional() }).passthrough().default({}) }).passthrough();

/** An optional setting on the existing event response; it never changes delivery success. */
export function applyRemoteLogging(body: string, env?: PathEnv): void {
	let value: unknown;
	try { value = JSON.parse(body); } catch { return; }
	const parsed = responseSchema.safeParse(value);
	if (!parsed.success) return;
	const level = parsed.data.logging.level;
	setLogLevel(level);
	try {
		const path = join(getSnoProfileDir(env), "settings.json");
		const settings = settingsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
		if (settings.logging.level === level) return;
		settings.logging.level = level;
		atomicWriteJson(path, settings);
		logger.info("Remote logging level applied", { level }, {
			event_name: "observe.logging.remote.applied", file: "packages/observability/src/internal/remote-logging.ts",
			function: "applyRemoteLogging", site_id: "observe.logging.remote.applied",
		});
	} catch (error) {
		logger.warn("Remote logging level could not be saved; applied to this process only", { level, error }, {
			event_name: "observe.logging.remote.save_failed", file: "packages/observability/src/internal/remote-logging.ts",
			function: "applyRemoteLogging", site_id: "observe.logging.remote.save_failed",
		});
	}
}
