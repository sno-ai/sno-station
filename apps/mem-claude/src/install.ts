import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
	CODING_SKIN_HOOKS,
	type CodingSkinHookName,
	codingSkinHookCommand,
	isCodingSkinHookCommand,
	shellQuote,
} from "@snoai/memory/coding-skin";
import { z } from "zod";
import { APP_NAME } from "./constants.js";
import { MESSAGES } from "./messages.js";

const hookSchema = z.looseObject({ type: z.string(), command: z.string().optional() });
const groupSchema = z.looseObject({ hooks: z.array(hookSchema) });
const settingsSchema = z.looseObject({
	hooks: z.record(z.string(), z.array(groupSchema)).optional(),
	permissions: z.looseObject({ allow: z.array(z.string()).optional() }).optional(),
	disableAllHooks: z.boolean().optional(),
});
type Settings = z.infer<typeof settingsSchema>;

export interface InstallOptions {
	configDir: string;
	programPath: string;
	dryRun?: boolean;
	writeOutput: (line: string) => void;
}

function isOwnedProgram(program: string): boolean {
	return basename(program) === APP_NAME || /\/mem-claude\/(?:dist|src)\/cli\.(?:js|ts)$/.test(program);
}

// A hook written by this installer, or by the earlier one that ran `<mem-claude program> <event>`
// (replaced in place so the event is never hooked twice).
export function isOwnedHookCommand(command: string, subcommand: string): boolean {
	if (isCodingSkinHookCommand(command, subcommand, "claude")) return true;
	const suffix = ` ${subcommand}`;
	const trimmed = command.trim();
	if (!trimmed.endsWith(suffix)) return false;
	const encoded = trimmed.slice(0, -suffix.length);
	const program = encoded.startsWith("'") && encoded.endsWith("'")
		? encoded.slice(1, -1).replaceAll("'\\''", "'") : encoded;
	if (encoded !== shellQuote(program) && !/^[\w./-]+$/.test(encoded)) return false;
	return isOwnedProgram(program);
}

export function isOwnedPermissionRule(rule: string): boolean {
	if (!rule.startsWith("Bash(") || !rule.endsWith(" *)")) return false;
	const body = rule.slice(5, -3);
	if (body.endsWith(" memory")) return basename(body.slice(0, -" memory".length)) === "sno";
	return isAbsolute(body) && isOwnedProgram(body);
}

export async function readSettings(configDir: string): Promise<Settings | undefined> {
	let text: string;
	try {
		text = await readFile(join(configDir, "settings.json"), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
		throw error;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (!settingsSchema.safeParse(parsed).success) return undefined;
		// Keep validated user objects intact, including their original key order.
		return parsed as Settings;
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

function updateSettings(settings: Settings, programPath: string): void {
	settings.hooks ??= {};
	for (const event of Object.keys(CODING_SKIN_HOOKS) as CodingSkinHookName[]) {
		const details = CODING_SKIN_HOOKS[event];
		const groups = settings.hooks[event] ?? [];
		let installed = false;
		const hook = {
			type: "command", command: codingSkinHookCommand(programPath, details.subcommand, "claude"),
			timeout: details.timeout,
		};
		for (const group of groups) {
			group.hooks = group.hooks.map(current => {
				if (!current.command || !isOwnedHookCommand(current.command, details.subcommand)) return current;
				installed = true;
				return hook;
			});
		}
		if (!installed) groups.push({ hooks: [hook] });
		settings.hooks[event] = groups;
	}
	settings.permissions ??= {};
	const allow = settings.permissions.allow ?? [];
	const rule = `Bash(${programPath} memory *)`;
	const index = allow.findIndex(isOwnedPermissionRule);
	if (index < 0) allow.push(rule);
	else allow[index] = rule;
	settings.permissions.allow = allow;
}

export async function installClaude(options: InstallOptions): Promise<void> {
	const settings = await readSettings(options.configDir);
	const writes = [{
		path: join(options.configDir, "skills", APP_NAME, "SKILL.md"),
		content: await readFile(new URL(`../skills/${APP_NAME}/SKILL.md`, import.meta.url), "utf8"),
	}];
	if (settings) {
		updateSettings(settings, options.programPath);
		writes.unshift({
			path: join(options.configDir, "settings.json"),
			content: `${JSON.stringify(settings, null, 2)}\n`,
		});
	} else {
		options.writeOutput(MESSAGES.settingsUnparsable);
	}
	for (const write of writes) {
		if (options.dryRun) options.writeOutput(`${MESSAGES.dryRunPrefix} ${write.path}`);
		else {
			await mkdir(dirname(write.path), { recursive: true, mode: 0o700 });
			await writeFile(write.path, write.content, { mode: 0o600 });
		}
	}
	if (!options.dryRun && settings) options.writeOutput(MESSAGES.installComplete);
}
