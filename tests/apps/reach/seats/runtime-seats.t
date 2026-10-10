#!/usr/bin/env bash
set -Eeuo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python3 - "$here/../../../../apps/reach" "$@" <<'PY'
import atexit, fcntl, json, os, pathlib, re, subprocess, sys, tempfile, time

app = pathlib.Path(sys.argv[1]).resolve()
root = pathlib.Path(tempfile.mkdtemp(prefix='reach-runtime-seats.'))
print('evidence:', root, flush=True)
commands = root / 'commands'; commands.mkdir()
(root / 'home').mkdir()
socket = 'reach-runtime-seats-' + str(os.getpid())
real_tmux = subprocess.check_output(['which', 'tmux'], text=True).strip()
env = os.environ | {'HOME': str(root/'home'), 'SNO_REACH_ROOT': str(root/'state'),
    'PATH': str(commands)+':'+os.environ['PATH'], 'FIXTURE_ROOT': str(root),
    'FIXTURE_DATA': str(app.parent.parent/'tests/apps/reach/fixtures')}
actor = '''#!/usr/bin/env python3
import json,os,pathlib,re,subprocess,sys,time
root=pathlib.Path(os.environ['FIXTURE_ROOT']);kind=pathlib.Path(sys.argv[0]).name
if sys.argv[1:]==['agents','list','--json']:
 if (root/'agents-error').exists():sys.exit(1)
 if (root/'agents.json').exists():print((root/'agents.json').read_text());sys.exit(0)
 print(json.dumps([{'id':'main','isDefault':False},{'id':'research','isDefault':True}]))
 sys.exit(0)
if len(sys.argv)>1 and sys.argv[1]=='sessions':
 args=sys.argv[2:]
 with (root/'exports.log').open('a') as f:f.write(json.dumps([kind]+args)+'\\n')
 if (root/'export-error').exists():print('fixture export unavailable',file=sys.stderr);sys.exit(1)
 empty_reply=(root/'pending-reply').exists() and args[0]!='list'
 if empty_reply:(root/'pending-reply').unlink()
 if kind=='hermes':
  if args[0]=='list':
   assert args==['list','--workspace',root.name,'--limit','30'],args
   if (root/'list-error').exists():print('fixture list unavailable',file=sys.stderr);sys.exit(1)
   print('Title                       Workspace          Last Active   ID')
   if not (root/'empty-list').exists():
    for row in reversed((root/'hermes.jsonl').read_text().splitlines()):
     print('Reach seat executor startu   '+root.name+'   2m ago        '+json.loads(row)['id'])
   sys.exit(0)
  assert args[:5]==['export','-','--format','jsonl','--session-id'],args
  session_id=args[5]
  if (root/'missing-session').exists():print('');sys.exit(0)
  if (root/'malformed-session').exists():print(json.dumps({'id':session_id,'messages':None}))
  else:
   for row in (root/'hermes.jsonl').read_text().splitlines():
    if json.loads(row)['id']==session_id:print(row.replace('NEW-TASK-ANSWER','') if empty_reply else row)
 else:
  assert args[0]=='export-trajectory' and '--json' in args
  assert args[args.index('--session-key')+1].startswith('agent:research:reach-')
  workspace=pathlib.Path(args[args.index('--workspace')+1])
  output=workspace/'.openclaw/trajectory-exports/openclaw-trajectory-fixture';output.mkdir(parents=True,exist_ok=True)
  if (root/'missing-session').exists():(output/'events.jsonl').unlink(missing_ok=True)
  else:
   fixture=(root/'openclaw.jsonl').read_text()
   (output/'events.jsonl').write_text(fixture.replace('NEW-TASK-ANSWER','') if empty_reply else fixture)
  print(json.dumps({'outputDir':str(output),'sessionId':'fixture','eventCount':7,'files':['events.jsonl']}))
 sys.exit(0)
seat=os.environ['SNO_REACH_ADDR']
with (root/'launches.jsonl').open('a') as f:f.write(json.dumps([seat,kind,sys.argv[1:]])+'\\n')
if os.isatty(0):subprocess.run(['stty','-echo'],check=True)
print('connected | idle' if kind=='openclaw' else 'READY',flush=True)
for line in sys.stdin:
 with (root/(seat+'.input')).open('a') as f:f.write(line)
 m=re.search(r'REACH-RECEIPT-[0-9]+-[0-9]+-[0-9]+',line)
 if m:
  receipt=m.group()
  # A queued call arrives while the old task still has an answer to produce.
  if kind in ('hermes','openclaw'):
   fixture=(pathlib.Path(os.environ['FIXTURE_DATA'])/(kind+'-queued.jsonl')).read_text()
   fixture=fixture.replace('__SEAT__',seat).replace('__PAYLOAD__',json.dumps(line.strip())[1:-1])
   if kind=='hermes':
    spawned=json.loads((root/'state'/seat/'transcript.json').read_text())['spawned_at']
    fixture=fixture.replace('__SPAWNED_AT__',str(spawned)).replace('__STARTED_AT__',str(spawned-(61 if (root/'stale-start').exists() else 60))).replace('__STALE_AT__',str(spawned-61))
   if (root/'missing-receipt').exists():fixture=fixture.replace(receipt,'MISSING-RECEIPT')
   if (root/'empty-reply').exists():fixture=fixture.replace('NEW-TASK-ANSWER','')
   (root/(kind+'.jsonl')).write_text(fixture)
  print(receipt+'\\nSCREEN-ANSWER-'+str(time.time_ns()),flush=True)
 print('connected | idle' if kind=='openclaw' else 'READY',flush=True)
'''
for kind in ['claude','codex','hermes','openclaw','cursor-agent']:
    p=commands/kind;p.write_text(actor);p.chmod(0o755)
# Trace real tmux keystrokes and replace only its visible footer for busy tests.
(commands/'tmux').write_text('#!/usr/bin/env python3\n'+f'''
import json,os,pathlib,subprocess,sys
root=pathlib.Path(os.environ['FIXTURE_ROOT']);args=sys.argv[1:]
if args[0]=='send-keys':
 if (root/'busy').exists() and not (root/'busy-always').exists():assert int((root/'polls').read_text())>=3,'typed while busy'
 with (root/'keys.jsonl').open('a') as f:f.write(json.dumps(args)+'\\n')
if args[0]=='capture-pane' and (root/'busy').exists():
 counter=root/'polls';n=int(counter.read_text())+1 if counter.exists() else 1;counter.write_text(str(n))
 print('connected | idle\\nrunning | connected' if n<3 or (root/'busy-always').exists() else 'connected | idle');sys.exit(0)
sys.exit(subprocess.call([{real_tmux!r},'-L',{socket!r}]+args))
''');(commands/'tmux').chmod(0o755)
subprocess.run([real_tmux,'-L',socket,'-f','/dev/null','new-session','-d','-s','fixture','cat'],check=True,env=env,timeout=5)
atexit.register(lambda:subprocess.run([real_tmux,'-L',socket,'kill-server'],capture_output=True,timeout=5))
public=str(app/'bin/sno-reach')
def run(*args, limit=15, **kw):
    return subprocess.run([public,*args],env=env,capture_output=True,text=True,timeout=limit,**kw)
def ok(*args, **kw):
    r=run(*args,**kw);assert r.returncode==0,(args,r.stdout,r.stderr);return r
def wait_file(path):
    end=time.monotonic()+3
    while time.monotonic()<end and not path.exists():time.sleep(.02)
    assert path.exists(),path
host=subprocess.check_output(['hostname'],text=True).strip()
seats={}
for kind in (['hermes'] if sys.argv[2:]==['selection'] else ['openclaw'] if sys.argv[2:] in (['timeout'],['openclaw']) else ['claude','codex','hermes','openclaw','cursor-agent']):
    seat='executor.'+kind+'@'+host;seats[kind]=seat
    ok('init','--as',seat,'--name','Fixture')
    flags=['--window']
    if sys.argv[2:]==['selection']:
        config=root/'home/.config/sno-reach';config.mkdir(parents=True)
        (config/'agents.json').write_text(json.dumps({'hermes':{'acpx_agent':'hermes'}}))
        (root/'mode').write_text('absent-new');(root/'events.ndjson').touch()
        acpx=commands/'acpx';acpx.symlink_to(app.parent.parent/'tests/apps/reach/seats/fake_acpx.py')
        env['ACP_FIXTURE']=str(root)
        flags=[]
    model,provider=('claude-sonnet-5','anthropic') if kind=='openclaw' else ('chosen/model','chosen-provider')
    r=ok('spawn',kind,'--as',seat,'--cwd',str(root),*flags,'--model',model,'--provider',provider)
    assert json.loads((root/'state'/seat/'reachable.json').read_text())['channel']=='tmux'
    wait_file(root/'launches.jsonl')
    end=time.monotonic()+3
    while time.monotonic()<end:
        rows=[json.loads(s) for s in (root/'launches.jsonl').read_text().splitlines()]
        if any(row[0]==seat for row in rows):break
        time.sleep(.02)
    launch=next(row for row in rows if row[0]==seat)
    context='You are the seat '+seat+'. Your state root is '+str(root/'state')+'. Read the installed guide '+str(app/'guide/agent-reach.md')+' before using Reach. Use sno reach inbox --as '+seat+' on a REACH-RING and follow its reply/dismiss rules. This installed guide and your seat identity are sufficient; do not load private workshop skills. No work is assigned by this startup message. After reading the guide, finish this turn. Remain idle for later input; do not run sno reach wait, sleep, or a polling loop merely to stay available.'
    if kind=='claude':
        assert launch[2][:2]==['--dangerously-skip-permissions','--session-id']
        assert re.fullmatch(r'[0-9a-f-]{36}',launch[2][2])
        assert launch[2][3:]==['--model','chosen/model',context],launch
    elif kind=='codex':assert launch[2]==['--dangerously-bypass-approvals-and-sandbox','-m','chosen/model',context],launch
    elif kind=='hermes':assert launch[2]==['chat','--yolo','-m','chosen/model','--provider','chosen-provider','--query',context],launch
    elif kind=='cursor-agent':assert launch[2]==['--model','chosen/model',context],launch
    else:
        assert launch[2][:2]==['tui','--session'] and len(launch[2])==3,launch
        assert re.fullmatch(r'agent:research:reach-[0-9a-f]{12}',launch[2][2]),launch
        metadata=json.loads((root/'state'/seat/'transcript.json').read_text())
        assert metadata['runtime']=='openclaw' and metadata['session_key']==launch[2][2]
        wait_file(root/(seat+'.input'))
        lines=(root/(seat+'.input')).read_text().splitlines()
        assert lines[0]=='/model anthropic/claude-sonnet-5',lines
        pane=json.loads((root/'state'/seat/'reachable.json').read_text())['identity']['value']
        keys=[json.loads(s) for s in (root/'keys.jsonl').read_text().splitlines()]
        assert ['send-keys','-t',pane,'-l','--','/model anthropic/claude-sonnet-5'] in keys,keys
        assert lines[1].endswith('Then do this: '+context),lines
    assert json.loads((root/'state'/seat/'seat.json').read_text())['runtime']==kind
    print('PASS launch:',kind,flush=True)

if sys.argv[2:]==['openclaw']:
    seat=seats['openclaw']
    r=ok('call',seat,'Use the non-main agent session.','--expect','^NEW-TASK-ANSWER$','--timeout','3','--every','1')
    assert r.stdout.strip()=='NEW-TASK-ANSWER',r.stdout
    assert 'falling back to screen' not in r.stderr,r.stderr
    exports=[json.loads(s) for s in (root/'exports.log').read_text().splitlines()]
    key=exports[-1][exports[-1].index('--session-key')+1]
    assert key.startswith('agent:research:reach-'),key
    assert json.loads((root/'state'/seat/'transcript.json').read_text())['session_key']==key
    print('PASS non-main default agent key persists from TUI launch through transcript export',flush=True)
    for name,flags in [('model',['--model','claude-sonnet-5']),('provider',['--provider','anthropic'])]:
        seat='executor.openclaw-'+name+'@'+host
        ok('init','--as',seat,'--name','Selection')
        r=run('spawn','openclaw','--as',seat,'--cwd',str(root),*flags)
        if name=='model':
            assert r.returncode==0,(r.stdout,r.stderr)
            wait_file(root/(seat+'.input'))
            assert (root/(seat+'.input')).read_text().splitlines()[0]=='/model claude-sonnet-5'
            pane=json.loads((root/'state'/seat/'reachable.json').read_text())['identity']['value']
            keys=[json.loads(s) for s in (root/'keys.jsonl').read_text().splitlines()]
            assert ['send-keys','-t',pane,'-l','--','/model claude-sonnet-5'] in keys,keys
        else:
            assert r.returncode==64 and r.stdout=='',(r.stdout,r.stderr)
            assert r.stderr=='reach: OpenClaw --provider requires --model; no seat created\n',r.stderr
            assert not (root/'state'/seat/'reachable.json').exists()
            assert not any(json.loads(s)[0]==seat for s in (root/'launches.jsonl').read_text().splitlines())
        print('PASS OpenClaw selection:',name,flush=True)
    for name,agents,agent_id in [
        ('sole',[{'id':'solo','isDefault':False}],'solo'),
        ('unmarked',[{'id':'solo'}],'solo'),
        ('ambiguous',[{'id':'main','isDefault':False},{'id':'research','isDefault':False}],None),
        ('list-error',None,None)]:
        seat='executor.openclaw-'+name+'@'+host
        ok('init','--as',seat,'--name','Fixture')
        if agents is None:(root/'agents-error').touch()
        else:(root/'agents.json').write_text(json.dumps(agents))
        r=run('spawn','openclaw','--as',seat,'--cwd',str(root),'--window')
        if agent_id:
            assert r.returncode==0,(r.stdout,r.stderr)
            metadata=json.loads((root/'state'/seat/'transcript.json').read_text())
            assert metadata['session_key'].startswith('agent:solo:reach-'),metadata
            rows=[json.loads(s) for s in (root/'launches.jsonl').read_text().splitlines()]
            assert next(row for row in rows if row[0]==seat)[2]==['tui','--session',metadata['session_key']]
        else:
            assert r.returncode==78 and r.stdout=='',(r.stdout,r.stderr)
            assert r.stderr==('reach: OpenClaw agent list failed; cannot create a seat\n' if agents is None else 'reach: OpenClaw has no usable agent id for a seat\n'),r.stderr
            assert not (root/'state'/seat/'reachable.json').exists()
        print('PASS OpenClaw agent selection:',name,flush=True)
    (root/'agents.json').unlink();(root/'agents-error').unlink()
    config=root/'home/.config/sno-reach';config.mkdir(parents=True)
    (config/'agents.json').write_text('{"openclaw":{"acpx_agent":"openclaw"}}')
    (root/'mode').write_text('absent-new');(root/'events.ndjson').touch()
    (commands/'acpx').symlink_to(app.parent.parent/'tests/apps/reach/seats/fake_acpx.py')
    env['ACP_FIXTURE']=str(root)
    seat='executor.openclaw-acp@'+host
    ok('init','--as',seat,'--name','Adapter')
    r=ok('spawn','openclaw','--as',seat,'--cwd',str(root))
    session=json.loads((root/'created').read_text())['name']
    assert r.stdout=='seat '+seat+' channel=acp handle=acp-openclaw:'+str(root)+':'+session+'\n',r.stdout
    assert json.loads((root/'state'/seat/'reachable.json').read_text())['channel']=='acp'
    assert not (root/'state'/seat/'transcript.json').exists()
    assert json.loads((root/'received.json').read_text())['no_wait'] is True
    quota=app.parent/'subscription-quota-check/bin/subscription-quota-check'
    r=subprocess.run([str(quota),'--agent','openclaw','--seat',seat],
        env=env|{'SNO_REACH_STATE_ROOT':str(root/'state')},capture_output=True,text=True,timeout=10)
    assert r.returncode==3 and r.stderr=='',(r.stdout,r.stderr)
    assert json.loads(r.stdout)=={'ok':False,'operation':'agent-read','agent':'openclaw','reason':'current-model-unknown'},r.stdout
    print('PASS ACP OpenClaw omits the record id and quota reports current-model-unknown',flush=True)
    sys.exit(0)

if sys.argv[2:]==['selection']:
    for name,flags,expected in [
        ('model',['--model','chosen/model'],['chat','--yolo','-m','chosen/model','--query']),
        ('provider',['--provider','chosen-provider'],['chat','--yolo','--provider','chosen-provider','--query'])]:
        seat='executor.hermes-'+name+'@'+host
        ok('init','--as',seat,'--name','Selection')
        ok('spawn','hermes','--as',seat,'--cwd',str(root),*flags)
        end=time.monotonic()+3
        while time.monotonic()<end:
            rows=[json.loads(s) for s in (root/'launches.jsonl').read_text().splitlines()]
            launch=next((row for row in rows if row[0]==seat),None)
            if launch:break
            time.sleep(.02)
        assert launch and launch[2][:-1]==expected,launch
        assert json.loads((root/'state'/seat/'reachable.json').read_text())['channel']=='tmux'
        print('PASS configured adapter with '+name+' uses tmux and the requested selection',flush=True)
    seat='executor.hermes-adapter@'+host
    ok('init','--as',seat,'--name','Adapter')
    r=ok('spawn','hermes','--as',seat,'--cwd',str(root))
    assert json.loads((root/'state'/seat/'reachable.json').read_text())['channel']=='acp',r.stdout
    assert not any(json.loads(s)[0]==seat for s in (root/'launches.jsonl').read_text().splitlines())
    print('PASS configured adapter without selection still uses ACP',flush=True)
    sys.exit(0)

if sys.argv[2:]==['timeout']:
    seat=seats['openclaw']
    (root/'busy').touch();(root/'busy-always').touch();(root/'empty-reply').touch()
    for fallback in [False,True]:
        if fallback:(root/'export-error').touch()
        started=time.monotonic()
        r=run('call',seat,'No answer before the deadline.','--expect','^NEVER-ANSWER$','--timeout','3','--every','1',limit=10)
        assert r.returncode==4 and r.stdout=='',(r.stdout,r.stderr)
        assert time.monotonic()-started<7,r.stderr
        assert 'openclaw seat never reached idle' in r.stderr,r.stderr
        if fallback:assert 'fixture export unavailable' in r.stderr,r.stderr
        else:assert 'the transcripts showed no reply' in r.stderr,r.stderr
        print('PASS idle wait shares timeout with '+('screen fallback' if fallback else 'transcript'),flush=True)
    for name in ['busy','busy-always','empty-reply','export-error']:(root/name).unlink()
    r=ok('call',seat,'Answer while idle.','--expect','^NEW-TASK-ANSWER$','--timeout','3','--every','1')
    assert r.stdout.strip()=='NEW-TASK-ANSWER',r.stdout
    print('PASS idle seat still returns its transcript reply',flush=True)
    sys.exit(0)

for kind,expected in [
    ('claude',['--dangerously-skip-permissions','--session-id','reach-fixture','literal startup']),
    ('codex',['--dangerously-bypass-approvals-and-sandbox','literal startup']),
    ('hermes',['chat','--yolo','--query','literal startup']),
    ('openclaw',['tui','--session','reach-fixture']),
    ('cursor-agent',['literal startup'])]:
    r=subprocess.run([str(app/'lib/reach-agent'),kind,'literal startup'],
        env=env|{'SNO_REACH_ADDR':seats[kind],'SNO_REACH_SESSION_ID':'reach-fixture'},
        stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=5)
    assert r.returncode==0,(r.stdout,r.stderr)
    launch=json.loads((root/'launches.jsonl').read_text().splitlines()[-1])
    assert launch[2]==expected,launch
    print('PASS launch without model/provider:',kind,flush=True)
r=subprocess.run([str(app/'lib/reach-agent'),'hermes','literal startup','chosen/model'],
    env=env|{'SNO_REACH_ADDR':seats['hermes']},stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=5)
assert r.returncode==0,(r.stdout,r.stderr)
assert json.loads((root/'launches.jsonl').read_text().splitlines()[-1])[2]==['chat','--yolo','-m','chosen/model','--query','literal startup']
print('PASS Hermes model without provider omits the provider flag',flush=True)
defaultseat='executor.openclaw-default@'+host
ok('init','--as',defaultseat,'--name','Default')
ok('spawn','openclaw','--as',defaultseat,'--cwd',str(root),'--window')
wait_file(root/(defaultseat+'.input'))
assert (root/(defaultseat+'.input')).read_text().splitlines()[0].startswith('First output exactly REACH-RECEIPT-')
assert '/model ' not in (root/(defaultseat+'.input')).read_text()
print('PASS OpenClaw without a model sends startup context without a switch',flush=True)
if sys.argv[2:]==['launch']:sys.exit(0)

for kind in ['claude','hermes','openclaw']:
    seat=seats[kind];inp=root/(seat+'.input');before=inp.read_text() if inp.exists() else ''
    r=ok('call',seat,'/model exact/model','--raw')
    assert r.stdout=='typed '+seat+'\n',r.stdout
    time.sleep(.1)
    assert inp.read_text()[len(before):]=='/model exact/model\n'
    r=run('call',seat,'/model forbidden','--raw','--expect','DONE')
    assert r.returncode==64 and '--raw cannot be used with --expect' in r.stderr,(r.stdout,r.stderr)
    assert '/model forbidden' not in inp.read_text()
print('PASS raw bytes, immediate confirmation and rejected expectation',flush=True)
seat=seats['hermes'];before=(root/(seat+'.input')).read_text()
pane=json.loads((root/'state'/seat/'reachable.json').read_text())['identity']['value']
token=subprocess.check_output([real_tmux,'-L',socket,'show-options','-p','-v','-t',pane,'@agent-window-token'],text=True).strip()
with (root/'state'/'.channels/tmux'/token/'send.lock').open('w') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    r=run('call',seat,'/model locked','--raw')
    assert r.returncode==3 and r.stdout=='',(r.stdout,r.stderr)
assert (root/(seat+'.input')).read_text()==before
print('PASS raw input respects the existing send lock',flush=True)

shellseat='executor.shell@'+host
ok('init','--as',shellseat,'--name','Shell')
shellpane=subprocess.check_output([real_tmux,'-L',socket,'new-window','-d','-P','-F','#{pane_id}','bash --norc'],text=True).strip()
ok('register','--as',shellseat,'--channel','tmux','--handle',shellpane)
ok('call',shellseat,"printf 'RAW-SHELL\\n'",'--raw')
keys=[json.loads(s) for s in (root/'keys.jsonl').read_text().splitlines()]
assert keys[-2]==['send-keys','-t',shellpane,'-l','--',"printf 'RAW-SHELL\\n'"]
assert keys[-1]==['send-keys','-t',shellpane,'C-m']
print('PASS raw shell input has no printf receipt wrapper',flush=True)

for kind in ['hermes','openclaw']:
    seat=seats[kind]
    r=ok('call',seat,'Answer the queued request.','--timeout','3','--every','1')
    assert r.stdout.strip()=='NEW-TASK-ANSWER',r.stdout
    if kind=='hermes':
        assert 'falling back to screen' not in r.stderr,r.stderr
        exports=[json.loads(s) for s in (root/'exports.log').read_text().splitlines()]
        assert exports==[
            ['hermes','list','--workspace',root.name,'--limit','30'],
            ['hermes','export','-','--format','jsonl','--session-id','20261009_071206_aabbcc'],
            ['hermes','export','-','--format','jsonl','--session-id','20261009_071006_873a0a']],exports
    (root/'missing-receipt').touch()
    r=run('call',seat,'Receipt is required.','--timeout','1','--every','1')
    assert r.returncode==4 and r.stdout=='',(r.stdout,r.stderr)
    (root/'missing-receipt').unlink()
    (root/'empty-reply').touch()
    started=time.monotonic()
    r=run('call',seat,'Wait for an answer.','--timeout','2','--every','1')
    assert r.returncode==4 and r.stdout=='' and 'the transcripts showed no reply' in r.stderr,(r.stdout,r.stderr)
    assert time.monotonic()-started>=2
    (root/'empty-reply').unlink()
    (root/'pending-reply').touch()
    r=ok('call',seat,'Wait for a delayed answer.','--timeout','3','--every','1')
    assert r.stdout.strip()=='NEW-TASK-ANSWER',r.stdout
    r=run('call',seat,'Do not match this prompt: PROMPT-ONLY.','--expect','^PROMPT-ONLY$','--timeout','1','--every','1')
    assert r.returncode==4 and r.stdout=='' and 'NEW-TASK-ANSWER' in r.stderr,(r.stdout,r.stderr)
    r=ok('call',seat,'Answer the next request.','--expect','^NEW-TASK-ANSWER$','--timeout','3','--every','1')
    assert r.stdout.strip()=='NEW-TASK-ANSWER',r.stdout
    if kind=='hermes':
        assert (root/(seat+'.input')).read_text().splitlines()[-1].startswith('/queue First output exactly REACH-RECEIPT-')
        assert json.loads((root/'state'/seat/'transcript.json').read_text())['session_id']=='20261009_071006_873a0a'
        exports=[json.loads(s) for s in (root/'exports.log').read_text().splitlines()]
        assert exports[-1]==['hermes','export','-','--format','jsonl','--session-id','20261009_071006_873a0a'],exports
    (root/'export-error').touch()
    r=ok('call',seat,'Use the fallback.','--expect','^SCREEN-ANSWER-[0-9]+$','--timeout','3','--every','1')
    assert 'fixture export unavailable' in r.stderr and seat in r.stderr and 'sessions' in r.stderr,r.stderr
    (root/'export-error').unlink()
    (root/'missing-session').touch()
    r=ok('call',seat,'Missing export.','--expect','^SCREEN-ANSWER-[0-9]+$','--timeout','3','--every','1')
    assert 'falling back to screen' in r.stderr and seat in r.stderr,r.stderr
    (root/'missing-session').unlink()
    if kind=='hermes':
        (root/'malformed-session').touch()
        r=ok('call',seat,'Invalid exported session.','--expect','^SCREEN-ANSWER-[0-9]+$','--timeout','3','--every','1')
        assert 'falling back to screen' in r.stderr and 'hermes' in r.stderr,r.stderr
        (root/'malformed-session').unlink()
        for failure,reason in [('list-error','fixture list unavailable'),('empty-list','no seat session'),('stale-start','no seat session')]:
            metadata_path=root/'state'/seat/'transcript.json'
            metadata=json.loads(metadata_path.read_text());metadata.pop('session_id',None)
            metadata_path.write_text(json.dumps(metadata))
            (root/failure).touch()
            r=ok('call',seat,'Session resolution failed.','--expect','^SCREEN-ANSWER-[0-9]+$','--timeout','3','--every','1')
            assert 'falling back to screen' in r.stderr and seat in r.stderr and reason in r.stderr,r.stderr
            assert 'session_id' not in json.loads(metadata_path.read_text())
            (root/failure).unlink()
print('PASS receipt-selected transcript replies and export failure screen fallback',flush=True)
if sys.argv[2:]==['transcript']:sys.exit(0)

# Substitute only the OS process inventory: a shell parent and one interpreted child,
# or an OpenClaw TUI pane process with no children.
(commands/'ps').write_text('''#!/usr/bin/env python3
import json,os,pathlib,sys
tree=json.loads((pathlib.Path(os.environ['FIXTURE_ROOT'])/'tree.json').read_text());args=sys.argv[1:]
if '--ppid' in args:
 print('900001' if tree['comm']!='openclaw-tui' and args[args.index('--ppid')+1]!='900001' else '')
elif args[-1]=='900001' or tree['comm']=='openclaw-tui':print(tree['comm'] if 'comm=' in args else tree['args'])
else:print('bash' if 'comm=' in args else '/bin/bash')
''');(commands/'ps').chmod(0o755)
for kind,comm,args in [('codex','codex','/bin/runtime'),('claude','worker','/opt/bin/claude'),
                         ('hermes','python3','python3 /opt/bin/hermes chat'),
                         ('openclaw','node','node /opt/openclaw tui'),
                         ('openclaw','openclaw-tui','openclaw-tui'),
                         ('openclaw','openclaw-tui','/bin/runtime'),
                         ('openclaw','node','node /opt/openclaw-tui'),
                         ('cursor-agent','node','node /opt/cursor-agent')]:
    (root/'tree.json').write_text(json.dumps({'comm':comm,'args':args}))
    r=ok('ring',seats[kind]);assert r.stdout=='rang-unverified\n',(r.stdout,r.stderr)
    if kind=='hermes':
        time.sleep(.1);assert (root/(seats[kind]+'.input')).read_text().splitlines()[-1].startswith('/queue REACH-RING ')
    print('PASS pane process tree:',kind,flush=True)
(root/'tree.json').write_text(json.dumps({'comm':'node','args':'node /opt/openclawhelper tui'}))
r=run('ring',seats['openclaw']);assert r.returncode==1 and r.stdout=='failed\n'
print('PASS different argv basename is rejected',flush=True)
for operation in ['call','ring']:
    (root/'tree.json').write_text(json.dumps({'comm':'node','args':'node /opt/openclaw tui'}))
    (root/'busy').touch();(root/'polls').unlink(missing_ok=True)
    if operation=='call':r=ok('call',seats['openclaw'],'Wait for idle.','--expect','^NEW-TASK-ANSWER$','--timeout','3','--every','1')
    else:r=ok('ring',seats['openclaw'])
    assert int((root/'polls').read_text())>=3
    (root/'busy').unlink()
print('PASS busy OpenClaw calls and rings wait for the idle footer',flush=True)
if sys.argv[2:]==['quick']:sys.exit(0)
for operation in ['call','ring']:
    (root/'busy').touch();(root/'busy-always').touch();(root/'polls').unlink(missing_ok=True)
    if operation=='call':r=ok('call',seats['openclaw'],'Deliver after timeout.','--expect','^NEW-TASK-ANSWER$','--timeout','10','--every','1',limit=75)
    else:r=ok('ring',seats['openclaw'],limit=75)
    assert 'reach: openclaw seat never reached idle' in r.stderr,r.stderr
    assert int((root/'polls').read_text())>=(3 if operation=='call' else 25)
    (root/'busy').unlink();(root/'busy-always').unlink()
    print('PASS idle timeout still delivers:',operation,flush=True)
PY
