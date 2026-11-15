#!/usr/bin/env python3
"""Exercise real QUIC streams, remote exit status and receiver process cleanup."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

binary = str(Path(sys.argv[1]).resolve())
case = sys.argv[2] if len(sys.argv) > 2 else "all"
assert case in ("all", "duplex", "reject", "shutdown", "authorization"), case
with tempfile.TemporaryDirectory(prefix="reach-native-") as directory:
    root = Path(directory)
    receiver = root / "receiver"
    receiver.write_text("""#!/usr/bin/env python3
import os, pathlib, subprocess, sys
assert sys.argv[1:] == ['__receive'], sys.argv
mode = sys.stdin.buffer.readline()
if mode == b'reject\\n':
    sys.stderr.write('receiver refused before body\\n')
    sys.exit(23)
if mode == b'error\\n':
    sys.stdout.buffer.write(b'READY\\n')
    sys.stdout.buffer.flush()
    body = sys.stdin.buffer.read()
    sys.stdout.buffer.write(b'RECEIVED:' + body)
    sys.stdout.buffer.flush()
    sys.stderr.write('receiver rejected after reading body\\n')
    sys.exit(23)
child = subprocess.Popen(['sleep', '90'])
pathlib.Path(os.environ['NATIVE_CHILD']).write_text(str(child.pid))
child.wait()
""")
    receiver.chmod(0o755)
    info = root / "info.json"
    child_file = root / "child.pid"
    client_key = root / "client-key"
    client_info = root / "client-info.json"
    bootstrap = subprocess.Popen(
        [binary, "serve", "--bind", "127.0.0.1:0", "--key-file", str(client_key),
         "--info-file", str(client_info), "--receiver", str(receiver)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 10
        while not client_info.exists():
            assert bootstrap.poll() is None
            assert time.monotonic() < deadline
            time.sleep(.05)
        (root / "peers").mkdir()
        (root / "peers/client.test.json").write_text(client_info.read_text())
    finally:
        bootstrap.terminate()
        bootstrap.wait(timeout=10)
    connect_args = [binary, "connect", "--peer-file", str(info), "--key-file", str(client_key)]
    with (root / "server.log").open("w+") as log:
        server = subprocess.Popen(
            [binary, "serve", "--bind", "127.0.0.1:0", "--key-file", str(root / "key"),
             "--info-file", str(info), "--receiver", str(receiver)],
            env=dict(os.environ, NATIVE_CHILD=str(child_file)), stdout=log, stderr=log,
        )
        client = None
        try:
            deadline = time.monotonic() + 10
            while not info.exists():
                assert server.poll() is None, "receiver exited before writing its contact"
                assert time.monotonic() < deadline, "receiver did not publish contact"
                time.sleep(.05)
            contact = json.loads(info.read_text())
            assert contact["addresses"], contact
            if case in ("all", "authorization"):
                denied = subprocess.run(
                    [binary, "connect", "--peer-file", str(info),
                     "--key-file", str(root / "unknown-key")],
                    input=b"sleep\n", capture_output=True, timeout=10,
                )
                assert denied.returncode != 0 and b"not authorized" in denied.stderr, denied
                assert not child_file.exists(), "unknown peer started the receiver"
                print("PASS unknown peer cannot invoke the receiver", flush=True)
            if case in ("all", "duplex"):
                client = subprocess.Popen(connect_args,
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                client.stdin.write(b"error\n")
                client.stdin.flush()
                # Receiving READY before finishing input proves the stream is duplex.
                import selectors
                with selectors.DefaultSelector() as selector:
                    selector.register(client.stdout, selectors.EVENT_READ)
                    assert selector.select(10), "no remote READY while sender input remained open"
                assert client.stdout.readline() == b"READY\n"
                out, err = client.communicate(b"complete body\x00with binary bytes", timeout=10)
                assert client.returncode == 23, (client.returncode, out, err)
                assert out == b"RECEIVED:complete body\x00with binary bytes", out
                assert b"receiver rejected after reading body" in err, err
                print("PASS duplex bytes, remote stderr and nonzero exit survive real QUIC", flush=True)
            if case in ("all", "reject"):
                client = subprocess.Popen(connect_args,
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                client.stdin.write(b"reject\n")
                client.stdin.flush()
                client.wait(timeout=10)
                assert client.returncode == 23, client.returncode
                assert b"receiver refused before body" in client.stderr.read()
                client.stdin.close()
                print("PASS early receiver refusal returns while caller stdin remains open", flush=True)
            if case in ("all", "shutdown"):
                client = subprocess.Popen(connect_args,
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                client.stdin.write(b"sleep\n")
                client.stdin.flush()
                deadline = time.monotonic() + 10
                while not child_file.exists():
                    assert client.poll() is None, "connect exited before receiver child started"
                    assert time.monotonic() < deadline, "receiver child did not start"
                    time.sleep(.05)
                server.terminate()
                server.wait(timeout=10)
                child = child_file.read_text()
                deadline = time.monotonic() + 2
                while True:
                    state = subprocess.run(["ps", "-p", child, "-o", "stat="], text=True, capture_output=True)
                    if state.returncode != 0 or state.stdout.strip().startswith("Z"):
                        break
                    assert time.monotonic() < deadline, state.stdout
                    time.sleep(.05)
                client.communicate(timeout=10)
                assert client.returncode != 0, "interrupted receiver was reported successful"
                print("PASS receiver shutdown stops its child and fails interrupted connect", flush=True)
        finally:
            if client is not None and client.poll() is None:
                client.terminate()
                client.communicate(timeout=5)
            if server.poll() is None:
                server.terminate()
                server.wait(timeout=10)
            if child_file.exists():
                try:
                    os.kill(int(child_file.read_text()), 15)
                except ProcessLookupError:
                    pass
