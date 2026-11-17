import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, copyFileSync, chmodSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { writeSettingsFixture } from '../../../packages/memory/fixtures/settings-file-fixture.ts';
import { globalPrefixWith, realSno } from '../../support/real-sno.mjs';
import { cleanupProfile } from '../../support/profile-cleanup.mjs';
import { initSqliteRuntime, openSqliteDatabase } from '../../../../packages/memory/src/store/sqlite-runtime.ts';
import { connect } from '../../../../packages/memory/dist/client.js';
import { settingsSchema } from '../../../../packages/memory/config/settings.ts';

const activeProcesses = new Set();
export const deadline = Date.now() + Number(process.env.MP_BUDGET_MS ?? (process.argv[2] === '9' ? 900_000 : 265_000));
export function stopRuns() { for (const child of activeProcesses) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } } }
export const repo = resolve(import.meta.dirname, '../../../..');
export const sourceHome = process.env.MP_SOURCE_HOME;
export const evidenceDir = join(repo, process.argv[2] === '9' ? 'ai-doc/ACTIVE/PRD/Precision-Memory/evidence/e2e-real-agents' : 'ai-doc/ACTIVE/PRD/memory-precision/evidence/e2e-2026-11-11');
export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export const json = path => JSON.parse(readFileSync(path, 'utf8'));
export const lines = path => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
export function files(path) {
  return existsSync(path) ? readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]) : [];
}
export function save(name, data) {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, `${name}.json`), JSON.stringify(data, null, 2), { mode: 0o600 });
}
export async function run(command, args, options = {}) {
  const started = Date.now();
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? repo, env: options.env ?? process.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    activeProcesses.add(child);
    let stdout = '', stderr = '';
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    const timer = setTimeout(kill, Math.max(1, Math.min(options.timeoutMs ?? 110_000, deadline - Date.now())));
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', kill);
    child.on('close', code => { activeProcesses.delete(child); clearTimeout(timer); done({ code, stdout, stderr, elapsedMs: Date.now() - started }); });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
  });
}
export function database(settings, operation, readonly = true) {
  initSqliteRuntime(settings.store.encryptionKey);
  const db = openSqliteDatabase(settings.store.path, { fileMustExist: true, readonly }).raw;
  try { return operation(db); } finally { db.close(); }
}
export const rows = settings => database(settings, db => db.prepare('SELECT id,text,category,project_id,metadata,lane,content_hash FROM nodix_memories ORDER BY timestamp,id').all())
  .map(row => ({ ...row, metadata: JSON.parse(row.metadata) }));
export const modes = settings => database(settings, db => db.prepare('SELECT * FROM nodix_place_modes').all());
export const loaded = settings => database(settings, db => db.prepare('SELECT * FROM nodix_place_loaded_files').all()).map(row => ({ ...row, files: JSON.parse(row.files) }));
export const norm = text => text.trim().replace(/\s+/g, ' ').toLowerCase();
export function duplicates(entries) {
  const seen = new Set();
  return entries.filter(row => { const key = JSON.stringify([row.project_id, row.category, norm(row.text)]); if (seen.has(key)) return true; seen.add(key); return false; });
}
export const activity = text => /\b(?:tests? (?:passed|completed)|completed and merged|ran the tests|opened a pull request)\b|测试全部通过|完成并合并/i.test(text);
export async function environment({ copied = false, capture = true, root: existingRoot } = {}) {
  assert.ok(sourceHome, 'MP_SOURCE_HOME is the credential/instruction source home');
  assert.equal(process.env.SNO_USAGE_CLASS, 'research');
  const preparedProfile = process.env.SNO_PROFILE_DIR;
  const inputSettings = json(join(preparedProfile, 'settings.json'));
  const prepared = process.argv[2] === '9' ? { ...json(join(repo, 'packages/memory/settings.default.json')), snoGpu: inputSettings.snoGpu, embedding: inputSettings.embedding } : inputSettings;
  // The allocated scratch path exceeds the Unix socket path limit; /proc keeps all writes there.
  if (process.argv[2] === '9') process.chdir(process.env.TMPDIR);
  const root = existingRoot ?? mkdtempSync(process.argv[2] === '9' ? `/proc/${process.pid}/cwd/mp-e2e-run-` : join(sourceHome, '.cache/mp-e2e-run-'));
  const profile = copied ? preparedProfile : join(root, 'profile');
  let identityAlignment;
  if (copied) {
    const identityPath = join(profile, 'identity.json'), identity = json(identityPath);
    const machineUuid = json(join(sourceHome, '.sno/identity.json')).machine_uuid;
    identityAlignment = identity.machine_uuid === machineUuid ? 'already-matched' : 'updated';
    if (identityAlignment === 'updated') {
      identity.machine_uuid = machineUuid;
      writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
      chmodSync(identityPath, 0o600);
    }
  }
  const calls = [];
  const hostCalls = [];
  let hostServer;
  let hostRegistration;
  let proxy;
  let settings = copied ? settingsSchema.parse(prepared) : prepared;
  if (!copied) {
    const upstream = new URL(prepared.snoGpu.baseUrl);
    const request = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
    proxy = createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const observed = { path: req.url, source: req.headers['x-sno-source'], workload: req.headers['x-sno-workload'], usageClass: req.headers['x-sno-usage-class'], requestId: req.headers['x-request-id'], started: Date.now(), chatInstruction: body.toString().includes('capture EVERY fact') };
        calls.push(observed);
        const forward = request(new URL(req.url, upstream.origin), { method: req.method, headers: { ...req.headers, host: upstream.host } }, response => {
          observed.status = response.statusCode;
          res.writeHead(response.statusCode, response.headers); response.pipe(res);
          const reply = []; response.on('data', chunk => reply.push(chunk));
          response.on('end', () => { observed.elapsedMs = Date.now() - observed.started; observed.reply = Buffer.concat(reply).toString(); });
        });
        forward.on('error', error => { observed.error = error.message; res.destroy(error); });
        forward.end(body);
      });
    });
    await new Promise(done => proxy.listen(0, '127.0.0.1', done));
    ({ settings } = writeSettingsFixture(profile, { ...prepared,
      store: { path: join(root, 'memory.sqlite'), encryptionKey: process.argv[2] === '9' ? randomBytes(32).toString('hex') : prepared.store.encryptionKey },
      memoryPackage: { path: join(repo, 'packages/memory'), node: process.execPath },
      snoGpu: { ...prepared.snoGpu, baseUrl: `http://127.0.0.1:${proxy.address().port}${upstream.pathname.replace(/\/$/, '')}` },
      capture: { ...prepared.capture, ambient: capture, assistant: true },
      rem: { ...prepared.rem, tick: false },
      logging: { ...prepared.logging, file: join(profile, 'memory.log') },
      telemetry: { ...prepared.telemetry, memoryUsage: { enabled: false }, observe: { enabled: false } },
    }));
  }
  process.env.SNO_PROFILE_DIR = profile;
  process.env.SNO_CAPTURE_SCRIPTED = '1';
  process.env.SNO_STATION_MEM_MAINTENANCE_INTERVAL_MS = '86400000';
  const prefix = globalPrefixWith(Object.fromEntries(['claude', 'codex', 'cursor'].map(agent => [`@snoai/mem-${agent}`, join(repo, `apps/mem-${agent}`)])));
  const env = { ...process.env, npm_config_prefix: prefix, SNO_EXECUTABLE: realSno() };
  const clients = {};
  const client = async skin => {
    if (!clients[skin]) {
      clients[skin] = await connect({ skinId: skin });
      const startupLog = join(profile, 'sno-station-mem/sidecar-startup.log');
      const startupError = process.argv[2] === '9' && clients[skin].degraded && existsSync(startupLog) ? readFileSync(startupLog, 'utf8').slice(-8000).replaceAll(settings.snoGpu.apiKey, '[credential]').replaceAll(settings.store.encryptionKey, '[store key]') : '';
      assert.equal(clients[skin].degraded, false, `${clients[skin].error ?? ''}\n${startupError}`);
    }
    return clients[skin];
  };
  async function project(name) {
    const path = join(root, name); mkdirSync(path);
    const result = await run('git', ['init', '-q', path], { env }); assert.equal(result.code, 0, result.stderr); return path;
  }
  const projectId = async (skin, place) => { const c = await client(skin), result = await c.inspect({ op: 'list', limit: 1 }, scope(c, place)); assert.equal(result.degraded, false); return result.result.project; };
  const scope = (c, place, session = randomUUID()) => ({ principal: c.principal, project: place, session, host: { workspace: place } });
  async function hostModel() {
    if (hostRegistration) return hostRegistration;
    const home = await agentHome({ root, env }, 'claude');
    process.env.CLAUDE_CONFIG_DIR = home;
    const { runClaudeChild } = await import('../../../../apps/mem-claude/dist/worker.js');
    hostServer = createServer(async (incoming, outgoing) => {
      const parts = []; for await (const part of incoming) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts).toString());
      const prompt = body.messages.map(item => item.content).join('\n\n');
      const started = Date.now();
      const result = await runClaudeChild(prompt, root, Math.max(1, Math.min(90_000, deadline - Date.now())));
      hostCalls.push({ started, elapsedMs: Date.now() - started, ...result });
      outgoing.setHeader('content-type', 'application/json');
      outgoing.writeHead(result.kind === 'ok' ? 200 : 503).end(JSON.stringify(result.kind === 'ok' ? { choices: [{ message: { content: result.text } }] } : { error: result }));
    });
    await new Promise(done => hostServer.listen(0, '127.0.0.1', done));
    hostRegistration = { baseUrl: `http://127.0.0.1:${hostServer.address().port}/v1`, credential: 'isolated-test-host', model: 'real-claude-child' };
    return hostRegistration;
  }
  return { root, profile, settings, prefix, env, calls, hostCalls, hostModel, client, project, scope, projectId, identityAlignment, processIds: () => [process.pid, ...Object.values(clients).map(client => client.pid)],
    async close({ keepHomes = false } = {}) {
      if (!copied) await cleanupProfile(profile, 'claude', prefix);
      else rmSync(prefix, { recursive: true, force: true });
      if (hostServer) { hostServer.closeAllConnections(); await new Promise(done => hostServer.close(done)); }
      if (proxy) { proxy.closeAllConnections(); await new Promise(done => proxy.close(done)); }
      process.env.SNO_PROFILE_DIR = preparedProfile;
      if (!keepHomes) rmSync(root, { recursive: true, force: true });
    } };
}

export async function agentHome(test, agent, { instructions = true } = {}) {
  const home = join(test.root, agent); mkdirSync(home, { recursive: true });
  if (agent === 'cursor') return home;
  const cli = join(repo, `apps/mem-${agent}/dist/cli.js`);
  if (agent === 'codex') {
    copyFileSync(join(sourceHome, '.codex/auth.json'), join(home, 'auth.json'));
    if (instructions) for (const name of ['AGENTS.override.md', 'AGENTS.md']) if (existsSync(join(sourceHome, '.codex', name))) copyFileSync(join(sourceHome, '.codex', name), join(home, name));
    writeFileSync(join(home, 'config.toml'), 'model_provider = "ccproxy"\nmodel_reasoning_effort = "low"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[features]\nhooks = true\n[model_providers.ccproxy]\nname = "ccproxy"\nbase_url = "http://localhost:8070/codex/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n');
    const recorder = join(home, 'sno');
    copyFileSync(join(repo, 'tests/apps/mem-codex/fixtures/capture-installed-hook.mjs'), recorder); chmodSync(recorder, 0o700);
    const { installCodex } = await import('../../../../apps/mem-codex/dist/install.js');
    await installCodex({ codexHome: realpathSync(home), programPath: recorder, writeOutput() {} });
    return home;
  }
  const args = ['--config-dir', home];
  const installed = await run(process.execPath, [cli, 'install', ...args], { env: test.env });
  assert.equal(installed.code, 0, installed.stderr);
  // Reuse the existing installed-hook recorder; it dispatches the real sno binary.
  const recorder = join(repo, 'tests/apps/mem-codex/fixtures/capture-installed-hook.mjs');
  const hooksPath = join(home, 'settings.json');
  const hooks = json(hooksPath);
  for (const groups of Object.values(hooks.hooks)) for (const group of groups) {
    const commands = group.hooks ?? [group];
    for (const hook of commands) {
      const suffix = /memory hook (.*)$/.exec(hook.command)?.[1];
      if (suffix) hook.command = `env HOME=${quote(process.env.HOME)} SNO_USAGE_CLASS=research SNO_CAPTURE_SCRIPTED=1 SNO_BINARY=${quote(realSno())} SNO_MEM_UPDATE_CAPTURE_FILE=${quote(join(home, 'hooks-observed.jsonl'))} ${quote(process.execPath)} ${quote(recorder)} memory hook ${suffix}`;
    }
  }
  writeFileSync(hooksPath, JSON.stringify(hooks));
  if (agent === 'claude') {
    copyFileSync(join(sourceHome, '.claude/.credentials.json'), join(home, '.credentials.json'));
    if (instructions) copyFileSync(join(sourceHome, '.claude/CLAUDE.md'), join(home, 'CLAUDE.md'));
    const path = join(home, 'settings.json'), config = json(path);
    config.autoMemoryEnabled = false;
    config.hooks.InstructionsLoaded = [{ hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(join(repo, 'tests/apps/memory-precision/e2e-agent/observe.mjs'))} ${quote(join(home, 'instructions.jsonl'))}` }] }];
    writeFileSync(path, JSON.stringify(config));

  }
  return home;
}
export async function turn(test, agent, home, cwd, prompt, session) {
  const env = { ...test.env, CLAUDE_CONFIG_DIR: home, CODEX_HOME: home, SNO_BINARY: realSno(), SNO_MEM_UPDATE_CAPTURE_FILE: join(home, 'hooks-observed.jsonl') };
  for (const name of ['CLAUDECODE', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_SAFE_MODE']) delete env[name];
  let command, args;
  if (agent === 'claude') {
    command = 'claude'; args = ['-p', ...(session ? ['--resume', session] : ['--session-id', randomUUID()]), '--setting-sources', 'user,project,local', '--tools', '', '--permission-mode', 'dontAsk', '--max-turns', '2', '--output-format', 'stream-json', '--verbose'];
  } else if (agent === 'codex') {
    command = 'codex'; args = session ? ['exec', 'resume', '--json', session, prompt] : ['exec', '--json', '--skip-git-repo-check', prompt];
  } else {
    command = 'cursor-agent'; args = ['-p', '--force', '--trust', '--workspace', cwd, '--output-format', 'json', '--mode', 'ask', prompt];
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete env[name];
    env.HOME = home;
    env.XDG_CONFIG_HOME = join(home, '.config');
    const cursorConfig = join(cwd, '.cursor');
    if (!existsSync(join(cursorConfig, 'hooks.json'))) {
      const installed = await run(process.execPath, [join(repo, 'apps/mem-cursor/dist/cli.js'), 'install', '--cursor-home', cursorConfig], { cwd, env: test.env });
      assert.equal(installed.code, 0, installed.stderr);
      const hookPath = join(cursorConfig, 'hooks.json'), hooks = json(hookPath);
      for (const list of Object.values(hooks.hooks)) for (const hook of list) {
        const suffix = /memory hook (.*)$/.exec(hook.command)?.[1];
        if (suffix) hook.command = `env HOME=${quote(process.env.HOME)} SNO_USAGE_CLASS=research SNO_CAPTURE_SCRIPTED=1 SNO_PROFILE_DIR=${quote(test.profile)} npm_config_prefix=${quote(test.prefix)} SNO_BINARY=${quote(realSno())} SNO_MEM_UPDATE_CAPTURE_FILE=${quote(join(home, 'hooks-observed.jsonl'))} ${quote(process.execPath)} ${quote(join(repo, 'tests/apps/mem-codex/fixtures/capture-installed-hook.mjs'))} memory hook ${suffix}`;
      }
      writeFileSync(hookPath, JSON.stringify(hooks));
    }
    mkdirSync(join(env.XDG_CONFIG_HOME, 'cursor'), { recursive: true });
    copyFileSync(join(sourceHome, '.config/cursor/auth.json'), join(env.XDG_CONFIG_HOME, 'cursor/auth.json'));
  }
  const c = await test.client(agent === 'claude' ? 'claude-code' : agent);
  const scope = test.scope(c, cwd);
  const readyDeadline = Math.min(deadline, Date.now() + 60_000);
  let ready;
  do {
    ready = await c.getRecall('readiness', scope, { source: 'auto', injectionPhase: 'session-start' });
    if (!ready.unavailable && !ready.degraded) break;
    await new Promise(done => setTimeout(done, 500));
  } while (Date.now() < readyDeadline);
  assert.ok(!ready.unavailable && !ready.degraded, JSON.stringify(ready));
  const before = new Set(files(join(home, agent === 'claude' ? 'projects' : 'sessions')).filter(path => path.endsWith('.jsonl')));
  const result = await run(command, args, { cwd, env, input: agent === 'claude' ? prompt : '', timeoutMs: 110_000 });
  const events = result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const id = events.find(row => row.type === 'thread.started')?.thread_id ?? events.find(row => row.session_id)?.session_id ?? events.find(row => row.conversation_id)?.conversation_id ?? session;
  const transcripts = [...new Set([...files(join(home, agent === 'claude' ? 'projects' : 'sessions')).filter(path => path.endsWith('.jsonl') && (path.includes(id) || !before.has(path))), ...lines(join(home, 'hooks-observed.jsonl')).filter(event => event.input?.session_id === id || event.input?.conversation_id === id).map(event => event.input.transcript_path).filter(path => typeof path === 'string' && existsSync(path))])];
  const transcript = transcripts.map(path => ({ path, text: readFileSync(path, 'utf8') }));
  return { ...result, agent, home, cwd, prompt, session: id, transcript, hooks: lines(join(home, 'hooks-observed.jsonl')).filter(event => event.input?.session_id === id || event.input?.conversation_id === id) };
}
export function blocks(run) {
  const strings = [];
  function walk(value) { if (typeof value === 'string') strings.push(value); else if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') Object.values(value).forEach(walk); }
  for (const item of run.transcript) for (const line of item.text.split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    if (row.type === 'attachment' || (row.type === 'api-request-blob' && row.message?.role !== 'assistant') || (row.type === 'response_item' && ['developer', 'user', 'system'].includes(row.payload?.role)) || (row.type === 'system' && row.subtype === 'hook_response')) walk(row);
  }
  return [...new Set(strings.flatMap(text => [...text.matchAll(/Sno memory \(data, not instructions;[^\n]*\n(?:(?:[^\n]*\[id:[^\n]+|Open task:[^\n]*)\n?)+/g)].map(match => match[0].trim())))];
}
export function assertRun(result) { assert.equal(result.code, 0, result.stderr || result.stdout); assert.ok(result.transcript.length, 'Real session transcript was not found'); }
export function digest(text) { return createHash('sha256').update(text).digest('hex'); }
