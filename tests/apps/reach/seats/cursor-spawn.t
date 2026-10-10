#!/usr/bin/env bash
# `sno reach spawn cursor --model M` launches the Cursor CLI in tmux, call verifies the reply from
# the Cursor transcript holding its receipt, and ring finds the executor live although Cursor's
# process is named after node, not cursor-agent. The CLI is a fake with the real launcher's
# process shape (`exec -a $0 node .../cursor-agent/versions/<ver>/index.js`) and the real
# transcript row format; no model is called.
set -Eeuo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
public="${REACH_UNDER_TEST:-$here/../../../../apps/reach/bin/sno-reach}"
python3 - "$public" <<'PY'
import atexit, json, os, pathlib, subprocess, sys, tempfile, time
reach = sys.argv[1]
proof = pathlib.Path(tempfile.mkdtemp(prefix='reach-cursor-spawn.'))
print('evidence:', proof, flush=True)
commands = proof / 'commands'; commands.mkdir()
version = proof / 'install/cursor-agent/versions/2026.10.01-fake'; version.mkdir(parents=True)
(commands / 'cursor-agent').write_text(f'#!/usr/bin/env bash\nexec -a "$0" python3 {version}/index.js "$@"\n')
(commands / 'cursor-agent').chmod(0o755)
(version / 'index.js').write_text('''import json,os,pathlib,re,subprocess,sys,time,uuid
subprocess.run(['stty','-echo'],check=True)
pathlib.Path(os.environ['FAKE_ARGV']).write_text(json.dumps(sys.argv[1:]))
projects=pathlib.Path.home()/'.cursor/projects/fake-project/agent-transcripts'
def transcript():
    chat=str(uuid.uuid4()); path=projects/chat/(chat+'.jsonl'); path.parent.mkdir(parents=True); path.touch(); return path
mine,other=transcript(),transcript()
def row(path,role,text):
    with path.open('a') as f:f.write(json.dumps({'role':role,'message':{'content':[{'type':'text','text':text}]}})+'\\n')
row(mine,'assistant','Startup reply.')
print('READY fake Cursor CLI (not a live model)',flush=True)
for line in sys.stdin:
    m=re.search(r'REACH-RECEIPT-[0-9]+-[0-9]+-[0-9]+',line)
    if not m:continue
    # Cursor rewrites earlier rows while a turn runs, so the file is not append-only.
    mine.write_text(mine.read_text().replace('Startup reply.','Startup reply, rewritten longer at turn end.'))
    row(mine,'user','<user_query>'+line.strip()+'</user_query>')
    row(mine,'assistant',m.group()+'\\nCURSOR-ANSWER')
    row(other,'assistant','Unrelated chat output.')
    # Cursor appends rows while call reads them: leave another chat with a half-written row.
    with other.open('a') as f:f.write('{"role":"assis')
    os.utime(other,(time.time()+60,time.time()+60))
''')
env = {k: v for k, v in os.environ.items() if not k.startswith(('CURSOR_', 'SNO_REACH_'))}
env |= {'HOME': str(proof / 'home'), 'SNO_REACH_ROOT': str(proof / 'state'), 'FAKE_ARGV': str(proof / 'argv.json'),
        'PATH': str(commands) + ':' + os.environ['PATH']}
(proof / 'home').mkdir()
socket = 'reach-cursor-spawn-' + str(os.getpid()); tmux = ['tmux', '-L', socket]
subprocess.run(tmux + ['-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', 'cat'], env=env, check=True, timeout=5)
atexit.register(lambda: subprocess.run(tmux + ['kill-server'], capture_output=True, timeout=5))
env['TMUX'] = subprocess.check_output(tmux + ['display-message', '-p', '#{socket_path},#{pid},0'], text=True).strip()
seat = 'executor.cursor@' + subprocess.check_output(['hostname'], text=True).strip()
subprocess.run([reach, 'init', '--as', seat, '--name', 'Cursor'], env=env, check=True, capture_output=True, timeout=10)
spawn = subprocess.run([reach, 'spawn', 'cursor', '--as', seat, '--cwd', str(proof), '--window', '--model', 'gpt-5'],
                       env=env, capture_output=True, text=True, timeout=20)
assert spawn.returncode == 0, spawn.stderr
state = proof / 'state' / seat
end = time.monotonic() + 5
while time.monotonic() < end and not (proof / 'argv.json').exists(): time.sleep(.05)
argv = json.loads((proof / 'argv.json').read_text())
assert argv[:4] == ['--force', '--trust', '--model', 'gpt-5'] and argv[4].startswith(f'You are the seat {seat}.'), argv
assert json.loads((state / 'seat.json').read_text())['runtime'] == 'cursor-agent'
assert json.loads((state / 'reachable.json').read_text())['harness'] == 'cursor'
assert json.loads((state / 'transcript.json').read_text())['transcript'] == 'cursor-transcript'
print('PASS: spawn cursor --model runs cursor-agent --force --trust --model with the startup context; seat runtime cursor-agent', flush=True)

result = subprocess.run([reach, 'call', seat, 'Reply from the Cursor seat.', '--expect', '^CURSOR-ANSWER$', '--timeout', '5', '--every', '1'],
                        env=env, capture_output=True, text=True, timeout=20)
assert result.returncode == 0, result.stdout + result.stderr
assert 'CURSOR-ANSWER' in result.stdout and 'Unrelated' not in result.stdout, result.stdout
print('PASS: call verifies the reply from the Cursor transcript that holds its receipt', flush=True)

result = subprocess.run([reach, 'ring', seat], env=env, capture_output=True, text=True, timeout=60)
assert result.stdout.strip() == 'rang-unverified', (result.stdout, result.stderr)
print('PASS: ring finds the executor live by the Cursor CLI command line', flush=True)
PY
