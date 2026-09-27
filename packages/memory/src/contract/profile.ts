import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { z } from "zod";
import { createLogger } from "@snoai/utils/logger";
import { settingsSchema, type Settings } from "../../config/settings";

export function getStateDir(defaultStateDir?: string): string { return path.resolve(process.env.SNO_PROFILE_DIR ?? defaultStateDir ?? path.join(homedir(), ".sno")); }
export function getSettingsPath(): string { return path.join(getStateDir(), "settings.json"); }

export class SettingsUnavailableError extends Error {}

export function readSettings(): Settings {
	const settingsPath = getSettingsPath();
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(settingsPath, "utf8"));
	} catch (error) {
		const detail = error instanceof Error && "code" in error && error.code === "ENOENT"
			? "file" : error instanceof SyntaxError ? `JSON: ${error.message}` : "file";
		throw new SettingsUnavailableError(`settings unavailable: ${settingsPath}: ${detail}; run sno setup`);
	}
	const parsed = settingsSchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const field = issue?.code === "unrecognized_keys"
			? [...issue.path, issue.keys[0]].join(".") : issue?.path.join(".") || "settings";
		throw new SettingsUnavailableError(`settings unavailable: ${settingsPath}: ${field}; run sno setup`);
	}
	return parsed.data;
}
export function getSnoStationMemStateDir(): string { return path.join(getStateDir(), "sno-station-mem"); }
export function getPrincipal(): string { return userInfo().username; }
export function getBindingPath(): string { return path.join(getStateDir(), "station", `sno-station-mem-${getPrincipal()}.binding.json`); }
export function getInstallationConfigPath(): string { return path.join(getStateDir(), "station", `sno-station-mem-${getPrincipal()}.config.json`); }
export function getDefaultStorePath(): string { return path.join(getSnoStationMemStateDir(), getPrincipal(), "memory.sqlite"); }
export function getDiscoveryPath(): string { return path.join(getStateDir(), "station", "sidecar.json"); }
export function getSidecarSocketPath(): string { return path.join(getStateDir(), "station", "sidecar.sock"); }
export function getStartupLogPath(): string { return path.join(getSnoStationMemStateDir(), "sidecar-startup.log"); }

const bindingSchema = z.strictObject({ principal: z.string().min(1), storePath: z.string().refine(path.isAbsolute) });

export async function readBoundStorePath(requestedPath?: string): Promise<string> {
	try {
		const binding = bindingSchema.parse(JSON.parse(await readFile(getBindingPath(), "utf8")));
		return binding.storePath;
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
			createLogger("sno-station-mem:profile").error("memory.binding.read.failed", { error }, {
				event_name: "memory.binding.read.failed", file: "packages/memory/src/contract/profile.ts",
				function: "readBoundStorePath", site_id: "memory.binding.read.failed",
			});
		}
		try {
			const installed: unknown = JSON.parse(await readFile(getInstallationConfigPath(), "utf8"));
			if (installed && typeof installed === "object" && "storePath" in installed &&
				typeof installed.storePath === "string" && path.isAbsolute(installed.storePath)) return installed.storePath;
		} catch { /* The runtime logs an unreadable installation config when it opens. */ }
		return requestedPath ? path.resolve(requestedPath) : getDefaultStorePath();
	}
}
