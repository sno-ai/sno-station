// QCG-13 (REQ-15, REQ-16, REQ-17): Reach appends usage-statistics rows through
// `sno observe append`, started in the background. The public `sno-reach` executable runs against
// a private tmux server and a temporary SNO_REACH_ROOT. A stand-in `sno` first on PATH
// validates nothing: it sleeps SNO_STANDIN_SLEEP seconds, appends its argv as one line to
// SNO_CAPTURE and exits with SNO_STANDIN_EXIT, so each case reads the exact command line Reach
// ran. The real `sno observe append` contract is proven by its own installed E2E test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

const REACH = resolve(import.meta.dirname, "../../../apps/reach/bin/sno-reach");
const work = mkdtempSync(join(tmpdir(), "reach-observe-"));
const server = `reach-observe-${process.pid}`;
const home = join(work, "home");
const root = join(work, "state");
const bin = join(work, "bin");
let tmuxEnv = "";
let failed = false;

const tmux = (...args) => {
	const result = spawnSync("tmux", ["-L", server, ...args], {
		encoding: "utf8", timeout: 10_000,
	});
	assert.equal(result.status, 0, `tmux ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
};

before(() => {
	mkdirSync(home, { recursive: true });
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		join(bin, "sno"),
		'#!/usr/bin/env bash\nsleep "${SNO_STANDIN_SLEEP:-0}"\nprintf \'%s\\n\' "$*" >> "$SNO_CAPTURE"\nexit "$SNO_STANDIN_EXIT"\n',
	);
	chmodSync(join(bin, "sno"), 0o755);
	// A fake `codex`: its process name stays `codex` and it idles reading the pane's input.
	writeFileSync(join(bin, "codex"), "#!/bin/bash\nwhile read -r _; do :; done\n");
	chmodSync(join(bin, "codex"), 0o755);
	// An agent that acknowledges every doorbell by printing ACK-<nonce>.
	writeFileSync(
		join(bin, "ack-agent"),
		"#!/usr/bin/env bash\nwhile IFS= read -r line; do\n" +
			"  n=$(sed -n 's/.*Seat: [^ ]* \\([0-9a-f]\\{8\\}\\) typed.*/\\1/p' <<<\"$line\")\n" +
			'  [[ -z "$n" ]] || echo "ACK-$n"\ndone\n',
	);
	chmodSync(join(bin, "ack-agent"), 0o755);
	tmux("-f", "/dev/null", "new-session", "-d", "-s", "proof", "-x", "160", "-y", "30",
		"bash --norc");
	tmuxEnv = tmux("display-message", "-p", "#{socket_path},#{pid},0");
});

after(() => {
	spawnSync("tmux", ["-L", server, "kill-server"]);
	if (failed) console.log(`test evidence: ${work}`);
	else rmSync(work, { recursive: true, force: true });
});

// Run the public executable with an explicit harness marker: CLAUDECODE is set in this very
// process when the suite runs inside Claude Code, so it is never inherited.
function reach(args, { claudeCode = false, snoExit = 0, snoSleep = 0, capture, as }) {
	const env = { ...process.env };
	for (const key of ["CLAUDECODE", "SNO_REACH_ADDR", "SNO_TPM_REGISTRY", "TPM_REGISTRY",
		"MAILBOX_TERMINAL_REGISTRY", "TMUX_PANE"]) delete env[key];
	Object.assign(env, {
		PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
		XDG_STATE_HOME: join(home, ".local/state"), SNO_REACH_ROOT: root, TMUX: tmuxEnv,
		SNO_CAPTURE: capture, SNO_STANDIN_EXIT: String(snoExit), SNO_STANDIN_SLEEP: String(snoSleep),
	});
	if (as) env.SNO_REACH_ADDR = as;
	if (claudeCode) env.CLAUDECODE = "1";
	const started = process.hrtime.bigint();
	const result = spawnSync(REACH, args, { env, encoding: "utf8", timeout: 60_000 });
	const wallMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
	return { code: result.status, wallMs, out: `${result.stdout}${result.stderr}` };
}

// The background `sno observe` writes after Reach returns; wait until `count` lines landed.
function waitFor(capture, count, ms = 10_000) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (existsSync(capture) &&
			readFileSync(capture, "utf8").split("\n").filter(Boolean).length >= count) return;
		spawnSync("sleep", ["0.1"]);
	}
}

// The `sno observe` lines captured in one file, as { line, event, fields }.
function captured(capture, count = 0) {
	if (count > 0) waitFor(capture, count);
	if (!existsSync(capture)) return [];
	return readFileSync(capture, "utf8").split("\n").filter(Boolean).map(line => {
		const [group, sub, event, ...args] = line.split(" ");
		assert.equal(`${group} ${sub}`, "observe append", `unexpected sno call: ${line}`);
		const fields = Object.fromEntries(args.map(arg => {
			const match = /^--([a-z_]+)=(.*)$/.exec(arg);
			assert.ok(match, `argument is not --field=value: ${arg} in ${line}`);
			return [match[1], match[2]];
		}));
		return { line, event, fields };
	});
}

// A fresh pane registered as a seat; returns its address and the register result.
function seat(name, options) {
	const pane = tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "proof", "bash --norc");
	const address = `${name}.observe@${hostname()}`;
	const init = reach(["init", "--as", address, "--name", name], options);
	assert.equal(init.code, 0, `init ${address}: ${init.out}`);
	const register = reach(
		["register", "--as", address, "--channel", "tmux", "--handle", pane], options);
	return { address, register };
}

const okCall = address => ["call", address, "printf 'PING-%s\\n' OK",
	"--expect", "^PING-OK$", "--timeout", "5", "--every", "1"];
const lateCall = address => ["call", address, "true # no reply",
	"--expect", "^NEVER-PRINTED$", "--timeout", "1", "--every", "1"];

function messageRow(capture, result, outcome, from, to, minimumMs) {
	const rows = captured(capture, 1);
	const messages = rows.filter(row => row.event === "reach.message");
	assert.equal(messages.length, 1,
		`one reach.message row, captured: ${JSON.stringify(rows.map(row => row.line))}`);
	const { latency_ms: latency, ...rest } = messages[0].fields;
	assert.deepEqual(rest, { agent: from, kind: "call", from_harness: from, to_harness: to, outcome },
		messages[0].line);
	assert.match(latency, /^[0-9]+$/, messages[0].line);
	assert.ok(Number(latency) >= minimumMs && Number(latency) <= result.wallMs,
		`latency_ms ${latency} within [${minimumMs}, measured wall ${result.wallMs}]`);
}

test("outside Claude Code a seat registers as codex and each call appends one reach.message", t => {
	t.after(() => { failed ||= !t.passed; });
	const capture = join(work, "codex.log");
	const { address, register } = seat("codexseat", { capture });
	assert.equal(register.code, 0, register.out);
	assert.deepEqual(captured(capture, 1).map(row => [row.event, row.fields]),
		[["reach.register", { agent: "codex", harness: "codex", action: "register" }]],
		"register appends exactly one row");

	const okCapture = join(work, "codex-ok.log");
	const ok = reach(okCall(address), { capture: okCapture });
	assert.equal(ok.code, 0, ok.out);
	messageRow(okCapture, ok, "ok", "codex", "codex", 0);

	const lateCapture = join(work, "codex-late.log");
	const late = reach(lateCall(address), { capture: lateCapture });
	assert.equal(late.code, 4, late.out);
	messageRow(lateCapture, late, "timeout", "codex", "codex", 1000);
});

test("under CLAUDECODE a seat registers as claude-code; a codex caller's row names both", t => {
	t.after(() => { failed ||= !t.passed; });
	const capture = join(work, "claude.log");
	const { address, register } = seat("claudeseat", { claudeCode: true, capture });
	assert.equal(register.code, 0, register.out);
	assert.deepEqual(captured(capture, 1).map(row => [row.event, row.fields]),
		[["reach.register", { agent: "claude-code", harness: "claude-code", action: "register" }]],
		"register appends exactly one row");

	const callCapture = join(work, "claude-call.log");
	const call = reach(okCall(address), { capture: callCapture });
	assert.equal(call.code, 0, call.out);
	messageRow(callCapture, call, "ok", "codex", "claude-code", 0);
});

test("a sno observe that exits 2 leaves exit codes unchanged and only logs a line", t => {
	t.after(() => { failed ||= !t.passed; });
	const capture = join(work, "failing.log");
	const failing = { snoExit: 2, capture };
	const { address, register } = seat("failseat", failing);
	assert.equal(register.code, 0, `register keeps exit 0: ${register.out}`);
	const ok = reach(okCall(address), failing);
	assert.equal(ok.code, 0, `call keeps exit 0: ${ok.out}`);
	const late = reach(lateCall(address), failing);
	assert.equal(late.code, 4, `a timed-out call keeps exit 4: ${late.out}`);
	// The failing stand-in really ran for all three, so the exit codes above were exercised.
	assert.deepEqual(captured(capture, 3).map(row => row.event),
		["reach.register", "reach.message", "reach.message"]);
	spawnSync("sleep", ["0.5"]);
	const log = readFileSync(join(root, "reach.log"), "utf8");
	assert.equal(log.split("\n").filter(line => line.includes("sno observe")).length, 3,
		`reach.log has one sno observe line per failed append:\n${log}`);
	assert.equal(captured(capture).some(row => row.event === "error"), false,
		"Reach sends no error event of its own");
});

test("spawn from a Claude Code shell records the spawned program's harness, also on refresh", t => {
	t.after(() => { failed ||= !t.passed; });
	const capture = join(work, "spawn.log");
	const address = `s1.observe@${hostname()}`;
	const init = reach(["init", "--as", address, "--name", "s1"], { claudeCode: true, capture });
	assert.equal(init.code, 0, init.out);
	const spawned = reach(["spawn", "codex", "--as", address, "--window", "--cwd", work],
		{ claudeCode: true, capture });
	assert.equal(spawned.code, 0, spawned.out);
	const record = JSON.parse(readFileSync(join(root, address, "reachable.json"), "utf8"));
	assert.equal(record.harness, "codex");
	const registers = () => captured(capture).filter(row => row.event === "reach.register");
	waitFor(capture, 1);
	assert.deepEqual(registers().map(row => row.fields.harness), ["codex"]);
	const refresh = reach(["register", "--as", address, "--channel", "tmux", "--handle", record.identity.value],
		{ claudeCode: true, capture });
	assert.equal(refresh.code, 0, refresh.out);
	waitFor(capture, captured(capture).length + 1);
	const after = JSON.parse(readFileSync(join(root, address, "reachable.json"), "utf8"));
	assert.equal(after.harness, "codex");
	assert.deepEqual(registers().map(row => row.fields.harness), ["codex", "codex"]);
	assert.ok(registers().every(row => row.fields.agent === "codex"));
});

test("an unacknowledged ring records unacked and an acknowledged ring records ok", t => {
	t.after(() => { failed ||= !t.passed; });
	const setup = join(work, "ring-setup.log");
	// An executor seat is never asked to acknowledge, so its ring is delivered but unconfirmed.
	const silentPane = tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "proof", join(bin, "codex"));
	const silent = `executor.observe@${hostname()}`;
	assert.equal(reach(["init", "--as", silent, "--name", "executor"], { capture: setup }).code, 0);
	const register = reach(["register", "--as", silent, "--channel", "tmux", "--handle", silentPane],
		{ capture: setup });
	assert.equal(register.code, 0, register.out);
	const unackedCapture = join(work, "ring-unacked.log");
	const unacked = reach(["ring", silent], { capture: unackedCapture });
	assert.equal(unacked.code, 0, unacked.out);
	const [silentRow] = captured(unackedCapture, 1).filter(row => row.event === "reach.message");
	assert.equal(silentRow.fields.kind, "ring");
	assert.equal(silentRow.fields.outcome, "unacked");

	const pane = tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "proof", join(bin, "ack-agent"));
	const acked = `acker.observe@${hostname()}`;
	assert.equal(reach(["init", "--as", acked, "--name", "acker"], { capture: setup }).code, 0);
	assert.equal(reach(["register", "--as", acked, "--channel", "tmux", "--handle", pane], { capture: setup }).code, 0);
	const okCapture = join(work, "ring-ok.log");
	const ok = reach(["ring", acked], { capture: okCapture });
	assert.equal(ok.code, 0, ok.out);
	const [okRow] = captured(okCapture, 1).filter(row => row.event === "reach.message");
	assert.equal(okRow.fields.outcome, "ok", okRow.line);
});

test("a slow sno observe never delays a Reach call", t => {
	t.after(() => { failed ||= !t.passed; });
	const setup = join(work, "slow-setup.log");
	const { address, register } = seat("slowseat", { capture: setup });
	assert.equal(register.code, 0, register.out);
	const capture = join(work, "slow.log");
	const sent = reach(okCall(address), { capture, snoSleep: 5 });
	assert.equal(sent.code, 0, sent.out);
	assert.ok(sent.wallMs < 5000, `send returned in ${sent.wallMs} ms`);
	assert.ok(captured(capture, 1).some(row => row.event === "reach.message"),
		"the background sno observe still ran");
});
