#!/usr/bin/env node
// After npm run build: SNO_BINARY=/absolute/path/to/sno node tests/apps/reach/e2e-agent/reach25.mjs
// Optional case names (see journeys below) rerun only the named journeys.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { globalPrefixWith, realSno } from "../../support/real-sno.mjs";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const sno = realSno();
const evidence = await mkdtemp(join(tmpdir(), "reach25-"));
console.log("Evidence:", evidence);
const sourceClaude = join(process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME, ".claude"), ".credentials.json");
const sourceCodex = join(process.env.CODEX_HOME ?? join(process.env.HOME, ".codex"), "auth.json");
const host = hostname();
const developer = `developer.human@${host}`;
const recorder = join(repo, "tests/apps/mem-codex/fixtures/capture-installed-hook.mjs");
const exec = promisify(execFile);
const agentTimeout = 105_000;

async function optional(operation, fallback) {
	try { return await operation(); }
	catch (error) { if (error.code !== "ENOENT") throw error; return fallback; }
}

async function read(path) { return optional(() => readFile(path, "utf8"), ""); }
function jsonLines(text) { return text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
function header(card, name) {
	return card.split(/\r?\n\r?\n/, 1)[0].split(/\r?\n/)
		.find(line => line.toLowerCase().startsWith(`${name.toLowerCase()}: `))?.slice(name.length + 2);
}
function body(card) {
	const separator = /\r?\n\r?\n/.exec(card);
	return separator ? card.slice(separator.index + separator[0].length).trimEnd() : "";
}
function quote(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }

async function until(label, check, milliseconds = agentTimeout) {
	const deadline = Date.now() + milliseconds;
	do {
		const value = await check();
		if (value) return value;
		await delay(150);
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${label}`);
}

async function fixture(name, harness, run) {
	const home = join(evidence, name);
	const cwd = join(home, "work");
	const bin = join(home, "bin");
	const tmp = join(home, "tmp");
	const config = join(home, ".config/sno");
	const profile = join(home, ".sno");
	const root = join(home, "reach");
	const claudeHome = join(home, ".claude");
	const codexHome = join(home, ".codex");
	const hooks = join(home, "hooks.jsonl");
	const notifications = join(home, "notifications.jsonl");
	const tmux = join(home, "tmux.sock");
	const credentials = harness === "claude" ? join(claudeHome, ".credentials.json") : join(codexHome, "auth.json");
	const env = {
		...Object.fromEntries(["LANG", "LC_ALL", "TZ", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "no_proxy"]
			.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
		HOME: home, PATH: `${bin}:${process.env.PATH}`, SHELL: "/bin/bash", TMPDIR: tmp,
		XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".local/state"),
		XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"),
		CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, DISABLE_AUTOUPDATER: "1",
		SNO_PROFILE_DIR: profile, SNO_REACH_ROOT: root, SNO_BINARY: sno,
		SNO_EXECUTABLE: sno, SNO_MEM_UPDATE_CAPTURE_FILE: hooks, NOTICE_OUTPUT: notifications,
	};
	await Promise.all([cwd, bin, tmp, config, profile, claudeHome, codexHome].map(path => mkdir(path, { recursive: true })));
	const originalTmp = process.env.TMPDIR;
	try {
		process.env.TMPDIR = tmp;
		env.npm_config_prefix = globalPrefixWith({
			"@snoai/memory": join(repo, "packages/memory"),
			"@snoai/mem-claude": join(repo, "apps/mem-claude"),
			"@snoai/mem-codex": join(repo, "apps/mem-codex"),
		});
	} finally {
		if (originalTmp === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = originalTmp;
	}
	const programs = {};
	for (const [key, entry] of [["reach", "bin/sno-reach"], ["heartbeat", "bin/heartbeat"]]) {
		const current = join(home, `.local/lib/sno-${key}/current`);
		await mkdir(dirname(current), { recursive: true });
		await symlink(join(repo, "apps", key), current);
		programs[key] = { version: "test", sha256: "", entry: join(current, entry), dependencies: [] };
	}
	const observationHook = join(bin, "record-hook.mjs");
	await copyFile(recorder, observationHook);
	await chmod(observationHook, 0o700);
	await Promise.all([
		symlink(sno, join(bin, "sno")),
		writeFile(join(config, "cli.json"), '{"auto":{"enabled":false}}\n'),
		writeFile(join(config, "assemble.json"), JSON.stringify({
			generation: "test", files: {}, directories: [], programs, skills_version: "", skill_destinations: {},
			contract_sha256: "", requirements_fixture_sha256: "", hooks: [], timer: false,
		})),
		writeFile(join(profile, "settings.json"), JSON.stringify({
			capture: { ambient: false }, rem: { tick: false },
			telemetry: { memoryUsage: { enabled: false }, observe: { enabled: false } },
		})),
		writeFile(join(bin, "notify-send"), `#!${process.execPath}
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.NOTICE_OUTPUT, JSON.stringify(process.argv.slice(2)) + "\\n");
`, { mode: 0o700 }),
	]);

	async function command(file, args, { extraEnv = {}, input, allowFailure = false, timeout = 20_000 } = {}) {
		let result;
		try {
			const child = exec(file, args, { cwd, env: { ...env, ...extraEnv }, timeout, maxBuffer: 8 * 1024 * 1024 });
			child.child.stdin.on("error", error => { if (error.code !== "EPIPE") child.child.emit("error", error); });
			child.child.stdin.end(input);
			result = { code: 0, ...await child };
		} catch (error) {
			result = { code: error.code ?? error.signal, stdout: error.stdout, stderr: error.stderr, error: error.message };
		}
		await appendFile(join(home, "commands.jsonl"), JSON.stringify({ file, args, input, ...result }) + "\n");
		if (!allowFailure) assert.equal(result.code, 0, result.stderr || result.error || result.stdout);
		return result;
	}
	const reach = (args, options) => command(sno, ["reach", ...args], options);
	async function mail(address) {
		const boxes = await Promise.all(["new", "cur"].map(async folder => {
			const dir = join(root, address, folder);
			return Promise.all((await optional(() => readdir(dir), [])).map(async name => {
				const path = join(dir, name);
				return { path, text: await read(path) };
			}));
		}));
		return boxes.flat();
	}
	async function events(session) {
		return jsonLines(await read(join(profile, "station/agents", `${harness}--${session}.jsonl`)));
	}

	const claudeSettings = join(claudeHome, "settings.json");
	try {
		await copyFile(harness === "claude" ? sourceClaude : sourceCodex, credentials);
		const cli = join(repo, `apps/mem-${harness}/dist/cli.js`);
		if (harness === "claude") {
			await writeFile(join(claudeHome, ".claude.json"), JSON.stringify({
				hasCompletedOnboarding: true, autoUpdates: false, projects: { [cwd]: { hasTrustDialogAccepted: true } },
			}));
			await writeFile(claudeSettings, JSON.stringify({
				// The due runner uses the ordinary user settings, without pickup's CLI permission flags.
				permissions: name.endsWith("-resume") ? { defaultMode: "dontAsk", allow: ["Bash"] } : {},
			}));
		} else {
			await writeFile(join(codexHome, "config.toml"), `model_provider = "ccproxy"
model_reasoning_effort = "low"
approval_policy = "never"
sandbox_mode = "workspace-write"
[features]
hooks = true
[model_providers.ccproxy]
name = "ccproxy"
base_url = "http://localhost:8070/codex/v1"
wire_api = "responses"
requires_openai_auth = false
`);
		}
		await command(process.execPath, [cli, "install", harness === "claude" ? "--config-dir" : "--codex-home",
			harness === "claude" ? claudeHome : codexHome], { extraEnv: { SNO_EXECUTABLE: observationHook } });
		await command(harness, ["--version"]);
		await run({ home, cwd, env, profile, root, hooks, notifications, tmux, claudeSettings, command, reach, mail, events });
	} finally {
		await command("tmux", ["-S", tmux, "kill-server"], { allowFailure: true });
		await rm(credentials, { force: true });
	}
}

function claudeArgs(settings, session, mode, prompt) {
	return ["-p", "--session-id", session, "--setting-sources", "", "--settings", settings, "--permission-mode", mode,
		"--tools", "Bash", "--verbose", "--output-format", "stream-json", "--", prompt];
}

async function startSeat(t, harness, prompt) {
	const sender = `sender.reach25@${host}`;
	const seat = `${harness}.reach25@${host}`;
	const session = randomUUID();
	await t.reach(["init", "--as", sender, "--name", "Reach test sender"]);
	await t.reach(["init", "--as", seat, "--name", harness]);
	// The sender has its own pane. Any reply ring goes there, never back to the agent under test.
	await t.command("tmux", ["-S", t.tmux, "-f", "/dev/null", "new-session", "-d", "-s", "sender", "cat"]);
	const pane = (await t.command("tmux", ["-S", t.tmux, "display-message", "-p", "-t", "sender", "#{pane_id}"])).stdout.trim();
	const tmuxEnv = { TMUX: `${t.tmux},0,0` };
	await t.reach(["register", "--as", sender, "--channel", "tmux", "--handle", pane], { extraEnv: tmuxEnv });
	const script = join(t.home, "start-seat");
	await writeFile(script, `#!/bin/bash
set -e
export SNO_REACH_ADDR=${quote(seat)} SNO_REACH_HARNESS=${harness === "claude" ? "claude-code" : "codex"}
cd ${quote(t.cwd)}
sno reach register --channel tmux --handle "$TMUX_PANE"
sno reach whoami > ${quote(join(t.home, "whoami"))}
timeout 20s bash -c 'until [[ -e "$1" ]]; do sleep 0.1; done' bash ${quote(join(t.home, "start"))}
set +e
timeout --kill-after=3s ${agentTimeout / 1000}s "$@" </dev/null > ${quote(join(t.home, "agent.stdout"))} 2> ${quote(join(t.home, "agent.stderr"))}
echo "$?" > ${quote(join(t.home, "agent.exit"))}
`, { mode: 0o700 });
	const args = harness === "claude"
		? [...claudeArgs(t.claudeSettings, session, "dontAsk", prompt).slice(0, -2), "--allowedTools", "Bash", "--", prompt]
		: ["exec", "--json", "--skip-git-repo-check", prompt];
	await t.command("tmux", ["-S", t.tmux, "new-window", "-d", "-n", "agent", "/bin/bash", "-c",
		`exec ${[script, harness, ...args].map(quote).join(" ")} >${quote(join(t.home, "seat.log"))} 2>&1`]);
	assert.equal((await until("the agent seat's whoami", () => read(join(t.home, "whoami")), 5_000)).trim(), seat);
	const start = () => writeFile(join(t.home, "start"), "");
	const exited = () => read(join(t.home, "agent.exit"));
	const output = () => read(join(t.home, "agent.stdout"));
	async function finish() {
		const status = await until("the real agent to exit", exited);
		const out = await output();
		assert.equal(status.trim(), "0", `agent exited ${status.trim()}\n${await read(join(t.home, "agent.stderr"))}\n${out}`);
		const rows = jsonLines(out);
		if (harness === "claude") {
			assert.equal(rows.findLast(row => row.type === "result")?.is_error, false, out);
			assert.ok(rows.some(row => row.session_id === session), out);
			return session;
		}
		assert.ok(rows.some(row => row.type === "turn.completed"), out);
		const thread = rows.find(row => row.type === "thread.started")?.thread_id;
		assert.ok(thread, out);
		return thread;
	}
	return { sender, seat, tmuxEnv, start, exited, output, finish };
}

async function sendTask(t, agent, token, body, probe = false) {
	const id = `<${token}@${host}>`;
	const card = type => `From: Sender <${agent.sender}>
To: Agent <${agent.seat}>
Subject: [${type.toUpperCase()}] Reach 2.5 task ${token}
Date: ${new Date().toUTCString()}
Message-ID: ${id}
X-Type: ${type}
X-Work: ${token}

${body}
`;
	const args = ["send", "--as", agent.sender, "--no-ring"];
	let result;
	if (probe) {
		result = await t.reach(args, { input: card("task"), allowFailure: true });
		if (result.code !== 0) {
			assert.equal(result.code, 65, result.stderr);
			assert.match(result.stderr, /unknown X-Type value: task/);
			console.log("OBSERVED literal task card:", result.stderr.trim());
		}
	}
	if (!result || result.code !== 0) result = await t.reach(args, { input: card("decision") });
	assert.ok(result.stdout.includes(`delivered to ${agent.seat}`), result.stdout);
	assert.equal((await t.mail(agent.seat)).filter(card => header(card.text, "Message-ID") === id).length, 1, "task reached seat");
	return id;
}

function replies(cards, id) {
	return cards.filter(card => header(card.text, "References")?.split(/\s+/).includes(id));
}

async function pickup(t, harness) {
	const token = `pickup-${randomUUID()}`;
	const started = join(t.cwd, "first-tool-started");
	const agent = await startSeat(t, harness,
		`Use one shell tool to run exactly: touch ${quote(started)} && sleep 10. Then reply FIRST_TURN_DONE. Continue if a Stop hook supplies additional work.`);
	await agent.start();
	await until("the initial shell command to start", async () => {
		assert.ok(!await agent.exited(), `agent exited before starting its first command\n${await agent.output()}`);
		return optional(async () => { await access(started); return true; }, false);
	}, 75_000);
	const id = await sendTask(t, agent, token, `In this isolated test, use the path from the Stop hook to read this card.
Run sno reach reply --as ${agent.seat} --card <that path> --state accepted with ${token} on stdin.
After success, run sno reach reply on the same card with --state completed and ${token} on stdin. Then end the turn.`, true);
	assert.ok(!await agent.exited(), "agent ended before task placement");
	const session = await agent.finish();
	const observations = await t.events(session);
	const hookRuns = jsonLines(await read(t.hooks));
	const stop = hookRuns.find(row => row.command === "stop");
	const block = stop && jsonLines(stop.output).find(row => row.decision === "block");
	const received = replies(await t.mail(agent.sender), id);
	const states = received.map(card => header(card.text, "X-State")).sort();
	const trace = jsonLines(await read(join(t.root, agent.seat, "tries.jsonl")));
	assert.ok(observations.some(row => row.event === "user-prompt-submit"), "real UserPromptSubmit record missing");
	const rings = jsonLines(await read(join(t.root, "reach-ring.jsonl")));
	assert.ok(!rings.some(row => row.msg_id === id), "task was rung instead of picked up");
	if (!received.length && !stop) {
		assert.ok(!observations.some(row => row.event === "stop"), "installed Stop observation missing its recorder output");
		assert.ok(!trace.some(row => row.msg_id === id), "pickup recorded with no Stop hook");
		return `OBSERVED ${harness} non-interactive run exited successfully without invoking its installed Stop hook`;
	}
	assert.ok(block?.reason.includes(`Reach 2.5 task ${token}`),
		`expected the real Stop block to identify the delivered card\n${stop?.output ?? ""}\n${stop?.error ?? ""}`);
	assert.ok(trace.some(row => row.msg_id === id && row.kind === "pickup"), "Reach did not record a pickup");
	if (!received.length && hookRuns.filter(row => row.command === "stop").length === 1 &&
		!observations.some(row => row.event === "pre-tool-use" && row.at > observations.find(row => row.event === "stop")?.at)) {
		return `OBSERVED ${harness} non-interactive run exited after one Stop block without any reply or subsequent tool use`;
	}
	assert.deepEqual(states, ["accepted", "completed"], `sender mailbox reply states for ${id}`);
	for (const card of received) {
		// mrep also quotes the original task, which already contains the token.
		const lines = body(card.text).replace(/=\r?\n/g, "").split(/\r?\n/);
		assert.ok(lines.some(line => !line.startsWith(">") && line.includes(token)), card.path);
	}
	return `PASS same ${harness} run replied accepted and completed to ${agent.sender}`;
}

async function noticeOutcome(t, card, expected) {
	const id = header(card.text, "Message-ID");
	const subject = header(card.text, "Subject");
	const digest = createHash("sha256").update(id).digest("hex");
	const path = join(t.root, developer, "shown", digest, "outcome");
	const outcome = (await until("desktop notice routing", () => read(path), 8_000)).trim();
	const calls = jsonLines(await read(t.notifications)).filter(args => args[1] === subject);
	if (expected === "approval" && outcome.startsWith("not-shown: ")) {
		assert.equal(calls.length, 0);
		return outcome;
	}
	assert.equal(outcome, "shown");
	assert.deepEqual(calls, [["--", subject, body(card.text)]]);
	return "shown once";
}

async function approval(t, timed) {
	const session = randomUUID();
	const result = await t.command("claude", claudeArgs(t.claudeSettings, session, "default",
		"Call Bash exactly once with: touch approval-proof.txt. If permission is denied, report it and stop."),
	{ extraEnv: timed ? { SNO_DUE_RUN: "1" } : {}, timeout: agentTimeout });
	const rows = await t.events(session);
	const permission = rows.filter(row => row.event === "permission-request" && row.input.tool_name === "Bash");
	assert.equal(await optional(async () => { await access(join(t.cwd, "approval-proof.txt")); return true; }, false),
		false, "unapproved Bash command ran");
	assert.equal(permission.length, 1, `Claude -p did not record exactly one Bash permission request\n${result.stdout}\n${result.stderr}`);
	if (timed) {
		// The notice is detached in the positive case, so let a stray send become observable.
		await delay(3_000);
		assert.deepEqual(await t.mail(developer), [], "timed run sent a developer card");
		assert.deepEqual(jsonLines(await read(t.notifications)), [], "timed run showed a desktop approval");
		return "PASS SNO_DUE_RUN suppressed a real permission request";
	}
	const delivered = await until("developer approval card", async () => {
		const found = await t.mail(developer);
		return found.length && found;
	}, 8_000);
	assert.equal(delivered.length, 1);
	assert.equal(header(delivered[0].text, "X-Type"), "approval");
	assert.equal(header(delivered[0].text, "X-Session"), session);
	const outcome = await noticeOutcome(t, delivered[0], "approval");
	return `PASS one approval card with session ${session}; desktop ${outcome}`;
}

async function developerNotice(t, harness) {
	const session = randomUUID();
	const prompt = "Reply with exactly TYPED_PROMPT_RECORDED. Do not call any tools.";
	const result = harness === "claude"
		? await t.command("claude", claudeArgs(t.claudeSettings, session, "dontAsk", prompt), { timeout: agentTimeout })
		: await t.command("codex", ["exec", "--json", "--skip-git-repo-check", prompt], { timeout: agentTimeout });
	const id = harness === "claude" ? session : jsonLines(result.stdout).find(row => row.type === "thread.started")?.thread_id;
	assert.ok(id, result.stdout);
	assert.ok((await t.events(id)).some(row => row.event === "user-prompt-submit" && row.input.prompt === prompt),
		"real UserPromptSubmit did not record the developer's prompt");
	const subject = `Reach test ${randomUUID()}`;
	const body = "A developer question from the isolated Reach test.";
	await t.reach(["notify", "--type", "question", "--subject", subject, "--body", body]);
	const cards = (await t.mail(developer)).filter(card => header(card.text, "Subject") === `[QUESTION] ${subject}`);
	assert.equal(cards.length, 1, "question must reach the local developer mailbox");
	assert.equal(header(cards[0].text, "X-Type"), "question");
	await noticeOutcome(t, cards[0], "question");
	return `PASS ${harness} user prompt routed one desktop question to ${developer}`;
}

function firstTool(rows, harness) {
	if (harness === "codex") {
		const start = rows.find(row => row.type === "item.started" && row.item.type === "command_execution")?.item;
		const end = start && rows.find(row => row.type === "item.completed" && row.item.id === start.id)?.item;
		return { command: start?.command, succeeded: end?.exit_code === 0, output: end?.aggregated_output };
	}
	const start = rows.filter(row => row.type === "assistant").flatMap(row => row.message.content)
		.find(part => part.type === "tool_use");
	const end = start && rows.filter(row => row.type === "user").flatMap(row => row.message.content)
		.find(part => part.type === "tool_result" && part.tool_use_id === start.id);
	return { command: start?.input.command, succeeded: Boolean(end && !end.is_error), output: end?.content };
}

async function resume(t, harness) {
	const token = `resume-${randomUUID()}`;
	const agent = await startSeat(t, harness,
		"Read your Reach inbox using sno reach inbox --as \"$SNO_REACH_ADDR\" and open the returned card. " +
		"Accept the single task with sno reach reply --state accepted, following the card. Leave it accepted and reply HELD. Do not complete it.");
	const id = await sendTask(t, agent, token, "Accept this task with sno reach reply --state accepted and a short body. Finish your current turn without completing it.");
	await agent.start();
	const session = await agent.finish();
	const received = replies(await t.mail(agent.sender), id);
	assert.deepEqual(received.map(card => header(card.text, "X-State")), ["accepted"], "sender must see acceptance before the conversation closes");
	assert.ok((await t.events(session)).some(event => event.pid && event.processStart && event.reachAddress === agent.seat),
		"real hook did not record the holder's process identity");
	const handoff = join(t.profile, "station/handoff");
	const progress = join(handoff, `${session}.md`);
	await mkdir(handoff, { recursive: true });
	// A progress record is a prerequisite to scheduling the existing conversation.
	if (!await read(progress)) {
		await writeFile(progress, `# Reach test progress

The Reach card is accepted and still open.

<!-- machine-record:start -->
checkout: ${t.cwd}
runtime: ${harness === "claude" ? "claude-code" : "codex"}
session-id: ${session}
<!-- machine-record:end -->
`);
	}
	await t.reach(["rewake"], { extraEnv: agent.tmuxEnv });
	assert.ok((await read(progress)).includes(`Message-ID ${id}`), `Reach re-wake did not schedule the closed holder in ${progress}`);
	await t.command(sno, ["heartbeat", "--due-tick"], { extraEnv: agent.tmuxEnv });
	const logDir = join(t.env.XDG_STATE_HOME, "heartbeat/log");
	const log = await until("the timekeeper to finish the resumed conversation", async () => {
		const record = await read(progress);
		return /^last: .* (?:DUE_RESULT |not started:|no result line|ended with error)/m.test(record) && record;
	});
	const runLog = (await readdir(logDir)).find(name => name.startsWith("due-"));
	assert.ok(runLog, "timekeeper did not record its agent command");
	const out = await read(join(logDir, runLog));
	assert.ok(out.includes(`operation: resume ${session}`), out);
	assert.ok(!out.includes("operation: fresh"), out);
	const rows = out.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
	const first = firstTool(rows, harness);
	assert.match(first.command ?? "", /sno reach state --work /, out);
	assert.ok(first.command.includes(token), first.command);
	assert.ok(first.succeeded, `First progress command failed:\n${first.command}\n${first.output ?? ""}`);
	assert.ok(first.output.includes(`message_id: ${id}\trecipient: ${agent.seat}\tstate: accepted`), first.output);
	assert.match(log, /DUE_RESULT done/, log);
	return `PASS timekeeper resumed ${session}; first tool read the held card's progress`;
}

const journeys = {
	"claude-pickup": ["claude", pickup],
	"codex-pickup": ["codex", pickup],
	"claude-approval": ["claude", t => approval(t, false)],
	"claude-timed-approval": ["claude", t => approval(t, true)],
	"claude-notice": ["claude", developerNotice],
	"codex-notice": ["codex", developerNotice],
	"claude-resume": ["claude", resume],
	"codex-resume": ["codex", resume],
};
const selected = process.argv.slice(2);
for (const name of selected) assert.ok(Object.hasOwn(journeys, name), `Unknown journey: ${name}`);
for (const [name, [harness, run]] of Object.entries(journeys)) {
	if (selected.length && !selected.includes(name)) continue;
	console.log("START", name);
	let result;
	try {
		await fixture(name, harness, async t => { result = await run(t, harness); });
	} catch (error) {
		result = `FAIL ${error.message}`;
		process.exitCode = 1;
	}
	await writeFile(join(evidence, name, "result.txt"), result + "\n");
	console.log(name, result.split("\n", 1)[0]);
}
console.log("SKIP cross-machine delivery, routing and forwarding (requires a second machine).");
console.log("Evidence:", evidence);
