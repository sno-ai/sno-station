#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";

// A test-only PATH wrapper: forward the real process and record no prompt or credential text.
const executable = process.env.SNO_REAL_CLAUDE;
const observationFile = process.env.SNO_CLAUDE_OBSERVATION_FILE;
if (!executable || !observationFile) throw new Error("observer requires real Claude path and observation file");
const args = process.argv.slice(2);
const input = readFileSync(0);
const flag = name => {
	const index = args.indexOf(name);
	return index < 0 ? null : args[index + 1];
};
const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
const startedAt = Date.now();
const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
const stdout = [];
child.stdout.on("data", chunk => { stdout.push(chunk); process.stdout.write(chunk); });
child.stderr.pipe(process.stderr);
child.stdin.on("error", error => { if (error.code !== "EPIPE") throw error; });
child.stdin.end(input);
const killMarker = process.env.SNO_CLAUDE_KILL_MARKER;
let killTimer;
let killedAt = null;
if (killMarker && existsSync(killMarker) && args.includes("--no-session-persistence")) {
	unlinkSync(killMarker);
	killTimer = setTimeout(() => {
		if (child.kill("SIGTERM")) killedAt = Date.now();
	}, 2_000);
}
child.on("error", error => { throw error; });
child.on("close", (code, signal) => {
	if (killTimer) clearTimeout(killTimer);
	const text = Buffer.concat(stdout).toString("utf8");
	let output;
	try { output = JSON.parse(text); } catch { output = undefined; }
	appendFileSync(observationFile, `${JSON.stringify({
		started_at: startedAt, ended_at: Date.now(), wrapper_pid: process.pid, child_pid: child.pid,
		cwd: process.cwd(), git_root: git.status === 0 ? git.stdout.trim() : null,
		git_exit: git.status, git_ceiling: process.env.GIT_CEILING_DIRECTORIES ?? null,
		claude_code_unset: process.env.CLAUDECODE === undefined,
		worker_child: args.includes("--no-session-persistence"),
		setting_sources: flag("--setting-sources"), hooks_disabled: flag("--settings") === '{"disableAllHooks":true}',
		tools: flag("--tools"), permission_mode: flag("--permission-mode"),
		input_bytes: input.length, input_chars: input.toString("utf8").length,
		usage: output?.usage ?? null, is_error: output?.is_error ?? null,
		exit_code: code, signal, killed_at: killedAt,
	})}\n`, { mode: 0o600 });
	process.exitCode = code ?? 128;
});
