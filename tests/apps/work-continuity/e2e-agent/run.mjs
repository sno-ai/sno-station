import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { writeSettingsFixture } from '../../../packages/memory/fixtures/settings-file-fixture.ts';
import { globalPrefixWith, realSno } from '../../support/real-sno.mjs';

const scenario = process.argv[2];
if (scenario?.startsWith('codex-') || scenario === 'claude-to-codex') {
  console.error('BLOCKED: the owner prohibits a nested Codex process; no real Codex scenario ran.');
  process.exit(2);
}
assert.ok(['claude-native-resume', 'claude-rebuild', 'claude-compact-lesson'].includes(scenario), 'select one work-continuity scenario');
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const skills = process.env.SNO_SKILLS_SOURCE;
assert.ok(skills, 'SNO_SKILLS_SOURCE is the skills source checkout');
const scripts = join(skills, 'skills/R-recursive-self-improvement/rem-reflect/skill/scripts');
const checkpoint = join(skills, 'skills/S-communication-and-handoff/handoff/skill/scripts/handoff-checkpoint');
const resume = join(skills, 'skills/S-communication-and-handoff/rotate-agent/skill/scripts/rotate-agent-resume');
const sno = realSno();
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const sourceHome = homedir();
const claude = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
mkdirSync(join(sourceHome, '.cache'), { recursive: true });
const root = mkdtempSync(join(sourceHome, '.cache/work-continuity-'));
const home = join(root, 'home'), project = join(root, 'project'), profile = join(home, '.sno'), config = join(home, '.claude');
for (const path of [home, project, profile, config, join(home, 'bin'), join(home, '.config/sno')]) mkdirSync(path, { recursive: true });
const prefix = globalPrefixWith({ '@snoai/mem-claude': join(repo, 'apps/mem-claude'), '@snoai/mem-codex': join(repo, 'apps/mem-codex'), '@snoai/memory': join(repo, 'packages/memory') });
const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: config, CODEX_HOME: join(home, '.codex'), SNO_PROFILE_DIR: profile,
  REM_REFLECT_STORE: join(root, 'experience'), XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'),
  XDG_CACHE_HOME: join(home, '.cache'), SNO_REACH_ROOT: join(root, 'reach'), npm_config_prefix: prefix,
  SNO_CAPTURE_SCRIPTED: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0', TERM: 'xterm-256color',
  PATH: `${join(home, 'bin')}:/usr/bin:/bin` };
for (const key of ['CLAUDECODE','CLAUDE_SESSION_ID','CODEX_THREAD_ID','SNO_REACH_ADDR','SNO_EXECUTOR_ADDR','SNO_REACH_SESSION_ID','TMUX','TMUX_PANE','CLAUDE_CODE_SIMPLE','CLAUDE_CODE_SAFE_MODE']) delete env[key];
for (const [name, path] of [['sno', sno], ['node', process.execPath], ['claude', claude]]) symlinkSync(path, join(home, 'bin', name));
const credential = join(process.env.CLAUDE_CONFIG_DIR ?? join(sourceHome, '.claude'), '.credentials.json');
copyFileSync(credential, join(config, '.credentials.json')); chmodSync(join(config, '.credentials.json'), 0o600);
const invoke = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: project, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options });
  appendFileSync(join(root, 'commands.jsonl'), JSON.stringify({ command, args, status: result.status, error: result.error?.message, stdout: result.stdout, stderr: result.stderr }) + '\n');
  assert.equal(result.error, undefined, result.error?.message);
  return result;
};
const requireOk = result => { assert.equal(result.status, 0, result.stderr || result.stdout); return result.stdout; };
requireOk(invoke('git', ['init', '-q']));
requireOk(invoke('git', ['-c','user.name=Continuity test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','Fixture']));
writeFileSync(join(project, 'numbers.csv'), '13,29,8\n');
const expected = '50\n';
const programs = { reach: join(repo, 'apps/reach/bin/sno-reach'), 'handoff-checkpoint': checkpoint, 'rotate-agent-resume': resume };
const rem = join(home, 'bin/rem-reflect');
writeFileSync(rem, `#!/usr/bin/env bash\nexec ${quote(process.execPath)} --experimental-strip-types ${quote(join(scripts, 'rem-reflect.ts'))} "$@"\n`, { mode: 0o755 });
programs['rem-reflect'] = rem;
writeFileSync(join(home, '.config/sno/cli.json'), JSON.stringify({ auto: { enabled: false } }));
writeFileSync(join(home, '.config/sno/assemble.json'), JSON.stringify({ generation: 'test', files: {}, directories: [], skills_version: '', skill_destinations: {}, contract_sha256: '', requirements_fixture_sha256: '', hooks: [], timer: false,
  memory_pieces: { memory: { location: join(prefix, 'lib/node_modules/@snoai/memory'), node: process.execPath } },
  programs: Object.fromEntries(Object.entries(programs).map(([name, entry]) => [name, { version: '1.0', sha256: '', entry, dependencies: [] }])) }));
const priorProfile = process.env.SNO_PROFILE_DIR;
process.env.SNO_PROFILE_DIR = profile;
writeSettingsFixture(profile, { mode: 'local-first', memoryPackage: { path: join(repo, 'packages/memory'), node: process.execPath },
  embedding: { cacheDir: join(sourceHome, '.cache/sno-station/models'), offline: true }, rerank: { mode: 'none' }, rem: { tick: false },
  telemetry: { memoryUsage: { enabled: false }, observe: { enabled: false } }, capture: { ambient: false },
  recall: { auto: true, explicitLimit: 5, prompt: { minChars: 0, minScore: 0 } } });
const { initializeStore, emptyState, git } = await import(pathToFileURL(join(scripts, 'store.ts')));
const { appendRows } = await import(pathToFileURL(join(scripts, 'lessons.ts')));
mkdirSync(env.REM_REFLECT_STORE);
initializeStore(env.REM_REFLECT_STORE, { claude_home: config, codex_home: env.CODEX_HOME, hermes_home: join(home, '.hermes'), openclaw_home: join(home, '.openclaw'),
  claude_root: join(config, 'projects'), codex_root: join(env.CODEX_HOME, 'sessions'), cursor_root: join(home, '.cursor'), project_names: {}, time_zone: 'UTC' }, emptyState());
appendRows(join(env.REM_REFLECT_STORE, 'wiki/lessons.jsonl'), [{ lesson_id: 'L-continuity-report', page_id: 'pg-continuity', status: 'candidate', listed: true,
  count: 2, helped: 0, harmful: 0, measured: false, created_run: '20261103-0000', project_id: 'fixture', agent_id: 'claude-code', user_id: 'fixture', skill_target: null, applies_to: 'general',
  situation: { task_type: 'file processing', trigger: 'report this sum task', tools: ['Bash'] }, scenario: { task_type: 'file processing', trigger: 'report this sum task', tools: ['Bash'] },
  advice: "When replying about this task, begin with exactly 'Verified result:'.", because: 'The task report must identify a verified result.', expected_result: "Every task reply starts with 'Verified result:'.",
  success_criteria: "The next ordinary reply and the postcompact completion reply begin with 'Verified result:'.", memory_fact_ids: [], polarity: 'from_failure', evidence: [], counter_examples: 'not searched' }]);
git(env.REM_REFLECT_STORE, ['add', 'config.json','state.json','.gitignore','wiki/lessons.jsonl']); git(env.REM_REFLECT_STORE, ['commit','-qm','Fixture lesson']);
const observed = join(root, 'hooks.jsonl');
const observer = join(root, 'observe-hook.mjs');
writeFileSync(observer, `import {readFileSync,appendFileSync} from 'node:fs'; import {spawnSync} from 'node:child_process';
const raw=readFileSync(0,'utf8'); const result=spawnSync(${JSON.stringify(sno)},['memory','hook',process.argv[2],'--harness','claude'],{input:raw,encoding:'utf8',timeout:20000});
appendFileSync(${JSON.stringify(observed)},JSON.stringify({event:process.argv[2],input:JSON.parse(raw),status:result.status,stdout:result.stdout,stderr:result.stderr})+'\\n');
process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status??1);\n`);
const server = `continuity-${process.pid}`;
const mux = (...args) => requireOk(invoke('tmux', ['-L',server,...args], { timeout: 15_000 }));
const hooks = () => existsSync(observed) ? readFileSync(observed,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)) : [];
let client, pane, session = randomUUID();
const transcript = () => {
  const walk = path => existsSync(path) ? readdirSync(path,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(join(path,entry.name)):entry.name===`${session}.jsonl`?[join(path,entry.name)]:[]) : [];
  const path = walk(join(config,'projects'))[0];
  return path ? readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)) : [];
};
const replies = () => transcript().filter(row=>row.type==='assistant').flatMap(row=>row.message.content).filter(block=>block.type==='text').map(block=>block.text);
async function until(check, label, seconds=110) {
  const deadline=Date.now()+seconds*1000;
  while(Date.now()<deadline) { if(check()) return; await delay(250); }
  if(pane) writeFileSync(join(root,'failure-screen.txt'),mux('capture-pane','-p','-t',pane,'-S','-'));
  throw new Error(`${label}; evidence ${root}`);
}
function send(text) { mux('send-keys','-t',pane,'-l','--',text); mux('send-keys','-t',pane,'Enter'); }
const briefPath=()=>join(profile,'station/handoff',`${session}.md`);
const proof={scenario,host:hostname(),source:repo,profile,session,checks:{},models:[]};
try {
  const { connect } = await import('../../../../packages/memory/dist/client.js');
  client=await connect({skinId:'mem-claude'}); assert.equal(client.degraded,false,client.error??client.reason);
  const scope={principal:client.principal,project,session:'fixture-seed',host:{workspace:project}};
  assert.equal((await client.init(scope,{skinId:'mem-claude'})).degraded,false);
  const fact='The work-continuity sum task input is numbers.csv; report the sum after checking the actual input.';
  const stored=await client.mutate({op:'store',content:fact,category:'episodic'},scope);
  assert.equal(stored.degraded,false,JSON.stringify(stored)); assert.equal(stored.result.isError,false,JSON.stringify(stored));
  proof.memory={id:stored.result.details.id,pid:client.pid,endpoint:`http://127.0.0.1:${client.port}`};
  requireOk(invoke(process.execPath,[join(repo,'apps/mem-claude/dist/cli.js'),'install','--config-dir',config],{env:{...env,SNO_EXECUTABLE:sno}}));
  console.log(JSON.stringify({phase:'isolated source hooks installed',scenario,session,memory:proof.memory,evidence:root}));
  const hookSettings=JSON.parse(readFileSync(join(config,'settings.json'),'utf8'));
  for(const groups of Object.values(hookSettings.hooks)) for(const group of groups) for(const hook of group.hooks) {
    const event=/memory hook (\S+) --harness claude$/.exec(hook.command)?.[1];
    if(event) hook.command=`${quote(process.execPath)} ${quote(observer)} ${event}`;
  }
  hookSettings.autoMemoryEnabled=false; hookSettings.sandbox={enabled:false};
  hookSettings.permissions.allow.push('Bash', 'Read', 'Write', 'Edit');
  writeFileSync(join(config,'settings.json'),JSON.stringify(hookSettings));
  const onboarding={hasCompletedOnboarding:true,bypassPermissionsModeAccepted:true,projects:{[project]:{hasTrustDialogAccepted:true}}};
  writeFileSync(join(config,'.claude.json'),JSON.stringify(onboarding)); writeFileSync(join(home,'.claude.json'),JSON.stringify(onboarding));
  const begin='Work only in this disposable sum task; do not commit. First run cat absent-input.txt once and retain its actual failure. The authorized unfinished action is to read numbers.csv, sum all comma-separated integers, and write the decimal sum plus newline to result.txt. Do not do that unfinished action in this first turn. Preserve your current task through the installed continuity instructions, including the failed operation and expected result, then pause. Before work or continuation, use sno memory recall --harness claude "work-continuity sum task input" and read the actual returned fact. Reply READY_FOR_CONTINUATION when your task record is saved and you are waiting.';
  mux('-f','/dev/null','new-session','-d','-x','240','-y','40','-s','fixture','cat');
  env.TMUX=mux('display-message','-p','#{socket_path},#{pid},0').trim();
  pane=mux('new-window','-d','-P','-F','#{pane_id}','-t','fixture','-n','source',`${quote(claude)} --dangerously-skip-permissions --session-id ${session} ${quote(begin)}`).trim();
  await until(()=>replies().some(text=>text.includes('READY_FOR_CONTINUATION')),'source task did not pause');
  assert.ok(existsSync(briefPath()),'the source agent must save the product brief itself');
  assert.match(readFileSync(briefPath(),'utf8'),/absent-input/); assert.ok(!existsSync(join(project,'result.txt')),'the next action must remain unfinished');
  proof.checks.sourceSavedBrief=true;
  console.log(JSON.stringify({phase:'real agent saved unfinished task',scenario,session,evidence:root}));
  if(scenario==='claude-compact-lesson') {
    requireOk(invoke(sno,['rem-reflect','accept','L-continuity-report','--all-projects']));
    const count=replies().length; send('Report whether you are ready to continue; leave files unchanged.');
    await until(()=>replies().slice(count).some(text=>text.startsWith('Verified result:')),'same-process next reply did not follow locally approved lesson');
    assert.ok(!existsSync(join(project,'result.txt'))); proof.checks.immediateApproval=true;
    console.log(JSON.stringify({phase:'same-process next reply applied local approval',session}));
    send('/compact');
    await until(()=>transcript().some(row=>row.type==='system'&&row.subtype==='compact_boundary'),'actual manual compaction did not occur');
    await until(()=>hooks().some(row=>row.event==='session-start'&&row.input.source==='compact'),'actual postcompact session boundary did not run');
    const countAfter=replies().length; send('Continue.');
    await until(()=>existsSync(join(project,'result.txt')),'postcompact task action did not complete');
    await until(()=>replies().slice(countAfter).some(text=>text.startsWith('Verified result:')&&/absent-input/.test(text)),'postcompact answer lost the lesson or failed operation');
    assert.ok(hooks().some(row=>row.event==='pre-compact'&&row.input.trigger==='manual'));
    proof.checks.actualCompaction=true; proof.checks.postcompactLessonAndFailure=true;
  } else {
    mux('kill-pane','-t',pane); pane=undefined;
    if(scenario==='claude-native-resume') {
      const continued=invoke(sno,['rotate-agent-resume','--to','claude-code','--cwd',project,'--checkpoint',briefPath(),'--work','native-sum'],{timeout:240_000});
      requireOk(continued); assert.match(continued.stdout,/resumed/); proof.recovery=continued.stdout;
    } else {
      const old=briefPath();
      const findNative = path => readdirSync(path,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?findNative(join(path,entry.name)):entry.name===`${session}.jsonl`?[join(path,entry.name)]:[]);
      const native=findNative(join(config,'projects'))[0]; assert.ok(native);
      renameSync(native,join(root,'unavailable-original-transcript.jsonl'));
      const rebuilt=invoke(sno,['rotate-agent-resume','--to','claude-code','--cwd',project,'--checkpoint',old,'--work','rebuilt-sum'],{timeout:240_000});
      requireOk(rebuilt); assert.match(rebuilt.stdout,/rebuilt/); proof.recovery=rebuilt.stdout;
      const receiver=`resume.rebuilt-sum-claude-code@${hostname().toLowerCase()}`;
      const metadata=JSON.parse(readFileSync(join(env.SNO_REACH_ROOT,receiver,'transcript.json'),'utf8'));
      session=basename(metadata.transcript,'.jsonl'); proof.receiverSession=session;
      await until(()=>existsSync(join(project,'result.txt')),'scripted rebuilt receiver did not complete the next action');
      await until(()=>replies().some(text=>/absent-input/.test(text)&&/rebuilt/.test(text)),'rebuilt receiver did not report conversation loss and failed operation');
    }
    assert.ok(existsSync(join(project,'result.txt')),'recovery must perform the unfinished action, not only acknowledge a brief');
  }
  assert.equal(readFileSync(join(project,'result.txt'),'utf8'),expected);
  const events=transcript();
  assert.ok(events.some(row=>row.type==='assistant'&&row.message.content.some(block=>block.type==='tool_use'&&block.name==='Bash'&&/sno memory recall/.test(block.input.command))),'continuing real agent must execute actual scoped retrieval');
  assert.ok(events.some(row=>row.type==='user'&&JSON.stringify(row).includes(stored.result.details.id)),'actual receiver tool output must include the retrieved fact ID');
  proof.models=[...new Set(events.filter(row=>row.type==='assistant').map(row=>row.message.model))];
  proof.checks.output=expected; proof.passed=true;
  console.log(JSON.stringify({scenario,passed:true,checks:proof.checks,models:proof.models,host:proof.host,evidence:root}));
} catch(error) { proof.failure=error.stack; console.error(error); process.exitCode=1; }
finally {
  proof.hooks=hooks(); proof.transcript=transcript(); writeFileSync(join(root,'proof.json'),JSON.stringify(proof,null,2));
  spawnSync('tmux',['-L',server,'kill-server'],{env,timeout:5000});
  if(client?.pid) { try { process.kill(client.pid,'SIGTERM'); } catch(error) { if(error.code!=='ESRCH') console.error(error); } }
  rmSync(join(config,'.credentials.json'),{force:true}); rmSync(prefix,{recursive:true,force:true});
  if(priorProfile===undefined) delete process.env.SNO_PROFILE_DIR; else process.env.SNO_PROFILE_DIR=priorProfile;
  console.log(`evidence: ${root}`);
}
