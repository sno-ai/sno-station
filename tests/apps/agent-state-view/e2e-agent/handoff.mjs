#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realSno, globalPrefixWith } from "../../support/real-sno.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const sno = realSno();
const root = await mkdtemp(join(tmpdir(), "sno-squad-handoff-"));
const home = join(root, "home"), project = join(root, "project"), state = join(root, "reach");
const prefix = globalPrefixWith({ "@snoai/memory": join(repo, "packages/memory"), "@snoai/mem-claude": join(repo, "apps/mem-claude") });
const nonce = randomUUID().replaceAll("-", "").slice(0, 12);
const server = `squad-handoff-${nonce}`;
const source = `worker.source-${nonce}@${hostname()}`;
const target = `worker.target-${nonce}@${hostname()}`;
const owner = `lead.owner-${nonce}@${hostname()}`;
const original = `<original-${nonce}@${hostname()}>`, transfer = `<transfer-${nonce}@${hostname()}>`, work = `handoff-${nonce}`;
const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"),
	SNO_PROFILE_DIR: join(home, ".sno"), XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".local/state"),
	XDG_CACHE_HOME: join(home, ".cache"), SNO_REACH_ROOT: state, npm_config_prefix: prefix,
	PATH: `${dirname(sno)}:${process.env.PATH}`, TERM: "xterm-256color", DISABLE_AUTOUPDATER: "1" };
for (const key of ["CLAUDECODE", "CODEX_THREAD_ID", "SNO_REACH_ADDR", "SNO_EXECUTOR_ADDR", "TMUX", "TMUX_PANE", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SNO_CAPTURE_SCRIPTED"]) delete env[key];
const credentials = join(env.CLAUDE_CONFIG_DIR, ".credentials.json");
const started = Date.now();
const log = [];
function run(command, args, { input, limit = 20_000, extraEnv = {} } = {}) {
	const result = spawnSync(command, args, { env: { ...env, ...extraEnv }, cwd: project, input, encoding: "utf8", timeout: limit });
	log.push({ command, args, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
	assert.equal(result.status, 0, `${command} ${args[0]}: ${result.stderr || result.stdout || result.error?.message}`);
	return result.stdout;
}
const mux = (...args) => run("tmux", ["-L", server, ...args]);
const reach = (...args) => run(sno, ["reach", ...args]);
const call = (address, text, expect) => run(sno, ["reach", "call", address, text, "--expect", expect, "--timeout", "75", "--every", "1"], { limit: 85_000, extraEnv: { SNO_REACH_ADDR: owner } });
const snapshot = () => JSON.parse(run(sno, ["--json", "squad"]));
const progress = () => reach("state", "--work", work, "--json").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
async function waitUntil(check, label, seconds = 30) {
	const deadline = Date.now() + seconds * 1000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise(resolveWait => setTimeout(resolveWait, 250));
	}
	throw new Error(`timed out waiting for ${label}`);
}
async function agentStopped(address) {
	try {
		const files = await readdir(join(env.SNO_PROFILE_DIR, "station/agents"));
		for (const file of files) {
			const events = (await readFile(join(env.SNO_PROFILE_DIR, "station/agents", file), "utf8")).trim().split("\n").map(line => JSON.parse(line));
			if (events.some(event => event.reachAddress === address) && events.at(-1)?.event === "stop") return true;
		}
	} catch (error) { if (error.code !== "ENOENT") throw error; }
	return false;
}
function card(id, from, to, body) {
	return `From: Sender <${from}>\nTo: Receiver <${to}>\nReply-To: Owner <${owner}>\nDate: ${new Date().toUTCString()}\nSubject: [DECISION] Isolated work transfer\nMessage-ID: ${id}\nX-Type: decision\nX-Work: ${work}\n\n${body}\n`;
}
try {
	for (const path of [home, project, state, env.CLAUDE_CONFIG_DIR, join(home, ".config/sno")]) await mkdir(path, { recursive: true });
	await copyFile(join(process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME, ".claude"), ".credentials.json"), credentials);
	await chmod(credentials, 0o600);
	const version = run("claude", ["--version"]).trim();
	await writeFile(join(env.CLAUDE_CONFIG_DIR, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true,
		lastOnboardingVersion: version.split(" ")[0], bypassPermissionsModeAccepted: true, projects: { [project]: { hasTrustDialogAccepted: true } } }));
	await writeFile(join(home, ".config/sno/cli.json"), JSON.stringify({ auto: { enabled: false } }));
	await writeFile(join(home, ".config/sno/assemble.json"), JSON.stringify({ generation: "test", files: {}, directories: [],
		skills_version: "", skill_destinations: {}, contract_sha256: "", requirements_fixture_sha256: "", hooks: [], timer: false,
		memory_pieces: {}, programs: { reach: { version: "1.0", sha256: "", entry: join(repo, "apps/reach/bin/sno-reach"), dependencies: [] } } }));
	run(process.execPath, [join(repo, "apps/mem-claude/dist/cli.js"), "install", "--config-dir", env.CLAUDE_CONFIG_DIR], { extraEnv: { SNO_EXECUTABLE: sno } });
	mux("-f", "/dev/null", "new-session", "-d", "-x", "180", "-y", "55", "-s", "fixture", "cat");
	env.TMUX = mux("display-message", "-p", "#{socket_path},#{pid},0").trim();
	for (const address of [owner, source, target]) reach("init", "--as", address, "--name", address === owner ? "Owner" : "Worker");
	const ownerPane = mux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "fixture", `bash '${join(repo, "tests/apps/reach/fixtures/tmux-ack-actor.sh")}'`).trim();
	await waitUntil(() => mux("capture-pane", "-p", "-t", ownerPane).includes("READY integration ACK actor"), "owner receipt terminal", 5);
	reach("register", "--as", owner, "--channel", "tmux", "--handle", ownerPane);
	for (const address of [source, target]) reach("spawn", "claude", "--as", address, "--cwd", project, "--window");
	await waitUntil(async () => await agentStopped(source) && await agentStopped(target), "both real agent startup turns", 60);
	console.log(`real agents ready: host=${hostname()} Claude=${version} evidence=${root}`);
	const transferPath = join(root, "transfer.eml");
	await writeFile(transferPath, card(transfer, source, target, `Continue original work card ${original}. Do not write before explicit release. After release write handoff-result.txt containing exactly ${nonce}. Preserve this card and its Reply-To.`));
	run(sno, ["reach", "send", "--as", owner, "--no-ring"], { input: card(original, owner, source, "Prepare this work for transfer; do not write the task result yourself.") });
	call(source, `Read your inbox and original work card ${original}. Accept ONLY that original work using sno reach reply --state accepted with a nonblank body. Then send the prepared transfer card by running cat ${JSON.stringify(transferPath)} | sno reach send --as ${source} --no-ring. Cancel your original work using sno reach reply --state cancelled --reason transfer-to-receiver with a nonblank body. Do not accept or complete this call transport mail. Do not release yet or write any task result. Finish by printing exactly SOURCE_PREPARED ${nonce}.`, `SOURCE_PREPARED ${nonce}`);
	const beforeReady = snapshot();
	await writeFile(join(root, "before-ready.json"), JSON.stringify({ squad: beforeReady, progress: progress() }, null, 2));
	assert.equal(beforeReady.work.filter(item => item.work === work).length, 1);
	assert.equal(beforeReady.work.find(item => item.work === work)?.owner, source);
	call(target, `Read your inbox and original transfer task card ${transfer}. Accept ONLY that task using sno reach reply --state accepted with a nonblank body. Do not accept or complete this call transport mail. Do not write any task file until explicit release. Finish by printing exactly HANDOFF_READY ${nonce}.`, `HANDOFF_READY ${nonce}`);
	const beforeRelease = snapshot();
	await writeFile(join(root, "before-release.json"), JSON.stringify({ squad: beforeRelease, progress: progress() }, null, 2));
	assert.equal(beforeRelease.work.find(item => item.work === work)?.owner, source, "readiness must not transfer ownership");
	await assert.rejects(readFile(join(project, "handoff-result.txt")), { code: "ENOENT" });
	console.log("readiness preserved original work ownership and no task result exists");
	const release = `Release your original work card ${transfer}. Release nonce: ${nonce}. Before any task write output exactly HANDOFF_RELEASED ${nonce} as one standalone line. Then write handoff-result.txt containing exactly ${nonce}. Do not complete the task card yet; preserve its original Reply-To.`;
	call(source, `Now perform the explicit release with this exact command: sno reach call ${target} ${JSON.stringify(release)} --expect ${JSON.stringify(`^HANDOFF_RELEASED ${nonce}$`)} --timeout 60 --every 1. Do not write the task result yourself. After the call succeeds finish with exactly RELEASE_OBSERVED ${nonce}.`, `RELEASE_OBSERVED ${nonce}`);
	await waitUntil(async () => await readFile(join(project, "handoff-result.txt"), "utf8").then(text => text.trim() === nonce, () => false), "receiver authorized result", 30);
	await waitUntil(() => snapshot().work.find(item => item.work === work)?.owner === target, "released work ownership", 10);
	const after = snapshot();
	const result = { host: hostname(), version, binary: sno, elapsedSeconds: (Date.now() - started) / 1000,
		source, target, original, transfer, work, result: "passed", squad: after, progress: progress(), file: await readFile(join(project, "handoff-result.txt"), "utf8") };
	assert.equal(after.work.filter(item => item.work === work).length, 1);
	assert.equal(after.work.find(item => item.work === work)?.message_id, original);
	assert.equal(after.agents.find(row => row.reachAddress === source)?.group, "Finished");
	assert.equal(after.agents.find(row => row.reachAddress === source)?.subgroup, "handed over");
	assert.equal(after.agents.find(row => row.reachAddress === target)?.work.filter(item => item.work === work).length, 1);
	const files = await readdir(join(env.SNO_PROFILE_DIR, "station/agents"));
	const allEvents = (await Promise.all(files.map(file => readFile(join(env.SNO_PROFILE_DIR, "station/agents", file), "utf8")))).flatMap(text => text.trim().split("\n").map(line => JSON.parse(line)));
	assert(allEvents.some(event => event.event === "handoff-released" && event.input.message_id === original && event.input.target === target));
	const metadata = JSON.parse(await readFile(join(state, target, "transcript.json"), "utf8"));
	const transcript = (await readFile(metadata.transcript, "utf8")).trim().split("\n").map(line => JSON.parse(line));
	const actions = transcript.filter(row => row.type === "assistant").flatMap(row => row.message?.content ?? []).flatMap(block => {
		if (block.type === "text" && block.text.split("\n").some(line => line.trim() === `HANDOFF_RELEASED ${nonce}`)) return ["released"];
		if (block.type === "tool_use" && ((["Write", "Edit"].includes(block.name) && block.input.file_path?.endsWith("handoff-result.txt")) ||
			(block.name === "Bash" && />\s*["']?(?:[^\s"']*\/)?handoff-result\.txt/.test(block.input.command ?? "")))) return ["write"];
		return [];
	});
	assert(actions.includes("released") && actions.includes("write") && actions.indexOf("released") < actions.indexOf("write"), "receiver must emit its standalone release before the actual result write");
	result.receiverActions = actions;
	await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2));
	console.log(JSON.stringify({ result: "passed", realAgents: 2, explicitReleaseBeforeActualWrite: true, singleWorkOwner: true, elapsedSeconds: result.elapsedSeconds, evidence: root }));
} finally {
	await writeFile(join(root, "commands.json"), JSON.stringify(log, null, 2));
	await rm(credentials, { force: true });
	spawnSync("tmux", ["-L", server, "kill-server"], { env, encoding: "utf8", timeout: 10_000 });
	await rm(prefix, { recursive: true, force: true });
	console.log(`handoff evidence: ${root}`);
}
