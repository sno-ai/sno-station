#!/usr/bin/env python3
"""Installed public commands, stock-PATH refusal, restored exchange; one shared wall."""
import email
from email.utils import formatdate
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time
import uuid

assert os.uname().sysname in ("Darwin", "Linux"), "admitted platform required"
macos = os.uname().sysname == "Darwin"
preflight = Path(sys.argv[1]).resolve()
assert preflight.is_file(), "Chapter 0 must exist before the journey"
baseline = json.loads(preflight.read_text())
assert baseline.get("passed") is True, "Chapter 0 did not pass"
checks = baseline.get("checks")
assert isinstance(checks, list) and checks and all(row.get("passed") is True for row in checks), "Chapter 0 has failed or empty checks"
assert {"host", "runtime-bash", "archive", "installed-payload", "codex-login", "no-paid-key"} <= {row["name"] for row in checks}, "Chapter 0 is incomplete"
assert baseline["host"] == os.uname().nodename and baseline["path"] == os.environ["PATH"], "Chapter 0 host or PATH changed"
assert hashlib.sha256(Path(baseline["archive"]).read_bytes()).hexdigest() == baseline["sha256"], "Chapter 0 archive changed"
preflight_digest = hashlib.sha256(preflight.read_bytes()).hexdigest()
root = Path(sys.argv[2]).resolve()
root.mkdir(parents=True, exist_ok=True)
clock = root / "clock.json"
if not clock.exists():
    clock.write_text(json.dumps(dict(host=os.uname().nodename, started=time.time(), ceiling_seconds=1800)) + "\n")
wall = json.loads(clock.read_text())
assert wall["host"] == os.uname().nodename and wall["ceiling_seconds"] == 1800
attempt = root / ("attempt-" + uuid.uuid4().hex[:8])
attempt.mkdir()
print(f"Journey evidence: {attempt}; original wall start={wall['started']}", flush=True)
here = Path(__file__).resolve().parent
reach = str(Path.home() / ".local/bin/sno-reach")
heartbeat = str(Path.home() / ".local/bin/heartbeat")
quota = str(Path.home() / ".local/bin/subscription-quota-check")
env = dict(os.environ, SNO_REACH_ROOT=str(attempt / "state"))
for key in ("SNO_MBOX_ROOT", "SNO_EXECUTOR_ADDR", "SNO_REACH_ADDR", "SNO_TPM_REGISTRY", "TPM_REGISTRY"):
    env.pop(key, None)
server = "platform-" + uuid.uuid4().hex[:8]
rows = []
passed = False

def run(argv, *, context=None, body=None, expected=(0,), bound=120):
    remaining = wall["started"] + 1800 - time.time()
    assert remaining > 0, "original 30-minute wall exhausted; no reset allowed"
    index = len(rows)
    print(f"{index:02}: {shlex.join(argv)}", flush=True)
    result = subprocess.run(argv, input=body, env=context or env, capture_output=True,
                            text=True, timeout=min(bound, remaining))
    (attempt / f"{index:02}.stdout").write_text(result.stdout)
    (attempt / f"{index:02}.stderr").write_text(result.stderr)
    rows.append(dict(argv=argv, exit_code=result.returncode, expected=list(expected)))
    assert result.returncode in expected, (argv, result.returncode, result.stdout, result.stderr)
    return result

try:
    host = os.uname().nodename
    assert host == ("lab-mba" if macos else "gpt1"), f"expected the approved host, got {host}"
    addresses = [f"a.platform@{host}", f"b.platform@{host}"]
    actor = shlex.join(["bash", str(here / "fixtures/tmux-ack-actor.sh")])
    run(["tmux", "-L", server, "-f", "/dev/null", "new-session", "-d", "-s", "platform", actor])
    pane_a = run(["tmux", "-L", server, "display-message", "-p", "#{pane_id}"]).stdout.strip()
    pane_b = run(["tmux", "-L", server, "new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "platform", actor]).stdout.strip()
    tmux_env = run(["tmux", "-L", server, "display-message", "-p", "#{socket_path},#{pid},0"]).stdout.strip()
    contexts = [dict(env, TMUX=tmux_env, TMUX_PANE=pane) for pane in (pane_a, pane_b)]
    for address, context in zip(addresses, contexts):
        run([reach, "init", "--as", address, "--name", address[0]], context=context)
        run([reach, "register", "--as", address, "--channel", "tmux", "--handle", context["TMUX_PANE"]], context=context)
        doctor = run([reach, "doctor", "--as", address], context=context)
        assert "prerequisites: ok\n" in doctor.stdout and "DOCTOR-OK\n" in doctor.stdout
    identity = run([str(Path.home() / ".local/lib/sno-reach/current/lib/reach-machine-id")]).stdout.strip()
    assert len(identity) == 32 and all(c in "0123456789abcdef" for c in identity)

    def exchange(wave):
        nonce = uuid.uuid4().hex
        message_id = f"<platform-{nonce}@{host}>"
        card = (f"From: Sender <{addresses[0]}>\nTo: Receiver <{addresses[1]}>\n"
                f"Subject: [QUESTION] platform {wave}\nDate: {formatdate(localtime=False)}\n"
                f"Message-ID: {message_id}\nX-Work: platform-{nonce}\nX-Type: question\n\n"
                f"Return this nonce: {nonce}\n")
        run([reach, "send", "--as", addresses[0]], context=contexts[0], body=card)
        inbox = run([reach, "inbox", "--as", addresses[1]], context=contexts[1])
        candidates = [Path(line.split()[0]) for line in inbox.stdout.splitlines() if "platform " + wave in line]
        assert len(candidates) == 1, inbox.stdout
        original = candidates[0]
        received = email.message_from_string(original.read_text())
        assert received["Message-ID"] == message_id
        assert received.get_all("Delivered-To") == [addresses[1]] and received["Bcc"] is None
        received_nonce = received.get_payload().removeprefix("Return this nonce: ").strip()
        assert received.get_payload() == f"Return this nonce: {nonce}\n", "delivered question body changed"
        run([reach, "reply", "--as", addresses[1], "--card", str(original), "--state", "accepted"],
            context=contexts[1], body="Accepted.\n")
        run([reach, "reply", "--as", addresses[1], "--card", str(original), "--state", "completed"],
            context=contexts[1], body=f"Returned nonce: {received_nonce}\n")
        waited = run([reach, "wait", "--as", addresses[0], "--from", addresses[1],
                      "--reply-to", message_id, "--timeout", "5", "--every", "1"], context=contexts[0])
        reply_path = Path(waited.stdout.strip())
        reply = email.message_from_string(reply_path.read_text())
        assert reply["X-Type"] == "answer" and reply["X-State"] == "completed"
        assert reply.get_all("Delivered-To") == [addresses[0]] and reply["Bcc"] is None
        assert message_id in reply["References"] and nonce in reply.get_payload()
        heart_env = dict(env, HEARTBEAT=heartbeat, PLATFORM_HEARTBEAT_LABEL="platform-e2e")
        run(["python3", str(here.parent / "heartbeat/platform-macos-reader.py")], context=heart_env, bound=110)
        reading = run([quota, "--vendor", "codex"], expected=(0, 1, 3, 4), bound=60)
        assert reading.stdout.strip() or reading.stderr.strip(), "quota read produced no diagnostic"
        return original

    original = exchange("before-plant")
    guard_home, guard_tmp = attempt / "guard-home", attempt / "guard-tmp"
    guard_home.mkdir()
    guard_tmp.mkdir()
    guard_env = dict(env, PATH="/usr/bin:/bin:/usr/sbin:/sbin", HOME=str(guard_home),
                     TMPDIR=str(guard_tmp), XDG_STATE_HOME=str(guard_home / "state"),
                     SNO_REACH_ROOT=str(guard_home / "mail"))
    refusals = [([reach, *args], 69) for args in (
        ["init", "--as", addresses[0], "--name", "a"],
        ["register", "--as", addresses[0], "--channel", "tmux", "--handle", pane_a],
        ["doctor", "--as", addresses[0]], ["send", "--as", addresses[0]],
        ["inbox", "--as", addresses[1]],
        ["reply", "--as", addresses[1], "--card", str(original), "--state", "completed"],
        ["wait", "--as", addresses[0], "--timeout", "0"])]
    refusals += [([heartbeat, "--interval", "1m", "--label", "platform-e2e", "--", "true"], 1),
                 ([heartbeat, "--stop", "platform-e2e"], 1), ([quota, "--vendor", "codex"], 2)]
    # The stock macOS Bash 3.2 plant has no Linux counterpart. Linux still runs
    # both complete installed exchanges; its missing-tool cases are separate.
    for argv, code in (refusals if macos else []):
        result = run(argv, context=guard_env, expected=(code,), body="Refused input.\n")
        assert not result.stdout and len(result.stderr.splitlines()) == 1
        assert "needs Bash 5" in result.stderr and "3.2" in result.stderr
        assert not list(guard_home.rglob("*")) and not list(guard_tmp.rglob("*"))
    for address, context in zip(addresses, contexts):
        run([reach, "init", "--as", address, "--name", address[0]], context=context)
        run([reach, "register", "--as", address, "--channel", "tmux", "--handle", context["TMUX_PANE"]], context=context)
        doctor = run([reach, "doctor", "--as", address], context=context)
        assert "prerequisites: ok\n" in doctor.stdout and "DOCTOR-OK\n" in doctor.stdout
    exchange("after-restore")
    passed = True
finally:
    subprocess.run(["tmux", "-L", server, "kill-server"], env=env, capture_output=True, timeout=5)
    report = dict(host=os.uname().nodename, preflight=str(preflight), preflight_sha256=preflight_digest, wall=wall,
                  finished=time.time(), passed=passed, commands=rows,
                  stock_macos_plant="executed" if macos else "not applicable: Linux host",
                  boundary="installed public commands; ordinary shell peers, no live model seats")
    (attempt / "results.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Journey passed={passed}; report={attempt / 'results.json'}", flush=True)
