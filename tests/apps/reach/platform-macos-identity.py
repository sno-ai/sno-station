#!/usr/bin/env python3
"""Exercise real macOS identity and deliberately unavailable hardware lookup."""
import concurrent.futures
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

assert os.uname().sysname == "Darwin", "macOS host required"
helper = Path(__file__).resolve().parents[3] / "apps/reach/lib/reach-machine-id"
root = Path(tempfile.mkdtemp(prefix="platform-macos-identity-"))
if os.environ.get("REACH_TEST_CONSTANT_FALLBACK") == "1":
    original = helper.read_text()
    target = "reach_id_value=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \\n')"
    assert original.count(target) == 1, "random fallback boundary changed"
    helper = root / "constant-fallback-helper"
    helper.write_text(original.replace(target, "reach_id_value=00000000000000000000000000000000"))
    helper.chmod(0o700)
    print(f"PLANTED constant fallback in isolated helper: {helper}", flush=True)
stub = root / "bin"
stub.mkdir()
(stub / "ioreg").write_text("#!/bin/sh\nexit 1\n")
(stub / "ioreg").chmod(0o700)

def run(state, unavailable=False):
    env = dict(os.environ, XDG_STATE_HOME=str(root / state))
    if unavailable:
        env["PATH"] = str(stub) + ":" + env["PATH"]
    return subprocess.run([str(helper)], env=env, capture_output=True, text=True, timeout=10)

def value(result):
    assert result.returncode == 0 and re.fullmatch(r"[0-9a-f]{32}\n", result.stdout), vars(result)
    return result.stdout

hardware = subprocess.check_output(["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"], text=True)
expected = re.search(r'"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]+)"', hardware)[1].replace("-", "").lower()
native = value(run("native"))
assert native.strip() == expected
fallback = value(run("fallback", True))
assert value(run("fallback", True)) == fallback
# A recovered hardware source must not replace the persisted random identity.
assert value(run("fallback")) == fallback
with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
    concurrent = list(pool.map(lambda _: value(run("concurrent", True)), range(20)))
assert len(set(concurrent)) == 1
assert fallback != concurrent[0], "independent random fallback states received the same identity"
for state, chosen in (("native", native), ("fallback", fallback), ("concurrent", concurrent[0])):
    target = root / state / "sno-reach/machine-id"
    assert target.read_text() == chosen
    assert target.stat().st_mode & 0o777 == 0o600
    assert list(target.parent.iterdir()) == [target]
bad = root / "native/sno-reach/machine-id"
bad.write_text("not-hex\n")
refusal = run("native")
assert refusal.returncode == 74 and not refusal.stdout and str(bad) in refusal.stderr
assert bad.read_text() == "not-hex\n"
report = dict(host=os.uname().nodename, helper=str(helper), native=native, fallback=fallback,
              concurrent=concurrent, invalid_stderr=refusal.stderr, passed=True)
(root / "results.json").write_text(json.dumps(report, indent=2) + "\n")
print(f"PASS macOS hardware identity, distinct persisted fallback states, 20 concurrent creators, 0600, corrupt refusal: {root}")
