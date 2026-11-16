import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { RecallOptions } from "../src/contract/inputs";

function logReadFailure(path: string, error: unknown): void {
	if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
	console.error(JSON.stringify({ operation: "read-loaded-file", target: path, error: String(error), impact: "file omitted; memory remains deliverable" }));
}

function readFile(path: string): Buffer | undefined {
	try { return readFileSync(path); }
	catch (error) { logReadFailure(path, error); return undefined; }
}

function ruleFiles(directory: string, extension: string): string[] {
	try {
		return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
			.flatMap(entry => {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) return ruleFiles(path, extension);
				return entry.name.endsWith(extension) ? [path] : [];
			});
	} catch (error) { logReadFailure(directory, error); return []; }
}

function frontmatter(text: string): string {
	return text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1] ?? "";
}

/** The loaded prefixes, in the agent's documented startup order. */
export function loadedFilesAtStart(
	agent: "claude-code" | "codex" | "cursor", cwd: string, projectRoot: string,
): NonNullable<RecallOptions["loadedFiles"]> {
	const home = homedir();
	const files = new Map<string, Buffer>();
	const add = (path: string, bytes?: Buffer): void => {
		const absolute = resolve(path);
		const content = bytes ?? readFile(absolute);
		if (content !== undefined && !files.has(absolute)) files.set(absolute, content);
	};
	const ancestors: string[] = [];
	for (let directory = resolve(cwd); ; directory = dirname(directory)) {
		ancestors.push(directory);
		if (directory === dirname(directory)) break;
	}
	if (agent === "codex") {
		let remaining = 32 * 1024;
		const directories = [process.env.CODEX_HOME || join(home, ".codex"),
			...ancestors.slice(0, ancestors.indexOf(resolve(projectRoot)) + 1).reverse()];
		for (const directory of directories) {
			const override = join(directory, "AGENTS.override.md");
			const path = existsSync(override) ? override : join(directory, "AGENTS.md");
			const bytes = readFile(path);
			if (bytes === undefined || remaining === 0 || files.has(resolve(path))) continue;
			add(path, bytes.subarray(0, remaining));
			remaining -= Math.min(bytes.length, remaining);
		}
	} else if (agent === "cursor") {
		for (const path of ruleFiles(join(projectRoot, ".cursor", "rules"), ".mdc")) {
			const bytes = readFile(path);
			if (bytes && /^\s*alwaysApply:\s*true\s*(?:#.*)?$/mu.test(frontmatter(bytes.toString("utf8")))) add(path, bytes);
		}
		add(join(projectRoot, "AGENTS.md"));
		add(join(projectRoot, "CLAUDE.md"));
	} else {
		const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
		const load = (path: string, depth = 0): void => {
			const absolute = resolve(path);
			const bytes = files.get(absolute) ?? readFile(absolute);
			if (bytes === undefined) return;
			add(absolute, bytes);
			if (depth >= 5) return;
			for (const match of bytes.toString("utf8").matchAll(/(?:^|\s)@([^\s`'"<>]+)/gu)) {
				const imported = match[1];
				if (!imported) continue;
				const target = imported.startsWith("~/") ? join(home, imported.slice(2)) : resolve(dirname(absolute), imported);
				load(target, depth + 1);
			}
		};
		load(join(claudeHome, "CLAUDE.md"));
		for (const directory of ancestors) {
			for (const name of ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"]) load(join(directory, name));
		}
		for (const directory of [join(projectRoot, ".claude", "rules"), join(claudeHome, "rules")]) {
			for (const path of ruleFiles(directory, ".md")) {
				const bytes = readFile(path);
				if (bytes && !/^\s*paths:/mu.test(frontmatter(bytes.toString("utf8")))) load(path);
			}
		}
		let outputStyle: string | undefined;
		for (const path of [join(projectRoot, ".claude", "settings.local.json"),
			join(projectRoot, ".claude", "settings.json"), join(home, ".claude", "settings.json")]) {
			const bytes = readFile(path);
			if (!bytes) continue;
			try {
				const settings: unknown = JSON.parse(bytes.toString("utf8"));
				if (typeof settings !== "object" || settings === null || !("outputStyle" in settings)) continue;
				outputStyle = typeof settings.outputStyle === "string" ? settings.outputStyle : undefined;
				break;
			} catch (error) { logReadFailure(path, error); }
		}
		if (outputStyle) {
			const directories = [...ancestors.slice(0, ancestors.indexOf(resolve(projectRoot)) + 1), home];
			styles: for (const directory of directories) {
				for (const path of ruleFiles(join(directory, ".claude", "output-styles"), ".md")) {
					const bytes = readFile(path);
					if (!bytes) continue;
					const name = frontmatter(bytes.toString("utf8")).match(/^name:\s*(.*?)\s*$/mu)?.[1]
						?.replace(/^(["'])(.*)\1$/u, "$2") ?? basename(path, ".md");
					if (name !== outputStyle) continue;
					add(path, bytes);
					break styles;
				}
			}
		}
		const memory = join(claudeHome, "projects", resolve(cwd).replaceAll("/", "-"), "memory", "MEMORY.md");
		const bytes = readFile(memory);
		if (bytes) {
			let end = 0;
			for (let line = 0; line < 200 && end < bytes.length; line++) {
				const newline = bytes.indexOf(10, end);
				end = newline < 0 ? bytes.length : newline + 1;
			}
			add(memory, bytes.subarray(0, Math.min(end, 25 * 1024)));
		}
	}
	return [...files].map(([path, bytes]) => ({ path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length }));
}
