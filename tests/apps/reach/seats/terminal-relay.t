#!/usr/bin/env bash
# A real PTY receiver observes both ordinary input and a Reach wake, independent of terminal brand.
set -Eeuo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
target="${REACH_TERMINAL_UNDER_TEST:-$here/../../../../apps/reach/lib/reach-terminal}"
mode="${1:-all}"
[[ "$mode" == all || "$mode" == native ]] || { printf 'choose all or native\n' >&2; exit 2; }
python3 - "$target" "$mode" <<'PY'
import json
import fcntl
import os
import pathlib
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

target = str(pathlib.Path(sys.argv[1]).resolve())
if sys.argv[2] == "native":
    raise SystemExit(0)
with tempfile.TemporaryDirectory(prefix="reach-terminal-test.") as work:
    root = pathlib.Path(work)
    receiver = root / "receiver.py"
    receiver.write_text('''import json, os, pathlib, subprocess, sys, termios, tty
root = pathlib.Path(sys.argv[1])
tty.setraw(0)
discovery = subprocess.run([sys.argv[2], "discover"], capture_output=True, text=True, check=True)
(root / "ready.tmp").write_text(discovery.stdout)
(root / "ready.tmp").rename(root / "ready.json")
os.write(1, b"RECEIVER-READY")
data = b""
while not data.endswith(b"\\r"):
    data += os.read(0, 65536)
(root / "received.json").write_text(json.dumps({"input": data.decode(), "isatty": os.isatty(0)}))
os.write(1, b"RECEIVER-RECEIVED")
raise SystemExit(23)
''')
    env = dict(os.environ, TERM_PROGRAM="an-unfamiliar-terminal")
    env.pop("SNO_REACH_TERMINAL_SOCKET", None)
    process = subprocess.Popen([target, "run", "--", sys.executable, str(receiver), work, target],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    try:
        deadline = time.monotonic() + 8
        while not (root / "ready.json").exists():
            assert process.poll() is None, process.communicate()
            assert time.monotonic() < deadline, "receiver did not become ready"
            time.sleep(0.02)
        discovery = json.loads((root / "ready.json").read_text())
        handle = discovery["handle"]
        socket_path = pathlib.Path(handle.removeprefix("relay:"))
        assert handle.startswith("relay:/"), discovery
        assert discovery["identity"] == str(socket_path), discovery
        probe = subprocess.run([target, "probe", handle], capture_output=True, text=True, timeout=5)
        assert probe.returncode == 0, probe.stderr
        process.stdin.write(b"ordinary-input:")
        process.stdin.flush()
        text = "Reach message with spaces\nand 中文"
        sent = subprocess.run([target, "ring", handle, text], capture_output=True, text=True, timeout=5)
        assert sent.returncode == 0, sent.stderr
        stdout, stderr = process.communicate(timeout=5)
        assert process.returncode == 23, (process.returncode, stderr)
        received = json.loads((root / "received.json").read_text())
        assert received == {"input": "ordinary-input:\x1b[200~" + text + "\x1b[201~\r", "isatty": True}, received
        assert b"RECEIVER-READY" in stdout and b"RECEIVER-RECEIVED" in stdout, stdout
        assert not socket_path.exists(), socket_path
        dead = subprocess.run([target, "ring", handle, "late"], capture_output=True, text=True, timeout=5)
        assert dead.returncode != 0 and dead.stderr, dead
        print("PASS ordinary input and multiline Reach message reach the same real PTY; output, exit status and cleanup survive")
    finally:
        if process.poll() is None:
            process.terminate()
            process.communicate(timeout=5)

    result = subprocess.run([target, "run", "--", sys.executable, "-c", "raise SystemExit(7)"],
                            stdin=subprocess.DEVNULL, capture_output=True, timeout=5)
    assert result.returncode == 7, (result.returncode, result.stderr)
    print("PASS a command needing no input preserves its exit status with stdin redirected")

    receiver.write_text('''import fcntl, json, os, pathlib, signal, sys, termios, time
root = pathlib.Path(sys.argv[1])
def resized(signum, frame):
    (root / "size.json").write_text(json.dumps(list(termios.tcgetwinsize(0))))
signal.signal(signal.SIGWINCH, resized)
(root / "child-pid").write_text(str(os.getpid()))
while True:
    signal.pause()
''')
    master, terminal = os.openpty()
    original = termios.tcgetattr(terminal)
    process = subprocess.Popen([target, "run", "--", sys.executable, str(receiver), work],
                               stdin=terminal, stdout=terminal, stderr=subprocess.PIPE, env=env)
    try:
        deadline = time.monotonic() + 5
        while not (root / "child-pid").exists():
            assert process.poll() is None, process.communicate()
            assert time.monotonic() < deadline
            time.sleep(0.02)
        child = int((root / "child-pid").read_text())
        fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 43, 117, 0, 0))
        process.send_signal(signal.SIGWINCH)
        while not (root / "size.json").exists():
            assert time.monotonic() < deadline, "receiver did not receive resize"
            time.sleep(0.02)
        assert json.loads((root / "size.json").read_text()) == [43, 117]
        process.terminate()
        _, stderr = process.communicate(timeout=5)
        assert process.returncode == 143, (process.returncode, stderr)
        restored = termios.tcgetattr(terminal)
        # macOS sets PENDIN when canonical input is restored, even without a relay.
        restored[3] &= ~termios.PENDIN
        original[3] &= ~termios.PENDIN
        assert restored == original
        try:
            os.kill(child, 0)
        except ProcessLookupError:
            pass
        else:
            raise AssertionError("terminated relay left its command running")
        print("PASS terminal resize reaches the child; termination restores terminal settings and leaves no child")
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=5)
        os.close(master)
        os.close(terminal)

PY
python3 - "$target" <<'PY'
import base64
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

target = str(pathlib.Path(sys.argv[1]).resolve())
# Only the external Codex CLI is substituted; the terminal adapter remains real.
with tempfile.TemporaryDirectory(prefix="reach-terminal-native.") as work:
    root = pathlib.Path(work)
    adapter = root / "reach-terminal"
    shutil.copy2(target, adapter)
    wake = root / "reach-codex-wake"
    wake.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
with pathlib.Path(os.environ["FAKE_WAKE_LOG"]).open("a") as log:
    log.write(json.dumps({"argv": sys.argv[1:], "home": os.environ["CODEX_HOME"]}) + "\\n")
if os.environ.get("FAKE_WAKE_FAIL"):
    sys.stderr.write("native wake refused\\n")
    raise SystemExit(8)
''')
    wake.chmod(0o755)
    native_bin = root / "native-bin"
    native_bin.mkdir()
    fake_codex = native_bin / "codex"
    fake_codex.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
with pathlib.Path(os.environ["FAKE_CODEX_LOG"]).open("a") as log:
    log.write(json.dumps({"argv": sys.argv[1:], "home": os.environ["CODEX_HOME"]}) + "\\n")
if "native failure" in sys.argv:
    sys.stderr.write("native queue offline\\n")
    raise SystemExit(7)
if "--message" in sys.argv:
    sys.stderr.write("native resume warning\\n")
''')
    fake_codex.chmod(0o755)
    native_log = root / "native.jsonl"
    wake_log = root / "wake.jsonl"
    native_home = str(root / "home with spaces")
    encoded_home = base64.urlsafe_b64encode(os.fsencode(native_home)).decode()
    native_handle = "codex:11111111-2222-4333-8444-555555555555:" + encoded_home
    native_env = dict(os.environ, PATH=str(native_bin) + os.pathsep + os.environ["PATH"],
                      FAKE_CODEX_LOG=str(native_log), FAKE_WAKE_LOG=str(wake_log), CODEX_HOME="wrong inherited home")
    probe = subprocess.run([str(adapter), "probe", native_handle], env=native_env,
                           capture_output=True, text=True, timeout=5)
    sent = subprocess.run([str(adapter), "ring", native_handle, "native message 中文"], env=native_env,
                          capture_output=True, text=True, timeout=5)
    failed = subprocess.run([str(adapter), "ring", native_handle, "native failure"], env=native_env,
                            capture_output=True, text=True, timeout=5)
    wake_failed = subprocess.run([str(adapter), "ring", native_handle, "native wake failure"],
                                env=dict(native_env, FAKE_WAKE_FAIL="1"), capture_output=True, text=True, timeout=5)
    assert probe.returncode == 0 and sent.returncode == 0, (probe.stderr, sent.stderr)
    assert "native resume warning" in sent.stderr, sent.stderr
    assert failed.returncode == 3 and "native queue offline" in failed.stderr, failed
    assert wake_failed.returncode == 3 and "native wake refused" in wake_failed.stderr, wake_failed
    calls = [json.loads(line) for line in native_log.read_text().splitlines()]
    assert calls == [
        {"argv": ["queue", "--help"], "home": native_home},
        {"argv": ["queue", "--thread", "11111111-2222-4333-8444-555555555555", "--message", "native message 中文", "--resume"], "home": native_home},
        {"argv": ["queue", "--thread", "11111111-2222-4333-8444-555555555555", "--message", "native failure", "--resume"], "home": native_home},
        {"argv": ["queue", "--thread", "11111111-2222-4333-8444-555555555555", "--message", "native wake failure", "--resume"], "home": native_home},
    ], calls
    wake_calls = [json.loads(line) for line in wake_log.read_text().splitlines()]
    expected_wake = {"argv": ["--codex", str(fake_codex), "--thread", "11111111-2222-4333-8444-555555555555"], "home": native_home}
    assert wake_calls == [expected_wake, expected_wake], wake_calls
    print("PASS native queue and wake use exact thread/home; probe and failed queue do not wake; warnings/errors remain visible")
PY
