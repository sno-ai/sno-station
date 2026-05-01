import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { sha256Hex } from "./hash.js";
import { updateIdentity } from "./identity.js";
import type { PathEnv } from "./paths.js";

const projectIdCache = new Map<string, string>();

export function detectProjectId(cwd = process.cwd(), env: PathEnv = process.env): string {
	const resolvedCwd = resolve(cwd);
	const absCwd = normalizePath(resolvedCwd);
	const cached = projectIdCache.get(absCwd);
	if (cached !== undefined) {
		return cached;
	}

	const remote = readGitRemote(resolvedCwd);
	if (remote !== null) {
		const projectId = `p_${sha256Hex(normalizeGitRemote(remote)).slice(0, 16)}`;
		projectIdCache.set(absCwd, projectId);
		return projectId;
	}

	if (absCwd !== normalizePath(homedir()) && absCwd !== normalizePath(resolve("/"))) {
		const projectId = `p_${sha256Hex(absCwd).slice(0, 16)}`;
		projectIdCache.set(absCwd, projectId);
		return projectId;
	}

	return getOrCreateDefaultProjectId(env);
}

export function normalizeGitRemote(remote: string): string {
	let value = remote.trim().toLowerCase();
	value = value.replace(/\.git$/u, "");
	value = value.replace(/^git@([^:]+):/u, "$1/");
	value = value.replace(/^[a-z]+:\/\/([^@/]+@)?/u, "");
	value = value.replace(/^([^@/]+)@/u, "");
	value = value.replace(/\/+/gu, "/");
	return value;
}

function readGitRemote(cwd: string): string | null {
	const result = spawnSync("git", ["config", "--get", "remote.origin.url"], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (result.status !== 0) {
		return null;
	}
	const remote = result.stdout.trim();
	return remote.length === 0 ? null : remote;
}

function normalizePath(path: string): string {
	return path.replace(/\\/gu, "/").toLowerCase();
}

function getOrCreateDefaultProjectId(env: PathEnv): string {
	const generated = `p_default_${Math.floor(Date.now() / 1000)}`;
	const identity = updateIdentity((current) => {
		if (
			typeof current.default_project_id === "string" &&
			current.default_project_id.startsWith("p_default_")
		) {
			return current;
		}
		return {
			...current,
			default_project_id: generated,
		};
	}, env);
	if (typeof identity.default_project_id === "string") {
		return identity.default_project_id;
	}
	return generated;
}
