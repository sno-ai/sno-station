#!/usr/bin/env python3
"""Exercise Ghostty's actual input API in a disposable macOS window."""
import json
import pathlib
import os
import shlex
import socket
import subprocess
import sys
import tempfile
import time

adapter = str(pathlib.Path(sys.argv[1]).resolve())
reach = str(pathlib.Path(sys.argv[2]).resolve()) if len(sys.argv) > 2 else None
join = str(pathlib.Path(sys.argv[3]).resolve()) if len(sys.argv) > 3 else None


def applescript(source, *args):
    return subprocess.check_output(["osascript", "-", *args], input=source, text=True, timeout=20).strip()


with tempfile.TemporaryDirectory(prefix="reach-ghostty.") as directory:
    root = pathlib.Path(directory)
    host = socket.gethostname().lower()
    recipient, sender = f'test.ghostty@{host}', f'test.sender@{host}'
    env = dict(os.environ, HOME=str(root/'home'), SNO_REACH_ROOT=str(root/'state'),
               XDG_STATE_HOME=str(root/'home/.local/state'))
    if reach:
        (root/'bin').mkdir()
        (root/'home').mkdir()
        dispatch = root/'bin/sno'
        dispatch.write_text('#!/usr/bin/env bash\nshift\nexec '+shlex.quote(reach)+' "$@"\n')
        dispatch.chmod(0o755)
        env['PATH'] = str(root/'bin')+':'+os.environ['PATH']
        subprocess.run([reach, 'init', '--as', sender, '--name', 'Sender'], env=env, check=True, capture_output=True)
    receiver = root / "receiver.py"
    receiver.write_text(
        "import os,pathlib,sys,time,subprocess,json\n"
        "root=pathlib.Path(sys.argv[1])\n"
        "if len(sys.argv)>2:\n"
        " result=subprocess.run(['bash',sys.argv[3],sys.argv[4],'--name','Ghostty-test'],capture_output=True,text=True)\n"
        " (root/'join-result').write_text(result.stdout+result.stderr)\n"
        " result.check_returncode()\n"
        "(root/'tty').write_text(os.ttyname(0))\n"
        "(root/'received').write_text(input())\n"
        "if len(sys.argv)>2:\n"
        " listing=subprocess.check_output([sys.argv[2],'inbox','--as',sys.argv[4]],text=True)\n"
        " (root/'body').write_text(pathlib.Path(listing.split('\\t')[0]).read_text())\n"
        "time.sleep(20)\n"
    )
    command = [sys.executable, str(receiver), str(root)]
    if reach:
        command += [reach, join, recipient]
        command = ['env', *[key+'='+env[key] for key in ('HOME','PATH','SNO_REACH_ROOT','XDG_STATE_HOME')], *command]
    window = applescript(
        '''on run argv
tell application "Ghostty"
set config to new surface configuration from {command:item 1 of argv}
set created to new window with configuration config
return id of created
end tell
end run''',
        shlex.join(command),
    )
    try:
        deadline = time.monotonic() + 10
        while not (root / "tty").exists() and time.monotonic() < deadline:
            time.sleep(0.1)
        assert (root/'tty').exists(), (root/'join-result').read_text() if (root/'join-result').exists() else 'receiver did not start'
        tty = (root / "tty").read_text()
        if reach:
            record=json.loads((root/'state'/recipient/'reachable.json').read_text())
            handle=record['handle']
        else:
            handle = subprocess.check_output(["bash", adapter, "discover", tty], text=True, timeout=15).strip()
        assert handle.startswith("ghostty:"), (tty, handle, (root/'join-result').read_text() if reach else '')
        text = "REACH-RING ordinary terminal 中文 7Q"
        if reach:
            from email.utils import formatdate
            card='\n'.join([f'From: Sender <{sender}>',f'To: {recipient}', 'Date: '+formatdate(localtime=True),
                'Subject: [QUESTION] Ghostty test', 'Message-ID: <ghostty-plain-7q@example.test>',
                'X-Type: question', 'X-Work: ghostty-plain-7q', '', 'GHOSTTY-CARD-BODY-7Q', ''])
            sent=subprocess.run([reach,'send','--as',sender],input=card,env=env,text=True,capture_output=True,timeout=20)
            assert sent.returncode == 0, sent.stderr
            assert 'rang-unverified' in sent.stderr, sent.stderr
        else:
            subprocess.run(["bash", adapter, "ring", handle, text], check=True, timeout=15)
        deadline = time.monotonic() + 5
        while not (root / "received").exists() and time.monotonic() < deadline:
            time.sleep(0.1)
        if reach:
            deadline=time.monotonic()+5
            while not (root/'body').exists() and time.monotonic()<deadline:
                time.sleep(.1)
            assert 'GHOSTTY-CARD-BODY-7Q' in (root/'body').read_text()
            assert 'REACH-RING' in (root/'received').read_text()
        else:
            assert (root / "received").read_text() == text
        print(json.dumps({"passed": True, "platform": "macOS", "terminal": "Ghostty", "join_and_mail": bool(reach)}))
    finally:
        applescript(
            '''on run argv
tell application "Ghostty" to close window (first window whose id is item 1 of argv)
end run''',
            window,
        )
