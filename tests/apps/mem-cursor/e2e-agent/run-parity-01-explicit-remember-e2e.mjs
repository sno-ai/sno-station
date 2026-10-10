import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture.ts";
import { globalPrefixWith, realSno } from "../../support/real-sno.mjs";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const installedPrefix = process.env.SNO_INSTALLED_PREFIX;
const installedMemory = installedPrefix && join(installedPrefix, "node_modules/@snoai/memory");
const entry = installedPrefix
	? join(installedPrefix, "node_modules/@snoai/mem-cursor/dist/cli.js")
	: join(repo, "apps/mem-cursor/dist/cli.js");
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

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

async function rememberJourney() {
	const profile = mkdtempSync(join(tmpdir(), "mem-update-cursor-native-"));
	let embedding = { cacheDir: "" };
	try { embedding = JSON.parse(readFileSync(join(homedir(), ".sno/settings.json"), "utf8")).embedding; }
	catch (error) { if (error.code !== "ENOENT") throw error; }
	const { settings } = writeSettingsFixture(profile, {
		...(installedMemory && { memoryPackage: { path: installedMemory, node: process.execPath } }),
		mode: "local-first", embedding, rerank: { mode: "none" }, rem: { tick: false },
		telemetry: { memoryUsage: { enabled: false }, observe: { enabled: false } },
		capture: { ambient: false }, recall: { auto: true, explicitLimit: 20, prompt: { minChars: 0, minScore: 0 } },
	});
	const project = join(profile, "repo");
	const sno = realSno();
	const prefix = globalPrefixWith({ "@snoai/mem-cursor": dirname(dirname(entry)) });
	const env = { ...process.env, SNO_PROFILE_DIR: profile, npm_config_prefix: prefix };
	const proof = { host: "local", profile, project, database: settings.store.path, checks: {}, passed: false };
	let client;
	let failure;
	try {
		assert.equal((await processRun("git", ["init", "-q", project], { env })).code, 0);
		const { connect } = await import(installedMemory
			? pathToFileURL(join(installedMemory, "dist/client.js")).href
			: "../../../../packages/memory/dist/client.js");
		client = await connect({ skinId: "mem-cursor" });
		assert.equal(client.degraded, false, client.error ?? client.reason);
		const scope = { principal: client.principal, project, session: "native-inspect", host: { workspace: project } };
		assert.equal((await client.init(scope, { skinId: "mem-cursor" })).degraded, false);
		// The hooks go into the project, so the real ~/.cursor and its Cursor login are left alone.
		const cursorHome = join(project, ".cursor");
		mkdirSync(cursorHome, { recursive: true });
		const installed = await processRun(process.execPath, [entry, "install", "--cursor-home", cursorHome], { cwd: project, env: { ...env, SNO_EXECUTABLE: sno } });
		assert.equal(installed.code, 0, installed.stderr);
		// Cursor's shell and hooks do not inherit this environment, so each command carries it. sno reads the install
		// location it recorded under HOME first, so it gets an empty HOME and finds the candidate under npm_config_prefix.
		const emptyHome = join(profile, "home");
		mkdirSync(emptyHome, { recursive: true });
		const envPrefix = `env HOME=${shellQuote(emptyHome)} SNO_PROFILE_DIR=${shellQuote(profile)} npm_config_prefix=${shellQuote(prefix)}`;
		const hooksPath = join(cursorHome, "hooks.json");
		const hooksFile = JSON.parse(readFileSync(hooksPath, "utf8"));
		let ours = 0;
		for (const list of Object.values(hooksFile.hooks)) for (const item of list) {
			if (!item.command.includes("--harness cursor")) continue;
			item.command = `${envPrefix} ${item.command}`;
			ours++;
		}
		assert.ok(ours > 0, "hooks.json has no Sno hook");
		writeFileSync(hooksPath, JSON.stringify(hooksFile, null, 2));
		proof.checks.installed = true;

		const agent = process.env.CURSOR_AGENT_BIN ?? "cursor-agent";
		const model = async prompt => {
			// Cursor's streaming connection does not survive an HTTP proxy, so it runs without one.
			const direct = { ...env };
			for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete direct[name];
			let run;
			// Cursor's service connection drops now and then and leaves no answer; ask again, up to three times.
			for (let attempt = 0; attempt < 3; attempt++) {
				run = await processRun(agent, ["-p", "--force", "--trust", "--workspace", project, "--output-format", "text", prompt],
					{ cwd: project, env: direct, timeoutMs: 300_000 });
				if (run.stdout.trim() && !run.stdout.includes("RetriableError")) break;
			}
			// Cursor's own connection retries can end the process with a failure code after its work is done, so the
			// checks below read the effects, not the exit code.
			return run.stdout;
		};
		const sh = `${envPrefix} ${shellQuote(sno)}`;
		const nonce = randomUUID();
		const text = `The native Cursor orchid release label is ${nonce}.`;
		const said = await model(`Run exactly one shell command: ${sh} memory remember --harness cursor ${shellQuote(text)}. Do not run anything else. Then say exactly what it printed.`);
		const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(said)?.[0];
		assert.ok(id, `Cursor did not print a memory id; it said: ${said.slice(0, 600)}`);
		const stored = await processRun("sh", ["-c", `${sh} memory get ${id} --harness cursor`], { cwd: project, env, timeoutMs: 60_000 });
		assert.ok(stored.stdout.includes(nonce), `The remembered text is not in the memory store: ${(stored.stdout + stored.stderr).slice(0, 400)}`);
		proof.checks.modelRemember = true;
		const answer = await model(`Run exactly one shell command: ${sh} memory recall --harness cursor ${shellQuote("native Cursor orchid release label")}. Then reply with the label value only.`);
		assert.ok(answer.includes(nonce), `A new Cursor session did not recall the label: ${answer.slice(0, 300)}`);
		proof.checks.freshSessionRecall = true;
		const records = readdirSync(join(profile, "cursor", "conversations")).filter(name => name.endsWith(".json"));
		assert.ok(records.length >= 2, `Expected a conversation record per Cursor session, found ${records.length}`);
		proof.checks.conversationRecords = records.length;
		proof.passed = true;
	} catch (error) { failure = error; proof.failure = error.message; process.exitCode = 1; }
	if (client) process.kill(client.pid, "SIGTERM");
	console.log(JSON.stringify({ passed: proof.passed, failure: proof.failure, checks: proof.checks, profile }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await rememberJourney();
