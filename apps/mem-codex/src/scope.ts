import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { ScopeCtx } from "@snoai/memory/client";
import { CODING_SKIN_MANUAL_SESSION_ID } from "@snoai/memory/coding-skin";

const execFileAsync = promisify(execFile);

/** One workspace is the git repository root when `cwd` is inside one, else `cwd` itself. */
export async function workspaceRoot(cwd: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			timeout: 2_000,
		});
		const root = stdout.trim();
		return root.length > 0 ? root : resolve(cwd);
	} catch {
		return resolve(cwd);
	}
}

export function hookScope(project: string, sessionId: string): ScopeCtx {
	return {
		principal: "client-replaced-by-sidecar-library",
		project,
		session: sessionId,
		host: { sessionId, workspace: project },
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
