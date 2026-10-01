#!/usr/bin/env python3
"""Prove local test failure and the declared workflow dependency, not a hosted run."""
from pathlib import Path
import hashlib
import subprocess
import sys

import yaml

root = Path(sys.argv[1]).resolve()
workflow = yaml.safe_load((root / ".github/workflows/release-packages.yml").read_text())
jobs = workflow["jobs"]
test_job = jobs["test-utilities"]
publish_job = jobs["publish-utilities"]
assert "test-utilities" in publish_job["needs"], "publish job bypasses the test dependency"
assert "if" not in publish_job, "review changed success condition before using this proof"
assert test_job["needs"] == "utility-metadata"
test_steps = [step for step in test_job["steps"] if "run" in step]
assert len(test_steps) == 1, "test job command boundary changed"
test_step = test_steps[0]
assert not test_step.get("continue-on-error", False)
assert not test_job.get("continue-on-error", False)
assert "if" not in test_step, "test step can be skipped"
commands = test_step["run"]
assert "bash tests/apps/heartbeat/run.sh" in commands
assert "bash tests/apps/subscription-quota-check/run.sh" in commands
assert "bash tests/apps/report-time/run.sh" in commands
for job_name in ("utility-metadata", "test-utilities"):
    for step in jobs[job_name]["steps"]:
        command = step.get("run", "")
        assert " package" not in command
        assert "verify-utility-release.sh" not in command
        assert "gh release" not in command

case = root / "tests/apps/heartbeat/heartbeat.t"
case.write_text("#!/usr/bin/env bash\nprintf 'planted failing heartbeat case\\n'\nexit 1\n")


def artifacts():
    return {
        str(path.relative_to(root)): (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns)
        for app in ("heartbeat", "report-time", "subscription-quota-check")
        for path in (root / "apps" / app / "dist").rglob("*")
        if path.is_file()
    }


before = artifacts()
assert len(before) == 6, "expected three archive/checksum pairs before failed test job"
result = subprocess.run(
    ["bash", "-c", commands], cwd=root, text=True, capture_output=True, timeout=120
)
print(result.stdout, end="")
print(result.stderr, end="", file=sys.stderr)
assert result.returncode != 0, "actual workflow test command swallowed failed case"
assert "planted failing heartbeat case" in result.stdout
assert artifacts() == before, "failed test job changed package files"
print(
    "PASS actual workflow test command fails; publish-utilities has an unconditional "
    "success dependency on test-utilities and owns all utility packaging/upload steps. "
    "This is local command and workflow-structure evidence, not a hosted scheduler run."
)
