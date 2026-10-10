import { readFile } from "node:fs/promises";
import { CODING_SKIN_CURSOR_HOOKS, type CodingSkinCursorHookName } from "@snoai/memory/coding-skin";
import { z } from "zod";
import { isOwnedEntry, isOwnedIdePermission, isOwnedPermissionRule, readCliConfig, readHooksFile, readIdePermissions } from "./install.js";
import { sidecarDiscoveryPath } from "./paths.js";

const discoverySchema = z.object({ pid: z.number().int().positive(), port: z.number().int().positive(), token: z.string() });

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

export async function doctor(cursorHome: string): Promise<string[]> {
	const hooks = await readHooksFile(cursorHome).catch(() => undefined);
	const events = (Object.keys(CODING_SKIN_CURSOR_HOOKS) as CodingSkinCursorHookName[]).map(event => {
		if (hooks === undefined) return `${event}=unparsable`;
		const present = hooks?.hooks?.[event]?.some(entry => isOwnedEntry(event, entry.command)) ?? false;
		return `${event}=${present ? "present" : "absent"}`;
	}).join(" ");
	const config = await readCliConfig(cursorHome).catch(() => undefined);
	const permission = config === undefined ? "unparsable"
		: config?.permissions?.allow?.some(isOwnedPermissionRule) ? "present" : "absent";
	const ideConfig = await readIdePermissions(cursorHome).catch(() => undefined);
	const idePermission = ideConfig === undefined ? "unparsable"
		: ideConfig?.terminalAllowlist?.some(isOwnedIdePermission) ? "present" : "absent";
	return [
		`sidecar: ${await sidecarStatus()}`,
		`hooks: ${events}`,
		`permission rule: ${permission}`,
		`IDE permission rule: ${idePermission}`,
	];
}
