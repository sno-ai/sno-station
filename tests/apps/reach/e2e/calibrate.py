#!/usr/bin/env python3
"""No-runtime calibration of guard predicates and actual archive fault seams."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import ast
import os
from email.utils import formatdate
from live_support import ROOT, manifest, sha, assistant_events
from preconditions import calibrate
from variants import variant

if len(sys.argv) != 2:
    raise SystemExit("usage: calibrate.py <frozen-archive>")
archive = Path(sys.argv[1]).resolve()
subprocess.run([sys.executable, str(Path(__file__).with_name("harness-regressions.py"))], check=True)
subprocess.run(["bash", str(Path(__file__).with_name("fixture-cleanup.t"))], check=True, timeout=60)
assert Path(str(archive) + ".sha256").read_text().split() == [sha(archive), archive.name]
root = Path(tempfile.mkdtemp(prefix="reach-e2e-calibration-"))


class Calibration:
    def __init__(self):
        self.home = root / "home"
        version = subprocess.check_output(["tar", "-xOf", str(archive), "VERSION"], text=True).strip()
        release = self.home / f".local/lib/sno-reach/releases/{version}"
        release.mkdir(parents=True)
        subprocess.run(["tar", "-xzf", str(archive), "-C", str(release)], check=True)
        (self.home / ".local/lib/sno-reach/current").symlink_to(release)
        self.context = dict(release=str(release), run=str(root), payload=manifest(release))
        self.evidence = root / "evidence"
        self.evidence.mkdir()

    def command(self, args):
        assert args[:2] == ["bash", "-n"], "calibration may only check Bash syntax, never execute a runtime"
        result = subprocess.run(args, capture_output=True, text=True, timeout=10)
        return result.returncode, result.stdout, result.stderr

    def baseline(self):
        assert manifest(self.context["release"]) == self.context["payload"]


run = Calibration()
refusals = calibrate(run.home)
plants = []
for defect in ("send-ring", "reply-ring", "reply-to", "call-read", "call-read-tmux", "watch-prompt", "remind-deadline"):
    with variant(run, defect):
        current = (run.home / ".local/lib/sno-reach/current").resolve()
        actual = manifest(current)
        changed = [name for name in set(actual) | set(run.context["payload"]) if actual.get(name) != run.context["payload"].get(name)]
        assert len(changed) == 1, f"plant changed more than its one file: {changed}"
        plants.append(dict(defect=defect, changed=changed))
        if defect == "remind-deadline":
            env = dict(os.environ, REACH_UNDER_TEST=str(current / "bin/sno-reach"))
            result = subprocess.run(["bash", str(ROOT / "tests/apps/reach/progress-reporting.t"), "reminder_deadline"],
                                    env=env, capture_output=True, text=True, timeout=12)
            (run.evidence / "deadline-plant.stdout").write_text(result.stdout)
            (run.evidence / "deadline-plant.stderr").write_text(result.stderr)
            assert result.returncode != 0 and "expected whole-command deadline, got 0" in result.stdout + result.stderr
    run.baseline()
typed = root / "typed"
typed.mkdir()
typed.chmod(0o755)
(typed / "file").write_text("same bytes")
before = manifest(typed)
(typed / "file").rename(typed / "other")
(typed / "file").symlink_to("other")
assert manifest(typed) != before and manifest(typed)["file"]["type"] == "symlink"
before = manifest(typed)
typed.chmod(0o700)
assert manifest(typed) != before, "directory mode is not part of payload identity"
report = dict(candidate=sha(archive), refusals=refusals, plants=plants, full_manifest_refusals=["symlink substitution", "directory mode change"])
tree = ast.parse(Path(__file__).with_name("journeys.py").read_text())
builder = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "question")
namespace = dict(mid="<calibration@host>", work="calibration", formatdate=formatdate)
exec(compile(ast.Module(body=[builder], type_ignores=[]), "actual-journey-question", "exec"), namespace)
card = namespace["question"](dict(label="Sender", address="lead.calibration@host"), dict(label="Worker", address="worker.calibration@host"), "Return the named result.")
for valid in (False, True):
    path = root / ("valid.eml" if valid else "old-bare-from.eml")
    path.write_text(card if valid else card.replace("From: Sender <lead.calibration@host>", "From: lead.calibration@host"))
    result = subprocess.run([str(Path(run.context["release"]) / "bin/sno-reach"), "lint", str(path)], capture_output=True, text=True, timeout=10)
    (run.evidence / (path.name + ".stderr")).write_text(result.stderr)
    assert (result.returncode == 0) == valid, result.stderr
report["actual_question_lint"] = "old bare From refused; actual corrected journey constructor accepted"
def event(kind, text, session="owned"):
    return json.dumps(dict(method="session/update", params=dict(sessionId=session,
        update=dict(sessionUpdate=kind, content=dict(type="text", text=text))))) + "\n"
assert assistant_events("fixed text", "owned") == ""
assert assistant_events(event("user_message_chunk", "WATCH-WORK-nonce"), "owned") == ""
assert assistant_events(event("agent_message_chunk", "WATCH-WORK-nonce", "other"), "owned") == ""
assert assistant_events(event("agent_message_chunk", "WATCH-WORK-") + event("agent_message_chunk", "nonce"), "owned") == "WATCH-WORK-nonce"
report["watch_event_calibration"] = "reject fixed text, user echo and other session; accept split real assistant chunks"
(root / "calibration.json").write_text(json.dumps(report, indent=2) + "\n")
print(f"PASS guards, archive fault seams/restores, actual question lint and causal whole-deadline negative: {root / 'calibration.json'}")
