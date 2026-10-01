import { userInfo } from "node:os";
import { join } from "node:path";
import { bindTestMemory } from "./memory-sidecar-fixture.ts";

export function testInstallationConfigPath(profileRoot: string): string {
	return join(profileRoot, "station", `sno-station-mem-${userInfo().username}.config.json`);
}

/** Writes the profile's `settings.json` from an OpenClaw-shaped config; `encryptionKey` is the store's key. */
export function writeTestInstallationConfig(profileRoot: string, original: {
	plugins?: { entries?: Record<string, { config?: { dbPath?: string; embedding?: Record<string, unknown>; mode?: string; retrieval?: Record<string, unknown>; memoryTelemetry?: unknown; autoRecallTimeoutMs?: number; remOperations?: string[] } }> };
}, encryptionKey?: string): void {
	const config = original.plugins?.entries?.["sno-mem-claw"]?.config;
	bindTestMemory(profileRoot,
		config?.dbPath ?? join(profileRoot, "sno-station-mem", userInfo().username, "memory.sqlite"),
		{ ...config, mode: config?.mode ?? "local-first" }, encryptionKey);
}
