import { profile, quote, remote, success } from "./harness.mjs";

export function resumeCommand(configDir, cwd, sessionId, prompt, compactPercent) {
	const environment = compactPercent === undefined ? "" : `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=${compactPercent} `;
	return `cd ${quote(cwd)}\nprintf '%s' ${quote(prompt)} | env -u CLAUDECODE ${environment}CLAUDE_CONFIG_DIR=${quote(configDir)} SNO_PROFILE_DIR=${profile} claude -p --resume ${quote(sessionId)} --tools '' --permission-mode dontAsk --output-format json`;
}

export function resume(configDir, cwd, sessionId, prompt) {
	const result = JSON.parse(success(remote(resumeCommand(configDir, cwd, sessionId, prompt), 240_000), "resume Claude session"));
	if (result.is_error || typeof result.result !== "string") throw new Error(`resume failed: ${JSON.stringify(result)}`);
	return result;
}

export function compactCommand(configDir, cwd, sessionId, method) {
	if (method === "slash-command") return resumeCommand(configDir, cwd, sessionId, "/compact");
	if (method === "auto-compact-1-percent") {
		return resumeCommand(configDir, cwd, sessionId, "Reply only with COMPACT_PROBE_DONE.", 1);
	}
	throw new Error(`unmeasured compact method: ${method}`);
}
