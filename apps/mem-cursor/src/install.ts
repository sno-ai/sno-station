import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
	CODING_SKIN_CURSOR_HOOKS,
	type CodingSkinCursorHookName,
	codingSkinHookCommand,
	isCodingSkinHookCommand,
} from "@snoai/memory/coding-skin";
import { z } from "zod";
import { APP_NAME } from "./constants.js";

// Cursor's hooks.json: {"version":1,"hooks":{"<event>":[{"command","timeout",…}]}}. Other writers (Orca, Reach,
// rem-reflect) own their own entries there; this installer touches only the entries whose command it writes.
const entrySchema = z.looseObject({ command: z.string().optional() });
const hooksFileSchema = z.looseObject({ version: z.number().optional(), hooks: z.record(z.string(), z.array(entrySchema)).optional() });
type HooksFile = z.infer<typeof hooksFileSchema>;
const cliConfigSchema = z.looseObject({ permissions: z.looseObject({ allow: z.array(z.string()).optional() }).optional() });
type CliConfig = z.infer<typeof cliConfigSchema>;
const idePermissionsSchema = z.looseObject({ terminalAllowlist: z.array(z.string()).optional() });
type IdePermissions = z.infer<typeof idePermissionsSchema>;

export interface InstallOptions {
	cursorHome: string;
	programPath: string;
	dryRun?: boolean;
	writeOutput: (line: string) => void;
}

const EVENTS = Object.keys(CODING_SKIN_CURSOR_HOOKS) as CodingSkinCursorHookName[];

export function isOwnedEntry(event: CodingSkinCursorHookName, command: string | undefined): boolean {
	return command !== undefined && isCodingSkinHookCommand(command, CODING_SKIN_CURSOR_HOOKS[event].subcommand, "cursor");
}

/**
 * `Shell(<abs path to sno>)` and `Shell(sno)`: Cursor CLI asks before running `sno` without them (measured
 * 2026-10-09), and the model runs it by name as the skill says (measured 2026-10-10: "Not in allowlist: sno").
 */
export function isOwnedPermissionRule(rule: string): boolean {
	return rule === "Shell(sno)" || rule.startsWith("Shell(/") && rule.endsWith(")") && basename(rule.slice(6, -1)) === "sno";
}

export function isOwnedIdePermission(rule: string): boolean {
	return rule === "sno" || rule.startsWith("/") && basename(rule) === "sno";
}

/** Reads a JSON file: null when absent, undefined when it cannot be parsed (left untouched). */
async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | null | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
	try {
		return schema.parse(JSON.parse(text));
	} catch {
		return undefined;
	}
}

export async function readHooksFile(cursorHome: string): Promise<HooksFile | null | undefined> {
	return readJson(join(cursorHome, "hooks.json"), hooksFileSchema);
}

export async function readCliConfig(cursorHome: string): Promise<CliConfig | null | undefined> {
	return readJson(join(cursorHome, "cli-config.json"), cliConfigSchema);
}

export async function readIdePermissions(cursorHome: string): Promise<IdePermissions | null | undefined> {
	return readJson(join(cursorHome, "permissions.json"), idePermissionsSchema);
}

/** Replaces our entry of each event in place (one per event), appends it when missing, keeps every other entry. */
export function updateHooks(file: HooksFile, programPath: string | undefined): HooksFile {
	const hooks = file.hooks ?? {};
	for (const event of EVENTS) {
		const entry = programPath === undefined ? undefined : {
			command: codingSkinHookCommand(programPath, CODING_SKIN_CURSOR_HOOKS[event].subcommand, "cursor"),
			timeout: CODING_SKIN_CURSOR_HOOKS[event].timeout,
		};
		let placed = false;
		const entries = (hooks[event] ?? []).flatMap(current => {
			if (!isOwnedEntry(event, current.command)) return [current];
			if (placed || !entry) return [];
			placed = true;
			return [entry];
		});
		if (entry && !placed) entries.push(entry);
		if (entries.length > 0) hooks[event] = entries;
		else delete hooks[event];
	}
	return { ...file, version: file.version ?? 1, hooks };
}

export function updateCliConfig(config: CliConfig, programPath: string | undefined): CliConfig {
	const allow = (config.permissions?.allow ?? []).filter(rule => !isOwnedPermissionRule(rule));
	if (programPath !== undefined) allow.push(`Shell(${programPath})`, "Shell(sno)");
	return { ...config, permissions: { ...config.permissions, allow } };
}

function updateIdePermissions(config: IdePermissions, programPath: string | undefined): IdePermissions {
	const terminalAllowlist = (config.terminalAllowlist ?? []).filter(rule => !isOwnedIdePermission(rule));
	if (programPath !== undefined) terminalAllowlist.push(programPath, "sno");
	return { ...config, terminalAllowlist };
}

function skillPath(cursorHome: string): string {
	return join(cursorHome, "skills", APP_NAME, "SKILL.md");
}

/** Writes one config file through `update`; an unparsable file is reported and left as it is, an absent one is created only when installing. */
async function rewrite<T>(
	path: string,
	current: T | null | undefined,
	update: (value: T) => T,
	empty: T,
	installing: boolean,
	options: Pick<InstallOptions, "dryRun" | "writeOutput">,
): Promise<boolean> {
	if (current === undefined) {
		options.writeOutput(`${basename(path)} parse error; left unchanged: ${path}`);
		return false;
	}
	if (current === null && !installing) return true;
	if (options.dryRun) options.writeOutput(`would write ${path}`);
	else {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await writeFile(path, `${JSON.stringify(update(current ?? empty), null, 2)}\n`, { mode: 0o600 });
	}
	return true;
}

/** Writes (programPath set) or removes (undefined) our hook entries and allowlist rule. */
async function apply(cursorHome: string, programPath: string | undefined, options: Pick<InstallOptions, "dryRun" | "writeOutput">): Promise<boolean> {
	const hooks = await rewrite(join(cursorHome, "hooks.json"), await readHooksFile(cursorHome),
		value => updateHooks(value, programPath), {}, programPath !== undefined, options);
	const config = await rewrite(join(cursorHome, "cli-config.json"), await readCliConfig(cursorHome),
		value => updateCliConfig(value, programPath), {}, programPath !== undefined, options);
	const permissions = await rewrite(join(cursorHome, "permissions.json"), await readIdePermissions(cursorHome),
		value => updateIdePermissions(value, programPath), {}, programPath !== undefined, options);
	return hooks && config && permissions;
}

const INCOMPLETE = "Cursor configuration not fully updated: a file above could not be parsed and was left unchanged";

export async function installCursor(options: InstallOptions): Promise<void> {
	const complete = await apply(options.cursorHome, options.programPath, options);
	const skill = await readFile(new URL(`../skills/${APP_NAME}/SKILL.md`, import.meta.url), "utf8");
	if (options.dryRun) options.writeOutput(`would write ${skillPath(options.cursorHome)}`);
	else {
		await mkdir(dirname(skillPath(options.cursorHome)), { recursive: true, mode: 0o700 });
		await writeFile(skillPath(options.cursorHome), skill, { mode: 0o600 });
		if (complete) options.writeOutput("Sno memory for Cursor installed");
	}
	if (!complete) throw new Error(INCOMPLETE);
}

export async function uninstallCursor(options: Omit<InstallOptions, "programPath">): Promise<void> {
	if (!await apply(options.cursorHome, undefined, options)) throw new Error(INCOMPLETE);
	if (options.dryRun) options.writeOutput(`would remove ${dirname(skillPath(options.cursorHome))}`);
	else {
		await rm(dirname(skillPath(options.cursorHome)), { recursive: true, force: true });
		options.writeOutput("Sno memory for Cursor removed");
	}
}
