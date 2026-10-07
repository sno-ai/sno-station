#!/usr/bin/env python3
"""Read-only checks of the installed CI candidate on the two admitted hosts."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import time

root = Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=True)
archive = Path(sys.argv[2]).resolve()
expected_digest = sys.argv[3]
rows = []

def check(name, command, predicate, calibration):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=60)
        output = result.stdout + result.stderr
        passed = predicate(result.returncode, output)
    except (OSError, subprocess.TimeoutExpired) as error:
        output, passed = str(error), False
    rows.append(dict(name=name, command=command, output=output, passed=passed,
                     calibration=calibration, owner="platform executor"))
    print(f"{'PASS' if passed else 'FAIL'} preflight {name}", flush=True)

macos = os.uname().sysname == "Darwin"
expected_host = "lab-mba" if macos else "gpt1"
check("host", ["hostname"], lambda code, out: code == 0 and out.strip() == expected_host, "wrong host refuses; no remote host is modified")
check("system", ["sw_vers"] if macos else ["uname", "-s"], lambda code, out: code == 0 and ("15.7.9" if macos else "Linux") in out, "a host upgrade voids this baseline")
check("architecture", ["uname", "-m"], lambda code, out: code == 0 and out.strip() == ("arm64" if macos else "x86_64"), "wrong-architecture archive is not used")
if macos:
    check("stock-bash", ["/bin/bash", "--version"], lambda code, out: code == 0 and "3.2" in out, "all three actual Bash 3.2 refusal cases were observed")
check("runtime-bash", ["bash", "-c", 'test "${BASH_VERSINFO[0]}" -ge 5 && bash --version'], lambda code, out: code == 0, "stock PATH refusal is the declared journey plant")
for tool, args, token in (("realpath", ["-e", "--", "/"], "/"), ("find", ["/", "-maxdepth", "0", "-printf", "ready"], "ready"),
                         ("stat", ["-c", "%d", "/"], ""), ("sed", ["--version"], "GNU sed"),
                         ("timeout", ["--version"], "GNU coreutils"), ("tail", ["--version"], "GNU coreutils"),
                         ("setsid", ["--version"], "util-linux"), ("jq", ["--version"], "jq-"),
                         ("tmux", ["-V"], "tmux")):
    check(tool, [tool, *args], lambda code, out, token=token: code == 0 and token in out,
          "closed-PATH missing/flavour cases and the stock-PATH journey plant")
if macos:
    check("formulas", ["/opt/homebrew/bin/brew", "list", "--versions", "bash", "flock", "coreutils", "findutils", "gnu-sed", "gnu-tar", "make", "tmux", "jq", "util-linux"],
          lambda code, out: code == 0 and len(out.splitlines()) == 10, "installation is a separate agent action; this check never installs")
check("codex-version", ["codex", "--version"], lambda code, out: code == 0 and "codex-cli" in out, "hiding codex produces the named missing-CLI refusal")
check("codex-login", ["codex", "login", "status"], lambda code, out: code == 0 and "ChatGPT" in out,
      "revocation is not planted in a shared login; the journey performs an actual quota read")
check("installed-version", [os.environ["SNO_BINARY"], "reach", "--version"], lambda code, out: code == 0 and out.strip() == "2.0", "missing VERSION is covered in the independent archive proof")
actual_digest = hashlib.sha256(archive.read_bytes()).hexdigest()
rows.append(dict(name="archive", command=["sha256sum", str(archive)], output=actual_digest,
                 passed=actual_digest == expected_digest, calibration="archive corruption is actually refused by archive.t", owner="platform executor"))
installed = Path.home() / ".local/lib/sno-reach/current"
with tarfile.open(archive, "r:gz") as package:
    mismatches = []
    for member in package.getmembers():
        if not member.isfile():
            continue
        name = Path(member.name)
        target = installed / name
        if name.is_absolute() or ".." in name.parts or not target.is_file() or target.read_bytes() != package.extractfile(member).read():
            mismatches.append(member.name)
rows.append(dict(name="installed-payload", command=["compare every regular archive member to installed release"],
                 output=json.dumps(mismatches), passed=not mismatches,
                 calibration="archive.t proves an independent corrupted install is refused", owner="platform executor"))
secret_names = [name for name in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY") if os.environ.get(name)]
rows.append(dict(name="no-paid-key", command=["environment presence check (values never printed)"],
                 output=json.dumps(secret_names), passed=not secret_names,
                 calibration="do not plant a billing credential in this shared host", owner="platform executor"))
payload = dict(host=os.uname().nodename, measured_at=time.time(), path=os.environ["PATH"],
               archive=str(archive), sha256=actual_digest, checks=rows, passed=all(row["passed"] for row in rows))
artifact = root / "preflight.json"
artifact.write_text(json.dumps(payload, indent=2) + "\n")
digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
report = root / "platform-e2e-preflight-2026-09-14.md"
report.write_text("# Platform Chapter 0\n\n" + f"Host: `{payload['host']}`. Baseline SHA-256: `{digest}`.\n\n"
                  + f"Archive: `{archive}` (`{actual_digest}`).\n\nPATH: `{payload['path']}`.\n\n"
                  + "Onboarding: agent-installed prerequisites, archive installed by sno setup, then public init/register.\n"
                  + "Budget: one 30-minute wall; no model generation, no paid API, no host destruction.\n"
                  + "Declared mutations: two disposable shell seats and state; heartbeat children; stock PATH in child environments only.\n"
                  + "A dependency, login, installed candidate, or host change voids the baseline.\n\n"
                  + "\n".join(f"## {row['name']}: {'PASS' if row['passed'] else 'FAIL'}\n\nCommand: `{json.dumps(row['command'])}`\n\n```text\n{row['output']}\n```\n\nCalibration: {row['calibration']}.\n" for row in rows))
print(f"Chapter 0: {report}; baseline={digest}; passed={payload['passed']}")
sys.exit(0 if payload["passed"] else 1)
