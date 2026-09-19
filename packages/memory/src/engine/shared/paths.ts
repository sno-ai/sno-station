/** @file paths.ts
 * @purpose Resolves profile state and the install-time principal/store binding.
 * @boundary Paths and binding files only; this module never opens a memory store.
 */
import { randomUUID } from "node:crypto";
import { access, link, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { ContractError } from "../../contract/error";
import { installationInputSchema, type InstallationInput } from "../../../config/installation-settings";

import { getBindingPath, getDefaultStorePath, getInstallationConfigPath, getPrincipal } from "../../contract/profile";
export { getBindingPath, getDefaultStorePath, getInstallationConfigPath, getPrincipal, getStateDir, getSnoStationMemStateDir, readBoundStorePath } from "../../contract/profile";

export function resolveSnoStationMemDbPath(configuredPath: string | undefined,
	resolveConfiguredPath: (input: string) => string): string {
	return configuredPath ? resolveConfiguredPath(configuredPath) : getDefaultStorePath();
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
