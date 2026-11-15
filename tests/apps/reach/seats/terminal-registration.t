#!/usr/bin/env bash
# Ordinary terminals and independently installed channels are not an allowlist.
set -Eeuo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$here/../test-lib.sh"
RECEIVER="maccoder.agent@$HOST"
initialize "$RECEIVER" 'Mac Coder'
jq -e '.name == "Mac Coder" and .role == "maccoder" and .seat == "agent"' "$STATE/$RECEIVER/seat.json" >/dev/null
invoke register --as "$RECEIVER" --channel terminal --handle tty:/dev/pts/12345
expect_rc 0
jq -e '.channel == "terminal" and .identity == {kind:"terminal",value:"tty:/dev/pts/12345"}' \
  "$STATE/$RECEIVER/reachable.json" >/dev/null
pass 'ordinary terminal registration does not require a named terminal application'
reach unregister --as "$RECEIVER"
mkdir -p "$WORK/bin"
cat >"$WORK/bin/reach-channel-example" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$1" == ring && "$2" == example-session ]]
printf '%s\n' "$3" >"$TERMINAL_WAKE_PROOF"
SH
chmod +x "$WORK/bin/reach-channel-example"
export PATH="$WORK/bin:$PATH" TERMINAL_WAKE_PROOF="$WORK/wake"
invoke register --as "$RECEIVER" --channel example --handle example-session
expect_rc 0
invoke ring "$RECEIVER"
expect_rc 0
has "$WORK/wake" REACH-RING
has "$WORK/wake" "$RECEIVER"
has "$WORK/out" rang-unverified
pass 'an installed channel can wake its recipient without changing Reach'
rm "$WORK/bin/reach-channel-example"
invoke ring "$RECEIVER"
[[ "$RC" != 0 ]]
has "$WORK/err" reach-channel-example
pass 'a missing input adapter reports the actual missing capability'

reach unregister --as "$RECEIVER"
initialize "$SENDER" Sender
python3 - "$REACH" "$TEST_HOME" "$STATE" "$SENDER" "$RECEIVER" "$WORK" <<'PY'
import datetime, json, os, pathlib, subprocess, sys, time
reach, home, state, sender, recipient, directory = sys.argv[1:]
root = pathlib.Path(directory)
env = dict(os.environ, HOME=home, XDG_CONFIG_HOME=home+'/.config',
           XDG_STATE_HOME=home+'/.local/state', SNO_REACH_ROOT=state)
actor = root / 'reader.py'
actor.write_text('''import json, os, pathlib, subprocess, sys, tty
reach, recipient, directory = sys.argv[1:]
root = pathlib.Path(directory)
tty.setraw(0)
subprocess.run([reach, 'register', '--as', recipient, '--channel', 'terminal'], check=True, capture_output=True)
(root/'reader-ready').write_text('ready')
data = b''
while not data.endswith(b'\\r'):
    data += os.read(0, 65536)
listing = subprocess.check_output([reach, 'inbox', '--as', recipient], text=True)
card = pathlib.Path(listing.split('\\t')[0])
(root/'read-result.json').write_text(json.dumps({'wake': data.decode(), 'card': card.read_text()}))
''')
process = subprocess.Popen([reach, 'terminal', '--', sys.executable, str(actor), reach, recipient, directory],
                           env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
try:
    deadline = time.monotonic() + 10
    while not (root/'reader-ready').exists():
        assert process.poll() is None, process.communicate()
        assert time.monotonic() < deadline, 'reader did not register'
        time.sleep(.05)
    card = '\n'.join([f'From: Sender <{sender}>', f'To: {recipient}',
        'Date: '+datetime.datetime.now(datetime.timezone.utc).strftime('%a, %d %b %Y %H:%M:%S +0000'),
        'Subject: [QUESTION] ordinary terminal', 'Message-ID: <plain-terminal-7q@example.test>',
        'X-Type: question', 'X-Work: plain-terminal-7q', '', 'HELLO-PLAIN-TERMINAL-7Q', ''])
    sent = subprocess.run([reach, 'send', '--as', sender], input=card, env=env,
                          text=True, capture_output=True, timeout=20)
    assert sent.returncode == 0, sent.stderr
    assert 'rang-unverified' in sent.stderr, sent.stderr
    output, error = process.communicate(timeout=10)
    assert process.returncode == 0, (output, error)
    received = json.loads((root/'read-result.json').read_text())
    assert 'REACH-RING' in received['wake'] and recipient in received['wake'], received
    assert 'HELLO-PLAIN-TERMINAL-7Q' in received['card'], received
    assert '<plain-terminal-7q@example.test>' in received['card'], received
    print('PASS public terminal launcher, discovery, registration, delivery, wake and inbox read work together')
finally:
    if process.poll() is None:
        process.terminate()
        process.communicate(timeout=5)
PY
