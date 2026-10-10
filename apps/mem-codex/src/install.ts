import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
	CODING_SKIN_HOOKS,
	CODING_SKIN_MODEL_COMMANDS,
	type CodingSkinHookName,
	codingSkinHookCommand,
	isCodingSkinHookCommand,
	snoProgramPath,
} from "@snoai/memory/coding-skin";
import { APP_NAME } from "./constants.js";
import { MESSAGES } from "./messages.js";

interface HookCommand {
	type: "command";
	command: string;
	timeout: number;
}

interface HookGroup {
	matcher?: string;
	hooks: HookCommand[];
}

interface HooksFile {
	hooks: Partial<Record<CodingSkinHookName, HookGroup[]>> & Record<string, HookGroup[] | undefined>;
}

export interface InstallOptions {
	codexHome: string;
	programPath: string;
	dryRun?: boolean;
	writeOutput: (line: string) => void;
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export function computeTrustHash(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

// A hook written by this installer, or by the earlier one that ran `<mem-codex program> <event>`
// (replaced in place so the event is never hooked twice).
export function isOwnedHookCommand(command: string, subcommand: string): boolean {
	if (isCodingSkinHookCommand(command, subcommand, "codex")) return true;
	const suffix = ` ${subcommand}`;
	const trimmed = command.trim();
	if (!trimmed.endsWith(suffix)) return false;
	const encodedProgram = trimmed.slice(0, -suffix.length);
	const program = encodedProgram.startsWith("'") && encodedProgram.endsWith("'")
		? encodedProgram.slice(1, -1).replaceAll("'\\''", "'")
		: encodedProgram;
	return program === APP_NAME || program.endsWith(`/${APP_NAME}`) || program.includes("/mem-codex/");
}

function hasStringCommands(value: unknown): boolean {
	if (!value || typeof value !== "object" || !("hooks" in value) || !Array.isArray(value.hooks)) return false;
	return value.hooks.every(hook =>
		hook && typeof hook === "object" && "command" in hook && typeof hook.command === "string");
}

function parseHooks(value: unknown): HooksFile | undefined {
	if (!value || typeof value !== "object" || !("hooks" in value)) return undefined;
	const hooks = value.hooks;
	if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return undefined;
	for (const event of Object.keys(CODING_SKIN_HOOKS) as CodingSkinHookName[]) {
		const groups = (hooks as Record<string, unknown>)[event];
		if (groups === undefined) continue;
		if (!Array.isArray(groups) || !groups.every(hasStringCommands)) return undefined;
	}
	return value as HooksFile;
}

async function readHooks(path: string): Promise<HooksFile> {
	try {
		const parsed = parseHooks(JSON.parse(await readFile(path, "utf8")));
		if (!parsed) throw new SyntaxError(`Invalid hooks configuration: ${path}`);
		return parsed;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return { hooks: {} };
		throw error;
	}
}

function trustKey(path: string, event: CodingSkinHookName, groupIndex: number, hookIndex: number): string {
	const details = CODING_SKIN_HOOKS[event];
	return `${path}:${details.eventName}:${groupIndex}:${hookIndex}`;
}

function trustSection(path: string, event: CodingSkinHookName, groupIndex: number, hookIndex: number, hook: HookCommand): string {
	const details = CODING_SKIN_HOOKS[event];
	const key = trustKey(path, event, groupIndex, hookIndex);
	const hash = computeTrustHash({
		event_name: details.eventName,
		hooks: [{ ...hook, async: false }],
	});
	return `[hooks.state.${JSON.stringify(key)}]\nenabled = true\ntrusted_hash = ${JSON.stringify(hash)}\n`;
}

function stripTrustSections(text: string, keys: string[]): string {
	let stripped = text;
	for (const key of keys) {
		const header = `[hooks.state.${JSON.stringify(key)}]`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = new RegExp(`(?:^|\\n)${header}\\n(?:[^\\[]*(?=\\n\\[|$))`, "g");
		stripped = stripped.replace(pattern, "\n");
	}
	return stripped.trimEnd();
}

// Codex caps a SessionEnd hook at 3 seconds and prints a clamping warning in every session that asks for more.
export function codexHookTimeout(event: CodingSkinHookName): number {
	return event === "SessionEnd" ? Math.min(CODING_SKIN_HOOKS[event].timeout, 3) : CODING_SKIN_HOOKS[event].timeout;
}

function rules(programPath: string): string {
	return CODING_SKIN_MODEL_COMMANDS.map(command =>
		`prefix_rule(pattern=[${JSON.stringify(programPath)}, "memory", ${JSON.stringify(command)}], decision="allow")`)
		.join("\n") + "\n";
}

async function skillText(): Promise<string> {
	return readFile(new URL("../skills/sno-mem-codex/SKILL.md", import.meta.url), "utf8");
}

export async function installCodex(options: InstallOptions): Promise<void> {
	if (!isAbsolute(options.codexHome) || !isAbsolute(options.programPath)) {
		throw new Error("codex home and program path must be absolute");
	}
	const hooksPath = join(options.codexHome, "hooks.json");
	const configPath = join(options.codexHome, "config.toml");
	const rulesPath = join(options.codexHome, "rules", "sno-mem-codex.rules");
	const skillPath = join(options.codexHome, "skills", "sno-mem-codex", "SKILL.md");
	const programPath = snoProgramPath(options.programPath);
	const hooks = await readHooks(hooksPath);
	const trust: string[] = [];
	const ownedTrustKeys: string[] = [];
	for (const event of Object.keys(CODING_SKIN_HOOKS) as CodingSkinHookName[]) {
		const details = CODING_SKIN_HOOKS[event];
		const currentGroups = hooks.hooks[event] ?? [];
		const hook: HookCommand = {
			type: "command",
			command: codingSkinHookCommand(programPath, details.subcommand, "codex"),
			timeout: codexHookTimeout(event),
		};
		let installed = false;
		for (const [groupIndex, group] of currentGroups.entries()) {
			const lastForeign = group.hooks.findLastIndex(current => !isOwnedHookCommand(current.command, details.subcommand));
			group.hooks = group.hooks.flatMap((current, hookIndex) => {
				if (!isOwnedHookCommand(current.command, details.subcommand)) return [current];
				ownedTrustKeys.push(trustKey(hooksPath, event, groupIndex, hookIndex));
				// A second copy is dropped unless a foreign hook follows it; an emptied group stays, so every
				// foreign hook keeps the position Codex trusts.
				if (installed && hookIndex > lastForeign) return [];
				installed = true;
				trust.push(trustSection(hooksPath, event, groupIndex, hookIndex, hook));
				return [hook];
			});
		}
		if (!installed) {
			ownedTrustKeys.push(trustKey(hooksPath, event, currentGroups.length, 0));
			trust.push(trustSection(hooksPath, event, currentGroups.length, 0, hook));
			currentGroups.push({ hooks: [hook] });
		}
		hooks.hooks[event] = currentGroups;
	}
	const currentConfig = await readFile(configPath, "utf8").catch(error => {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
		throw error;
	});
	const preservedConfig = stripTrustSections(currentConfig, ownedTrustKeys);
	const writes = [
		{ path: hooksPath, content: `${JSON.stringify(hooks, null, 2)}\n` },
		{ path: configPath, content: `${preservedConfig}${preservedConfig ? "\n\n" : ""}${trust.join("\n")}` },
		{ path: rulesPath, content: rules(programPath) },
		{ path: skillPath, content: await skillText() },
	];
	for (const write of writes) {
		if (options.dryRun) {
			options.writeOutput(`${MESSAGES.dryRunPrefix} ${write.path}`);
			continue;
		}
		await mkdir(dirname(write.path), { recursive: true, mode: 0o700 });
		await writeFile(write.path, write.content, { mode: 0o600 });
	}
	if (!options.dryRun) options.writeOutput(MESSAGES.installComplete);
}
