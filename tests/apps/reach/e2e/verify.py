#!/usr/bin/env python3
"""Revalidate completed native evidence without another model call or cached verdict."""
from email import policy
from email.parser import BytesParser
from email.utils import getaddresses
import json
from pathlib import Path
import re
import sys
import tarfile
import hashlib
from live_support import sha, test_identity, assistant_events, RULING, PREVIOUS_CLOCK, WINDOW
from entry_proof import commands as tool_commands, validate as validate_entry

MATRIX = {
    "QCG-4": [("acp", "none"), ("acp", "send-ring"), ("acp", "none"), ("acp", "reply-ring"), ("acp", "none")],
    "QCG-5": [("tmux", "none"), ("tmux", "wrong-channel"), ("tmux", "none"), ("tmux", "reply-ring"), ("tmux", "none")],
    "QCG-6": [("call", "none"), ("timeout-acp", "none"), ("timeout-tmux", "none"),
              ("call-acp", "call-read"), ("call-tmux", "call-read"), ("call", "none")],
    "QCG-7": [("watch", "none"), ("watch", "watch-prompt"), ("watch", "none")],
    "QCG-22": [("continuing", "none"), ("continuing", "reply-to"), ("continuing", "none")],
}
if len(sys.argv) < 4 or sys.argv[2] not in MATRIX:
    raise SystemExit("usage: verify.py <frozen-archive> <QCG-4|QCG-5|QCG-6|QCG-7|QCG-22> <ordered-evidence-dir>...")
archive, qcg = Path(sys.argv[1]), sys.argv[2]
rows = [Path(path) for path in sys.argv[3:]]
assert len(rows) == len(MATRIX[qcg]), "all normal/fault/restoration runs are required"
assert Path(str(archive) + ".sha256").read_text().split() == [sha(archive), archive.name]
with tarfile.open(archive, "r:gz") as packed:
    archive_payload = {}
    for member in packed.getmembers():
        value = dict(mode=oct(member.mode & 0o7777))
        if member.issym():
            value.update(type="symlink", target=member.linkname)
        elif member.isdir():
            value.update(type="directory")
        elif member.isfile() or member.islnk():
            value.update(type="file", sha256=hashlib.sha256(packed.extractfile(member).read()).hexdigest())
        else:
            raise AssertionError("unsupported archive member")
        archive_payload[member.name.rstrip("/")] = value
previous_end = 0
nonces = set()
clock_id = None
for directory, expected in zip(rows, MATRIX[qcg]):
    evidence = json.loads((directory / "journey.json").read_text())
    assert "error" not in evidence, "actual journey recorded an unresolved failure"
    assert (evidence["mode"], evidence["defect"]) == expected
    assert evidence["candidate"] == sha(archive) and evidence["test_inputs"] == test_identity()
    assert evidence["payload_before"] == evidence["payload_after"], "retained installed payload changed during journey"
    assert {name: value for name, value in evidence["payload_before"].items() if name != "."} == archive_payload
    assert evidence["nonce"] not in nonces
    nonces.add(evidence["nonce"])
    assert evidence["started_epoch"] >= previous_end
    previous_end = evidence["started_epoch"] + evidence["seconds"]
    ceiling = evidence["clock"]
    assert ceiling["ruling"] == RULING and ceiling["previous_clock_sha256"] == sha(PREVIOUS_CLOCK)
    assert ceiling["deadline_epoch"] - ceiling["started_epoch"] == WINDOW and ceiling["charged_incident_seconds"] == 0
    assert previous_end <= ceiling["deadline_epoch"] + 1
    assert evidence["seconds"] <= (600 if expected[0] in ("acp", "tmux", "continuing") else 240) + 1
    if clock_id is None:
        clock_id = ceiling
    assert clock_id == ceiling, "live clock was reset"
    preflight = evidence["preflight"]
    assert sha(preflight["path"]) == preflight["sha256"]
    baseline = json.loads(Path(preflight["path"]).read_text())
    assert baseline["candidate"] == evidence["candidate"] and baseline["host"] == evidence["host"]
    assert all(baseline["vendor_passed"][row["kind"]] for row in evidence["actors"])
    commands = []
    for path in sorted(directory.glob("command-*.json")):
        row = json.loads(path.read_text())
        out, err = path.with_suffix(".stdout"), path.with_suffix(".stderr")
        assert sha(out) == row["stdout_sha256"] and sha(err) == row["stderr_sha256"]
        assert row["host"] == evidence["host"] and row["seconds"] >= 0
        commands.append((row, out.read_text(), err.read_text()))
    assert commands, "no actual commands retained"
    def public(verb):
        return [entry for entry in commands if entry[0]["argv"][1:3] == ["reach", verb]]
    mode, defect = expected
    if defect in ("send-ring", "reply-ring", "reply-to"):
        channel = "tmux" if mode == "tmux" else "acp"
        roles = [(channel + "_sender", "send")]
        if defect in ("reply-ring", "reply-to"):
            roles.append((channel + "_receiver", "reply"))
        for label, verb in roles:
            native_rows = json.loads((directory / (label + "-executed-records.json")).read_text())
            extracted = tool_commands(native_rows)
            assert extracted == json.loads((directory / (label + "-executed-commands.json")).read_text())
            validate_entry(extracted, verb)
    if mode in ("acp", "tmux", "continuing"):
        waits = [entry for entry in public("wait") if "--reply-to" in entry[0]["argv"]]
        if defect == "reply-to":
            exports = list(directory.glob("acceptance-*.mbox"))
            assert exports and not waits
            continuing = next(row["address"] for row in evidence["actors"] if row["label"] == "acp_continuing")
            accepted_elsewhere = False
            for path in exports:
                for chunk in re.split(br"(?m)^From [^\n]*\n", path.read_bytes()):
                    if not chunk.strip():
                        continue
                    card = BytesParser(policy=policy.default).parsebytes(chunk)
                    if card["X-State"] == "accepted":
                        destinations = [addr for _, addr in getaddresses(card.get_all("To", []))]
                        assert continuing not in destinations
                        accepted_elsewhere = True
            assert accepted_elsewhere, "resolver negative never reached a real acceptance"
            continue
        assert len(waits) == 1 and waits[0][0]["argv"][-2:] == ["--timeout", "300"]
        if defect in ("send-ring", "wrong-channel"):
            assert waits[0][0]["exit_code"] == 4 and waits[0][0]["seconds"] >= 299
            raw = (directory / "thread.mbox").read_bytes()
            assert evidence["nonce"].encode() in raw and b"X-Type: question" in raw and b"X-State: completed" not in raw
            continue
        assert waits[0][0]["exit_code"] == 0
        raw = (directory / "thread.mbox").read_bytes()
        cards = [BytesParser(policy=policy.default).parsebytes(chunk) for chunk in re.split(br"(?m)^From [^\n]*\n", raw) if chunk.strip()]
        accepted = next(card for card in cards if card["X-State"] == "accepted")
        completed = next(card for card in cards if card["X-State"] == "completed")
        recipient = next(row["address"] for row in evidence["actors"] if row["label"] ==
                         ("acp_continuing" if mode == "continuing" else mode + "_sender"))
        receiver = next(row["address"] for row in evidence["actors"] if row["label"] == ("tmux_receiver" if mode == "tmux" else "acp_receiver"))
        for card in (accepted, completed):
            assert [addr for _, addr in getaddresses(card.get_all("To", []))] == [recipient]
            assert getaddresses(card.get_all("From", []))[0][1] == receiver and card["X-Work"] == evidence["work"]
            assert f"<{evidence['work']}@{evidence['host']}>" in str(card["References"])
        assert accepted["Message-ID"] != completed["Message-ID"]
        assert str(accepted["Message-ID"]) in str(completed["References"])
        assert evidence["nonce"] in completed.get_content() and "RESULT=42" in completed.get_content()
        assert (directory / "native-result.txt").read_text().splitlines() == ["RESULT=42", "NONCE=" + evidence["nonce"]]
        acknowledgment = json.loads((directory / "terminal-ack.json").read_text())
        assert acknowledgment["message_id"] == str(completed["Message-ID"])
        if defect == "reply-ring":
            assert acknowledgment["seconds"] >= 119 and not acknowledgment["found"]
            assert not (directory / "terminal-ack.eml").exists()
        else:
            assert acknowledgment["found"]
            acknowledged = BytesParser(policy=policy.default).parsebytes((directory / "terminal-ack.eml").read_bytes())
            assert acknowledged["Message-ID"] == completed["Message-ID"]
            assert acknowledged["X-State"] == "completed" and evidence["nonce"] in acknowledged.get_content()
            assert acknowledgment["sha256"] == sha(directory / "terminal-ack.eml")
            assert (directory / "thread-after-ack.mbox").read_bytes() == raw
            assert any(row["exit_code"] == 0 and "completed" in output for row, output, _ in public("state"))
            assert any(row["exit_code"] == 0 and "--reply-to" not in row["argv"] for row, _, _ in public("wait"))
            fresh = BytesParser(policy=policy.default).parsebytes((directory / "fresh-selected.eml").read_bytes())
            assert fresh["Message-ID"] == f"<fresh-{evidence['nonce']}@{evidence['host']}>" and fresh["X-Type"] == "question"
            if mode == "continuing":
                assert str(accepted["Message-ID"]) in (directory / "accepted-pickup.txt").read_text()
                unregister = public("unregister")
                assert len(unregister) == 1 and unregister[0][0]["exit_code"] == 0
                permit = next(row for row, _, _ in public("call") if "Completion is now permitted" in row["argv"][4])
                assert unregister[0][0]["started_epoch"] + unregister[0][0]["seconds"] <= permit["started_epoch"]
    elif mode.startswith("timeout-"):
        calls = public("call")
        assert calls and calls[0][0]["exit_code"] == 4 and calls[0][0]["seconds"] >= 119
        marker = "AFTER-DEADLINE-" + evidence["nonce"]
        native = (directory / "timeout-native-at-deadline.txt").read_text()
        assert marker not in native
        assert (directory / "timeout-started.txt").read_text().strip() == evidence["nonce"]
    elif mode.startswith("call"):
        calls = public("call")
        if defect == "call-read":
            row, output, _ = calls[0]
            marker = row["argv"][row["argv"].index("--expect") + 1]
            assert row["exit_code"] == 4 and marker not in output
            assert any(marker in path.read_text() for path in directory.glob("pickup-*.txt"))
        else:
            assert {row["exit_code"] for row, _, _ in calls} >= {0, 3, 5}
            successes = [(row, output) for row, output, _ in calls if row["exit_code"] == 0]
            assert len(successes) == 2
            for row, output in successes:
                assert row["argv"][row["argv"].index("--expect") + 1] in output
    else:
        watch = public("watch")
        assert len(watch) == 1 and watch[0][0]["exit_code"] == 0 and watch[0][1].strip()
        assert "WATCH-WORK-" + evidence["nonce"] in assistant_events(watch[0][1], evidence["watch_session_id"])
        assert watch[0][0]["argv"][-2:] == ["--idle", "20"]
        histories = [json.loads(output) for row, output, _ in commands if "sessions" in row["argv"] and "read" in row["argv"] and row["exit_code"] == 0]
        counts = [sum(entry["role"] == "user" for entry in history["entries"]) for history in histories]
        assert counts[-1] == evidence["prompt_count_after"]
        assert evidence["prompt_count_before"] in counts
        assert (counts[-1] > evidence["prompt_count_before"]) if defect == "watch-prompt" else (counts[-1] == evidence["prompt_count_before"])
        inventories = [json.loads(output) for row, output, _ in commands if "sessions" in row["argv"] and "list" in row["argv"] and row["exit_code"] == 0]
        assert len(inventories) == 2
        assert sorted(row["acpxRecordId"] for row in inventories[0]) == sorted(row["acpxRecordId"] for row in inventories[1])
print(f"Verified {qcg}: {len(rows)} actual normal/fault/restoration evidence sets; no model call and no cached pass verdict used")
