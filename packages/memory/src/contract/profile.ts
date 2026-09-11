import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { z } from "zod";
import { ContractError } from "./error";

export function getStateDir(): string { return path.resolve(process.env.SNO_PROFILE_DIR ?? path.join(homedir(), ".sno")); }
export function getSnoStationMemStateDir(): string { return path.join(getStateDir(), "sno-station-mem"); }
export function getPrincipal(): string { return userInfo().username; }
export function getBindingPath(): string { return path.join(getStateDir(), "station", `sno-station-mem-${getPrincipal()}.binding.json`); }
export function getInstallationConfigPath(): string { return path.join(getStateDir(), "station", `sno-station-mem-${getPrincipal()}.config.json`); }
export function getDefaultStorePath(): string { return path.join(getSnoStationMemStateDir(), getPrincipal(), "memory.sqlite"); }
export function getDiscoveryPath(): string { return path.join(getStateDir(), "station", "sidecar.json"); }
export function getStartupLogPath(): string { return path.join(getSnoStationMemStateDir(), "sidecar-startup.log"); }
export function getSidecarLockPath(): string { return path.join(getSnoStationMemStateDir(), "sidecar.lock"); }

const bindingSchema = z.strictObject({ principal: z.string().min(1), storePath: z.string().refine(path.isAbsolute) });

export async function readBoundStorePath(requestedPath?: string): Promise<string> {
	let text: string;
	try { text = await readFile(getBindingPath(), "utf8"); }
	catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
		const defaultPath = getDefaultStorePath();
		if (requestedPath && path.resolve(requestedPath) !== defaultPath) throw new ContractError("store-mismatch");
		return defaultPath;
	}
	const binding = bindingSchema.parse(JSON.parse(text));
	if (binding.principal !== getPrincipal()) throw new ContractError("principal-mismatch");
	if (requestedPath && path.resolve(requestedPath) !== binding.storePath) throw new ContractError("store-mismatch");
	return binding.storePath;
}
