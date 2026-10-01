#!/usr/bin/env python3
"""External ACPX boundary fixture. Wire shapes: ACPX 0.13.2 CLI output."""
import json
import os
from pathlib import Path
import re
import sys
import time

root = Path(os.environ["ACP_FIXTURE"])
mode = (root / "mode").read_text()
args = sys.argv[1:]
with (root / "acpx.calls").open("a") as log:
    log.write(json.dumps(args) + "\n")
cwd = args[args.index("--cwd") + 1]
created = json.loads((root / "created").read_text()) if (root / "created").exists() else {}
record = {"acpxRecordId": "fixture-record", "name": created.get("name", "probe"), "cwd": cwd,
    "closed": mode == "closed", "eventLog": {"active_path": str(root / "events.ndjson")}}
if "sessions" in args:
    operation = args[args.index("sessions") + 1]
    if operation == "list":
        records = [] if mode in ("missing", "absent-new", "registration-fails") and not created else [record]
        print(json.dumps(records if "--local" in args else {"source": "agent", "sessions": []}))
    elif operation == "show":
        if mode in ("missing", "absent-new") and not (root / "created").exists():
            sys.exit(1)
        print(json.dumps(record))
    elif operation == "new":
        created = {key: os.environ.get(key) for key in ("SNO_REACH_ADDR", "SNO_REACH_ROOT", "SNO_REACH_GUIDE")}
        created["name"] = args[args.index("--name") + 1]
        (root / "created").write_text(json.dumps(created))
        if mode == "registration-fails":
            (Path(os.environ["SNO_REACH_ROOT"]) / os.environ["SNO_REACH_ADDR"] / "reachable.json").mkdir()
        print(json.dumps({"action": "session_ensured", "created": True,
            "acpxRecordId": "fixture-record", "name": "probe"}))
    elif operation == "close":
        (root / "closed").touch()
        print(json.dumps({"action": "session_closed", "acpxRecordId": "fixture-record"}))
    else:
        sys.exit(2)
    sys.exit(0)
if "prompt" not in args:
    sys.exit(2)
print("[acpx] session probe starting", file=sys.stderr)
text = sys.stdin.read() if "--file" in args else args[-1]
(root / "received.json").write_text(json.dumps({"cwd": cwd,
    "name": args[args.index("-s") + 1], "text": text, "no_wait": "--no-wait" in args}))
if mode == "fail":
    sys.exit(1)
if mode == "timeout":
    time.sleep(120)
if mode == "empty":
    sys.exit(0)
if mode == "garbage":
    print("not a queue acknowledgement")
elif "--no-wait" in args:
    print(json.dumps({"action": "prompt_queued", "acpxRecordId": "fixture-record", "requestId": "request-1"}))
else:
    receipt = re.search(r"REACH-RECEIPT-[A-Za-z0-9-]+", text).group(0)
    if mode == "receipt-missing":
        receipt = ""
    elif mode == "receipt-wrong":
        receipt = "REACH-RECEIPT-wrong"
    print(json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {
        "sessionId": "fixture-record", "update": {
            "sessionUpdate": "user_message_chunk" if mode == "echo" else "agent_message_chunk",
            "content": {"type": "text", "text": receipt + " RESULT-42" +
                ("x" * 262144 if mode == "large-reply" else "")}}}}))
    print(json.dumps({"jsonrpc": "2.0", "id": 3, "result": {"stopReason": "end_turn"}}))
