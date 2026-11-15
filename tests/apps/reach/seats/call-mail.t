#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/../test-lib.sh"
initialize "$SENDER" Sender
initialize "$RECEIVER" Receiver
register "$SENDER"
python3 - "$REACH" "$TEST_HOME" "$STATE" "$SENDER" "$RECEIVER" "$WORK" <<'PY'
import os, pathlib, subprocess, sys, time
reach, home, state, sender, recipient, directory = sys.argv[1:]
root = pathlib.Path(directory)
env = dict(os.environ, HOME=home, XDG_STATE_HOME=home+'/.local/state', SNO_REACH_ROOT=state,
           SNO_REACH_ADDR=sender)
actor = root/'reader.py'
actor.write_text('''import os,pathlib,subprocess,sys,tty
reach,recipient,directory,answer=sys.argv[1:]
root=pathlib.Path(directory)
tty.setraw(0)
subprocess.run([reach,'register','--as',recipient,'--channel','terminal'],check=True,capture_output=True)
(root/'ready').write_text('ready')
data=b''
while not data.endswith(b'\\r'): data+=os.read(0,65536)
listing=subprocess.check_output([reach,'inbox','--as',recipient],text=True)
card=pathlib.Path(listing.split('\\t')[0])
(root/'original').write_text(card.read_text())
subprocess.run([reach,'reply','--as',recipient,'--card',str(card)],input=answer+'\\n',text=True,check=True,capture_output=True)
''')
for name, text, answer, expect, expected_status in [
    ('answer', 'ORIGINAL-INSTRUCTION-7Q\nsecond line', 'RECEIVER-ANSWER-7Q', 'RECEIVER-ANSWER-7Q', 0),
    ('echo', 'ECHO-ONLY-7Q is in the request, not the answer.', 'DIFFERENT-ANSWER', 'ECHO-ONLY-7Q', 4),
]:
    case = root/name
    case.mkdir()
    process=subprocess.Popen([reach,'terminal','--',sys.executable,str(actor),reach,recipient,str(case),answer],
                             env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        deadline=time.monotonic()+10
        while not(case/'ready').exists():
            assert process.poll() is None,process.communicate()
            assert time.monotonic()<deadline
            time.sleep(.05)
        result=subprocess.run([reach,'call',recipient,text,'--expect',expect,'--timeout','15','--every','1'],
            env=env,text=True,capture_output=True,timeout=22)
        assert result.returncode==expected_status,(result.returncode,result.stdout,result.stderr)
        if expected_status == 0:
            assert answer in result.stdout,result.stdout
            assert 'ORIGINAL-INSTRUCTION-7Q' not in result.stdout,result.stdout
        out,err=process.communicate(timeout=5)
        assert process.returncode==0,(out,err)
        original=(case/'original').read_text()
        assert text in original, original
        assert 'X-Type: call' in original, original
        print('PASS terminal call '+name+' checks receiver output, not quoted input', flush=True)
    finally:
        if process.poll() is None:
            process.terminate();process.communicate(timeout=5)
PY
