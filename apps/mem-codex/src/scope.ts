import { execFile } from "node:child_process";
import { closeSync, openSync, readSync, realpathSync } from "node:fs";
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

/** Codex writes the session's origin on the transcript's first line; a `codex exec` run is a script, never memory. */
export function isScriptedSession(transcriptPath: string): boolean {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(transcriptPath, "r");
		const head = Buffer.alloc(65_536);
		const length = readSync(descriptor, head, 0, head.length, 0);
		return head.subarray(0, length).toString("utf8").split("\n")[0]?.includes('"source":"exec"') ?? false;
	} catch {
		return false;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

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
