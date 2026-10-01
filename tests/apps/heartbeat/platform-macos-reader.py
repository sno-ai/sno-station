#!/usr/bin/env python3
"""Run the exact printed reader and reject a recycled non-heartbeat pid on macOS."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

assert os.uname().sysname in ("Darwin", "Linux"), "admitted platform required"
program = os.environ.get("HEARTBEAT", str(Path(__file__).resolve().parents[3] / "apps/heartbeat/bin/heartbeat"))
root = Path(tempfile.mkdtemp(prefix="platform-macos-reader-"))
print(f"Reader evidence: {root}", flush=True)
env = dict(os.environ, HEARTBEAT_STATE=str(root / "state"), HEARTBEAT_OWNER="platform-reader")
label = os.environ.get("PLATFORM_HEARTBEAT_LABEL", "fd-e2e")
reader = None
foreign = None
arm = (root / "arm.log").open("w")
ticks = (root / "reader.log").open("w")
heartbeat = subprocess.Popen([program, "--interval", "1m", "--label", label, "--max-hours", "0.05", "--", "true"], env=env, stdout=arm, stderr=subprocess.STDOUT)
try:
    deadline = time.monotonic() + 5
    while True:
        match = re.search(r'Monitor\(\{command: "([^"]+)"', (root / "arm.log").read_text())
        if match:
            break
        assert heartbeat.poll() is None and time.monotonic() < deadline, (root / "arm.log").read_text()
        time.sleep(0.05)
    reader_command = match[1]
    assert reader_command.startswith(f"tail --pid={heartbeat.pid} -F -n0 ")
    log_path = Path(reader_command.split(" -F -n0 ", 1)[1])
    reader = subprocess.Popen(["bash", "-c", reader_command], env=env, stdout=ticks, stderr=subprocess.STDOUT)
    deadline = time.monotonic() + 90
    while not re.search(r"tick=[1-9][0-9]* ok", (root / "reader.log").read_text()):
        assert heartbeat.poll() is None and reader.poll() is None and time.monotonic() < deadline
        time.sleep(0.1)
    assert "tick=1 ok" in log_path.read_text(), "the immediate first tick did not run"
    first_observed_tick = int(re.search(r"tick=([1-9][0-9]*) ok", (root / "reader.log").read_text())[1])
    stop_started = time.monotonic()
    stop = subprocess.run([program, "--stop", label], env=env, capture_output=True, text=True, timeout=5)
    assert stop.returncode == 0 and "heartbeat: stopped" in stop.stdout + stop.stderr, vars(stop)
    heartbeat.wait(timeout=max(0.01, 5 - (time.monotonic() - stop_started)))
    reader.wait(timeout=max(0.01, 5 - (time.monotonic() - stop_started)))
    elapsed = time.monotonic() - stop_started
    assert elapsed <= 5 and reader.returncode == 0
    assert "STOPPED" in (root / "reader.log").read_text()
    # A stale registry entry can point at a live, unrelated process. The public
    # stop path must reject that entry without signalling the process.
    foreign = subprocess.Popen(["sleep", "60"])
    key = lambda text: hashlib.sha256(text.encode()).hexdigest()
    claim = root / "state/run" / key(env["HEARTBEAT_OWNER"]) / key("foreign")
    claim.mkdir(parents=True)
    (claim / "info").write_text(f'owner={env["HEARTBEAT_OWNER"]}\nlabel=foreign\npid={foreign.pid}\nlog={root}/foreign.log\n')
    refused = subprocess.run([program, "--stop", "foreign"], env=env, capture_output=True, text=True, timeout=5)
    assert refused.returncode != 0 and foreign.poll() is None, vars(refused)
    (root / "results.json").write_text(json.dumps(dict(host=os.uname().nodename, program=program,
        reader_command=reader_command, first_observed_tick=first_observed_tick,
        stop_seconds=elapsed, reader_exit=reader.returncode,
        foreign_pid=foreign.pid, foreign_refusal=refused.stdout + refused.stderr, passed=True), indent=2) + "\n")
    print(f"PASS real printed reader tick, STOPPED, self-retirement in {elapsed:.3f}s, foreign pid refusal: {root}")
finally:
    for process in (heartbeat, reader, foreign):
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
    arm.close()
    ticks.close()
