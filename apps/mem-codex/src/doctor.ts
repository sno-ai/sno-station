import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
	CODING_SKIN_HOOKS,
	type CodingSkinHookName,
} from "@snoai/memory/coding-skin";
import { z } from "zod";
import { computeTrustHash, isOwnedHookCommand } from "./install.js";
import { importDirectory, sidecarDiscoveryPath } from "./paths.js";

const discoverySchema = z.object({ pid: z.number().int().positive(), port: z.number().int().positive(), token: z.string() });

export async function sidecarStatus(): Promise<"healthy" | "unhealthy" | "unavailable"> {
	try {
		const discovery = discoverySchema.parse(JSON.parse(await readFile(sidecarDiscoveryPath(), "utf8")));
		const response = await fetch(`http://127.0.0.1:${discovery.port}/healthz`, { signal: AbortSignal.timeout(5_000) });
		const body: unknown = await response.json();
		return response.ok && body && typeof body === "object" && "status" in body && body.status === "ok"
			? "healthy"
			: "unhealthy";
	} catch {
		return "unavailable";
	}
}

function trustState(config: string, hooksPath: string, event: CodingSkinHookName, groupIndex: number, command: string): string {
	const details = CODING_SKIN_HOOKS[event];
	const key = `${hooksPath}:${details.eventName}:${groupIndex}:0`;
	const section = `[hooks.state.${JSON.stringify(key)}]`;
	const expected = computeTrustHash({
		event_name: details.eventName,
		hooks: [{ type: "command", command, timeout: details.timeout, async: false }],
	});
	const start = config.indexOf(section);
	if (start < 0) return "no-trust-entry";
	const end = config.indexOf("\n[", start + section.length);
	const block = config.slice(start, end < 0 ? undefined : end);
	return block.includes(`trusted_hash = ${JSON.stringify(expected)}`) ? "trusted-current" : "stale-hash";
}

async function trustSummary(codexHome: string): Promise<string> {
	try {
		const hooksPath = join(codexHome, "hooks.json");
		const hooks = JSON.parse(await readFile(hooksPath, "utf8")) as {
			hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
		};
		const config = await readFile(join(codexHome, "config.toml"), "utf8").catch(() => "");
		return (Object.keys(CODING_SKIN_HOOKS) as CodingSkinHookName[]).map(event => {
			const groups = hooks.hooks?.[event] ?? [];
			const index = groups.findIndex(group => group.hooks?.some(hook =>
				hook.command ? isOwnedHookCommand(hook.command, CODING_SKIN_HOOKS[event].subcommand) : false) ?? false);
			const command = index >= 0 ? groups[index]?.hooks?.[0]?.command : undefined;
			const state = command ? trustState(config, hooksPath, event, index, command) : "no-trust-entry";
			return `${event}=${state}`;
		}).join(" ");
	} catch {
		return (Object.keys(CODING_SKIN_HOOKS) as CodingSkinHookName[]).map(event => `${event}=no-trust-entry`).join(" ");
	}
}

export async function doctor(codexHome: string): Promise<string[]> {
	const rulesPath = join(codexHome, "rules", "sno-mem-codex.rules");
	const rules = await access(rulesPath).then(() => "present", () => "absent");
	const imports = await readdir(importDirectory()).then(entries => String(entries.length), () => "0");
	return [
		`sidecar: ${await sidecarStatus()}`,
		`hook trust: ${await trustSummary(codexHome)}`,
		`rules: ${rules}`,
		`import receipts: ${imports}`,
	];
}
