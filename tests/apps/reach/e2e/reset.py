#!/usr/bin/env python3
"""Reset only stopped owned fixtures after a recorded preflight environment RED."""
import json
from pathlib import Path
import sys
from live_support import Live, CLOCK, sha

if len(sys.argv) != 4:
    raise SystemExit("usage: reset.py <context> <new-evidence-dir> <completed-cleanup.json>")
run = Live(sys.argv[1], sys.argv[2])
cleanup_path = Path(sys.argv[3])
cleanup = json.loads(cleanup_path.read_text())
if cleanup["candidate"] != run.context["archive_sha256"]:
    raise SystemExit("cleanup does not name this candidate")
clock_before = CLOCK.read_bytes()
for actor in run.context["actors"]:
    if run.live_pids(actor):
        raise SystemExit("owned actor still alive; refuse fixture reset")
    if actor.get("handle") and actor["channel"] == "acp" and not run.acpx(actor, "show")["closed"]:
        raise SystemExit("owned ACP session is not closed")
code, _, _ = run.command([run.context["tools"]["tmux"]["path"], "-L", run.context["server"], "list-sessions"], timed=False)
if code == 0:
    raise SystemExit("private tmux server still has sessions")
prior = dict(preflight=run.context.get("preflight"), allocated=run.context["intentional_spawned"],
             actors=[dict(actor) for actor in run.context["actors"]], cleanup=str(cleanup_path), cleanup_sha256=sha(cleanup_path))
for actor in run.context["actors"]:
    if (run.state / actor["address"] / "reachable.json").exists():
        run.checked("unregister", "--as", actor["address"])
    actor.pop("handle", None)
run.context.setdefault("prior_attempts", []).append(prior)
run.context["intentional_spawned"] = 0
run.context["environment"].pop("TMUX", None)
for key in ("preflight", "blocked_vendors", "cleaned"):
    run.context.pop(key, None)
run.save()
if CLOCK.read_bytes() != clock_before:
    raise RuntimeError("live clock changed during fixture reset")
(run.evidence / "reset.json").write_text(json.dumps(dict(prior=prior, clock_sha256=sha(CLOCK),
    same_root=str(run.state), same_actors=[actor["address"] for actor in run.context["actors"]]), indent=2) + "\n")
print("PASS stopped owned fixtures reset; same six addresses/root and unchanged live clock")
