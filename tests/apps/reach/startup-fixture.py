#!/usr/bin/env python3
"""Build valid terminal records and source-attributed per-verb startup scenarios."""
import hashlib
import json
import os
from pathlib import Path
import sys

work, state, app = map(Path, sys.argv[1:4])
sender, receiver, other, pane, tmux, home = sys.argv[4:]
template = json.loads((work / "wake-template.json").read_text())
attempts = state / receiver / "wake-attempts"
attempts.mkdir(exist_ok=True)
for index in range(3500):
    row = dict(template, state="confirmed", child_pid=0, child_start_ticks=0,
               attempt_id=hashlib.sha256(str(index).encode()).hexdigest()[:32])
    path = attempts / f"terminal-{index:04}.json"
    path.write_text(json.dumps(row) + "\n")
    path.chmod(0o600)
terminal_files = sorted(attempts.glob("*.json"))
(work / "terminal-manifest.json").write_text(json.dumps({str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in terminal_files}, indent=2))
guard_dir = work / "guards"
guard_dir.mkdir()
for binary in ("codex", "claude", "hermes", "openclaw", "acpx"):
    (guard_dir / binary).symlink_to(Path(__file__).with_name("fixtures") / "forbid-live-runtime.sh")
env = dict(HOME=home, SNO_REACH_ROOT=str(state), SNO_REACH_ADDR=sender,
           TMUX=tmux, TMUX_PANE=pane, PATH=str(guard_dir) + ":" + os.environ["PATH"])
main = app / "bin/sno-reach"
scenarios = []


def scenario(verb, args, source, function, fragment, **extra):
    lines = source.read_text().splitlines()
    begin = next((i for i, line in enumerate(lines) if line.startswith(function + "()")), 0) if function else 0
    end = next((i for i in range(begin + 1, len(lines)) if function and lines[i] == "}"), len(lines))
    matches = [i for i in range(begin, end) if fragment in lines[i]]
    if len(matches) != 1:
        raise ValueError(f"ambiguous or missing boundary {verb}: {source}: {function}: {fragment}")
    index = matches[0]
    scenarios.append(dict(verb=verb, args=args, source=str(source), line=index + 1,
                          boundary=lines[index], env=env, **extra))


scenario("spawn", ["spawn", "codex", "--as", "worker.spawn@" + receiver.split("@")[1], "--cwd", str(work)], app / "lib/reach-spawn", "", 'flock -w 10 9')
scenario("register", ["register", "--as", other, "--channel", "tmux", "--handle", pane], main, "run_register", 'pane="$(timeout 5 tmux')
scenario("unregister", ["unregister", "--as", other], app / "lib/reach-reachability", "", 'flock 9 || die 74')
scenario("seats", ["seats", "--json"], main, "run_seats", 'for record in "$root"/*/reachable.json; do')
for verb in ("call", "watch"):
    args = [verb, receiver, "Return startup.", "--timeout", "1"] if verb == "call" else [verb, receiver, "--timeout", "1"]
    scenario(verb, args, main, "validate_live_record", 'session="$(timeout 5 tmux')
scenario("ring", ["ring", receiver], app / "lib/reach-ring", "tmux_target_current", 'session="$(tmux display-message')
scenario("send", ["send", "--as", sender], main, "run_send", 'queue_and_attempt_message "$root"', stdin=(work / "card").read_text())
scenario("reply", ["reply", "--as", receiver, "--card", str(state / receiver / "new/work"), "--state", "accepted"], main, "run_reply", 'flock -x -w 5 "$reply_fd"', stdin="Accepted for startup proof.\n")
scenario("inbox", ["inbox", "--as", receiver], main, "run_inbox", 'list_actions "$maildir"')
scenario("wait", ["wait", "--as", receiver, "--timeout", "0"], main, "run_wait", 'list_actions "$maildir"')
scenario("dismiss", ["dismiss", "--as", sender, "--card", str(state / sender / "new/report"), "--reason", "startup proof"], main, "run_dismiss", 'source="$(move_reply_source_to_cur')
scenario("log", ["log", "--as", receiver], main, "run_log", 'if ! scan_maildir_paths')
scenario("state", ["state", "--work", "startup", "--json"], main, "run_state", 'progress_load "$root"')
scenario("flush", ["flush", "--as", sender], main, "run_flush", 'if ! find "$outbox"')
scenario("init", ["init", "--as", "worker.new@" + receiver.split("@")[1], "--name", "New"], main, "", 'printf \'%s\\n\' "$init_result"', method="strace-write", marker="INIT-CREATED")
scenario("rebind", ["rebind", "--as", other, "--reason", "Startup proof"], main, "", "printf 'REBOUND\\n'", method="strace-write", marker="REBOUND")
scenario("doctor", ["doctor", "--as", receiver], main, "run_doctor", "printf 'DOCTOR-OK\\n'")
scenario("export", ["export", "--work", "startup", "--output", str(work / "export.mbox")], main, "run_export", 'capture_export_snapshot "$root" "$source_before"')
scenario("lint", ["lint", str(work / "card")], app / "lib/reach-lint", "", 'cp -- "$MESSAGE_FILE" "$SNAPSHOT"')
scenario("remind", ["remind", "--as", receiver], main, "run_remind", 'timeout --signal=KILL "$remaining"')
primary = list(scenarios)
scenarios.clear()
scenario("spawn", primary[0]["args"], app / "lib/reach-spawn", "", 'inventory="$(timeout', label="spawn-before-runtime", boundary_kind="later upper bound after first lock; no external runtime call")
reply = next(row for row in primary if row["verb"] == "reply")
scenario("reply", reply["args"], main, "run_reply", 'entry="$(stage_message_in_outbox', stdin=reply["stdin"], label="reply-after-adoption", boundary_kind="later upper bound including reply rendering and adoption after first lock")
(work / "startup-fixture.json").write_text(json.dumps(dict(state_root=str(state), scenarios=primary, supplementary=scenarios), indent=2) + "\n")
