/** @file paths.ts
 * @purpose Centralizes shared runtime path resolution helpers.
 * @boundary Environment fallbacks and host-relative path resolution.
 * @see ../operations/runtime-audit-log.ts, ../plugin/openclaw-plugin-runtime.ts, ../plugin/memory-management-cli.ts.
 *
 * @deprecated Prefer `@/storage/data-paths` for the new
 *   `~/.snoai/sno-station-core/mem-claw/data/` layout (PRD safe-uninstall §3.1).
 *   The helpers in this file resolve the older OpenClaw-state tree and remain
 *   only for consumers not yet moved to the safe-uninstall data path.
 */

import { homedir } from "node:os";
import path from "node:path";

/**
 * Resolves the OpenClaw state directory shared by audit, cost, and plugin state files.
 * @deprecated Use `@/storage/data-paths#getMemClawDataDir`.
 */
export function getStateDir(): string {
	return process.env.OPENCLAW_STATE_DIR ?? path.join(homedir(), ".openclaw");
}

/**
 * Resolves the mem-claw state directory under the host OpenClaw state root.
 * @deprecated Use `@/storage/data-paths#getMemClawDataDir`.
 */
export function getMemClawStateDir(): string {
	return path.join(getStateDir(), "mem-claw");
}

/**
 * Resolves the mem-claw SQLite DB path from config or state dir.
 * @deprecated Boot-time path resolution moved to
 *   `@/storage/data-bootstrap#bootstrapDataLayout`. Custom config.dbPath is now
 *   recorded in `install.json` at first install.
 */
export function resolveMemClawDbPath(
	configuredPath: string | undefined,
	resolveConfiguredPath: (input: string) => string,
): string {
	if (configuredPath) return resolveConfiguredPath(configuredPath);
	return path.join(getMemClawStateDir(), "mem-claw.sqlite");
}
