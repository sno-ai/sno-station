#!/usr/bin/env python3
"""Trace an installed executable to an exact pre-effect source line; kill its group."""
import contextlib
import hashlib
import json
import os
import re
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time

VERBS = set("spawn register unregister seats call watch ring send reply inbox wait dismiss log state flush init rebind doctor export lint remind".split())
HERE = Path(__file__).resolve().parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def state_identity(root):
    return {str(path.relative_to(root)): (oct(path.lstat().st_mode), os.readlink(path) if path.is_symlink()
            else digest(path) if path.is_file() else "directory") for path in sorted(root.rglob("*"))}


def trace(command, scenario, evidence, planted=False):
    guard = HERE / "fixtures/forbid-live-runtime.sh"
    first_path = Path(scenario["env"]["PATH"].split(":")[0])
    for binary in ("codex", "claude", "hermes", "openclaw", "acpx"):
        if (first_path / binary).resolve() != guard.resolve():
            raise ValueError(f"missing live-runtime safety guard for {binary}")
    source = Path(scenario["source"]).resolve()
    lines = source.read_text().splitlines()
    matches = [scenario["line"]] if "line" in scenario else [index + 1 for index, line in enumerate(lines) if line == scenario["boundary"]]
    if len(matches) != 1:
        raise ValueError(f"boundary must match exactly once: {source}: {scenario['boundary']!r}")
    if lines[matches[0] - 1] != scenario["boundary"]:
        raise ValueError("source boundary text changed")
    if scenario.get("method") == "strace-write":
        return trace_receiver(command, scenario, evidence)
    read_fd, write_fd = os.pipe()
    env = dict(os.environ, **scenario["env"], BASH_ENV=str(HERE / "fixtures/startup-trace-env.sh"),
               REACH_TRACE_SOURCE=str(source), REACH_TRACE_LINE=str(matches[0]),
               REACH_TRACE_FD=str(write_fd), REACH_TRACE_PLANTED_DELAY=str(int(planted)))
    name = scenario.get("label", scenario["verb"]) + ("-planted" if planted else "")
    before_hash = digest(source)
    state_root = Path(scenario["env"]["SNO_REACH_ROOT"])
    before_state = state_identity(state_root) if scenario["verb"] in ("state", "remind", "watch", "seats", "log", "doctor", "lint", "export") else None
    with (evidence / f"{name}.stdout").open("wb") as out, (evidence / f"{name}.stderr").open("wb") as err:
        # This timestamp precedes process creation and BASH_ENV, including the
        # planted delay. Starting a timer at the first DEBUG event would hide it.
        started = time.time()
        proc = subprocess.Popen([str(command), *scenario["args"]], env=env,
                                stdin=subprocess.PIPE, stdout=out, stderr=err,
                                pass_fds=(write_fd,), start_new_session=True)
        os.close(write_fd)
        selector = selectors.DefaultSelector()
        selector.register(read_fd, selectors.EVENT_READ)
        try:
            with contextlib.suppress(BrokenPipeError):
                proc.stdin.write(scenario.get("stdin", "").encode())
                proc.stdin.close()
            ready = selector.select(8)
            raw = os.read(read_fd, 65536) if ready else b""
            if not raw:
                raise RuntimeError(f"{name}: missing source boundary trace (exit={proc.poll()})")
            stamp, traced_source, traced_line, pid = raw.decode().strip().split("\t")
            if traced_source != str(source) or int(traced_line) != matches[0]:
                raise RuntimeError(f"{name}: wrong source trace {raw!r}")
            elapsed = float(stamp) - started
            row = dict(verb=scenario["verb"], source=str(source), line=int(traced_line),
                       text=scenario["boundary"], seconds=elapsed, pid=int(pid),
                       source_sha256=before_hash, planted=planted)
            row["boundary_kind"] = scenario.get("boundary_kind", "first business boundary")
        finally:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
            selector.close()
            os.close(read_fd)
    if digest(source) != before_hash:
        raise RuntimeError(f"{name}: installed source changed during trace")
    if before_state is not None and state_identity(state_root) != before_state:
        raise RuntimeError(f"{name}: read-only startup mutated state")
    (evidence / f"{name}.json").write_text(json.dumps(row, indent=2) + "\n")
    return row


def trace_receiver(command, scenario, evidence):
    name = scenario["verb"]
    trace_file = evidence / f"{name}.strace"
    env = dict(os.environ, **scenario["env"])
    env.pop("BASH_ENV", None)
    started = time.time()
    result = subprocess.run(["strace", "-f", "-ttt", "-s", "262144", "-e", "trace=execve,write",
                             "-o", str(trace_file), str(command), *scenario["args"]],
                            env=env, input=scenario.get("stdin", ""), capture_output=True, text=True, timeout=8)
    (evidence / f"{name}.stdout").write_text(result.stdout)
    (evidence / f"{name}.stderr").write_text(result.stderr)
    if result.returncode != 0:
        raise RuntimeError(f"{name}: receiver failed: {result.stderr}")
    marker = scenario["marker"]
    pattern = re.compile(r'^(\d+)\s+(\d+\.\d+)\s+write\(1, "' + re.escape(marker) + r'\\n", (\d+)\)\s+=\s+(\d+)$')
    events = []
    for line in trace_file.read_text().splitlines():
        match = pattern.match(line)
        if match and int(match[3]) == len(marker) + 1 and match[3] == match[4]:
            events.append(match)
    if not events:
        raise RuntimeError(f"{name}: no actual receiver write event (execve text is not evidence)")
    first = min(events, key=lambda match: float(match[2]))
    row = dict(verb=name, source=scenario["source"], line=scenario["line"], text=scenario["boundary"],
               seconds=float(first[2]) - started, pid=int(first[1]), descriptor=1,
               method="actual embedded POSIX receiver write; includes preceding local receiver operation",
               boundary_kind="later upper bound; >=1s is inconclusive, not a startup violation",
               source_sha256=digest(Path(scenario["source"])), planted=False)
    (evidence / f"{name}.json").write_text(json.dumps(row, indent=2) + "\n")
    return row


def main():
    command = Path(sys.argv[1]).resolve()
    fixture = json.loads(Path(sys.argv[2]).read_text())
    evidence = Path(sys.argv[3])
    evidence.mkdir(exist_ok=False, parents=True)
    if "releases" not in command.parts or command.name != "sno-reach":
        raise ValueError("startup proof requires the installed release executable")
    scenarios = fixture["scenarios"]
    if len(scenarios) != 21 or {row["verb"] for row in scenarios} != VERBS:
        raise ValueError("exactly all 21 public verbs are required")
    attempts = list(Path(fixture["state_root"]).glob("*/wake-attempts/*.json"))
    if len(attempts) != 3500:
        raise ValueError("fixture must contain exactly 3,500 terminal attempts")
    for path in attempts:
        if json.loads(path.read_text())["state"] not in ("confirmed", "escalated", "not-applicable"):
            raise ValueError(f"nonterminal fixture: {path}")
    results = [trace(command, row, evidence) for row in scenarios]
    supplementary = [trace(command, row, evidence) for row in fixture.get("supplementary", [])]
    planted = trace(command, next(row for row in scenarios if row["verb"] == "inbox"), evidence, True)
    report = dict(host=os.uname().nodename, executable=str(command), sha256=digest(command),
                  fixture=fixture, results=results, supplementary=supplementary, planted=planted,
                  bash=subprocess.check_output(["bash", "--version"], text=True).splitlines()[0])
    (evidence / "startup.json").write_text(json.dumps(report, indent=2) + "\n")
    exact = [row for row in results if row["verb"] not in ("init", "rebind")]
    upper = [row for row in results if row["verb"] in ("init", "rebind")]
    if any(row["seconds"] >= 1 or row["seconds"] < 0 for row in exact) or planted["seconds"] < 2:
        return 1
    if any(row["seconds"] >= 1 or row["seconds"] < 0 for row in upper):
        print("INCONCLUSIVE: receiver's later operation-inclusive bound cannot prove a startup violation; exact earlier trace is required")
        return 2
    print("PASS 19 pre-effect startup traces plus 2 conservative receiver upper bounds below 1 second; 2-second plant detected")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
