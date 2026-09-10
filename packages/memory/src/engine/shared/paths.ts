/** @file paths.ts
 * @purpose Resolves profile state and the install-time principal/store binding.
 * @boundary Paths and binding files only; this module never opens a memory store.
 */
import { randomUUID } from "node:crypto";
import { access, link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { z } from "zod";
import { ContractError } from "../../contract/index";
import { installationInputSchema, type InstallationInput } from "../../contract/installation-settings";

export function getStateDir(): string {
	return path.resolve(process.env.SNO_PROFILE_DIR ?? path.join(homedir(), ".sno"));
}

export function getSnoStationMemStateDir(): string {
	return path.join(getStateDir(), "sno-station-mem");
}

export function getPrincipal(): string {
	return userInfo().username;
}

export function getBindingPath(): string {
	return path.join(getStateDir(), "station", `sno-station-mem-${getPrincipal()}.binding.json`);
}

export function getInstallationConfigPath(): string {
	return path.join(getStateDir(), "station", `sno-station-mem-${getPrincipal()}.config.json`);
}

export function getDefaultStorePath(): string {
	return path.join(getSnoStationMemStateDir(), getPrincipal(), "memory.sqlite");
}

export function resolveSnoStationMemDbPath(configuredPath: string | undefined,
	resolveConfiguredPath: (input: string) => string): string {
	return configuredPath ? resolveConfiguredPath(configuredPath) : getDefaultStorePath();
}

const bindingSchema = z.strictObject({
	principal: z.string().min(1), storePath: z.string().refine(path.isAbsolute),
});

export async function readBoundStorePath(requestedPath?: string): Promise<string> {
	let text: string;
	try {
		text = await readFile(getBindingPath(), "utf8");
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
		return requestedPath ? path.resolve(requestedPath) : getDefaultStorePath();
	}
	const binding = bindingSchema.parse(JSON.parse(text));
	if (binding.principal !== getPrincipal()) throw new ContractError("principal-mismatch");
	if (requestedPath && path.resolve(requestedPath) !== binding.storePath) throw new ContractError("store-mismatch");
	return binding.storePath;
}

async function publishExclusive(target: string, bytes: string): Promise<void> {
	const temporary = `${target}.${randomUUID()}.tmp`;
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(bytes);
		await file.sync();
		await file.close();
		await link(temporary, target);
	} finally {
		await file.close();
		await unlink(temporary);
	}
}

export async function bindStore(storePath: string, settings: InstallationInput = {}): Promise<string> {
	if (!storePath.trim()) throw new ContractError("invalid-input");
	const installed = installationInputSchema.parse(settings);
	const bindingPath = getBindingPath();
	await mkdir(path.dirname(bindingPath), { recursive: true, mode: 0o700 });
	try {
		await access(bindingPath);
		throw Object.assign(new Error("binding exists"), { code: "EEXIST" });
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	const resolvedPath = path.resolve(storePath);
	const configBytes = `${JSON.stringify({ ...installed, storePath: resolvedPath })}\n`;
	try { await publishExclusive(getInstallationConfigPath(), configBytes); }
	catch (error) {
		// A crash before publishing the binding can leave this identical, complete config.
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST" ||
			await readFile(getInstallationConfigPath(), "utf8") !== configBytes) throw error;
	}
	await publishExclusive(bindingPath, `${JSON.stringify({ principal: getPrincipal(), storePath: resolvedPath })}\n`);
	const directory = await open(path.dirname(bindingPath), "r");
	try { await directory.sync(); } finally { await directory.close(); }
	return bindingPath;
}
