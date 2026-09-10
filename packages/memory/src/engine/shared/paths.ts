/** @file paths.ts
 * @purpose Resolves profile state and the install-time principal/store binding.
 * @boundary Paths and binding files only; this module never opens a memory store.
 */
import { mkdir, open, readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { z } from "zod";
import { ContractError } from "../../contract/index";

export function getStateDir(): string {
	return path.resolve(process.env.SNO_PROFILE_DIR ?? path.join(homedir(), ".sno"));
}

export function getMemClawStateDir(): string {
	return path.join(getStateDir(), "sno-station-mem");
}

export function getPrincipal(): string {
	return userInfo().username;
}

export function getBindingPath(): string {
	return path.join(getStateDir(), "station", `sno-station-mem-${getPrincipal()}.binding.json`);
}

export function getDefaultStorePath(): string {
	return path.join(getMemClawStateDir(), getPrincipal(), "memory.sqlite");
}

export function resolveMemClawDbPath(configuredPath: string | undefined,
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

export async function bindStore(storePath: string): Promise<string> {
	if (!storePath.trim()) throw new ContractError("invalid-input");
	const bindingPath = getBindingPath();
	await mkdir(path.dirname(bindingPath), { recursive: true, mode: 0o700 });
	const file = await open(bindingPath, "wx", 0o600);
	try {
		await file.writeFile(`${JSON.stringify({ principal: getPrincipal(), storePath: path.resolve(storePath) })}\n`);
		await file.sync();
	} finally {
		await file.close();
	}
	return bindingPath;
}
