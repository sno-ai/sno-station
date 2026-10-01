#!/usr/bin/env python3
"""Chapter0: checks the separately prepared environment; never repairs config."""
import json
import os
from pathlib import Path
import sys
import time
import uuid
import tomllib
from live_support import Live, RULING, WINDOW, sha, start_clock, test_identity, manifest
import preconditions
import readiness

if len(sys.argv) != 5 or sys.argv[3] != "--allow-live":
    raise SystemExit("usage: preflight.py <prepared-context> <new-evidence-dir> --allow-live <frozen-archive-sha256>")
run = Live(sys.argv[1], sys.argv[2])
if sys.argv[4] != run.context["archive_sha256"]:
    raise SystemExit("explicit live admission does not name this frozen archive")
checks = []


def check(name, command, expected, calibration, action):
    try:
        value = action()
        verdict = "green"
    except Exception as error:
        value, verdict = run.clean(str(error)), "red"
    checks.append(dict(id=name, command=command, expected=expected, calibration=calibration,
                       owner="Reach test writer", field=name, observed=value, verdict=verdict))
    return verdict == "green"


def environment():
    preconditions.environment(run.env, run.home)
    for path in (run.home / ".agents/skills", run.home / ".claude/skills"):
        if path.exists():
            raise RuntimeError("private skills must not be imported")
    skills = run.home / ".codex/skills"
    if skills.exists():
        system = skills / ".system"
        expected = {".codex-system-skills.marker", "imagegen", "openai-docs", "plugin-creator",
                    "review-agent", "skill-creator", "skill-installer"}
        if set(skills.iterdir()) != {system} or {path.name for path in system.iterdir()} != expected:
            raise RuntimeError("private user skills must not be imported")
        if any(path.is_symlink() for path in skills.rglob("*")):
            raise RuntimeError("native system skills must not link outside private HOME")
        (run.evidence / "native-created-system-skills.json").write_text(json.dumps(manifest(skills), indent=2) + "\n")
    return "private roots; no paid-key/trace variables or imported skills"


check("calibration", "execute shared predicates with synthetic valid and invalid values", "eleven bad cases refused; valid cases accepted",
      "no native call or real credential alteration", lambda: preconditions.calibrate(run.home))
check("bootstrap-calibration", "exercise read-only native completion predicate", "only fresh owned paired task completion accepted",
      "old same-cwd session and unpaired/incomplete events refused", readiness.calibrate)
check("environment", "inspect exact child env and private HOME paths", "all forbidden names absent; private roots only",
      "same predicate rejects OPENAI_API_KEY=calibration and shared CODEX_HOME", environment)
check("candidate", "hash resolved tools and complete installed archive payload", "all identities equal preparation manifest",
      "wrong expected digest and missing VERSION are refused by archive/startup proof", lambda: run.baseline() or run.context["archive_sha256"])
def reach_version():
    version = run.checked("--version").strip()
    if version != run.context["version"]:
        raise RuntimeError("installed Reach version does not match candidate")
    return dict(version=version, executable=str((run.home / ".local/bin/sno-reach").resolve()))
check("reach-version", "actual sno reach --version under private PATH", "version from retained release executable",
      "missing VERSION refused in installed archive proof", reach_version)
for name, tool in run.context["tools"].items():
    def version(tool=tool, name=name):
        code, out, err = run.command([tool["path"], "-V" if name == "tmux" else "--version"], timed=False)
        if code or not out.strip():
            raise RuntimeError(f"version probe failed: {code}: {err}")
        return out.strip()
    check("tool-" + name, [tool["path"], "--version"], "nonempty successful version from bound executable",
          "missing executable is a hard precondition failure", version)


def credentials():
    observed = []
    for path in map(Path, run.context["credentials"]):
        data = json.loads(path.read_text())
        preconditions.credential(data, path.name, path.stat().st_mode & 0o777, path.is_symlink())
        observed.append(dict(path=str(path), sha256=sha(path)))
    return observed


check("credential-files", "validate private0600 subscription JSON, no token output", "subscription structures only",
      "missing/malformed/paid-key structures refuse; live revocation unsafe without a disposable account", credentials)
check("ttl", "read private ~/.acpx/config.json ttl", "ttl0; explicit cleanup required",
      "missing/different ttl is red", lambda: preconditions.ttl(json.loads((run.home / ".acpx/config.json").read_text())))
def project_trust():
    path = run.home / ".codex/config.toml"
    value = tomllib.loads(path.read_text())
    expected = {actor["cwd"]: {"trust_level": "trusted"} for actor in run.context["actors"] if actor["kind"] == "codex"}
    preconditions.project_trust(value, expected, path.stat().st_mode & 0o777, path.is_symlink())
    return dict(path=str(path), sha256=sha(path), trusted_paths=sorted(expected))
check("project-trust", "read private Codex project trust entries", "exact five declared Codex cwd paths trusted; no broad /tmp trust",
      "missing config/entry, untrusted value or broad extra path is red", project_trust)
static_green = all(row["verdict"] == "green" for row in checks)
def control_server():
    if "TMUX" not in run.env:
        code, out, err = run.command([run.context["tools"]["tmux"]["path"], "-L", run.context["server"], "-f", "/dev/null",
                                     "new-session", "-d", "-s", "control", "sleep", str(WINDOW)], timed=False)
        if code:
            raise RuntimeError(f"could not create isolated control server: {err}")
        code, out, err = run.command([run.context["tools"]["tmux"]["path"], "-L", run.context["server"],
                                     "display-message", "-p", "#{socket_path},#{pid},0"], timed=False)
        if code:
            raise RuntimeError(err)
        run.env["TMUX"] = out.strip()
        run.save()
    return run.env["TMUX"]

if static_green:
    static_green = check("control-server", "create own empty tmux control server", "private socket and private child env",
                         "creation failure blocks dependent actors", control_server)
if static_green:
    blocked_vendors = set()
    for actor in sorted(run.context["actors"], key=lambda item: item["label"] != "tmux_sender"):
        def actor_probe(actor=actor):
            if actor["kind"] in blocked_vendors:
                raise RuntimeError("vendor refused earlier work; no further probe for this vendor")
            run.deadline = time.time() + 240
            if "handle" not in actor:
                run.checked("init", "--as", actor["address"], "--name", actor["label"])
                args = ["spawn", actor["kind"], "--as", actor["address"], "--cwd", actor["cwd"]]
                if actor["channel"] == "tmux":
                    args.append("--window")
                start_clock([run.context["tools"]["sno"]["path"], "reach", *args])
                if run.context["intentional_spawned"] >= 6:
                    raise RuntimeError("six runtime seats already allocated")
                run.context["intentional_spawned"] += 1
                actor["spawn_started_epoch"] = time.time()
                run.save()
                run.checked(*args, timeout=60)
                actor["handle"] = run.record(actor)["handle"]
                run.save()
            run.checked("doctor", "--as", actor["address"])
            if actor["channel"] == "tmux":
                readiness.wait(run, actor)
            nonce = uuid.uuid4().hex
            marker = "PREFLIGHT-42-" + nonce
            output = run.checked("call", actor["address"],
                f"Compute19+23. Reply with exactly {marker}. Read your installed Reach guide if not already read. Do not poll mail or start background work. Then wait for task input.",
                "--expect", marker, "--timeout", "120", timeout=125)
            if marker not in output or marker not in run.output(actor):
                raise RuntimeError("fresh mathematical response not observed at the owned receiver")
            if actor["kind"] == "codex":
                readiness.native_policy(run, actor)
            pids = run.live_pids(actor)
            if not pids:
                raise RuntimeError("no owned runtime process after successful response")
            for pid in pids:
                try:
                    env = dict(entry.decode().split("=", 1) for entry in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0") if b"=" in entry)
                except FileNotFoundError:
                    continue
                preconditions.environment(env, run.home)
            return dict(address=actor["address"], handle=actor["handle"], cwd=actor["cwd"], observed_pids=pids,
                        response=output, usage=run.usage(actor))
        check("actor-" + actor["label"], "public init/spawn/doctor/call plus receiver history and OS pid readback",
              "fresh PREFLIGHT-42 nonce, provider usage, live owned process",
              "closed/unregistered/wrong-pane and missing-read outputs are calibrated by same-run negative journeys", actor_probe)
        run.deadline = None
        if checks[-1]["verdict"] == "red":
            observed = str(checks[-1]["observed"]).lower()
            if any(word in observed for word in ("quota", "usage limit", "rate limit")):
                blocked_vendors.add(actor["kind"])
                checks[-1]["vendor_stop"] = actor["kind"]
                checks[-1]["next_action"] = "Report actual refusal; run subscription-quota-check once. No automatic product retry."
            elif "capacity" in observed:
                blocked_vendors.add(actor["kind"])
                checks[-1]["vendor_stop"] = actor["kind"]
                checks[-1]["next_action"] = "Capacity, not quota: report exact error. Dispatcher permits same-model retry after5 minutes, at most3, within unchanged live clock."
            else:
                blocked_vendors.add(actor["kind"])
                checks[-1]["vendor_stop"] = actor["kind"]
                checks[-1]["next_action"] = "Untriaged native failure: stop affected vendor, retain evidence, report to executor. Do not repeat a product failure."
else:
    for actor in run.context["actors"]:
        checks.append(dict(id="actor-" + actor["label"], command="public init/spawn/doctor/call", expected="fresh receiver proof",
                           calibration="dependent static precondition failed", owner="Reach test writer", field=actor["label"],
                           observed="not started because required static check failed", verdict="red"))
artifact = dict(ruling=RULING, host=os.uname().nodename, candidate=run.context["archive_sha256"], checks=checks,
                passed=all(row["verdict"] == "green" for row in checks),
                static_passed=static_green, test_inputs=test_identity(), machine_id_sha256=sha("/etc/machine-id"),
                vendor_passed={kind: static_green and all(row["verdict"] == "green" for row in checks
                    if row["id"] in ["actor-" + actor["label"] for actor in run.context["actors"] if actor["kind"] == kind])
                    for kind in {actor["kind"] for actor in run.context["actors"]}},
                credential_identity=next(row["observed"] for row in checks if row["id"] == "credential-files"),
                declared_mutations=["six owned native seats", "isolated source variants/current symlink", "own registration channel plants",
                                    "own native input buffer", "owned ACP sessions closed at cleanup"])
path = run.evidence / "preflight.json"
path.write_text(run.clean(json.dumps(artifact, indent=2)) + "\n")
run.context["preflight"] = dict(path=str(path), sha256=sha(path), passed=artifact["passed"], vendor_passed=artifact["vendor_passed"])
run.context["blocked_vendors"] = {row["vendor_stop"]: row["next_action"] for row in checks if "vendor_stop" in row}
run.save()
print(f"Chapter0 {'GREEN' if artifact['passed'] else 'RED'}: {path}")
raise SystemExit(0 if artifact["passed"] else 1)
