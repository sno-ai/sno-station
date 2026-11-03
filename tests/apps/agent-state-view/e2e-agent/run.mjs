#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "@lydell/node-pty";

const mode = process.argv[2];
assert(["screen", "quota"].includes(mode), "expected screen or quota");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const home = await mkdtemp(join(tmpdir(), "sno-squad-screen-"));
const profile = join(home, "profile");
const entry = join(root, "packages/memory/dist/agent-state-view.js");
const hook = join(root, "apps/mem-claude/dist/cli.js");
const env = Object.fromEntries(Object.entries({ ...process.env, HOME: home,
	SNO_PROFILE_DIR: profile, SNO_REACH_ROOT: join(home, "reach"),
	XDG_CONFIG_HOME: join(home, ".config"), CODEX_HOME: join(home, ".codex"),
	CLAUDE_CONFIG_DIR: join(home, ".claude"), TERM: "xterm-256color",
}).filter(([, value]) => value !== undefined));
for (const key of ["SNO_CAPTURE_SCRIPTED", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) delete env[key];
let terminal;

function run(args, input) {
	const result = spawnSync(process.execPath, args, { env, cwd: root, input,
		encoding: "utf8", timeout: 10_000 });
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	return result.stdout;
}
function observe(session, event, input) {
	run([hook, event === "stop" ? "stop" : "agent-state-hook", ...(event === "stop" ? [] : [event])],
		JSON.stringify({ session_id: session, cwd: home, ...input }));
}
function snapshot() { return JSON.parse(run([entry, "--json"])); }

async function screen(exitKey, tracing = false) {
	let output = "";
	let exited;
	const listeners = new Set();
	const command = tracing ? ["strace", "-f", "-e", "trace=execve", "-o", join(home, "exec.trace"), process.execPath, entry]
		: [process.execPath, entry];
	terminal = spawn("bash", ["--noprofile", "--norc", "-c", `
before=$(stty -g)
"$@"
status=$?
after=$(stty -g)
printf '\n__TERMINAL_RESTORED__%s__%s__%s\n' "$before" "$after" "$status"
[ "$before" = "$after" ] || exit 91
exit "$status"
`, "squad-screen-check", ...command], { cwd: root, env, name: "xterm-256color", cols: 240, rows: 90 });
	const closed = new Promise(resolveExit => terminal.onExit(event => {
		exited = event; for (const listener of listeners) listener(); resolveExit(event);
	}));
	terminal.onData(data => { output += data; for (const listener of listeners) listener(); });
	const waitFor = (predicate, description, timeout = 15_000) => new Promise((resolveWait, reject) => {
		const finish = error => { clearTimeout(timer); listeners.delete(check); error ? reject(error) : resolveWait(); };
		const check = () => {
			if (predicate(output)) finish();
			else if (exited) finish(new Error(`terminal exited before ${description}: ${output}`));
		};
		const timer = setTimeout(() => finish(new Error(`timed out waiting for ${description}: ${output}`)), timeout);
		listeners.add(check); check();
	});
	await waitFor(text => text.includes("q/Escape exit"), "initial grouped display");
	assert(output.includes("Needs you") && output.includes("Working") && output.includes("Finished"));
	for (const label of ["Doing:", "Process:", "Resumable:", "Waiting for a human:", "Work:", "Quota"]) assert(output.includes(label));
	assert(output.includes("awaiting-human") && output.includes("finished-result"));
	if (mode === "screen" && exitKey === "q") {
		const start = output.length;
		terminal.write("j\r");
		await waitFor(text => text.slice(start).includes("Result from actual hook entry."), "opened finished result");
		const seen = snapshot();
		assert.equal(seen.agents.find(row => row.sessionId === "finished-result").humanSeen, true);
		assert.equal(seen.agents.find(row => row.sessionId === "awaiting-human").waitingForHuman, "yes");
	}
	let quota = [];
	if (tracing) {
		const beforeRefresh = output.length;
		terminal.write(" ");
		await waitFor(text => text.length > beforeRefresh && text.slice(beforeRefresh).includes("q/Escape exit"), "local redraw");
		assert(!(await readFile(join(home, "exec.trace"), "utf8")).includes('"subscription-quota-check", "--vendor"'));
		terminal.write("r");
		await waitFor(text => text.includes('"source":"subscription-quota-check"'), "explicit account observations", 65_000);
		quota = output.split(/\r?\n/).filter(line => line.startsWith('{"observation":')).map(line => JSON.parse(line));
		assert.equal(quota.length, 2);
		assert.deepEqual(quota.map(row => row.observation.vendor).sort(), ["claude", "codex"]);
		for (const row of quota) {
			assert.equal(row.source, "subscription-quota-check");
			assert.notEqual(row.observedAt, "unknown");
			assert.equal(typeof row.observation.state, "string");
		}
		const refreshed = output.length;
		terminal.write(" ");
		await waitFor(text => text.length > refreshed && text.slice(refreshed).includes("q/Escape exit"), "redraw retaining account readings");
	}
	terminal.write(exitKey);
	await waitFor(text => text.includes("__TERMINAL_RESTORED__"), "OS terminal flag restoration");
	const exit = await closed;
	assert.equal(exit.exitCode, 0);
	assert(output.includes("\x1b[?1049h") && output.includes("\x1b[?1049l"));
	const flags = output.match(/__TERMINAL_RESTORED__([^_]+)__([^_]+)__(\d+)/);
	assert(flags); assert.equal(flags[1], flags[2]); assert.equal(flags[3], "0");
	if (tracing) {
		const trace = await readFile(join(home, "exec.trace"), "utf8");
		const accountReads = trace.split("\n").filter(line => line.includes('"subscription-quota-check", "--vendor", "both", "--json", "--quiet"') && line.endsWith("= 0"));
		assert.equal(accountReads.length, 1, "only explicit refresh invokes the existing quota reader");
	}
	terminal = undefined;
	return quota.map(row => ({ vendor: row.observation.vendor, state: row.observation.state,
		verdict: row.observation.verdict, observedAt: row.observedAt, exitCode: row.exitCode }));
}

try {
	await mkdir(env.SNO_REACH_ROOT, { recursive: true });
	await mkdir(profile, { recursive: true });
	observe("awaiting-human", "permission-request", { tool_name: "Bash", tool_use_id: "permission-one" });
	observe("finished-result", "stop", { last_assistant_message: "Result from actual hook entry." });
	assert.equal(snapshot().agents.find(row => row.sessionId === "finished-result").humanSeen, false);
	assert.equal(snapshot().agents.find(row => row.sessionId === "finished-result").humanSeen, false);
	assert.equal(await readFile(join(profile, "station/sidecar.json")).then(() => true, () => false), false);
	let quota = [];
	if (mode === "quota") {
		const installed = JSON.parse(await readFile(join(process.env.HOME, ".config/sno/assemble.json"), "utf8"));
		assert(installed.programs?.["subscription-quota-check"]?.entry, "existing quota reader must be installed");
		await mkdir(join(home, ".config/sno"), { recursive: true });
		await writeFile(join(home, ".config/sno/assemble.json"), JSON.stringify(installed));
		quota = await screen("q", true);
	} else {
		await screen("q");
		await screen("\x1b");
	}
	console.log(JSON.stringify({ mode, result: "passed", entry: "packaged Station entry; sno dispatcher blocked",
		terminalRestored: true, isolatedProfile: true, quota }));
} finally {
	terminal?.kill();
	await rm(home, { recursive: true, force: true });
}
