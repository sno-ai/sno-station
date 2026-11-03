import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { writeSettingsFixture } from '../../../packages/memory/fixtures/settings-file-fixture.ts';
import { globalPrefixWith, realSno } from '../../support/real-sno.mjs';

// prepare creates inputs, not a task brief or a result. The real current executor performs
// the failed read, recall and durable task capture between prepare and run.
const mode = process.argv[2];
assert.ok(['prepare', 'run', 'verify'].includes(mode), 'use prepare, run <prepared-root>, or verify <retained-root>');
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const sourceHome = homedir(), skills = process.env.SNO_SKILLS_SOURCE;
assert.ok(skills, 'SNO_SKILLS_SOURCE must identify the skill source checkout');
const sno = realSno(), quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const root = mode === 'prepare' ? mkdtempSync(join(sourceHome, '.cache/work-transfer-')) : process.argv[3];
assert.ok(root, 'run requires the prepared root');
const stateFile = join(root, 'fixture.json');
const fixture = mode === 'prepare' ? { root, id: randomUUID().slice(0, 12), server: `transfer-${process.pid}` } : JSON.parse(readFileSync(stateFile, 'utf8'));
const home = join(root, 'home'), project = join(root, 'project'), profile = join(home, '.sno'), config = join(home, '.claude'), state = join(root, 'reach');
const host = hostname().toLowerCase(), work = `continuity-${fixture.id}`;
const sender = `executor.source-${fixture.id}@${host}`, receiver = `executor.receiver-${fixture.id}@${host}`;
const owner = `lead.result-${fixture.id}@${host}`, initiator = `executor.recover-${fixture.id}@${host}`;
const originalId = `<original-${fixture.id}@${host}>`, receiverId = `<receiver-${fixture.id}@${host}>`;
const brief = join(root, 'source-progress.md');
const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: config, CODEX_HOME: join(home, '.codex'), SNO_PROFILE_DIR: profile,
  REM_REFLECT_STORE: join(root, 'experience'), XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'), XDG_CACHE_HOME: join(home, '.cache'),
  SNO_REACH_ROOT: state, SNO_CAPTURE_SCRIPTED: '1', npm_config_prefix: fixture.prefix, DISABLE_AUTOUPDATER: '1', TERM: 'xterm-256color',
  CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0', PATH: `${join(home, 'bin')}:/usr/bin:/bin` };
for (const key of ['CLAUDECODE', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID', 'SNO_REACH_ADDR', 'SNO_EXECUTOR_ADDR', 'SNO_REACH_SESSION_ID', 'TMUX', 'TMUX_PANE', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_SAFE_MODE']) delete env[key];
const invoke = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: project, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options });
  appendFileSync(join(root, 'commands.jsonl'), JSON.stringify({ command, args, status: result.status, error: result.error?.message, stdout: result.stdout, stderr: result.stderr }) + '\n');
  assert.equal(result.error, undefined, result.error?.message); return result;
};
const ok = result => { assert.equal(result.status, 0, result.stderr || result.stdout); return result.stdout; };
const reach = (...args) => invoke(sno, ['reach', ...args]);
const mux = (...args) => ok(invoke('tmux', ['-L', fixture.server, ...args], { timeout: 15_000 }));
const card = (from, to, id, body) => `From: Continuity <${from}>\nTo: Executor <${to}>\nReply-To: Result <${owner}>\nDate: ${new Date().toUTCString()}\nSubject: [DECISION] Continue the authorized sum\nMessage-ID: ${id}\nX-Type: decision\nX-Work: ${work}\n\n${body}\n`;
const taskRows = () => ok(reach('state', '--work', work, '--json')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const actor = join(repo, 'tests/apps/reach/fixtures/tmux-ack-actor.sh');
let client, pane;

function cleanupCreated() {
  spawnSync('tmux', ['-L', fixture.server, 'kill-server'], { env, timeout: 5000 });
  const pid = client?.pid ?? fixture.memory?.pid;
  if (pid) try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') console.error(error); }
  rmSync(join(config, '.credentials.json'), { force: true });
  if (fixture.prefix) rmSync(fixture.prefix, { recursive: true, force: true });
}

async function until(check, label, seconds = 110) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) { if (check()) return; await delay(300); }
  if (pane) writeFileSync(join(root, 'failure-screen.txt'), mux('capture-pane', '-p', '-t', pane, '-S', '-'));
  throw new Error(`${label}; evidence ${root}`);
}

if (mode === 'prepare') {
 try {
  for (const path of [home, project, profile, config, join(home, 'bin'), join(home, '.config/sno')]) mkdirSync(path, { recursive: true });
  const claude = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  for (const [name, path] of [['sno', sno], ['node', process.execPath], ['claude', claude]]) symlinkSync(path, join(home, 'bin', name));
  copyFileSync(join(process.env.CLAUDE_CONFIG_DIR ?? join(sourceHome, '.claude'), '.credentials.json'), join(config, '.credentials.json'));
  chmodSync(join(config, '.credentials.json'), 0o600);
  fixture.prefix = globalPrefixWith({ '@snoai/mem-claude': join(repo, 'apps/mem-claude'), '@snoai/mem-codex': join(repo, 'apps/mem-codex'), '@snoai/memory': join(repo, 'packages/memory'), '@snoai/observability': join(repo, 'packages/observability') }); env.npm_config_prefix = fixture.prefix;
  const scripts = join(skills, 'skills/R-recursive-self-improvement/rem-reflect/skill/scripts');
  const checkpoint = join(skills, 'skills/S-communication-and-handoff/handoff/skill/scripts/handoff-checkpoint');
  const rem = join(home, 'bin/rem-reflect');
  writeFileSync(rem, `#!/usr/bin/env bash\nexec ${quote(process.execPath)} --experimental-strip-types ${quote(join(scripts, 'rem-reflect.ts'))} "$@"\n`, { mode: 0o755 });
  writeFileSync(join(home, '.config/sno/cli.json'), JSON.stringify({ auto: { enabled: false } }));
  writeFileSync(join(home, '.config/sno/assemble.json'), JSON.stringify({ generation: 'test', files: {}, directories: [], skills_version: '', skill_destinations: {},
    contract_sha256: '', requirements_fixture_sha256: '', hooks: [], timer: false,
    memory_pieces: { memory: { location: join(fixture.prefix, 'lib/node_modules/@snoai/memory'), node: process.execPath } },
    programs: Object.fromEntries(Object.entries({ reach: join(repo, 'apps/reach/bin/sno-reach'), 'handoff-checkpoint': checkpoint, 'rem-reflect': rem })
      .map(([name, entry]) => [name, { version: '1.0', sha256: '', entry, dependencies: [] }])) }));
  writeSettingsFixture(profile, { mode: 'local-first', memoryPackage: { path: join(repo, 'packages/memory'), node: process.execPath },
    embedding: { cacheDir: join(sourceHome, '.cache/sno-station/models'), offline: true }, rerank: { mode: 'none' }, rem: { tick: false },
    telemetry: { memoryUsage: { enabled: false }, observe: { enabled: false } }, capture: { ambient: false }, recall: { auto: true, prompt: { minChars: 0, minScore: 0 } } });
  const onboarding = { hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true, projects: { [project]: { hasTrustDialogAccepted: true } } };
  writeFileSync(join(config, '.claude.json'), JSON.stringify(onboarding)); writeFileSync(join(home, '.claude.json'), JSON.stringify(onboarding));
  ok(invoke('git', ['init', '-q']));
  ok(invoke('git', ['-c', 'user.name=Continuity fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Fixture']));
  writeFileSync(join(project, 'ledger.csv'), '17,31,9\n');
  process.env.SNO_PROFILE_DIR = profile;
  const { connect } = await import('../../../../packages/memory/dist/client.js');
  client = await connect({ skinId: 'mem-claude' }); assert.equal(client.degraded, false, client.error ?? client.reason);
  const scope = { principal: client.principal, project, session: 'seed', host: { workspace: project } };
  assert.equal((await client.init(scope, { skinId: 'mem-claude' })).degraded, false);
  const stored = await client.mutate({ op: 'store', content: 'The continuity transfer task computes the comma-separated integer sum from ledger.csv and writes the decimal sum plus newline to result.txt.', category: 'episodic' }, scope);
  assert.equal(stored.degraded, false, JSON.stringify(stored)); assert.equal(stored.result.isError, false, JSON.stringify(stored));
  fixture.memory = { id: stored.result.details.id, pid: client.pid, endpoint: `http://127.0.0.1:${client.port}` };
  ok(invoke(process.execPath, [join(repo, 'apps/mem-claude/dist/cli.js'), 'install', '--config-dir', config], { env: { ...env, SNO_EXECUTABLE: sno } }));
  mux('-f', '/dev/null', 'new-session', '-d', '-x', '200', '-y', '45', '-s', 'fixture', 'cat');
  env.TMUX = mux('display-message', '-p', '#{socket_path},#{pid},0').trim(); fixture.tmux = env.TMUX;
  const sourcePane = mux('display-message', '-p', '#{pane_id}').trim();
  const ownerPane = mux('new-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'fixture', `bash ${quote(actor)}`).trim();
  await until(() => mux('capture-pane', '-p', '-t', ownerPane).includes('READY integration ACK actor'), 'result mailbox notifier unavailable', 5);
  for (const address of [owner, sender, initiator, receiver]) ok(reach('init', '--as', address, '--name', 'Continuity'));
  ok(reach('register', '--as', owner, '--channel', 'tmux', '--handle', ownerPane));
  ok(reach('register', '--as', sender, '--channel', 'tmux', '--handle', sourcePane));
  const original = card(owner, sender, originalId, `The owner authorizes this disposable continuation proof. Read absent-invoice-metadata.csv once and retain its actual failure. Use scoped Sno memory for the task. Leave reading/summing ledger.csv and writing result.txt unfinished, save a complete handoff brief, then transfer under the same X-Work and Reply-To. No commits, other task files, or extra features. Report the recovered next-action result and failed operation to ${owner}.`);
  ok(invoke(sno, ['reach', 'send', '--as', owner, '--no-ring'], { input: original }));
  fixture.source = { sender, receiver, owner, initiator, work, originalId, receiverId, brief, sourcePane, runtime: 'current Codex executor; passive private notification pane, no spawned sender CLI' };
  writeFileSync(stateFile, JSON.stringify(fixture, null, 2));
  console.log(JSON.stringify({ prepared: true, root, ...fixture.source, memory: fixture.memory }));
  process.exit(0);
 } catch (error) {
  writeFileSync(join(root, 'prepare-failure.json'), JSON.stringify({ fixture, failure: error.stack }, null, 2));
  cleanupCreated(); throw error;
 }
}

env.TMUX = fixture.tmux; env.SNO_REACH_ADDR = initiator;
const proof = mode === 'verify' ? JSON.parse(readFileSync(join(root, 'proof.json'), 'utf8'))
  : { scenario: 'current-codex-to-claude-sender-gone', host, root, source: fixture.source, memory: fixture.memory, checks: {} };
if (mode === 'verify' && proof.failure) {
  if (!existsSync(join(root, 'proof-initial-run.json'))) copyFileSync(join(root, 'proof.json'), join(root, 'proof-initial-run.json'));
  proof.harnessFailures ??= []; proof.harnessFailures.push(proof.failure);
  proof.initialHarnessFailure ??= proof.failure; delete proof.failure;
  proof.verificationMode = 'read retained real execution artifacts; no receiver or task rerun';
}
const transcript = () => {
  const meta = join(state, receiver, 'transcript.json'); if (!existsSync(meta)) return [];
  const path = JSON.parse(readFileSync(meta, 'utf8')).transcript; if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
};
const texts = () => transcript().filter(row => row.type === 'assistant').flatMap(row => row.message.content).filter(block => block.type === 'text').map(block => block.text);
const mailbox = () => ['new', 'cur'].flatMap(dir => readdirSync(join(state, receiver, dir)).map(name => join(state, receiver, dir, name)));
let launcher, release, releaseNonce, readyNonce;
try {
 if (mode === 'verify') {
  const commands = readFileSync(join(root, 'commands.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const calls = commands.filter(row => row.args[0] === 'reach' && row.args[1] === 'call' && row.args[2] === receiver);
  const start = calls.find(row => row.args[3].startsWith('This is a full ownership handoff'));
  const released = calls.find(row => row.args[3].startsWith('Release the task in the verified brief'));
  assert.ok(start && released, 'retained real call payloads must exist');
  assert.equal(start.status, 0); assert.equal(released.status, 0);
  launcher = start.args[3]; release = released.args[3];
  readyNonce = /Return (HANDOFF_READY_[^,]+),/.exec(launcher)?.[1];
  releaseNonce = /Release nonce: ([0-9a-f-]+)\./.exec(release)?.[1];
  assert.ok(readyNonce && releaseNonce, 'retain exact receiver release and readiness identities');
  assert.ok(launcher.includes(createHash('sha256').update(readFileSync(brief)).digest('hex')), 'source brief remains unchanged from verified handoff');
 } else {
  assert.ok(existsSync(brief), 'the real source executor must save its brief before run');
  const sourceRecord = readFileSync(brief, 'utf8');
  assert.match(sourceRecord, /absent-invoice-metadata\.csv/); assert.match(sourceRecord, /ENOENT|No such file/);
  assert.match(sourceRecord, /## Objective and authorization/); assert.match(sourceRecord, /## Next/);
  assert.ok(!existsSync(join(project, 'result.txt')), 'source must leave the next action unfinished');
  assert.ok(!existsSync(join(state, sender, 'reachable.json')), 'source must leave before recovery initiation');
  assert.equal(taskRows().find(row => row.message_id === originalId && row.recipient === sender)?.state, 'cancelled');
  proof.checks.sourceStopped = true;
  const quotas = join(root, 'quota-reader'); mkdirSync(quotas);
  writeFileSync(join(quotas, 'sender.json'), JSON.stringify({ agent: 'codex', vendor: { verdict: 'wait', wait_minutes: 60, summary: 'Recorded exhausted quota input for the external reader boundary' } }));
  const quota = ok(invoke('bash', [join(skills, 'skills/S-communication-and-handoff/rotate-agent/skill/scripts/selftest/fake-quota'), '--agent', 'codex', '--json'], {
    env: { ...env, QUOTA_FIXTURES: quotas, QUOTA_LOG: join(root, 'quota-reader.log') },
  }));
  assert.equal(JSON.parse(quota).vendor.verdict, 'wait'); proof.quota = { source: 'fixture replaces only external quota reader', reply: JSON.parse(quota), originalVendorCallSkipped: true };
  ok(reach('spawn', 'claude', '--as', receiver, '--cwd', project, '--window'));
  pane = JSON.parse(readFileSync(join(state, receiver, 'reachable.json'), 'utf8')).identity.value;
  await until(() => texts().length > 0, 'real receiver startup did not settle');
  const skill = readFileSync(join(skills, 'skills/S-communication-and-handoff/handoff/skill/SKILL.md'), 'utf8');
  const digest = createHash('sha256').update(sourceRecord).digest('hex'); readyNonce = `HANDOFF_READY_${randomUUID()}`; releaseNonce = randomUUID();
  launcher = skill.split('## Short launcher\n\n```text\n')[1].split('\n```')[0];
  for (const [token, value] of Object.entries({ '<CURRENT_CHECKOUT>': project, '<BRIEF_PATH>': brief, '<BYTE_COUNT>': Buffer.byteLength(sourceRecord), '<DIGEST>': digest, '<READY_NONCE>': readyNonce })) launcher = launcher.replaceAll(token, String(value));
  const ready = ok(reach('call', receiver, launcher, '--expect', readyNonce, '--timeout', '90', '--every', '1'));
  assert.ok(ready.includes(digest) && ready.includes(project), ready);
  assert.ok(!existsSync(join(project, 'result.txt')), 'receiver must not write before release');
  const body = `This receiver card continues original ${originalId} under X-Work ${work}. The sender already stopped; the recovery initiator uses its recorded owner authority, never a fabricated sender response. Read the complete verified brief ${brief}. Accept THIS task card, preserve Reply-To ${owner}, and wait for explicit release. Call mail is transport-only: never accept/complete it. After release finish the brief's unfinished action, retain the failed operation, and complete this same receiver card with outcome=rebuilt, original_conversation=lost, next_action=completed|unfinished|blocked and actual result. Use real scoped sno memory recall --harness claude before task action. Then finish your turn.`;
  ok(invoke(sno, ['reach', 'send', '--as', initiator, '--no-ring'], { input: card(initiator, receiver, receiverId, body) }));
  const acceptNonce = `CARD_ACCEPTED_${randomUUID()}`;
  ok(reach('call', receiver, `Read your inbox. Accept your actual task card ${receiverId}; do not accept this call mail. Remain paused without task writes, then output ${acceptNonce}.`, '--expect', acceptNonce, '--timeout', '90', '--every', '1'));
  assert.equal(taskRows().find(row => row.message_id === receiverId && row.recipient === receiver)?.state, 'accepted');
  assert.ok(!existsSync(join(project, 'result.txt')));
  release = skill.split('## Release message\n\n```text\n')[1].split('\n```')[0];
  for (const [token, value] of Object.entries({ '<DIGEST>': digest, '<B_CARD_ID_OR_NO_CARD>': receiverId, '<RELEASE_NONCE>': releaseNonce })) release = release.replaceAll(token, value);
  release += `\nThe recovery initiator ${initiator} releases recorded owner authorization while original sender ${sender} is already stopped; this is not a response from that sender. X-Work: ${work}. Receiver: ${receiver}. Use your actual receiver card and preserve its Reply-To.`;
  const released = ok(reach('call', receiver, release, '--expect', `^HANDOFF_RELEASED ${releaseNonce}$`, '--timeout', '90', '--every', '1'));
  assert.ok(released.includes(`HANDOFF_RELEASED ${releaseNonce}`));
  await until(() => existsSync(join(project, 'result.txt')) && taskRows().some(row => row.message_id === receiverId && row.recipient === receiver && row.state === 'completed'), 'receiver did not complete the released task');
 }
  const finalTasks = taskRows();
  assert.equal(finalTasks.find(row => row.message_id === originalId && row.recipient === sender)?.state, 'cancelled');
  assert.equal(finalTasks.find(row => row.message_id === receiverId && row.recipient === receiver)?.state, 'completed');
  assert.equal(readFileSync(join(project, 'result.txt'), 'utf8'), '57\n');
  const answer = ok(reach('wait', '--as', owner, '--reply-to', receiverId, '--from', receiver, '--timeout', '2')).trim();
  assert.ok(answer.startsWith(`${join(state, owner)}/`), 'actual final report must arrive at the original Reply-To');
  const report = readFileSync(answer, 'utf8'); assert.match(report, /rebuilt/); assert.match(report, /absent-invoice-metadata/); assert.match(report, /completed/);
  const rows = transcript(); const order = [];
  for (const row of rows.filter(row => row.type === 'assistant')) for (const block of row.message.content) {
    if (block.type === 'text' && block.text.split('\n').includes(`HANDOFF_RELEASED ${releaseNonce}`)) order.push('release');
    if (block.type === 'tool_use' && ((['Write', 'Edit', 'MultiEdit'].includes(block.name) && /(?:^|\/)result\.txt$/.test(block.input.file_path ?? ''))
      || /(?:^|\s)>[>]?\s*['"]?[^\s;&|'"]*result\.txt|\btee\s+[^\n]*result\.txt|result\.txt['")\]]*\.write_text\b|\bwriteFile(?:Sync)?\(['"][^'"]*result\.txt/.test(block.input.command ?? ''))) order.push('write');
  }
  assert.ok(order.includes('release') && order.includes('write') && order.indexOf('release') < order.indexOf('write'), JSON.stringify(order));
  const recallIds = new Set(rows.filter(row => row.type === 'assistant').flatMap(row => row.message.content)
    .filter(block => block.type === 'tool_use' && /sno memory recall/.test(block.input.command ?? '')).map(block => block.id));
  assert.ok(recallIds.size > 0, 'real receiver must perform scoped memory retrieval');
  assert.ok(rows.filter(row => row.type === 'user' && Array.isArray(row.message.content)).flatMap(row => row.message.content)
    .some(block => block.type === 'tool_result' && recallIds.has(block.tool_use_id) && JSON.stringify(block.content).includes(fixture.memory.id)),
  'the actual recall tool result, not the brief mentioning its id, must contain the stored fact');
  for (const payload of [launcher, release]) assert.equal(mailbox().filter(path => readFileSync(path, 'utf8').split('\n\nOriginal call text:\n')[1] === payload).length, 1, 'full call body must be saved once in receiver mailbox');
  const userText = rows.filter(row => row.type === 'user').flatMap(row => typeof row.message.content === 'string' ? [row.message.content] : row.message.content.filter(block => block.type === 'text').map(block => block.text));
  assert.ok(userText.some(text => text.startsWith('REACH-RING ') && !text.includes(readyNonce)), 'terminal receives the short cue, full launcher comes from mail');
  assert.ok(!userText.some(text => text.includes(launcher) || text.includes(release)), 'the full handoff payload is read from mail, never copied into terminal input');
  const commands = readFileSync(join(root, 'commands.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const releaseCall = commands.find(row => row.args[0] === 'reach' && row.args[1] === 'call' && row.args[2] === receiver && row.args[3] === release);
  assert.equal(releaseCall?.status, 0);
  assert.ok(releaseCall.stdout.split('\n').includes(`HANDOFF_RELEASED ${releaseNonce}`), 'Reach must observe the exact new receiver release line');
  proof.releaseObservation = { source: 'real Reach call output and native receiver transcript', recipient: receiver, card: receiverId, nonce: releaseNonce, output: releaseCall.stdout };
  proof.auxiliaryFailures = [];
  proof.squadOwnershipObservation = !releaseCall.stderr.includes('observation failed');
  if (!proof.squadOwnershipObservation) proof.auxiliaryFailures.push({ operation: 'record released work for squad display', target: receiver,
    error: releaseCall.stderr, impact: 'squad ownership observation unavailable; released task still completed' });
  const ledger = join(profile, 'observe/ledger.jsonl');
  const events = existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const buffer = join(profile, 'buffer.db');
  if (existsSync(buffer)) {
    const saved = invoke('python3', ['-c', 'import sqlite3,json,sys\ndb=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True)\nprint(json.dumps([json.loads(row[0]) for row in db.execute("SELECT payload FROM events ORDER BY rowid")]))', buffer]);
    if (saved.status === 0) events.push(...JSON.parse(saved.stdout));
    else proof.auxiliaryFailures.push({ operation: 'read saved Reach telemetry', target: buffer, error: saved.stderr, impact: 'persisted observation remains unproven' });
  }
  proof.persistedReleaseTelemetry = events.some(event => event.event_type === 'reach.message' && event.payload?.receipt === 'handoff_released');
  if (!proof.persistedReleaseTelemetry) proof.auxiliaryFailures.push({ operation: 'read saved Reach call telemetry', target: ledger,
    error: 'no persisted reach.message release event found in the isolated profile', impact: 'no saved statistics record; the real call output and receiver release receipt remain available' });
  proof.sourceActions = readFileSync(join(root, 'source-actions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(proof.sourceActions.at(-1)?.event, 'source task execution stopped');
  const actualCard = mailbox().map(path => readFileSync(path, 'utf8')).find(text => text.split('\n').some(line => line.toLowerCase() === `message-id: ${receiverId}`));
  assert.ok(actualCard, 'retain the actual receiver task card');
  assert.ok(actualCard.split('\n').some(line => line.startsWith('To:') && line.includes(`<${receiver}>`)));
  assert.ok(actualCard.split('\n').some(line => line.startsWith('Reply-To:') && line.includes(`<${owner}>`)));
  assert.ok(actualCard.split('\n').includes(`X-Work: ${work}`));
  proof.checks = { sourceStopped: true, originalCancelledByRealSenderBeforeExit: true, sameWorkAndReplyTo: true, receiverRecipient: receiver, receiverCard: receiverId,
    releaseNonce, releaseBeforeWrite: true, realScopedRecall: fixture.memory.id, actualResult: '57\n', nextAction: 'completed', recovery: 'rebuilt', originalConversation: 'lost', fullPayloadInMailboxAndShortCue: true, releaseObservation: true };
  proof.models = [...new Set(rows.filter(row => row.type === 'assistant').map(row => row.message.model))];
  proof.transcript = rows; proof.taskRows = finalTasks; proof.report = report;
  proof.functional_passed = true; proof.passed = proof.persistedReleaseTelemetry;
  proof.acceptance = proof.passed ? 'passed' : 'partial: real transfer completed; persisted release observation is unproven';
  if (!proof.passed) process.exitCode = 2;
  console.log(JSON.stringify({ functional_passed: true, passed: proof.passed, persistedReleaseTelemetry: proof.persistedReleaseTelemetry,
    squadOwnershipObservation: proof.squadOwnershipObservation, acceptance: proof.acceptance, checks: proof.checks, models: proof.models,
    auxiliaryFailures: proof.auxiliaryFailures, verificationMode: proof.verificationMode, evidence: root }));
} catch (error) { proof.failure = error.stack; process.exitCode = 1; console.error(error); }
finally {
  if (!proof.transcript) proof.transcript = transcript();
  writeFileSync(join(root, 'proof.json'), JSON.stringify(proof, null, 2));
  if (mode !== 'verify') cleanupCreated();
  console.log(`evidence: ${root}`);
}
