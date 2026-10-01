#!/usr/bin/env python3
"""Linux identity persistence/concurrency and isolated source fallback checks."""
import concurrent.futures
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

helper = Path(__file__).resolve().parents[3] / "apps/reach/lib/reach-machine-id"
root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix="platform-identity-"))
root = root.resolve()
root.mkdir(parents=True, exist_ok=True)
assert helper.is_file(), "missing required reach-machine-id helper"
if os.environ.get("REACH_TEST_CONSTANT_FALLBACK") == "1":
    original = helper.read_text()
    target = "reach_id_value=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \\n')"
    assert original.count(target) == 1, "random fallback boundary changed"
    helper = root / "constant-fallback-helper"
    helper.write_text(original.replace(target, "reach_id_value=00000000000000000000000000000000"))
    helper.chmod(0o700)
    print(f"PLANTED constant fallback in isolated helper: {helper}", flush=True)
def invoke(state, masked=False):
    env = dict(os.environ, XDG_STATE_HOME=str(state), HOME=str(root))
    args = [str(helper)]
    if masked:
        args = ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/etc", "--bind", str(root), str(root), *args]
    return subprocess.run(args, env=env, capture_output=True, text=True, timeout=10)
def valid(result):
    assert result.returncode == 0 and re.fullmatch(r"[0-9a-f]{32}\n", result.stdout), (result.returncode,result.stdout,result.stderr)
    return result.stdout
state = root / "linux"
first = valid(invoke(state))
assert first.strip() == Path("/etc/machine-id").read_text().strip()
assert (state / "sno-reach/machine-id").read_text() == first
assert (state / "sno-reach/machine-id").stat().st_mode & 0o777 == 0o600
assert valid(invoke(state, masked=True)) == first
random_state = root / "random"
random_first = valid(invoke(random_state, masked=True))
assert valid(invoke(random_state)) == random_first
concurrent_state = root / "concurrent"
with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
    values = list(pool.map(lambda _: valid(invoke(concurrent_state, masked=True)), range(20)))
assert len(set(values)) == 1
assert values[0] == (concurrent_state / "sno-reach/machine-id").read_text()
assert len(list((concurrent_state / "sno-reach").iterdir())) == 1
assert random_first != values[0], "independent random fallback states received the same identity"
bad = state / "sno-reach/machine-id"
bad.write_text("not-hex\n")
refusal = invoke(state)
assert refusal.returncode == 74 and not refusal.stdout and str(bad) in refusal.stderr
assert bad.read_text() == "not-hex\n"
(root / "results.json").write_text(json.dumps(dict(linux=first, fallback=random_first, concurrent=values, invalid_stderr=refusal.stderr), indent=2)+"\n")
print("PASS Linux source, persistence, distinct random fallback states,20-way atomic creation,0600 and corrupt-state refusal")
