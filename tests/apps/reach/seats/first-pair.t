#!/usr/bin/env bash
# Process actors test composition and real Maildir assignment, not agent judgment.
set -Eeuo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python3 - "$here/../../../../apps/reach" "$@" <<'PY'
import atexit, json, os, pathlib, subprocess, sys, tempfile, time
app=pathlib.Path(sys.argv[1]).resolve(); proof=pathlib.Path(tempfile.mkdtemp(prefix='reach-first-pair.'))
print('evidence:',proof,flush=True)
commands=proof/'commands';commands.mkdir(); real_tmux=subprocess.check_output(['which','tmux'],text=True).strip()
actor='''#!/usr/bin/env python3
import email,json,os,pathlib,re,subprocess,sys,time
kind=pathlib.Path(sys.argv[0]).name; root=pathlib.Path(os.environ['PAIR_FIXTURE']);config=json.loads((root/'config.json').read_text());args=sys.argv[1:]
entry=config.get(kind,{});signed=entry.get('signed',False)
if args[:2]==['auth','status'] and kind=='claude':print(json.dumps({'loggedIn':signed}));sys.exit(0)
if args[:2]==['login','status']:print('Logged in using ChatGPT' if signed else 'Not logged in');sys.exit(0 if signed else 1)
if args[:1]==['status'] and kind=='cursor-agent':print(json.dumps({'isAuthenticated':signed}));sys.exit(0)
if args[:2]==['fallback','list']:print('Primary: gpt-fixture (provider: openai-codex)');sys.exit(0)
if args[:2]==['auth','status']:print('openai-codex: logged '+('in' if signed else 'out'));sys.exit(0)
if args[:3]==['models','status','--json']:print(json.dumps({'defaultModel':'anthropic/claude-fixture','auth':{'oauth':{'profiles':[{'provider':'anthropic','status':'ok'}] if signed else []},'missingProviders':[] if signed else ['anthropic']}}));sys.exit(0)
if args[:3]==['agents','list','--json']:print('[{"id":"main","isDefault":true}]');sys.exit(0)
subprocess.run(['stty','-echo'],check=True);seat=os.environ['SNO_REACH_ADDR'];state=pathlib.Path(os.environ['SNO_REACH_ROOT']);reach=os.environ['PAIR_REACH']
with (root/'launches.jsonl').open('a') as f:f.write(json.dumps({'seat':seat,'kind':kind,'args':args})+'\\n')
print('connected | idle' if kind=='openclaw' else 'READY fake pair actor',flush=True)
for line in sys.stdin:
 m=re.search(r'REACH-RECEIPT-[0-9]+-[0-9]+-[0-9]+',line)
 if m:print(m.group(),flush=True)
 if 'REACH-RING' not in line:continue
 mails=[]
 for path in (state/seat/'new').glob('*'):
  msg=email.message_from_string(path.read_text());mails.append((path,msg,msg.get_payload()))
 roles=[x for x in mails if 'Role: '+('Reviewer' if seat.split('@')[0].endswith('-review') else 'Implementer') in x[2]]
 if not roles:continue
 path,msg,body=roles[0]
 if not (root/(seat+'.accepted')).exists():
  subprocess.run([reach,'reply','--as',seat,'--card',str(path),'--state','accepted'],input='Accepted.\\n',text=True,check=True)
  (root/(seat+'.accepted')).touch()
 if seat.split('@')[0].endswith('-impl'):
  if (root/(seat+'.result')).exists():continue
  (root/(seat+'.result')).touch();partner=re.search(r'^Partner: (.+)$',body,re.M).group(1)
  card='From: Implementer <'+seat+'>\\nTo: Reviewer <'+partner+'>\\nReply-To: Implementer <'+seat+'>\\nDate: '+email.utils.formatdate(localtime=True)+'\\nSubject: [DECISION] Implementation result\\nMessage-ID: <result-'+str(time.time_ns())+'@fixture>\\nX-Type: decision\\nX-Work: '+msg['X-Work']+'\\n\\nImplementation result: fixture completed its task.\\n'
  subprocess.run([reach,'send','--as',seat],input=card,text=True,check=True)
 else:
  if any('Implementation result: fixture' in b for p,m,b in mails):
   subprocess.run([reach,'reply','--as',seat,'--card',str(path)],input='No defects found in the fixture result.\\n',text=True,check=True)
'''
for kind in ['claude','codex','cursor-agent','hermes','openclaw']:
 p=commands/kind;p.write_text(actor);p.chmod(0o755)
socket='reach-pair-fixture-'+str(os.getpid())
(commands/'tmux').write_text('#!/usr/bin/env python3\n'+f'''import os,pathlib,subprocess,sys
root=pathlib.Path(os.environ['PAIR_FIXTURE']);args=sys.argv[1:]
if args[:1]==['new-session'] and '-s' in args and args[args.index('-s')+1].startswith('reach-'):
 n=int((root/'spawns').read_text())+1 if (root/'spawns').exists() else 1;(root/'spawns').write_text(str(n))
 if (root/'fail-second').exists() and n==2:print('fixture second spawn failed',file=sys.stderr);sys.exit(1)
sys.exit(subprocess.call([{real_tmux!r},'-L',{socket!r}]+args))
''');(commands/'tmux').chmod(0o755)
base={k:v for k,v in os.environ.items() if not k.startswith(('SNO_REACH_','CLAUDE','CODEX','CURSOR'))}
base|={'PATH':str(commands)+':'+os.environ['PATH'],'PAIR_FIXTURE':str(proof),'PAIR_REACH':str(app/'bin/sno-reach')}
subprocess.run([real_tmux,'-L',socket,'-f','/dev/null','new-session','-d','-s','fixture','cat'],check=True,env=base)
atexit.register(lambda:subprocess.run([real_tmux,'-L',socket,'kill-server'],capture_output=True))

def run_case(name,config,order,expected,fail=False):
 if sys.argv[2:] and name not in sys.argv[2:]:return
 home=proof/name;home.mkdir();(home/'.config/sno').mkdir(parents=True)
 (home/'.config/sno/models.toml').write_text('[models]\nhandoff_order="'+order+'"\n')
 (proof/'config.json').write_text(json.dumps(config));(proof/'spawns').unlink(missing_ok=True)
 (proof/'launches.jsonl').unlink(missing_ok=True)
 if fail:(proof/'fail-second').touch()
 else:(proof/'fail-second').unlink(missing_ok=True)
 env=base|{'HOME':str(home),'XDG_CONFIG_HOME':str(home/'.config'),'SNO_REACH_ROOT':str(home/'state'),'SNO_PROFILE_DIR':str(home/'.sno')}
 start=time.monotonic();r=subprocess.run([str(app/'bin/sno-reach'),'pair','Implement the fixture task and have the partner review it.'],env=env,cwd=proof,capture_output=True,text=True,timeout=45)
 (home/'stdout').write_text(r.stdout);(home/'stderr').write_text(r.stderr)
 if not expected:
  assert r.returncode==3,(name,r.returncode,r.stdout,r.stderr)
  assert not (proof/'launches.jsonl').exists();assert 'no usable signed-in' in r.stderr
 else:
  assert r.returncode==(1 if fail else 0),(name,r.returncode,r.stdout,r.stderr)
  rows=[json.loads(s) for s in (proof/'launches.jsonl').read_text().splitlines()]
  assert [x['kind'] for x in rows]==expected,(name,rows)
  seats=[p for p in (home/'state').iterdir() if p.name.startswith('executor.')]
  cards=[p for seat in seats for p in (seat/'new').glob('*')]+[p for seat in seats for p in (seat/'cur').glob('*')]
  bodies=[p.read_text() for p in cards]
  assert any('Role: Implementer' in b and 'fixture task' in b for b in bodies)
  if fail:assert 'only implementer started' in r.stderr
  else:
   assert any('Role: Reviewer' in b and 'Do not independently implement' in b for b in bodies)
   assert 'No defects found in the fixture result.' in r.stdout
   view=subprocess.run([str(app/'lib/reach-agent-view')],env=env,capture_output=True,text=True,timeout=20)
   items=[json.loads(line) for line in view.stdout.splitlines() if line.strip()]
   assert not [x for x in items if 'handoff_to' in x],(name,items)
   assert {x['recipient'] for x in items if x['recipient'].startswith('executor.')}=={p.name for p in seats},(name,items)
 print('PASS',name,'elapsed',round(time.monotonic()-start,2),flush=True)
run_case('unknown-first',{'cursor-agent':{'signed':True},'claude':{'signed':True},'codex':{'signed':True}},'cursor,claude-code,codex',['claude','codex'])
run_case('two-vendors',{'claude':{'signed':True},'codex':{'signed':True}},'claude-code,codex',['claude','codex'])
run_case('claude-only',{'claude':{'signed':True}},'claude-code,codex',['claude','claude'])
run_case('codex-only',{'codex':{'signed':True}},'claude-code,codex',['codex','codex'])
run_case('none',{},'claude-code,codex',[])
run_case('second-launch-failure',{'claude':{'signed':True}},'claude-code',['claude'],True)
run_case('hermes-provider',{'hermes':{'signed':True}},'hermes',['hermes','hermes'])
run_case('openclaw-provider',{'openclaw':{'signed':True}},'openclaw',['openclaw','openclaw'])
run_case('cursor-unknown-vendor',{'cursor-agent':{'signed':True}},'cursor',['cursor-agent','cursor-agent'])
PY
