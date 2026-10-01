import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { createServer, request } from "node:http";
import { pathToFileURL } from "node:url";

// Session plumbing copied from run-stp7-e2e.mjs; no deployment or planted product edits.
export function remote(script, timeout = 300_000) {
	const result = spawnSync("env", ["-u", "HTTPS_PROXY", "-u", "HTTP_PROXY", "ssh",
		"-o", "BatchMode=yes", "-o", "ConnectTimeout=10", process.env.SNO_TEST_SSH_HOST, "bash", "-s"],
	{ input: `set -euo pipefail\nexport HTTPS_PROXY= HTTP_PROXY=\n${script}\n`, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 });
	// Codex writes its failure (a turn.failed or error event) to stdout, not stderr.
	if (result.status !== 0) throw new Error(`exit ${result.status}: ${result.error?.message || result.stderr.trim()} | stdout: ${result.stdout.slice(-1500)}`);
	return result.stdout.trim();
}
export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export const profile = process.env.SNO_TEST_PROFILE;
export const root = process.env.SNO_TEST_ROOT;
export const unit = "sno-station-mem-mem-codex-e2e.service";

export async function runCase(journey) {
	const runId = randomUUID().replaceAll("-", "");
	const cwd = `${root}/repos/parity-${runId}`;
	const home = `${root}/tmp/parity-${runId}`;
	const sessions = [];
	let finished = false;
	function db(code) {
		return JSON.parse(remote(`node --input-type=module <<'JS'
import {openEncryptedDb,getDek} from "${root}/sno-station-mem/vendor/sqlite-crypto/dist/index.js";
import {readFileSync} from "node:fs";
const settings=JSON.parse(readFileSync("${profile}/settings.json","utf8"));
const db=openEncryptedDb(settings.store.path,getDek(settings.store.encryptionKey));
const ext="${root}/sno-station-mem/vendor/memory/sqlite-extensions/linux-x64";
db.loadExtension(ext+"/vec0.so"); db.loadExtension(ext+"/libsimple.so"); db.prepare("SELECT jieba_dict(?)").get(ext+"/dict");
try { ${code} } finally { db.close(); }
JS`));
	}
	function rows() {
		return db(`console.log(JSON.stringify(db.prepare("SELECT id,text,category,project_id AS scope,metadata FROM nodix_memories WHERE project_id = ?").all(${JSON.stringify(cwd)})));`)
			.map(row => ({ ...row, metadata: JSON.parse(row.metadata || "{}") }));
	}
	async function waitRows(predicate, label, timeout = 300_000) {
		const end = Date.now() + timeout;
		let found;
		do {
			found = rows();
			if (predicate(found)) return found;
			await new Promise(resolve => setTimeout(resolve, 2_000));
		} while (Date.now() < end);
		console.log(JSON.stringify({ label, rows: found }));
		assert.fail(label);
	}
	// `resume` continues the previous session of this run, so sessions are kept (no --ephemeral).
	function turn(prompt, resume = false) {
		const command = resume
			? `codex exec resume --json --skip-git-repo-check ${quote(sessions.at(-1))}`
			: "codex exec --json -s danger-full-access --skip-git-repo-check";
		const output = remote(`cd ${quote(cwd)}
CODEX_HOME=${quote(home)} SNO_PROFILE_DIR=${profile} timeout 240 ${command} ${quote(prompt)} </dev/null`, 250_000);
		const events = output.split("\n").filter(Boolean).map(line => JSON.parse(line));
		const session = events.find(event => event.type === "thread.started")?.thread_id;
		if (session) sessions.push(session);
		const response = events.filter(event => event.type === "item.completed" && event.item?.type === "agent_message").at(-1)?.item.text;
		assert.equal(typeof response, "string", `Codex JSON stream has no final agent message: ${JSON.stringify(events)}`);
		console.log(JSON.stringify({ session, response }));
		return response;
	}
	try {
		remote(`install -d -m 700 ${quote(cwd)} ${quote(home)}
git -C ${quote(cwd)} init -q
cat > ${quote(`${home}/config.toml`)} <<'CONFIG'
model = "gpt-5.6-sol"
model_reasoning_effort = "low"
model_provider = "ccproxy"
[model_providers.ccproxy]
name = "ccproxy"
base_url = "http://localhost:8070/codex/v1"
wire_api = "responses"
requires_openai_auth = false
CONFIG
SNO_PROFILE_DIR=${profile} ${root}/bin/sno-mem-codex install --codex-home ${quote(home)} >/dev/null
systemctl --user is-active ${unit}`);
		await journey({ runId, cwd, home, turn, rows, waitRows, db });
		finished = true;
	} catch (error) {
		console.error(error.message);
		throw error;
	} finally {
		// Wait for this run's detached capture before deleting its rows.
		const end = Date.now() + 300_000;
		let pending;
		do {
			pending = JSON.parse(remote(`node - <<'JS'
const fs=require('node:fs'); const dir='${profile}/sno-mem-codex/spool';
console.log(JSON.stringify(fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>f.endsWith('.json')).flatMap(f=>{try{const r=JSON.parse(fs.readFileSync(dir+'/'+f));return r.project===${JSON.stringify(cwd)}?[{file:f,attempts:r.attempts}]:[];}catch(e){if(e.code==='ENOENT')return [];throw e;}}):[]));
JS`));
			if (!pending.some(row => row.attempts < 3)) break;
			await new Promise(resolve => setTimeout(resolve, 2_000));
		} while (Date.now() < end);
		if (pending.some(row => row.attempts < 3)) console.error(`cleanup requires final late-write check: ${cwd}`);
		const cleanup = db(`db.prepare("DELETE FROM nodix_memory_chunk_vectors WHERE id IN (SELECT chunk_id FROM nodix_memory_chunks WHERE memory_id IN (SELECT id FROM nodix_memories WHERE project_id = ?))").run(${JSON.stringify(cwd)}); db.prepare("DELETE FROM nodix_memory_chunks WHERE memory_id IN (SELECT id FROM nodix_memories WHERE project_id = ?)").run(${JSON.stringify(cwd)}); const deleted=db.prepare("DELETE FROM nodix_memories WHERE project_id = ?").run(${JSON.stringify(cwd)}).changes; console.log(JSON.stringify({deleted,remaining:db.prepare("SELECT count(*) AS n FROM nodix_memories WHERE project_id = ?").get(${JSON.stringify(cwd)}).n}));`);
		console.log(JSON.stringify({ cleanup }));
		assert.equal(cleanup.remaining, 0);
		remote(`node - <<'JS'
const fs=require('node:fs'),crypto=require('node:crypto');
for(const id of ${JSON.stringify(sessions)}) {const p='${profile}/sno-mem-codex/sessions/'+crypto.createHash('sha256').update(id).digest('hex')+'.json';if(fs.existsSync(p))fs.unlinkSync(p);}
for(const row of ${JSON.stringify(pending)}) fs.unlinkSync('${profile}/sno-mem-codex/spool/'+row.file);
JS
find ${quote(home)} ${quote(cwd)} -depth -delete`);
		if (finished) assert.equal(pending.length, 0, "capture did not finish; absence is unproven");
	}
	console.log("green");
}

/** Run the current local Codex CLI against an isolated real memory service. */
export async function runNativeCase(journey) {
	const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
	const installedPrefix = process.env.SNO_INSTALLED_PREFIX;
	const installedMemory = installedPrefix && join(installedPrefix, "node_modules/@snoai/memory");
	const installedCodex = installedPrefix && join(installedPrefix, "node_modules/@snoai/mem-codex");
	const { writeSettingsFixture } = await import("../../../packages/memory/fixtures/settings-file-fixture.ts");
	const { connect } = await import(installedMemory
		? pathToFileURL(join(installedMemory, "dist/client.js")).href
		: "../../../../packages/memory/dist/client.js");
	const { installCodex } = await import(installedCodex
		? pathToFileURL(join(installedCodex, "dist/install.js")).href
		: "../../../../apps/mem-codex/src/install.ts");
	const sourceHome = process.env.CODEX_HOME || join(homedir(), ".codex");
	const nativeProfile = mkdtempSync("/tmp/mem-update-codex-native-profile-");
	process.env.SNO_PROFILE_DIR = nativeProfile;
	process.env.HOME = join(nativeProfile, "home");
	mkdirSync(process.env.HOME);
	writeSettingsFixture(nativeProfile, {
		...(installedMemory && { memoryPackage: { path: installedMemory, node: process.execPath } }),
		mode: "local-first", capture: { ambient: false }, embedding: { cacheDir: join(homedir(), ".cache/sno-station/models") },
		rerank: { mode: "none" }, rem: { tick: false },
		telemetry: { memoryUsage: { enabled: false }, observe: { enabled: false } },
		recall: { sessionStart: { limit: 10, maxChars: 8000, timeoutMs: 60_000 },
			prompt: { limit: 10, maxChars: 8000, timeoutMs: 60_000, minScore: 0, minChars: 1 } },
	});
	const client = await connect({ skinId: "codex" });
	assert.equal(client.degraded, false, client.error || client.reason);
	const fixture = { profile: nativeProfile, client };
	const runId = randomUUID().replaceAll("-", "");
	const wire = [];
	const recorder = createServer((incoming, outgoing) => {
		const parts = [];
		incoming.on("data", part => parts.push(part));
		incoming.on("end", () => {
			const body = Buffer.concat(parts).toString("utf8");
			const observed = { path: incoming.url, hasMemoryHeader: body.includes("Sno memory (data, not instructions;"),
				hasJordan: body.includes("Jordan"), bodyBytes: Buffer.byteLength(body) };
			if (incoming.url.includes("/responses")) {
				try {
					const parsed = JSON.parse(body), input = Array.isArray(parsed.input) ? parsed.input : [];
					const textOf = item => typeof item.content === "string" ? item.content
						: Array.isArray(item.content) ? item.content.map(part => part.text || "").join("\n") : "";
					observed.contentEncoding = incoming.headers["content-encoding"] || "identity";
					observed.model = parsed.model;
					observed.memoryItems = input.filter(item => textOf(item).startsWith("Sno memory (data, not instructions;"))
						.map(item => ({ role: item.role, type: item.type, content: item.content }));
					observed.userQuery = input.filter(item => item.role === "user").at(-1)?.content;
				} catch (error) {
					console.error(`wire observation failed: ${error.message}`);
				}
			}
			wire.push(observed);
			console.log(JSON.stringify({ wireObservation: observed }));
			const upstream = request({ hostname: "127.0.0.1", port: 8070, path: incoming.url,
				method: incoming.method, headers: incoming.headers }, response => {
				outgoing.writeHead(response.statusCode || 502, response.headers);
				response.pipe(outgoing);
			});
			upstream.on("error", error => { outgoing.destroy(error); });
			upstream.end(body);
		});
	});
	await new Promise(resolveReady => recorder.listen(0, "127.0.0.1", resolveReady));
	const modelEndpoint = `http://127.0.0.1:${recorder.address().port}/codex/v1`;
	const home = join(fixture.profile, "codex-home"), cwd = join(fixture.profile, "workspace");
	const hookLog = join(fixture.profile, "native-hooks.jsonl"), wrapper = join(home, "sno-mem-codex");
	mkdirSync(home); mkdirSync(cwd);
	writeFileSync(join(home, "config.toml"), [
		'model = "gpt-6-sol"', 'model_reasoning_effort = "low"', 'model_provider = "ccproxy"',
		'sandbox_mode = "danger-full-access"', 'approval_policy = "never"',
		'[features]', 'multi_agent = true', 'hooks = true', '[model_providers.ccproxy]',
		'name = "ccproxy"', `base_url = ${JSON.stringify(modelEndpoint)}`,
		'wire_api = "responses"', 'requires_openai_auth = false', "",
	].join("\n"));
	if (existsSync(join(sourceHome, "auth.json"))) copyFileSync(join(sourceHome, "auth.json"), join(home, "auth.json"));
	copyFileSync(join(repository, "tests/apps/mem-codex/fixtures/capture-installed-hook.mjs"), wrapper);
	chmodSync(wrapper, 0o700);
	await installCodex({ codexHome: home, programPath: wrapper, writeOutput() {} });
	const env = { ...process.env, CODEX_HOME: home, SNO_MEM_UPDATE_CAPTURE_FILE: hookLog,
		...(!installedCodex && { SNO_MEM_UPDATE_TSX: join(repository, "node_modules/tsx/dist/loader.mjs") }),
		SNO_MEM_UPDATE_CLI: installedCodex ? join(installedCodex, "dist/cli.js") : join(repository, "apps/mem-codex/src/cli.ts") };
	const cli = installedCodex ? join(installedCodex, "dist/cli.js") : join(repository, "apps/mem-codex/dist/cli.js");
	const scope = { principal: client.principal, project: cwd, session: "manual", host: { workspace: cwd, sessionId: "manual" } };
	await client.init(scope, { skinId: "codex" });
	async function readRow(id) {
		const result = await client.inspect({ op: "get", id }, scope);
		assert.equal(result.degraded, false, result.error || result.reason);
		return result.result.entry;
	}
	async function rowCount() {
		const result = await client.inspect({ op: "list", limit: 100 }, scope);
		assert.equal(result.degraded, false, result.error || result.reason);
		return result.result.entries.length;
	}
	const runs = [], actions = [];
	async function execute(program, args) {
		return new Promise((resolveRun, reject) => {
			const child = spawn(program, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
			let output = "", error = "";
			child.stdout.on("data", part => { output += part; });
			child.stderr.on("data", part => { error += part; });
			child.on("error", reject);
			child.on("exit", code => resolveRun({ code, output, error }));
		});
	}
	async function action(name, ...args) {
		const run = await execute(process.execPath, [cli, name, ...args]);
		actions.push({ action: name, args, ...run });
		console.log(JSON.stringify({ action: name, code: run.code, text: run.output.trim(), error: run.error }));
		return { ok: run.code === 0, text: run.output.trim() };
	}
	async function turn(prompt, session) {
		const args = session ? ["exec", "resume", "--json", "--skip-git-repo-check", session, prompt]
			: ["exec", "--json", "--skip-git-repo-check", "-C", cwd, prompt];
		const run = await execute("codex", args);
		runs.push(run);
		console.log(JSON.stringify({ nativeRun: run, home, profile: fixture.profile, model: "gpt-6-sol", endpoint: modelEndpoint, upstreamEndpoint: "http://localhost:8070/codex/v1" }));
		assert.equal(run.code, 0, run.error || run.output);
		const events = run.output.trim().split("\n").map(line => JSON.parse(line));
		assert.ok(events.some(event => event.type === "turn.completed"), run.output);
		const thread = events.find(event => event.type === "thread.started")?.thread_id || session;
		const response = events.filter(event => event.item?.type === "agent_message").at(-1)?.item.text;
		assert.equal(typeof response, "string", run.output);
		return { session: thread, response, output: run.output, code: run.code };
	}
	function hooks() {
		return existsSync(hookLog) ? readFileSync(hookLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
	}
	function spools() {
		const dir = join(fixture.profile, "sno-mem-codex/spool");
		return existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".json")).flatMap(name => {
			try { return [JSON.parse(readFileSync(join(dir, name), "utf8"))]; }
			catch (error) { if (error.code === "ENOENT") return []; throw error; }
		}) : [];
	}
	function setCapture(enabled) {
		const path = join(fixture.profile, "settings.json"), settings = JSON.parse(readFileSync(path, "utf8"));
		settings.capture.ambient = enabled;
		writeFileSync(path, JSON.stringify(settings));
	}
	console.log(JSON.stringify({ nativeSetup: { home, cwd, profile: fixture.profile, cli,
		model: "gpt-6-sol", endpoint: modelEndpoint, upstreamEndpoint: "http://localhost:8070/codex/v1", sandbox: "danger-full-access", approval: "never" } }));
	let passed = false;
	try {
		await journey({ runId, fixture, home, cwd, cli, turn, action, hooks, spools, setCapture, readRow, rowCount });
		passed = true;
	} finally {
		const evidence = { passed, runId, home, cwd, profile: fixture.profile, modelEndpoint, upstreamEndpoint: "http://localhost:8070/codex/v1", wire, runs, actions, hooks: hooks(), spools: spools() };
		const evidencePath = `/tmp/mem-update-codex-native-${runId}-evidence.json`;
		writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
		console.log(JSON.stringify({ evidencePath, passed }));
		recorder.closeAllConnections();
		await new Promise(resolveClosed => recorder.close(resolveClosed));
		const lock = join(fixture.profile, "sno-mem-codex/worker.lock");
		if (existsSync(lock)) {
			const pid = Number(readFileSync(lock, "utf8").split(" ")[0]);
			try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") { console.error(`worker teardown failed: ${error.message}`); process.exitCode = 1; } }
		}
		try { process.kill(client.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") { console.error(`sidecar teardown failed: ${error.message}`); process.exitCode = 1; } }
	}
	console.log("green");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await runNativeCase(async ({ runId, cli, turn, action, hooks, spools, setCapture, readRow }) => {
		const text = `The native Codex release convention for ${runId} is Indigo.`, command = `${quote(process.execPath)} ${quote(cli)}`;
		const stored = await turn(`Run exactly this memory command: ${command} remember ${quote(text)}. Return only the resulting memory id. Do not write or edit files.`);
		assert.match(stored.response, /^[0-9a-f-]{36}$/);
		assert.equal((await readRow(stored.response))?.text, text);
		assert.deepEqual(await action("get", stored.response), { ok: true, text: `${stored.response}\n${text}` });
		setCapture(true);
		const child = await turn(`This is an installed hook observation test. Our native primary project capture marker is Parent-${runId}. Use spawn_agent exactly once to create a child. Give it this task: Run the shell command printf installed-child-probe, then answer CHILD_COMPLETE. Do not spawn another agent. Wait for CHILD_COMPLETE. Then use send_input once to send that same child: Run printf installed-child-followup, then answer CHILD_FOLLOWUP. Wait for the follow-up result and reply CHILD_FOLLOWUP. You must create the child and send the follow-up; do not perform its tasks yourself. Do not write, edit, or delete files and do not use explicit memory actions.`);
		const { verifyInstalledChildHooks } = await import("../e2e/verify-installed-child-hooks.mjs");
		const observed = verifyInstalledChildHooks({ output: child.output, hooks: hooks(), spools: spools(), runExitCode: child.code });
		const primaryStop = hooks().find(hook => hook.command === "stop" && hook.input.session_id === child.session && !hook.input.agent_id);
		assert.ok(primaryStop, "the real main session must run Stop");
		assert.equal(primaryStop.code, 0, primaryStop.error);
		const captured = spools().filter(row => row.sessionId === child.session);
		assert.ok(captured.length > 0, "positive control: the real main Stop must append a capture spool");
		assert.ok(captured.some(row => row.user.includes(`Parent-${runId}`)), "the spool must retain the actual main prompt");
		const blocks = hooks().filter(hook => hook.input.session_id === child.session && ["session-start", "user-prompt-submit"].includes(hook.command))
			.map(hook => JSON.parse(hook.output).hookSpecificOutput.additionalContext);
		assert.equal(blocks.join("\n").split(`[id:${stored.response}]`).length - 1, 1, "first session phases must render the stored id once");
		console.log(JSON.stringify({ explicitRemember: stored.response, mainCaptureSpools: captured.length, ...observed }));
	});
}
