#!/usr/bin/env python3
"""Close only this run's owned runtimes, including unregistered seats."""
import json
import os
from pathlib import Path
import signal
import sys
import time
from live_support import Live

if len(sys.argv) != 3:
    raise SystemExit("usage: cleanup.py <prepared-context> <new-evidence-dir>")
run = Live(sys.argv[1], sys.argv[2])
rows = []
for record in run.state.glob("*/wake-attempts/*.json"):
    try:
        pid = int(json.loads(record.read_text()).get("child_pid") or 0)
        if pid <= 1:
            continue
        command = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode()
        if str(run.state) in command and "reach-wake" in command:
            os.kill(pid, signal.SIGTERM)
            rows.append(dict(wake_record=str(record), signalled_pid=pid))
    except (ValueError, FileNotFoundError, ProcessLookupError):
        continue
for actor in run.context["actors"]:
    handle = actor.get("handle")
    if actor["channel"] == "acp" and handle:
        prefix, cwd, name = handle.split(":", 2)
        if cwd != actor["cwd"] or prefix != "acp-" + actor["kind"]:
            raise RuntimeError("owned session identity mismatch; refusing cleanup")
        code, out, err = run.command([run.context["tools"]["acpx"]["path"], "--cwd", cwd,
            "--format", "json", actor["kind"], "sessions", "close", name], timed=False)
        rows.append(dict(actor=actor["label"], close_exit=code, output=out, error=err))
code, out, err = run.command([run.context["tools"]["tmux"]["path"], "-L", run.context["server"],
                             "kill-server"], timed=False)
rows.append(dict(control_server=run.context["server"], close_exit=code, error=err))
for actor in run.context["actors"]:
    # Close is preferred. Kill only a still-live PID whose current cwd remains
    # this exact owned actor directory; never match a process name or shared seat.
    signalled = []
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid in run.live_pids(actor):
            try:
                if os.readlink(f"/proc/{pid}/cwd") == actor["cwd"]:
                    os.kill(pid, sig)
                    signalled.append(dict(pid=pid, signal=sig.name))
            except (FileNotFoundError, ProcessLookupError):
                pass
        deadline = time.monotonic() + 3
        while run.live_pids(actor) and time.monotonic() < deadline:
            time.sleep(.1)
    rows.append(dict(actor=actor["label"], signals=signalled, remaining_pids=run.live_pids(actor)))
remaining = [row for row in rows if row.get("remaining_pids")]
artifact = dict(host=os.uname().nodename, candidate=run.context["archive_sha256"], rows=rows,
                passed=not remaining, private_credentials_retained=True)
(run.evidence / "cleanup.json").write_text(run.clean(json.dumps(artifact, indent=2)) + "\n")
run.context["cleaned"] = not remaining
run.save()
print("Owned runtimes stopped; private credential copies remain in isolated HOME" if not remaining else "RED: owned runtimes remain")
raise SystemExit(bool(remaining))
