#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "@lydell/node-pty";
import { realSno, globalPrefixWith } from "../../support/real-sno.mjs";
import { claudeFixture, cursorFixture, claudeUi } from "./native.mjs";

const mode = process.argv[2];
assert(["screen", "quota", "claude", "cursor", "claude-ui"].includes(mode), "expected screen, quota, claude, cursor or claude-ui");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const home = await mkdtemp(join(tmpdir(), "sno-squad-screen-"));
const profile = join(home, "profile");
const sno = realSno();
const prefix = globalPrefixWith({ "@snoai/memory": join(root, "packages/memory"),
	"@snoai/mem-claude": join(root, "apps/mem-claude"), "@snoai/mem-cursor": join(root, "apps/mem-cursor") });
const env = Object.fromEntries(Object.entries({ ...process.env, HOME: home,
	SNO_PROFILE_DIR: profile, SNO_REACH_ROOT: join(home, "reach"),
	XDG_CONFIG_HOME: join(home, ".config"), CODEX_HOME: join(home, ".codex"),
	CLAUDE_CONFIG_DIR: join(home, ".claude"), TERM: "xterm-256color",
	npm_config_prefix: prefix, PATH: `${dirname(sno)}:${process.env.PATH}`,
}).filter(([, value]) => value !== undefined));
for (const key of ["SNO_CAPTURE_SCRIPTED", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) delete env[key];
let terminal;
let fixture;

function run(args, input, extraEnv = {}, command = process.execPath) {
	const result = spawnSync(command, args, { env: { ...env, ...extraEnv }, cwd: home, input,
		encoding: "utf8", timeout: 10_000 });
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	return result.stdout;
}
function snapshot() { return JSON.parse(run(["--json", "squad"], undefined, {}, sno)); }

async function screen(exitKey, tracing = false) {
	let output = "";
	let exited;
	const listeners = new Set();
	const command = tracing ? ["strace", "-f", "-e", "trace=execve", "-o", join(home, "exec.trace"), sno, "squad"]
		: [sno, "squad"];
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
	assert(output.includes(fixture.sessions.question) && output.includes(fixture.sessions.finished));
	if (mode !== "quota" && exitKey === "q") {
		const start = output.length;
		terminal.write("j\r");
		await waitFor(text => text.slice(start).includes("Finished the isolated observation check."), "opened finished result");
		const seen = snapshot();
		assert.equal(seen.agents.find(row => row.sessionId === fixture.sessions.finished).humanSeen, true);
		assert.equal(seen.agents.find(row => row.sessionId === fixture.sessions.question).waitingForHuman, "yes");
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
	await mkdir(join(home, ".config/sno"), { recursive: true });
	await writeFile(join(home, ".config/sno/cli.json"), JSON.stringify({ auto: { enabled: false } }));
	if (mode !== "cursor") {
		fixture = await claudeFixture({ home, env, root, run, snapshot, sno });
		assert.equal(snapshot().agents.find(row => row.sessionId === fixture.sessions.finished).humanSeen, false);
		assert.equal(snapshot().agents.find(row => row.sessionId === fixture.sessions.finished).humanSeen, false);
	}
	assert.equal(await readFile(join(profile, "station/sidecar.json")).then(() => true, () => false), false);
	let quota = [];
	let cursor;
	let ui;
	if (mode === "claude-ui") {
		ui = await claudeUi({ home, env, snapshot, fixture });
	} else if (mode === "cursor") {
		cursor = await cursorFixture({ home, env, root, run, snapshot, sno });
	} else if (mode === "quota") {
		const installed = JSON.parse(await readFile(join(process.env.HOME, ".config/sno/assemble.json"), "utf8"));
		assert(installed.programs?.["subscription-quota-check"]?.entry, "existing quota reader must be installed");
		await mkdir(join(home, ".config/sno"), { recursive: true });
		await writeFile(join(home, ".config/sno/assemble.json"), JSON.stringify({ ...installed, memory_pieces: {}, programs: { "subscription-quota-check": installed.programs["subscription-quota-check"] } }));
		quota = await screen("q", true);
	} else {
		await screen("q");
		await screen("\x1b");
	}
	console.log(JSON.stringify({ mode, result: "passed", entry: `${sno} squad`, events: fixture?.events,
		answered: mode === "claude" ? await fixture.answer().then(() => true) : "not requested",
		terminalRestored: ["screen", "quota", "claude"].includes(mode), isolatedProfile: true, quota, cursor, ui }));
} finally {
	terminal?.kill();
	await rm(join(env.CLAUDE_CONFIG_DIR, ".credentials.json"), { force: true });
	await rm(join(home, ".config/cursor/auth.json"), { force: true });
	await rm(prefix, { recursive: true, force: true });
	console.log(JSON.stringify({ evidence: home }));
}
