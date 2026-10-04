#!/usr/bin/env bash
set -Eeuo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
public="${REACH_UNDER_TEST:-$here/../../../../apps/reach/bin/sno-reach}"
target="$(dirname -- "$(readlink -f -- "$public")")/../lib/reach-call"
python3 - "$target" <<'PY'
import atexit, json, os, pathlib, re, shlex, subprocess, sys, tempfile, time
proof = pathlib.Path(tempfile.mkdtemp(prefix='reach-repaint-delta.'))
print('evidence:', proof, flush=True)
socket = 'reach-repaint-delta-' + str(os.getpid())
tmux = ['tmux', '-L', socket]
subprocess.run(tmux + ['-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', '-x', '200', '-y', '30', 'cat'], check=True, timeout=5)
atexit.register(lambda: subprocess.run(tmux + ['kill-server'], capture_output=True, timeout=5))
subprocess.run(tmux + ['set-option', '-g', 'history-limit', '20000'], check=True, timeout=5)
env = os.environ | {'SNO_REACH_ROOT': str(proof / 'state'), 'TMUX': subprocess.check_output(tmux + ['display-message', '-p', '#{socket_path},#{pid},0'], text=True).strip()}
actor = proof / 'actor.py'
actor.write_text('''import os,pathlib,re,subprocess,sys
subprocess.run(['stty','-echo'],check=True)
large=sys.argv[2]=='large'
if large: sys.stdout.write(''.join('HISTORY-%05d '%i+'x'*120+'\\n' for i in range(11000)))
sys.stdout.write('\\x1b[H\\x1b[2JINITIAL-FRAME\\nOLD-HANDOFF-MARKER\\nSTATUS-0\\nREADY\\n');sys.stdout.flush()
for line in sys.stdin:
 m=re.search(r'REACH-RECEIPT-[0-9]+-[0-9]+-[0-9]+',line)
 if not m: continue
 pathlib.Path(sys.argv[1]).write_text(m.group())
 sys.stdout.write('\\x1b[H\\x1b[2J'+m.group()+'\\nOLD-HANDOFF-MARKER\\nSTATUS-1\\n'+('NEW-CORRECT\\n' if large else '')+'READY\\n');sys.stdout.flush()
''')
for mode in ('small', 'large'):
    received = proof / (mode + '.receipt')
    pane = subprocess.check_output(tmux + ['new-window', '-d', '-P', '-F', '#{pane_id}', shlex.join(['python3', str(actor), str(received), mode])], text=True).strip()
    end = time.monotonic() + 4
    while time.monotonic() < end:
        screen = subprocess.check_output(tmux + ['capture-pane', '-p', '-S', '-', '-t', pane])
        if b'INITIAL-FRAME' in screen: break
        time.sleep(.02)
    assert b'INITIAL-FRAME' in screen, 'real terminal fixture not ready'
    if mode == 'large': assert len(screen) > 1024 * 1024, len(screen)
    result = subprocess.run(['bash', sys.argv[1], '--terminal', pane, '--text', 'Check this repaint.', '--expect', '^OLD-HANDOFF-MARKER$' if mode == 'small' else '^NEW-CORRECT$', '--timeout', '2', '--every', '1'], env=env, capture_output=True, text=True, timeout=20)
    (proof / (mode + '.stdout')).write_text(result.stdout)
    (proof / (mode + '.stderr')).write_text(result.stderr)
    assert received.exists(), 'real terminal did not receive this call'
    expected = 4 if mode == 'small' else 0
    print(mode, 'exit', result.returncode, 'expected', expected, flush=True)
    assert result.returncode == expected, result.stdout + result.stderr
    if mode == 'large':
        report = json.loads(result.stdout)
        assert report['verified'] and 'NEW-CORRECT' in report['output'] and 'HISTORY-' not in report['output']
        assert len(report['output']) < 1000
    print('PASS: ' + ('unchanged old marker cannot satisfy a new receipt' if mode == 'small' else 'history above 1MiB survives repaint without duplicated history or invalid cursor'), flush=True)
PY
