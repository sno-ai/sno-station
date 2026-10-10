import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { ScopeCtx } from "@snoai/memory/client";
import { CODING_SKIN_MANUAL_SESSION_ID } from "@snoai/memory/coding-skin";

const execFileAsync = promisify(execFile);

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
