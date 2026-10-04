#!/usr/bin/env bash
set -Eeuo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python3 - "${REACH_UNDER_TEST:-$here/../../../apps/reach/bin/sno-reach}" "$here/fixtures/tmux-ack-actor.sh" <<'PY'
import os, pathlib, pty, select, shlex, shutil, signal, subprocess, sys, tempfile, time, json
entry = pathlib.Path(sys.argv[1]).absolute()
reach = entry.resolve()
print('actual public entry:', entry, 'release:', reach.parent.parent, flush=True)
proof = pathlib.Path(tempfile.mkdtemp(prefix='reach-command-deadline.'))
print('evidence:', proof, flush=True)
env = os.environ | {'HOME': str(proof / 'home'), 'SNO_REACH_ROOT': str(proof / 'state')}
pathlib.Path(env['HOME']).mkdir()
host = subprocess.check_output(['hostname'], text=True).strip()
sender, worker = 'lead.sender@' + host, 'worker.receiver@' + host
for seat in (sender, worker):
    subprocess.run([str(entry), 'init', '--as', seat, '--name', seat], env=env, check=True, capture_output=True, timeout=10)
socket = 'reach-deadline-' + str(os.getpid())
subprocess.run(['tmux', '-L', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', 'cat'], check=True, timeout=5)
def close_server():
    subprocess.run(['tmux', '-L', socket, 'kill-server'], capture_output=True, timeout=5)
import atexit
atexit.register(close_server)
tmux = ['tmux', '-L', socket]
env['TMUX'] = subprocess.check_output(tmux + ['display-message', '-p', '#{socket_path},#{pid},0'], text=True).strip()
actor = pathlib.Path(sys.argv[2]).resolve()
for seat in (sender, worker):
    pane = subprocess.check_output(tmux + ['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'fixture', shlex.join(['bash', str(actor)])], text=True).strip()
    subprocess.run([str(entry), 'register', '--as', seat, '--channel', 'tmux', '--handle', pane], env=env | {'TMUX_PANE': pane}, check=True, capture_output=True, timeout=10)
card = f'From: Sender <{sender}>\nTo: Worker <{worker}>\nSubject: [QUESTION] terminal stdin\nDate: Fri, 02 Oct 2026 10:00:00 +0000\nMessage-ID: <terminal-stdin@localhost>\nX-Type: question\nX-Work: terminal-stdin\n\nPlease answer.\n'
subprocess.run([str(entry), 'send', '--as', sender, '--no-ring'], input=card, text=True, env=env, check=True, capture_output=True, timeout=10)
original = next((proof / 'state' / worker / 'new').iterdir())
failures = []

def alive(pid):
    try:
        return pathlib.Path(f'/proc/{pid}/stat').read_text().split(') ', 1)[1][0] != 'Z'
    except (FileNotFoundError, ProcessLookupError):
        return False

def descendants(pid):
    try:
        children = [int(p) for p in pathlib.Path(f'/proc/{pid}/task/{pid}/children').read_text().split()]
    except (FileNotFoundError, ProcessLookupError):
        return []
    return children + [desc for child in children for desc in descendants(child)]

def cleanup(pids):
    for pid in reversed(pids):
        if alive(pid):
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass

def read_until(fd, marker, seconds):
    out, end = b'', time.monotonic() + seconds
    while time.monotonic() < end and marker not in out:
        ready, _, _ = select.select([fd], [], [], min(0.05, max(0, end - time.monotonic())))
        if ready:
            try: out += os.read(fd, 65536)
            except OSError: break
    return out

def terminal_case(label, command, input_bytes, seconds, verify):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env | {'PS1': '__REACH_PROMPT__ '})
        os.execv('/bin/bash', ['bash', '--noprofile', '--norc', '-i'])
    tracked = []
    try:
        assert b'__REACH_PROMPT__' in read_until(fd, b'__REACH_PROMPT__', 2)
        os.write(fd, (command + '\n').encode())
        time.sleep(0.5)
        tracked = descendants(pid)
        os.write(fd, input_bytes)
        if label == 'reply-reads-terminal-stdin':
            out, end = b'', time.monotonic() + seconds
            while time.monotonic() < end and not verify():
                out += read_until(fd, b'__REACH_PROMPT__', 0.05)
            if b'__REACH_PROMPT__' not in out:
                tracked.extend(descendants(pid))
                os.write(fd, b'\x03')
                out += read_until(fd, b'__REACH_PROMPT__', 1)
        else:
            out = read_until(fd, b'__REACH_PROMPT__', seconds)
        (proof / (label + '.out')).write_bytes(out)
        ok = bool(tracked) and b'__REACH_PROMPT__' in out and b'Stopped' not in out and all(not alive(p) for p in tracked) and verify()
        print(('PASS: ' if ok else 'FAIL: ') + label)
        if not ok: failures.append(label)
    finally:
        cleanup(tracked + descendants(pid) + [pid])
        os.close(fd)
        os.waitpid(pid, 0)

terminal_case('ctrl-c-stops-public-wait', shlex.join([str(entry), 'wait', '--as', sender, '--timeout', '280']), b'\x03', 1, lambda: True)
terminal_case('reply-reads-terminal-stdin', shlex.join([str(entry), 'reply', '--as', worker, '--card', str(original), '--state', 'accepted']), b'REAL-TERMINAL-BODY\n\x04', 3,
    lambda: any('REAL-TERMINAL-BODY' in p.read_text() for folder in ('new', 'cur') for p in (proof / 'state' / sender / folder).iterdir()))

consumer = "import sys,time;time.sleep(.8);text=sys.stdin.read();assert text.strip();print('PIPE-CONSUMED')"
pipeline_label = 'first-position-pipeline-keeps-consumer'
pipeline = shlex.join([str(entry), 'inbox', '--as', worker]) + ' | ' + shlex.join(['python3', '-c', consumer]) + '; printf "PIPE_DONE %s %s\\n" "${PIPESTATUS[0]}" "${PIPESTATUS[1]}"'
terminal_case(pipeline_label, pipeline, b'', 2,
    lambda: 'PIPE_DONE 0 0' in (proof / (pipeline_label + '.out')).read_text())
input_path = proof / 'pipeline-input'
input_path.write_text('ACTUAL-PIPE-INPUT\n')
second_pipeline = shlex.join(['cat', str(input_path)]) + ' | ' + shlex.join([str(entry), 'wait', '--as', sender, '--reply-to', '<never-pipeline-reply@localhost>', '--timeout', '280'])
terminal_case('ctrl-c-stops-second-position-pipeline', second_pipeline, b'\x03', 1, lambda: True)

raw_entry = proof / 'raw-sno-reach'
raw_entry.symlink_to(reach)
canonical_version = subprocess.run([str(entry), '--version'], env=env, capture_output=True, text=True, timeout=5)
assert canonical_version.returncode == 0
version = canonical_version.stdout.strip()
raw = subprocess.run([str(raw_entry), '--version'], env=env, capture_output=True, text=True, timeout=5)
ok = raw.returncode == 0 and raw.stdout.strip() == version
print(('PASS: ' if ok else 'FAIL: ') + 'real-symlink-public-entry')
if not ok: failures.append('real-symlink-public-entry')
no_ps = proof / 'without-ps'
no_ps.mkdir()
for name in ('bash', 'env', 'perl', 'realpath', 'find', 'stat', 'sed', 'sha256sum', 'timeout', 'flock', 'jq', 'readlink', 'dirname', 'cat', 'awk', 'rm', 'mkdir', 'uname', 'date', 'head', 'tr', 'mktemp', 'chmod'):
    binary = shutil.which(name)
    if binary: (no_ps / name).symlink_to(binary)
missing_ps = subprocess.run([str(entry), '--version'], env=env | {'PATH': str(no_ps)}, capture_output=True, text=True, timeout=5)
(proof / 'without-ps.stdout').write_text(missing_ps.stdout)
(proof / 'without-ps.stderr').write_text(missing_ps.stderr)
ok = missing_ps.returncode == 0 and missing_ps.stdout.strip() == version
print(('PASS: ' if ok else 'FAIL: ') + 'missing-ps-preserves-success' + f' exit={missing_ps.returncode}')
if not ok: failures.append('missing-ps-preserves-success')

sig_proc = subprocess.Popen([str(entry), 'wait', '--as', sender, '--reply-to', '<never-signals-reply@localhost>', '--timeout', '280'], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
sig_tracked = []
try:
    end = time.monotonic() + 2
    mains = []
    while time.monotonic() < end and not mains:
        sig_tracked = descendants(sig_proc.pid)
        for candidate in sig_tracked:
            try:
                if pathlib.Path(f'/proc/{candidate}/comm').read_text().strip() == 'bash' and str(reach.parent.parent / 'lib/reach-main').encode() in pathlib.Path(f'/proc/{candidate}/cmdline').read_bytes(): mains.append(candidate)
            except (FileNotFoundError, ProcessLookupError): pass
        if not mains: time.sleep(.02)
    assert mains, 'actual main process not found'
    time.sleep(.2)
    status = pathlib.Path(f'/proc/{mains[0]}/status').read_text()
    ignored = int(next(line.split()[1] for line in status.splitlines() if line.startswith('SigIgn:')), 16)
    (proof / 'main-signals.status').write_text(status)
    # Bash itself always ignores SIGQUIT; its inherited SIGINT must remain trappable.
    ok = ignored & (1 << (signal.SIGINT - 1)) == 0
    print(('PASS: ' if ok else 'FAIL: ') + 'main-int-not-ignored' + f' SigIgn={ignored:x}')
    if not ok: failures.append('main-int-not-ignored')
    monitors = [candidate for candidate in sig_tracked if pathlib.Path(f'/proc/{candidate}/comm').exists() and pathlib.Path(f'/proc/{candidate}/comm').read_text().strip() == 'timeout']
    assert monitors, 'actual private GNU timeout not found'
    monitor_status = pathlib.Path(f'/proc/{monitors[0]}/status').read_text()
    monitor_ignored = int(next(line.split()[1] for line in monitor_status.splitlines() if line.startswith('SigIgn:')), 16)
    (proof / 'private-timeout-signals.status').write_text(monitor_status)
    ok = monitor_ignored & ((1 << (signal.SIGINT - 1)) | (1 << (signal.SIGQUIT - 1))) == 0
    print(('PASS: ' if ok else 'FAIL: ') + 'private-timeout-int-quit-not-ignored' + f' SigIgn={monitor_ignored:x}')
    if not ok: failures.append('private-timeout-int-quit-not-ignored')
finally:
    sig_proc.terminate()
    try: sig_proc.communicate(timeout=7)
    finally: cleanup(sig_tracked + descendants(sig_proc.pid) + [sig_proc.pid])

commands = proof / 'commands'
commands.mkdir()
ssh = commands / 'ssh'
ssh.write_text('''#!/usr/bin/env python3
import os, pathlib, signal, time
root=pathlib.Path(os.environ['REACH_CHILD_PROOF'])
if os.environ.get('REACH_RESIST_TERM') == '1': signal.signal(signal.SIGTERM, signal.SIG_IGN)
child=os.fork()
(root / ('grandchild.pid' if child == 0 else 'child.pid')).write_text(str(os.getpid()))
time.sleep(60)
''')
ssh.chmod(0o755)
real_timeout = subprocess.check_output(['which', 'timeout'], text=True).strip()

def child_case(label, deadline=False, args=None, resist=False):
    child_proof = proof / label
    child_proof.mkdir()
    settings = env | {'PATH': str(commands) + ':' + env['PATH'], 'REACH_CHILD_PROOF': str(child_proof), 'REACH_RESIST_TERM': '1' if deadline or resist else '0'}
    proc = subprocess.Popen([str(entry), *(args or ['init', '--as', 'worker.remote@deadline-fixture-host', '--name', 'Remote'])], env=settings, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    tracked = []
    try:
        end = time.monotonic() + 4
        while time.monotonic() < end and not (child_proof / 'grandchild.pid').exists(): time.sleep(0.02)
        assert (child_proof / 'child.pid').exists() and (child_proof / 'grandchild.pid').exists(), 'external SSH fixture did not run'
        tracked = descendants(proc.pid)
        children = [int((child_proof / name).read_text()) for name in ('child.pid', 'grandchild.pid')]
        if not deadline: os.kill(proc.pid, signal.SIGTERM)
        try:
            output, error = proc.communicate(timeout=8 if resist else 4)
        except subprocess.TimeoutExpired:
            print('FAIL: ' + label + ' command did not terminate within its test deadline')
            failures.append(label)
            return
        (child_proof / 'stdout').write_bytes(output)
        (child_proof / 'stderr').write_bytes(error)
        end = time.monotonic() + 0.5
        while any(alive(pid) for pid in children) and time.monotonic() < end: time.sleep(0.02)
        ok = all(not alive(pid) for pid in set(children + tracked)) and (not deadline or proc.returncode in (124, 137, -9))
        print(('PASS: ' if ok else 'FAIL: ') + label + f' exit={proc.returncode} child-survivors={[pid for pid in set(children + tracked) if alive(pid)]}')
        if not ok: failures.append(label)
    finally:
        cleanup(tracked + descendants(proc.pid) + [proc.pid])
        proc.communicate(timeout=2)

child_case('public-pid-sigterm-stops-descendants')
adapter = commands / 'timeout'
adapter.write_text('#!/usr/bin/env python3\nimport os,sys\nargs=["1" if arg == "290" else "--kill-after=1" if arg == "--kill-after=5" else arg for arg in sys.argv[1:]]\nos.execv(' + repr(real_timeout) + ',["timeout"]+args)\n')
adapter.chmod(0o755)
child_case('whole-command-deadline-kills-term-resistant-descendants', deadline=True)
# The actual ACP ring invokes two inner foreground timeouts before the prompt.
acp_seat = 'worker.acp@' + host
# Setup must retain normal deadlines; only the later public ring gets shortened.
adapter.unlink()
subprocess.run([str(entry), 'init', '--as', acp_seat, '--name', 'ACP'], env=env, check=True, capture_output=True, timeout=10)
subprocess.run([str(entry), 'register', '--as', acp_seat, '--channel', 'acp', '--handle', 'acp-codex:' + str(proof) + ':deadline'], env=env, check=True, capture_output=True, timeout=10)
acpx = commands / 'acpx'
acpx.write_text("#!/usr/bin/env python3\nimport json,sys\nif 'sessions' in sys.argv and 'list' in sys.argv:\n print(json.dumps([{'cwd':" + repr(str(proof)) + ", 'name':'deadline','closed':False,'acpxRecordId':'deadline-session'}]))\nelse:\n exec(" + repr(ssh.read_text().split('\n', 1)[1]) + ")\n")
acpx.chmod(0o755)
adapter.write_text('#!/usr/bin/env python3\nimport os,sys\nargs=["1" if arg == "290" else "--kill-after=1" if arg == "--kill-after=5" else arg for arg in sys.argv[1:]]\nos.execv(' + repr(real_timeout) + ',["timeout"]+args)\n')
adapter.chmod(0o755)
child_case('nested-acp-timeouts-remain-in-public-process-group', deadline=True, args=['ring', acp_seat])
adapter.unlink()
child_case('public-pid-sigterm-kills-resistant-acp-descendants', args=['ring', acp_seat], resist=True)
child_case('public-watch-sigterm-kills-resistant-acp-descendants', args=['watch', acp_seat, '--timeout', '280'], resist=True)
# The public spawn and real tmux backend are exercised with a native external
# runtime fixture. This proves process lifetime, not a live LLM conversation.
native = commands / 'codex'
native.write_text("#!/usr/bin/env python3\nimport os,pathlib,time\npathlib.Path(os.environ['REACH_NATIVE_PID']).write_text(str(os.getpid()))\nprint('NATIVE RUNTIME READY',flush=True)\ntime.sleep(60)\n")
native.chmod(0o755)
spawn_seat = 'worker.native@' + host
subprocess.run([str(entry), 'init', '--as', spawn_seat, '--name', 'Native'], env=env, check=True, capture_output=True, timeout=10)
native_pid_path = proof / 'native.pid'
subprocess.run(tmux + ['set-environment', '-g', 'PATH', str(commands) + ':' + env['PATH']], check=True, timeout=5)
subprocess.run(tmux + ['set-environment', '-g', 'REACH_NATIVE_PID', str(native_pid_path)], check=True, timeout=5)
spawned = subprocess.run([str(entry), 'spawn', 'codex', '--as', spawn_seat, '--cwd', str(proof), '--window'], env=env | {'PATH': str(commands) + ':' + env['PATH'], 'REACH_NATIVE_PID': str(native_pid_path)}, capture_output=True, text=True, timeout=10)
end = time.monotonic() + 3
while not native_pid_path.exists() and time.monotonic() < end: time.sleep(.02)
ok = spawned.returncode == 0 and native_pid_path.exists() and alive(int(native_pid_path.read_text()))
print(('PASS: ' if ok else 'FAIL: ') + 'explicit-native-tmux-worker-stays-alive-not-live-llm' + f' exit={spawned.returncode}')
(proof / 'native-spawn.stdout').write_text(spawned.stdout)
(proof / 'native-spawn.stderr').write_text(spawned.stderr)
if not ok: failures.append('explicit-native-tmux-worker-stays-alive-not-live-llm')
print('evidence:', proof)
if failures: raise SystemExit('failed: ' + ', '.join(failures))
PY
