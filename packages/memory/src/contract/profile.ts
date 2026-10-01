import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
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
		throw new SettingsUnavailableError(`settings unavailable: ${settingsPath}: ${detail}; see https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md`);
	}
	const parsed = settingsSchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const field = issue?.code === "unrecognized_keys"
			? [...issue.path, issue.keys[0]].join(".") : issue?.path.join(".") || "settings";
		throw new SettingsUnavailableError(`settings unavailable: ${settingsPath}: ${field}; see https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md`);
	}
	return parsed.data;
}
export function getSnoStationMemStateDir(): string { return path.join(getStateDir(), "sno-station-mem"); }
export function getPrincipal(): string { return userInfo().username; }
export function getDiscoveryPath(): string { return path.join(getStateDir(), "station", "sidecar.json"); }
export function getSidecarSocketPath(): string { return path.join(getStateDir(), "station", "sidecar.sock"); }
export function getStartupLogPath(): string { return path.join(getSnoStationMemStateDir(), "sidecar-startup.log"); }
