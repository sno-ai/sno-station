import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture.ts";
import { globalPrefixWith, realSno } from "../../support/real-sno.mjs";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const installedPrefix = process.env.SNO_INSTALLED_PREFIX;
const installedMemory = installedPrefix && join(installedPrefix, "node_modules/@snoai/memory");
const entry = installedPrefix
	? join(installedPrefix, "node_modules/@snoai/mem-claude/dist/cli.js")
	: join(repo, "apps/mem-claude/dist/cli.js");
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

function processRun(command, args, options = {}) {
	return new Promise(resolveRun => {
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", chunk => { stdout += chunk; });
		child.stderr.on("data", chunk => { stderr += chunk; });
		const timeout = setTimeout(() => {
			stderr += "\nNative test process exceeded its declared deadline.";
			try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ }
		}, options.timeoutMs ?? 240_000);
		child.on("error", error => { clearTimeout(timeout); resolveRun({ code: null, stdout, stderr: `${stderr}\n${error.message}` }); });
		child.on("close", code => { clearTimeout(timeout); resolveRun({ code, stdout, stderr }); });
		child.stdin.on("error", () => {}); child.stdin.end(options.input ?? "");
	});
}

export async function createClaudeNative(label) {
	const profile = mkdtempSync(join(tmpdir(), `mem-update-claude-native-${label}-`));
	const previousProfile = process.env.SNO_PROFILE_DIR;
	process.env.SNO_PROFILE_DIR = profile;
	let embedding = { cacheDir: "" };
	try { embedding = JSON.parse(readFileSync(join(homedir(), ".sno/settings.json"), "utf8")).embedding; }
	catch (error) { if (error.code !== "ENOENT") throw error; }
	const { settings: installedSettings } = writeSettingsFixture(profile, {
		...(installedMemory && { memoryPackage: { path: installedMemory, node: process.execPath } }),
		mode: "local-first", embedding, rerank: { mode: "none" }, rem: { tick: false },
		telemetry: { memoryUsage: { enabled: false }, observe: { enabled: false } },
		capture: { ambient: false }, recall: { auto: true, explicitLimit: 20, prompt: { minChars: 0, minScore: 0 } },
	});
	const project = join(profile, "repo");
	// The real sno finds the package under `npm root -g` and runs its entry script by path.
	const sno = realSno();
	const prefix = globalPrefixWith({ "@snoai/mem-claude": dirname(dirname(entry)) });
	const config = join(project, ".claude");
	mkdirSync(config, { recursive: true });
	const env = { ...process.env, SNO_PROFILE_DIR: profile, npm_config_prefix: prefix };
	delete env.CLAUDECODE;
	delete env.CLAUDE_CONFIG_DIR;
	delete env.CLAUDE_CODE_SIMPLE;
	delete env.CLAUDE_CODE_SAFE_MODE;
	const initialized = await processRun("git", ["init", "-q", project], { env });
	assert.equal(initialized.code, 0, initialized.stderr);
	const { connect } = await import(installedMemory
		? pathToFileURL(join(installedMemory, "dist/client.js")).href
		: "../../../../packages/memory/dist/client.js");
	const client = await connect({ skinId: "mem-claude" });
	assert.equal(client.degraded, false, client.error ?? client.reason);
	const scope = { principal: client.principal, project, session: "native-inspect", host: { workspace: project } };
	const initializedService = await client.init(scope, { skinId: "mem-claude" });
	assert.equal(initializedService.degraded, false, JSON.stringify(initializedService));
	const rows = async () => {
		const result = await client.inspect({ op: "list", limit: 100 }, scope);
		assert.equal(result.degraded, false, result.error ?? result.reason);
		return result.result.entries;
	};
	// What `sno setup` does: run the package installer by path, with the path of the sno that ran it.
	const installed = await processRun(process.execPath, [entry, "install", "--config-dir", config], { cwd: project, env: { ...env, SNO_EXECUTABLE: sno } });
	assert.equal(installed.code, 0, installed.stderr);
	const observations = join(profile, "claude-hooks.jsonl");
	const wrapper = join(profile, "observe-hook.mjs");
	writeFileSync(wrapper, `import {readFileSync,appendFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const raw=readFileSync(0,'utf8'); const input=JSON.parse(raw);
const output=spawnSync(${JSON.stringify(sno)},['memory','hook',process.argv[2],'--harness','claude'],{input:raw,encoding:'utf8',timeout:30000});
appendFileSync(${JSON.stringify(observations)},JSON.stringify({command:process.argv[2],input,code:output.status,stdout:output.stdout,stderr:output.stderr})+'\\n');
process.stdout.write(output.stdout||''); process.stderr.write(output.stderr||''); process.exit(output.status??1);
`, { mode: 0o600 });
	const settingsPath = join(config, "settings.json");
	const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	for (const groups of Object.values(settings.hooks)) for (const group of groups) for (const hook of group.hooks) {
		const event = /memory hook (\S+) --harness claude$/.exec(hook.command.trim())?.[1];
		assert.ok(event, `installed hook is not a sno memory hook: ${hook.command}`);
		hook.command = `${shellQuote(process.execPath)} ${shellQuote(wrapper)} ${event}`;
	}
	settings.permissions.allow.push("Bash(printf *)", "Agent");
	settings.autoMemoryEnabled = false;
	settings.sandbox = { enabled: false };
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
	chmodSync(settingsPath, 0o600);
	const claude = process.env.CLAUDE_BIN ?? "claude";
	const proof = { label, host: "local", claude, profile, project, database: installedSettings.store.path,
		settings: settingsPath, servicePid: client.pid, endpoint: `http://127.0.0.1:${client.port}`,
		authentication: "existing local Claude OAuth; no credential copy", runs: [], checks: {}, passed: false };
	const hooks = () => {
		try { return readFileSync(observations, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
		catch (error) { if (error.code === "ENOENT") return []; throw error; }
	};
	const cli = async (action, ...args) => processRun(sno, ["memory", action, "--harness", "claude", ...args], { cwd: project, env, timeoutMs: 60_000 });
	const memory = action => `${shellQuote(sno)} memory ${action} --harness claude`;
	const model = async (prompt, tools = "Bash", session = randomUUID(), resume = false) => {
		console.log(JSON.stringify({ event: "claude-native-start", label, session, project, profile }));
		const run = await processRun(claude, ["-p", resume ? "--resume" : "--session-id", session,
			"--setting-sources", "", "--settings", settingsPath, "--tools", tools,
			"--permission-mode", "dontAsk", "--max-turns", "20", "--output-format", "stream-json", "--verbose"],
		{ cwd: project, env, input: prompt, timeoutMs: 240_000 });
		run.session = session;
		run.prompt = prompt;
		proof.runs.push(run);
		run.events = run.stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
		run.result = run.events.findLast(event => event.type === "result");
		console.log(JSON.stringify({ event: "claude-native-finished", label, session, code: run.code, subtype: run.result?.subtype }));
		assert.equal(run.code, 0, run.result?.result ?? run.stderr);
		assert.equal(run.result?.is_error, false, JSON.stringify(run.result));
		return run;
	};
	const outputs = (run, action) => {
		const [verb, ...rest] = action.split(" ");
		const head = `${sno} memory ${verb} --harness claude`;
		const uses = run.events.filter(event => event.type === "assistant").flatMap(event => event.message?.content ?? []);
		const matches = uses.filter(item => item.type === "tool_use" && item.name === "Bash"
			&& String(item.input?.command).replace(/'([^']*)'|"([^"]*)"/g, (_, single, double) => single ?? double).includes(head) && rest.every(part => String(item.input?.command).includes(part)));
		assert.ok(matches.length, `No actual Bash dispatch for ${action}`);
		return matches.map(use => {
			const result = run.events.filter(event => event.type === "user").flatMap(event => event.message?.content ?? [])
				.find(item => item.type === "tool_result" && item.tool_use_id === use.id);
			assert.ok(result, `No actual Bash result for ${action}`);
			return { text: typeof result.content === "string" ? result.content.trim() : JSON.stringify(result.content), isError: result.is_error === true };
		});
	};
	const output = (run, action) => outputs(run, action)[0];
	const finish = async error => {
		if (error) { proof.failure = error.message; process.exitCode = 1; }
		proof.hooks = hooks();
		proof.rows = await rows();
		proof.encryptedStore = !readFileSync(installedSettings.store.path).subarray(0, 16).toString().startsWith("SQLite format 3");
		const evidence = `/tmp/mem-update-claude-native-${label}-${randomUUID()}.json`;
		writeFileSync(evidence, JSON.stringify(proof, null, 2), { mode: 0o600 });
		process.kill(client.pid, "SIGTERM");
		if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
		else process.env.SNO_PROFILE_DIR = previousProfile;
		console.log(JSON.stringify({ label, passed: proof.passed, failure: proof.failure, checks: proof.checks, evidence }));
	};
	return { rows, sno, memory, project, env, proof, cli, model, output, outputs, hooks, finish };
}

async function rememberJourney() {
	const test = await createClaudeNative("remember");
	let failure;
	try {
		const nonce = randomUUID();
		const text = `The native Claude orchid release label is ${nonce}.`;
		const remembered = await test.model(`Run exactly one Bash command: ${test.memory("remember")} ${shellQuote(text)}. Return its output. Do not replace this with capture or another command.`);
		const id = test.output(remembered, "remember").text;
		assert.match(id, /^[0-9a-f-]{36}$/i);
		assert.equal((await test.rows()).find(row => row.id === id)?.text, text);
		test.proof.checks.modelRemember = true;
		const recalled = await test.model(`Run Bash ${test.memory("recall")} ${shellQuote("native Claude orchid release label")}, then use Agent to ask one child to run Bash "printf claude-native-child" once and report its result. Return the actual recall text and the child result.`, "Bash,Agent");
		assert.equal(test.output(recalled, "recall").text, `${id}\t${text} [id:${id}]\n${text}`);
		test.proof.checks.canonicalRecall = true;
		const hooks = test.hooks().filter(item => item.input.session_id === recalled.session);
		const primary = hooks.filter(item => !item.input.agent_id);
		const contexts = primary.filter(item => ["session-start", "user-prompt-submit"].includes(item.command));
		assert.ok(contexts.some(item => item.stdout.includes(` [id:${id}]`)), "Primary session must actually inject its stored row");
		assert.equal(contexts.flatMap(item => item.stdout.match(new RegExp(`\\[id:${id}\\]`, "g")) ?? []).length, 1, "SessionStart and prompt must not inject the same id twice");
		assert.ok(contexts.some(item => item.command === "user-prompt-submit"), "Native prompt hook must execute");
		assert.ok(contexts.every(item => !item.stderr.includes('"reason":"invalid-input"')), "Native hook input must parse");
		test.proof.checks.autoInjection = true;
		const children = test.hooks().filter(item => typeof item.input.agent_id === "string");
		const probe = children.find(item => item.command === "pre-tool-use" && JSON.stringify(item.input.tool_input).includes("claude-native-child"));
		assert.ok(probe, "The actual native child must execute its probe");
		assert.ok(children.some(item => item.command === "post-tool-use" && item.input.agent_id === probe.input.agent_id
			&& item.input.tool_use_id === probe.input.tool_use_id), "The actual child probe must have its matching tool return");
		for (const child of children) {
			assert.equal(child.code, 0, child.stderr);
			if (["session-start", "user-prompt-submit"].includes(child.command)) assert.equal(JSON.parse(child.stdout).hookSpecificOutput.additionalContext, "");
			else assert.equal(child.stdout.trim(), "", "Native child must not inject memory context");
		}
		test.proof.observedChildHookEvents = [...new Set(children.map(item => item.command))];
		test.proof.checks.childSkipped = true;
		const beforeResume = test.hooks().length;
		const resumed = await test.model(`Run exactly one Bash command: ${test.memory("get")} ${id}. Return its actual full output.`, "Bash", recalled.session, true);
		assert.equal(test.output(resumed, `get ${id}`).text, `${id}\n${text}`);
		const resumedHooks = test.hooks().slice(beforeResume).filter(item => item.input.session_id === recalled.session
			&& ["session-start", "user-prompt-submit"].includes(item.command));
		assert.ok(resumedHooks.some(item => item.command === "session-start" && item.input.source === "resume"));
		assert.ok(resumedHooks.some(item => item.command === "user-prompt-submit"));
		assert.ok(resumedHooks.every(item => !item.stdout.includes(` [id:${id}]`) && !item.stderr.includes('"reason":"invalid-input"')),
			"A resumed native session must retain the already-served id without failing its hooks");
		test.proof.checks.resumeNoRepeat = true;
		test.proof.passed = true;
	} catch (error) { failure = error; }
	await test.finish(failure);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await rememberJourney();
