#!/usr/bin/env bash
set -Eeuo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
public="${REACH_UNDER_TEST:-$here/../../../../apps/reach/bin/sno-reach}"
python3 - "$public" <<'PY'
import atexit, json, os, pathlib, shlex, subprocess, sys, tempfile, time
proof = pathlib.Path(tempfile.mkdtemp(prefix='reach-transcript-candidates.'))
print('evidence:', proof, flush=True)
commands = proof / 'commands'; commands.mkdir()
(proof / 'home').mkdir()
actor = commands / 'codex'
actor.write_text('''#!/usr/bin/env python3
import json,os,pathlib,re,subprocess,sys,time,uuid
subprocess.run(['stty','-echo'],check=True)
root=pathlib.Path(os.environ['CODEX_HOME'])/'sessions';root.mkdir(parents=True,exist_ok=True)
old=root/'rollout-older.jsonl';new=root/'rollout-newer.jsonl'
meta={'type':'session_meta','payload':{'id':os.environ['SNO_REACH_SESSION_ID'],'cwd':os.getcwd()}}
old.write_text(json.dumps(meta)+'\\n');new.write_text(json.dumps({'type':'session_meta','payload':dict(meta['payload'],id=str(uuid.uuid4()))})+'\\n')
os.utime(new,(time.time()+60,time.time()+60))
print('READY actual-format transcript fixture (not live LLM)',flush=True)
for line in sys.stdin:
 m=re.search(r'REACH-RECEIPT-[0-9]+-[0-9]+-[0-9]+',line)
 if not m:continue
 # This response is deliberately quicker than the first transcript poll.
 with old.open('a') as f:f.write(json.dumps({'type':'response_item','payload':{'type':'message','role':'assistant','content':[{'type':'output_text','text':m.group()+'\\nOLDER-SESSION-ANSWER'}]}})+'\\n')
 with new.open('a') as f:f.write(json.dumps({'type':'response_item','payload':{'type':'message','role':'assistant','content':[{'type':'output_text','text':'Unrelated newer session output.'}]}})+'\\n')
 os.utime(new,(time.time()+60,time.time()+60))
 print('REPLY written to older transcript',flush=True)
''');actor.chmod(0o755)
env = os.environ | {'HOME': str(proof / 'home'), 'SNO_REACH_ROOT': str(proof / 'state'), 'CODEX_HOME': str(proof / 'codex-home'), 'PATH': str(commands) + ':' + os.environ['PATH']}
socket = 'reach-transcript-candidates-' + str(os.getpid());tmux=['tmux','-L',socket]
subprocess.run(tmux + ['-f','/dev/null','new-session','-d','-s','fixture','cat'],env=env,check=True,timeout=5)
atexit.register(lambda:subprocess.run(tmux+['kill-server'],capture_output=True,timeout=5))
env['TMUX']=subprocess.check_output(tmux+['display-message','-p','#{socket_path},#{pid},0'],text=True).strip()
seat='worker.transcript@'+subprocess.check_output(['hostname'],text=True).strip()
subprocess.run([sys.argv[1],'init','--as',seat,'--name','Transcript'],env=env,check=True,capture_output=True,timeout=10)
subprocess.run([sys.argv[1],'spawn','codex','--as',seat,'--cwd',str(proof),'--window'],env=env,check=True,capture_output=True,timeout=10)
old=proof/'codex-home/sessions/rollout-older.jsonl';new=proof/'codex-home/sessions/rollout-newer.jsonl'
end=time.monotonic()+3
while time.monotonic()<end and not new.exists():time.sleep(.02)
assert old.exists() and new.exists(), 'native runtime did not create actual-format transcripts'
result=subprocess.run([sys.argv[1],'call',seat,'Reply from the selected seat.','--expect','^OLDER-SESSION-ANSWER$','--timeout','2','--every','1'],env=env,capture_output=True,text=True,timeout=15)
(proof/'stdout').write_text(result.stdout);(proof/'stderr').write_text(result.stderr)
assert 'REACH-RECEIPT-' in old.read_text() and 'REACH-RECEIPT-' not in new.read_text(), 'receipt fixture did not reach only the older session'
assert new.stat().st_mtime>old.stat().st_mtime
print('call exit',result.returncode,'expected 0',flush=True)
assert result.returncode==0,result.stdout+result.stderr
assert 'OLDER-SESSION-ANSWER' in result.stdout
print('PASS: actual receipt in older same-cwd transcript wins over unrelated newer transcript',flush=True)
PY
