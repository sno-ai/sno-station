import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { sha256Hex } from "./hash.js";
import type { PathEnv } from "./paths.js";
import type { JsonObject } from "./types.js";

const claudeAccountSchema = z.object({
	oauthAccount: z.object({ accountUuid: z.string() }),
});
const codexAccountSchema = z.object({
	tokens: z.object({ account_id: z.string() }),
});

export function collectPersonHints(env: PathEnv = process.env): JsonObject[] {
	const home = env["HOME"] ?? homedir();
	const configHome = join(home, ".config");
	const claude = claudeAccountSchema.safeParse(readJson(join(home, ".claude.json")));
	const codex = codexAccountSchema.safeParse(readJson(join(home, ".codex", "auth.json")));
	const email = gitEmail(readText(join(home, ".gitconfig")))
		?? gitEmail(readText(join(configHome, "git", "config")));
	const github = githubLogin(readText(join(home, ".config", "gh", "hosts.yml")));
	const identifiers = [
		["claude_account", claude.success ? claude.data.oauthAccount.accountUuid : undefined],
		["codex_account", codex.success ? codex.data.tokens.account_id : undefined],
		["git_email", email],
		["github_login", github],
	] as const;
	const hints: JsonObject[] = [];
	for (const [kind, identifier] of identifiers) {
		const value = identifier?.trim().toLowerCase();
		if (value) {
			hints.push({ kind, hash: sha256Hex(value) });
		}
	}
	return hints;
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		// Missing or unreadable identity files contribute no hint.
		return undefined;
	}
}

function readJson(path: string): unknown {
	const text = readText(path);
	if (text === undefined) {
		return undefined;
	}
	try {
		return JSON.parse(text);
	} catch {
		// A malformed identity file contributes no hint.
		return undefined;
	}
}

function gitEmail(text: string | undefined): string | undefined {
	let userSection = false;
	for (const line of text?.split(/\r?\n/) ?? []) {
		const section = /^\s*\[([^\]]+)\](.*)$/.exec(line);
		if (section) {
			userSection = section[1]?.trim().toLowerCase() === "user";
		}
		const email = userSection && /^\s*email\s*=\s*("[^"]*"|[^#;]*)/i.exec(
			section ? (section[2] ?? "") : line,
		);
		if (email) {
			return email[1]?.trim().replace(/^"(.*)"$/, "$1") || undefined;
		}
	}
	return undefined;
}

function githubLogin(text: string | undefined): string | undefined {
	let githubSection = false;
	for (const line of text?.split(/\r?\n/) ?? []) {
		if (/^\S/.test(line) && !line.startsWith("#")) {
			githubSection = /^github\.com:\s*(?:#.*)?$/.test(line);
		}
		const user = githubSection && /^\s+user:\s*(.*?)\s*(?:#.*)?$/.exec(line);
		if (user) {
			return user[1]?.trim().replace(/^(["'])(.*)\1$/, "$2") || undefined;
		}
	}
	return undefined;
}
