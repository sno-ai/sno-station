import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ScopeCtx } from "@snoai/memory/client";
import { CODING_SKIN_MANUAL_SESSION_ID } from "@snoai/memory/coding-skin";

const execFileAsync = promisify(execFile);

/** A session under the system temporary directory is a throwaway run (a script's or test's agent call); it is never memory. */
export function isTemporaryDirectory(dir: string): boolean {
	const real = (path: string): string => {
		try { return realpathSync(path); } catch { return resolve(path); }
	};
	const target = real(dir);
	return [tmpdir(), "/tmp", "/var/tmp"].some((root) => {
		const base = real(root);
		return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
	});
}

/** The git root of `dir`, or null outside a git work tree. */
export async function gitRoot(dir: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { timeout: 2_000 });
		const root = stdout.trim();
		return root.length > 0 ? root : null;
	} catch {
		return null;
	}
}

/** Explicit commands run in the agent's shell: the git root when inside one, else the folder itself. */
export async function workspaceRoot(cwd: string): Promise<string> {
	return (await gitRoot(cwd)) ?? resolve(cwd);
}

export function hookScope(project: string, sessionId: string, boundary?: "reset"): ScopeCtx {
	return {
		principal: "client-replaced-by-sidecar-library",
		project,
		session: sessionId,
		host: { sessionId, workspace: project, ...(boundary ? { boundary, at: Date.now() } : {}) },
	};
}

export function manualScope(project: string): ScopeCtx {
	return {
		principal: "client-replaced-by-sidecar-library",
		project,
		session: CODING_SKIN_MANUAL_SESSION_ID,
		host: { sessionId: CODING_SKIN_MANUAL_SESSION_ID, workspace: project },
	};
}
