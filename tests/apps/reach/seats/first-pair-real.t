#!/usr/bin/env bash
# A scratch project and copied logins isolate real collaboration from live sessions.
set -Eeuo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python3 - "$here/../../../../apps/reach" "${1:?two-vendors, claude-only or cursor-only required}" "${2-}" <<'PY'
import atexit,email,json,os,pathlib,shutil,signal,subprocess,sys,tempfile,time,tomllib
run_started=time.monotonic()
app=pathlib.Path(sys.argv[1]).resolve();scenario=sys.argv[2]
if scenario not in ('two-vendors','claude-only','cursor-only'):raise SystemExit('unknown scenario')
# An explicit retained directory rechecks observations after a test-reader repair;
# it does not claim a second agent journey ran.
if sys.argv[3]:
 proof=pathlib.Path(sys.argv[3]);home=proof/'home';project=proof/'project'
 seed=json.loads((home/'.sno/seed-result.json').read_text())
 print('Rechecking retained real journey:',proof,flush=True)
else:
 source_home=pathlib.Path.home();proof=pathlib.Path(tempfile.mkdtemp(prefix='reach-pair-real-'))
 home=proof/'home';project=proof/'project';commands=proof/'commands'
 for p in [home,project,commands,home/'.claude',home/'.codex',home/'.config/sno',home/'.config/sno-reach']:p.mkdir(parents=True,exist_ok=True)
 print('evidence:',proof,flush=True)
 auth_targets=[]
 def cleanup_auth():
  for target in auth_targets:target.unlink(missing_ok=True)
 atexit.register(cleanup_auth)
 credentials=[(source_home/'.config/cursor/auth.json',home/'.config/cursor/auth.json')] if scenario=='cursor-only' else [(source_home/'.claude/.credentials.json',home/'.claude/.credentials.json')]+([] if scenario=='claude-only' else [(pathlib.Path(os.environ.get('CODEX_HOME',str(source_home/'.codex')))/'auth.json',home/'.codex/auth.json')])
 for source,target in credentials:
  if not source.is_file():print('UNAVAILABLE: isolated login source absent for',target.name,flush=True);raise SystemExit(2)
  target.parent.mkdir(parents=True,exist_ok=True)
  auth_targets.append(target)
  shutil.copyfile(source,target);target.chmod(0o600)
 order={'two-vendors':'claude-code,codex','claude-only':'claude-code','cursor-only':'cursor'}[scenario]
 (home/'.config/sno/models.toml').write_text('[models]\nhandoff_order="'+order+'"\n')
 (home/'.config/sno/cli.json').write_text('{"auto":{"enabled":false}}\n')
 (home/'.config/sno/assemble.json').write_text(json.dumps({'generation':'test','files':{},'directories':[],'skills_version':'','skill_destinations':{},'contract_sha256':'','requirements_fixture_sha256':'','hooks':[],'timer':False,'programs':{'reach':{'version':(app/'VERSION').read_text().strip(),'sha256':'','entry':str(app/'bin/sno-reach'),'dependencies':[]}}}))
 claude_version=subprocess.check_output(['claude','--version'],text=True).strip()
 (home/'.claude/.claude.json').write_text(json.dumps({'hasCompletedOnboarding':True,'lastOnboardingVersion':claude_version.split()[0],'bypassPermissionsModeAccepted':True,'projects':{str(project):{'hasTrustDialogAccepted':True}}}))
 # Preserve the selected model without copying hooks, unrelated paths or credentials in config.
 source_config=pathlib.Path(os.environ.get('CODEX_HOME',str(source_home/'.codex')))/'config.toml'
 config=tomllib.loads(source_config.read_text()) if source_config.exists() else {}
 selected={k:config[k] for k in ('model','model_reasoning_effort','model_provider') if k in config}
 text=''.join(k+' = '+json.dumps(v)+'\n' for k,v in selected.items())
 provider=selected.get('model_provider')
 if provider and provider in config.get('model_providers',{}):
  text+='\n[model_providers.'+provider+']\n'
  for k,v in config['model_providers'][provider].items():
   if k in ('name','base_url','wire_api','requires_openai_auth'):text+=k+' = '+json.dumps(v)+'\n'
 text+='\n[projects.'+json.dumps(str(project))+']\ntrust_level = "trusted"\n'
 (home/'.codex/config.toml').write_text(text)
 real_tmux=shutil.which('tmux');socket='reach-pair-real-'+str(os.getpid())
 (commands/'tmux').write_text('#!/usr/bin/env bash\nexec '+shutil.which('tmux')+' -L '+socket+' "$@"\n');(commands/'tmux').chmod(0o755)
 env={k:v for k,v in os.environ.items() if not k.startswith(('SNO_REACH_','CLAUDE','CODEX','CURSOR'))}
 env|={'HOME':str(home),'CODEX_HOME':str(home/'.codex'),'CLAUDE_CONFIG_DIR':str(home/'.claude'),'SNO_PROFILE_DIR':str(home/'.sno'),'XDG_CONFIG_HOME':str(home/'.config'),'XDG_STATE_HOME':str(home/'.local/state'),'XDG_CACHE_HOME':str(home/'.cache'),'SNO_REACH_ROOT':str(proof/'state'),'PATH':str(commands)+':'+os.environ['PATH'],'TERM':'xterm-256color','DISABLE_AUTOUPDATER':'1'}
 if scenario=='cursor-only':
  # Existing Cursor E2E convention: its streaming transport does not survive HTTP proxies.
  for key in ('HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy'):env.pop(key,None)
  print('Cursor CLI:',subprocess.check_output(['cursor-agent','--version'],text=True).strip(),flush=True)
 subprocess.run([real_tmux,'-L',socket,'-f','/dev/null','new-session','-d','-s','fixture','cat'],env=env,check=True,timeout=10)
 def cleanup():subprocess.run([real_tmux,'-L',socket,'kill-server'],capture_output=True,timeout=10)
 atexit.register(cleanup)
 subprocess.run(['git','init','-q',str(project)],check=True,timeout=10)
 (project/'README.md').write_text('Scratch addition project. Implement addition in add.py.\n')
 installed=pathlib.Path(os.environ['SNO_INSTALLED_PREFIX'])/'lib/node_modules' if os.environ.get('SNO_INSTALLED_PREFIX') else pathlib.Path(subprocess.check_output(['npm','root','-g'],text=True).strip())
 memory=installed/'@snoai/memory'
 seed_source=r"""
 import assert from 'node:assert/strict';
 import {randomBytes,randomUUID} from 'node:crypto';
 import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
 import {pathToFileURL} from 'node:url';
 const [project,profile,memory,cache]=process.argv.slice(2);
 const settings=JSON.parse(readFileSync(memory+'/settings.default.json','utf8'));
 settings.mode='local-first';
 settings.store={...settings.store,path:profile+'/memory.sqlite',encryptionKey:randomBytes(32).toString('hex')};
 settings.memoryPackage={path:memory,node:process.execPath};
 settings.embedding={...settings.embedding,cacheDir:cache,offline:true};
 settings.rerank={...settings.rerank,mode:'none'};
 settings.rem={...settings.rem,tick:false};
 settings.telemetry={...settings.telemetry,memoryUsage:{...settings.telemetry.memoryUsage,enabled:false},observe:{...settings.telemetry.observe,enabled:false}};
 settings.capture={...settings.capture,ambient:false};
 settings.recall={...settings.recall,explicitLimit:5,prompt:{...settings.recall.prompt,minChars:0,minScore:0}};
 mkdirSync(profile,{recursive:true});
 writeFileSync(profile+'/settings.json',JSON.stringify(settings)+'\n',{mode:0o600});
 process.env.SNO_PROFILE_DIR=profile;
 const {connect}=await import(pathToFileURL(memory+'/dist/client.js'));
 const client=await connect({skinId:'codex'});
 assert.equal(client.degraded,false,client.error??client.reason);
 const scope={principal:client.principal,project,session:randomUUID(),host:{workspace:project}};
 const init=await client.init(scope,{skinId:'codex'});
 assert.equal(init.degraded,false,JSON.stringify(init));
 const marker='apricot-'+randomUUID();
 const fact='Tag Team shared project memory: the review word is '+marker+'.';
 const stored=await client.mutate({op:'store',content:fact,category:'episodic'},scope);
 assert.equal(stored.degraded,false,JSON.stringify(stored));
 assert.notEqual(stored.result.isError,true,JSON.stringify(stored));
 const id=stored.result.details.id;
 const read=await client.inspect({op:'get',id},scope);
 assert.equal(read.result.entry.text,fact);
 const result={id,marker,pid:client.pid,port:client.port,query:'Tag Team shared project memory review word'};
 writeFileSync(profile+'/seed-result.json',JSON.stringify(result)+'\n',{mode:0o600});
 console.log(JSON.stringify(result));
 """
 seed_command=['node','--input-type=module','-',str(project),str(home/'.sno'),str(memory),str(source_home/'.cache/sno-station/models')]
 seed_run=subprocess.run(seed_command,input=seed_source,text=True,capture_output=True,env=env,cwd=project,timeout=35)
 if seed_run.returncode:
  print('UNAVAILABLE: isolated installed memory seed failed:',seed_run.stderr,flush=True)
  raise SystemExit(2)
 seed=json.loads(seed_run.stdout.strip().splitlines()[-1])
 def cleanup_memory():
  try:os.kill(seed['pid'],signal.SIGTERM)
  except ProcessLookupError:pass
 atexit.register(cleanup_memory)
 print('seeded installed-memory fact id:',seed['id'],'private sidecar port:',seed['port'],flush=True)
 print('host:',os.uname().nodename,'Claude:',claude_version,'Codex:',subprocess.check_output(['codex','--version'],text=True).strip(),'selected model:',('Cursor client default; answering vendor unknown' if scenario=='cursor-only' else selected.get('model','client default')),'scenario:',scenario,flush=True)
 task='In this scratch project, implement integer addition as def add(a, b) in add.py and have the second agent review the result. Use Python assertions for add(2, 3)==5 and add(-2, 2)==0. The implementer sends changed paths and checks to its assigned reviewer through Reach. The reviewer reads add.py and returns concrete findings or an explicit no-defect result through Reach. Do not commit. Do not ask the owner anything. Complete only this tiny addition task.'
 task+=' Before implementation or review, EACH agent must run sno memory recall --harness H '+json.dumps(seed['query'])+' from this project, choosing H=claude for Claude Code, H=codex for Codex, or H=cursor for Cursor. Read the actual tool result and report the retrieved memory id in your Reach result or review. Do not read the isolated profile files for this fact; use the installed memory command. Both agents must do their own recall.'
 start=time.monotonic()
 with (proof/'stdout').open('w') as out,(proof/'stderr').open('w') as err:
  process=subprocess.Popen(['sno','reach','pair',task],cwd=project,env=env,stdout=out,stderr=err)
  try:rc=process.wait(timeout=max(1,235-(time.monotonic()-run_started)))
  except subprocess.TimeoutExpired:process.terminate();process.wait(timeout=10);rc=124
 print('pair exit:',rc,'elapsed:',round(time.monotonic()-start,2),flush=True)
 print((proof/'stdout').read_text(),flush=True)
 if rc:
  print((proof/'stderr').read_text(),flush=True)
  for seat in (proof/'state').glob('executor.*'):
   record=seat/'reachable.json'
   if record.exists():
    pane=json.loads(record.read_text()).get('identity',{}).get('value','')
    if pane: (proof/(seat.name+'.screen')).write_text(subprocess.run([real_tmux,'-L',socket,'capture-pane','-p','-S','-','-t',pane],capture_output=True,text=True).stdout)
  raise SystemExit(rc)
namespace={};exec((project/'add.py').read_text(),namespace)
assert namespace['add'](2,3)==5 and namespace['add'](-2,2)==0
roles={}
for seat in (proof/'state').glob('executor.*'):
 roles['reviewer' if '-review@' in seat.name else 'implementer']=seat
assert len(roles)==2
runtimes=[json.loads((roles[role]/'seat.json').read_text())['runtime'] for role in ('implementer','reviewer')]
assert runtimes=={'two-vendors':['claude','codex'],'claude-only':['claude','claude'],'cursor-only':['cursor-agent','cursor-agent']}[scenario],runtimes
print('verified seat runtimes:',runtimes,flush=True)
reviews=[]
for directory in ('new','cur'):
 for p in (roles['implementer']/directory).glob('*'):
  message=email.message_from_string(p.read_text())
  if roles['reviewer'].name in message.get('From','') and message.get('X-Type')=='answer':reviews.append(message.get_payload())
assert reviews and any(len(body.strip())>20 for body in reviews),reviews
print('PASS real addition file and reviewer answer delivered through Reach',flush=True)
if scenario=='cursor-only':
 records=[]
 for path in (home/'.sno/cursor/conversations').glob('*.json'):
  record=json.loads(path.read_text())
  if record.get('reach_addr') in {seat.name for seat in roles.values()}:records.append(record)
 print('Cursor recorded models:',[r.get('model') for r in records] or 'unknown; no installed conversation record',flush=True)
 print('UNPROVEN: actual answering vendor and each Cursor raw memory tool result require runtime records not exposed by this isolated setup.',flush=True)
 raise SystemExit(3)
# Match each runtime's real command invocation with its own tool-result record.
def recalled(runtime,record):
 if runtime=='claude':
  transcript=pathlib.Path(record['transcript']);paths=[transcript]
 else:
  paths=list((home/'.codex/sessions').rglob('rollout-*.jsonl'))
 for path in paths:
  if not path.is_file():continue
  rows=[]
  for line in path.read_text().splitlines():
   try:rows.append(json.loads(line))
   except json.JSONDecodeError:continue
  calls=set()
  for row in rows:
   if runtime=='claude':
    content=row.get('message',{}).get('content',[])
    if not isinstance(content,list):continue
    for item in content:
     if item.get('type')=='tool_use':
      command=json.dumps(item.get('input',{}))
      if 'sno memory recall' in command and seed['query'] in command and '--harness claude' in command:calls.add(item['id'])
     elif item.get('type')=='tool_result' and item.get('tool_use_id') in calls:
      output=json.dumps(item.get('content',''))
      if seed['marker'] in output and seed['id'] in output:return True
   elif row.get('type')=='response_item':
    payload=row.get('payload',{})
    if payload.get('type') in ('function_call','custom_tool_call'):
     command=payload.get('arguments',payload.get('input',''))
     if 'sno memory recall' in command and seed['query'] in command and '--harness codex' in command:calls.add(payload['call_id'])
    elif payload.get('type') in ('function_call_output','custom_tool_call_output') and payload.get('call_id') in calls:
     output=json.dumps(payload.get('output',''))
     if seed['marker'] in output and seed['id'] in output:return True
 return False
for role in ('implementer','reviewer'):
 runtime=json.loads((roles[role]/'seat.json').read_text())['runtime']
 record=json.loads((roles[role]/'transcript.json').read_text())
 assert recalled(runtime,record),(role,runtime,'own recall command/result did not return shared fact')
 print('PASS',role,runtime,'own installed-memory recall returned seeded fact',seed['id'],flush=True)
print('PASS complete real pair collaboration and shared project memory',scenario,flush=True)
PY
