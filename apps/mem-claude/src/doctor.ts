import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CODING_SKIN_HOOKS, type CodingSkinHookName } from "@snoai/memory/coding-skin";
import { z } from "zod";
import { isOwnedHookCommand, isOwnedPermissionRule, readSettings } from "./install.js";
import { importDirectory, sidecarDiscoveryPath } from "./paths.js";

const discoverySchema = z.object({ pid: z.number().int().positive(), port: z.number().int().positive(), token: z.string() });
const receiptSchema = z.object({ root: z.string() });

export async function sidecarStatus(): Promise<"healthy" | "unhealthy" | "unavailable"> {
	try {
		const discovery = discoverySchema.parse(JSON.parse(await readFile(sidecarDiscoveryPath(), "utf8")));
		const response = await fetch(`http://127.0.0.1:${discovery.port}/healthz`, { signal: AbortSignal.timeout(5_000) });
		const body: unknown = await response.json();
		return response.ok && body && typeof body === "object" && "status" in body && body.status === "ok"
			? "healthy" : "unhealthy";
	} catch {
		return "unavailable";
	}
}

async function importSummary(): Promise<string> {
	let files: string[];
	try {
		files = await readdir(importDirectory());
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return "absent";
		return "unavailable";
	}
	const states: string[] = [];
	for (const file of files.filter(file => file.endsWith(".json")).sort()) {
		try {
			const receipt = receiptSchema.parse(JSON.parse(await readFile(join(importDirectory(), file), "utf8")));
			states.push(`${JSON.stringify(receipt.root)}=present`);
		} catch {
			states.push(`${JSON.stringify(file)}=unparsable`);
		}
	}
	return states.join(" ") || "absent";
}

export async function doctor(configDir: string): Promise<string[]> {
	const settings = await readSettings(configDir).catch(() => undefined);
	const hooks = (Object.keys(CODING_SKIN_HOOKS) as CodingSkinHookName[]).map(event => {
		let state = "absent";
		if (!settings) state = "unparsable";
		else if (settings.disableAllHooks) state = "disabled";
		else if (settings.hooks?.[event]?.some(group => group.hooks.some(hook =>
			hook.type === "command" && hook.command
			&& isOwnedHookCommand(hook.command, CODING_SKIN_HOOKS[event].subcommand)))) state = "present";
		return `${event}=${state}`;
	}).join(" ");
	let permission = "unparsable";
	if (settings) permission = settings.permissions?.allow?.some(isOwnedPermissionRule) ? "present" : "absent";
	return [
		`sidecar: ${await sidecarStatus()}`,
		`hooks: ${hooks}`,
		`permission rule: ${permission}`,
		`import receipts: ${await importSummary()}`,
	];
}
