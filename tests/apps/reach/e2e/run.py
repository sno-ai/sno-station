#!/usr/bin/env python3
"""Serial admitted native matrix, one clock, no automatic failure retries."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from live_support import clock

if len(sys.argv) != 5 or sys.argv[3] != "--allow-live":
    raise SystemExit("usage: run.py <prepared-context> <new-evidence-root> --allow-live <frozen-archive-sha256>")
here = Path(__file__).resolve().parent
context, proof = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
data = json.loads(context.read_text())
if data["archive_sha256"] != sys.argv[4]:
    raise SystemExit("explicit live admission names a different archive")
proof.mkdir(parents=True, exist_ok=False)
matrix = {
    "QCG-4": [("acp", "none"), ("acp", "send-ring"), ("acp", "none"), ("acp", "reply-ring"), ("acp", "none")],
    "QCG-5": [("tmux", "none"), ("tmux", "wrong-channel"), ("tmux", "none"), ("tmux", "reply-ring"), ("tmux", "none")],
    "QCG-6": [("call", "none"), ("timeout-acp", "none"), ("timeout-tmux", "none"),
              ("call-acp", "call-read"), ("call-tmux", "call-read"), ("call", "none")],
    "QCG-7": [("watch", "none"), ("watch", "watch-prompt"), ("watch", "none")],
    "QCG-22": [("continuing", "none"), ("continuing", "reply-to"), ("continuing", "none")],
}
receipt = dict(host=os.uname().nodename, candidate=data["archive_sha256"], rows=[], complete=False)


def execute(args, limit=None):
    print("START " + " ".join(map(str, args)), flush=True)
    return subprocess.run([sys.executable, *map(str, args)], timeout=limit, check=False).returncode


try:
    preflight_code = execute([here / "preflight.py", context, proof / "preflight", "--allow-live", sys.argv[4]], 1600)
    receipt["preflight_exit"] = preflight_code
    data = json.loads(context.read_text())
    if not all(data.get("preflight", {}).get("vendor_passed", {}).get(actor["kind"]) for actor in data["actors"]):
        raise RuntimeError("a participating vendor has no green Chapter0; no journeys started")
    for qcg, trials in matrix.items():
        paths = []
        for index, (mode, defect) in enumerate(trials):
            clock()
            setup = proof / f"cleanup-before-{qcg}-{index + 1}"
            if execute([here / "fixture-inbox.py", context, setup, "--cleanup"], 120):
                raise RuntimeError("owned fixture inbox is not empty; no measured row started")
            path = proof / f"{qcg}-{index + 1}-{mode}-{defect}"
            code = execute([here / "journeys.py", context, path, mode, defect, sys.argv[4]],
                           min(605, clock()["deadline_epoch"] - time.time()))
            receipt["rows"].append(dict(qcg=qcg, mode=mode, defect=defect, path=str(path), exit_code=code))
            (proof / "matrix.json").write_text(json.dumps(receipt, indent=2) + "\n")
            if code:
                raise RuntimeError(f"{qcg}/{defect} failed; no automatic product-failure retry")
            paths.append(path)
        code = execute([here / "verify.py", data["archive"], qcg, *paths], 120)
        if code:
            raise RuntimeError(f"{qcg} completed evidence did not revalidate")
    receipt["complete"] = preflight_code == 0
except Exception as error:
    receipt["error"] = str(error)
finally:
    cleanup_code = execute([here / "cleanup.py", context, proof / "cleanup"], 120)
    receipt["cleanup_exit"] = cleanup_code
    receipt["complete"] = receipt["complete"] and cleanup_code == 0
    (proof / "matrix.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(f"Native matrix {'GREEN' if receipt['complete'] else 'RED'}: {proof / 'matrix.json'}")
raise SystemExit(0 if receipt["complete"] else 1)
