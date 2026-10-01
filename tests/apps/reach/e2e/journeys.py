#!/usr/bin/env python3
"""Real installed Reach journeys. Participants, not the observer, do mail work."""
from concurrent.futures import ThreadPoolExecutor
from email import policy
from email.parser import BytesParser
from email.utils import formatdate, getaddresses
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid
from live_support import Live, clock, sha, test_identity, assistant_events, handled_message, manifest
from variants import variant
from entry_proof import commands as tool_commands, validate as validate_entry
from entry_proof import records as tool_records
from datetime import datetime
import fcntl

MODES = ("acp", "tmux", "continuing", "call", "call-acp", "call-tmux", "timeout-acp", "timeout-tmux", "watch")
if len(sys.argv) != 6 or sys.argv[3] not in MODES:
    raise SystemExit("usage: journeys.py <context> <new-evidence> <acp|tmux|continuing|call|watch> <none|send-ring|reply-ring|wrong-channel|reply-to|call-read|watch-prompt> <archive-sha256>")
run = Live(sys.argv[1], sys.argv[2])
mode, defect = sys.argv[3:5]
allowed = {"acp": {"none", "send-ring", "reply-ring"}, "tmux": {"none", "wrong-channel", "reply-ring"},
           "continuing": {"none", "reply-to"}, "call": {"none"}, "call-acp": {"call-read"}, "call-tmux": {"call-read"},
           "timeout-acp": {"none"}, "timeout-tmux": {"none"}, "watch": {"none", "watch-prompt"}}
if defect not in allowed[mode] or sys.argv[5] != run.context["archive_sha256"]:
    raise SystemExit("mode/defect/candidate admission mismatch")
preflight = run.context.get("preflight", {})
kinds = {actor["kind"] for actor in run.context["actors"]}
if not all(preflight.get("vendor_passed", {}).get(kind) for kind in kinds) or sha(preflight["path"]) != preflight["sha256"]:
    raise SystemExit("same-candidate green Chapter0 for every participating vendor is required")
if kinds & set(run.context.get("blocked_vendors", {})):
    raise SystemExit("a participating vendor remains blocked by an actual refusal")
baseline = json.loads(Path(preflight["path"]).read_text())
if baseline["candidate"] != run.context["archive_sha256"] or baseline["host"] != os.uname().nodename:
    raise SystemExit("preflight host or candidate mismatch")
if baseline["test_inputs"] != test_identity():
    raise SystemExit("test source changed after Chapter0; no inherited preflight")
clock()
run.baseline()
run.deadline = time.time() + (600 if mode in ("acp", "tmux", "continuing") else 240)
actors = {row["label"]: row for row in run.context["actors"]}
nonce = uuid.uuid4().hex
work = "live-" + nonce
mid = f"<{work}@{os.uname().nodename}>"
evidence = dict(host=os.uname().nodename, candidate=run.context["archive_sha256"], preflight=preflight,
                mode=mode, defect=defect, work=work, nonce=nonce, clock=clock(), started_epoch=time.time(),
                test_inputs=test_identity(), actors=run.context["actors"])
evidence["payload_before"] = manifest(run.context["release"])


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def call(actor, prompt, marker):
    prompt = ("For every Reach operation in this task and later rings, run exactly `sno reach` from your current PATH. "
              "Never invoke a cached absolute sno-reach executable or release path. This applies to send, inbox, reply, dismiss and fresh-work cleanup.\n" + prompt)
    output = run.checked("call", actor["address"], prompt, "--expect", re.escape(marker), "--timeout", "120", timeout=125)
    require(marker in output and marker in run.output(actor), "call marker absent from actual assistant output")
    return output


def message(path):
    path = Path(path)
    require(path.resolve().is_relative_to(run.state), "returned card path escapes this run's state")
    return BytesParser(policy=policy.default).parsebytes(path.read_bytes())


def destination(card):
    return [address for _, address in getaddresses(card.get_all("To", []))]


def question(sender, receiver, body, reply_to=None, identity=mid, work_id=work):
    return (f"From: {sender['label']} <{sender['address']}>\nTo: {receiver['label']} <{receiver['address']}>\nDate: {formatdate(localtime=True)}\n"
            f"Subject: [QUESTION] {work_id}\nMessage-ID: {identity}\nX-Type: question\nX-Work: {work_id}\n"
            + (f"Reply-To: {reply_to['address']}\n" if reply_to else "") + "\n" + body + "\n")


def pickup_instruction():
    return ("On each REACH-RING use sno reach inbox with your own --as, read each received status/answer card, "
            "then use sno reach dismiss --as YOUR_ADDRESS --card ITS_PATH --reason acknowledged. "
            "After dismissal print PICKED followed by that received card's actual Message-ID, its X-State and its body nonce. "
            "Do not reply to reports. End the turn without polling, loops or background work. "
            "Do not handle other question work unless separately instructed.")


def cards_export():
    path = run.evidence / "thread.mbox"
    run.checked("export", "--work", work, "--output", str(path))
    # Reach export is an mbox stream. Parse each message after its envelope.
    raw = path.read_bytes()
    chunks = re.split(br"(?m)^From [^\n]*\n", raw)
    return [BytesParser(policy=policy.default).parsebytes(chunk) for chunk in chunks if chunk.strip()], raw


def exchange():
    channel = "tmux" if mode == "tmux" else "acp"
    sender, receiver = actors[channel + "_sender"], actors[channel + "_receiver"]
    recipient = actors["acp_continuing"] if mode == "continuing" else sender
    entry_streams = {}
    for actor in {row["label"]: row for row in (sender, receiver, recipient)}.values():
        if defect not in ("send-ring", "reply-ring", "reply-to"):
            continue
        streams = []
        if actor["channel"] == "acp":
            stream = Path(run.acpx(actor, "show")["eventLog"]["active_path"])
            require(stream.resolve().is_relative_to(run.home), "native ACP tool stream escapes private HOME")
            streams.append(stream)
        if actor["kind"] == "codex":
            candidates = []
            for path in (run.home / ".codex/sessions").rglob("*.jsonl"):
                rows = tool_records(path.read_text())
                meta = next((row for row in rows if row.get("type") == "session_meta"), None)
                if meta and meta["payload"].get("cwd") == actor["cwd"] and datetime.fromisoformat(meta["timestamp"].replace("Z", "+00:00")).timestamp() >= actor["spawn_started_epoch"]:
                    candidates.append(path)
            require(len(candidates) == 1, "cannot bind one fresh native Codex tool session")
            streams.extend(candidates)
        if actor["kind"] == "claude" and actor["channel"] == "tmux":
            streams.append(run.claude_transcript(actor))
        require(streams, "native actor has no command evidence stream")
        entry_streams[actor["label"]] = [(stream, len(tool_records(stream.read_text()))) for stream in streams]
    def entry(actor, verb):
        if defect not in ("send-ring", "reply-ring", "reply-to"):
            return
        until = min(time.time() + 10, run.deadline, clock()["deadline_epoch"])
        while True:
            rows = []
            for stream, offset in entry_streams[actor["label"]]:
                rows.extend(tool_records(stream.read_text())[offset:])
            selected = [row for row in rows if tool_commands([row])]
            observed = tool_commands(selected)
            (run.evidence / (actor["label"] + "-executed-records.json")).write_text(run.clean(json.dumps(selected, indent=2)) + "\n")
            (run.evidence / (actor["label"] + "-executed-commands.json")).write_text(run.clean(json.dumps(observed, indent=2)) + "\n")
            try:
                validate_entry(observed, verb)
                return
            except AssertionError as error:
                if "bypassed" in str(error) or time.time() >= until:
                    raise
                time.sleep(.2)
    for actor in {row["label"]: row for row in (sender, receiver, recipient)}.values():
        # A registration goes stale after 900 idle seconds and doctor then refuses; an earlier
        # journey can outlast that, so refresh through the public register first.
        handle = run.record(actor)["identity"]["value"] if actor["channel"] == "tmux" else actor["handle"]
        run.checked("register", "--as", actor["address"], "--channel", actor["channel"], "--handle", handle)
        run.checked("doctor", "--as", actor["address"])
    prepared = "READY-" + nonce
    call(recipient, pickup_instruction() + f" Reply {prepared} now, then wait without polling.", prepared)
    accept_only = mode == "continuing"
    receiver_rules = (
        f"Next work is {work}. Only act on that work ID when its REACH-RING arrives. Use sno reach inbox --as {receiver['address']}, "
        "read its exact card path, and use sno reach reply --state accepted on that path. Keep that original path. "
        + ("After acceptance stop. Do not complete until I explicitly permit completion through a later call. " if accept_only else
           "Then compute19+23, write the requested result file and reply --state completed on that same original path. ")
        + "Include NONCE from the question and RESULT=42 in the completed body. Never send raw acceptance/answer cards. "
        + f"Do not poll. Reply {prepared} now, then end this turn.")
    call(receiver, receiver_rules, prepared)
    body = (f"Accept this work, then compute19+23. Write result-{nonce}.txt in your current directory with exactly "
            f"RESULT=42 and NONCE={nonce} on separate lines. Return both values using reply --state completed on the original path. "
            + ("After acceptance, wait for explicit completion permission. " if accept_only else "") + "Do not poll.")
    card = question(sender, receiver, body, recipient if accept_only else None)
    send_marker = "SENT-" + nonce
    prompt = (pickup_instruction() + "\nCreate the following exact UTF-8 card in your own cwd, then run "
              f"sno reach send --as {sender['address']} with that card on stdin. Do not use --no-ring. "
              f"Report the real exit code as SEND-EXIT=<number>, then {send_marker}. Do not wait or poll for the answer.\n" + card)
    record_path = run.state / receiver["address"] / "reachable.json"
    record_before = record_path.read_bytes()
    if defect == "wrong-channel":
        broken = json.loads(record_before)
        broken["channel"] = "acp"
        wrong_name = "wrong-channel-" + nonce
        broken["handle"] = f"acp-codex:{receiver['cwd']}:{wrong_name}"
        broken["identity"] = dict(kind="acp-session", value=wrong_name)
        record_path.write_text(json.dumps(broken) + "\n")
    try:
        sent_output = call(sender, prompt, send_marker)
        entry(sender, "send")
        require(re.search(r"SEND-EXIT=[56]", sent_output) if defect == "wrong-channel" else "SEND-EXIT=0" in sent_output,
                "participant did not report the required actual public send result")
        if accept_only:
            # The accepted ID is generated by the receiver, not supplied by the
            # observer's prompt. Its actual pickup must precede A unregister.
            until = min(time.time() + 120, run.deadline)
            accepted = None
            wrong_acceptance = None
            while time.time() < until:
                # A may already have dismissed it. Export retains the bytes.
                temp_export = run.evidence / ("acceptance-" + uuid.uuid4().hex + ".mbox")
                run.checked("export", "--work", work, "--output", str(temp_export))
                for chunk in re.split(br"(?m)^From [^\n]*\n", temp_export.read_bytes()):
                    if not chunk.strip():
                        continue
                    row = BytesParser(policy=policy.default).parsebytes(chunk)
                    if row.get("X-State") == "accepted" and recipient["address"] in destination(row):
                        accepted = row
                    if row.get("X-State") == "accepted" and sender["address"] in destination(row):
                        wrong_acceptance = row
                if accepted and str(accepted["Message-ID"]) in run.output(recipient):
                    break
                time.sleep(1)
            if defect == "reply-to":
                entry(receiver, "reply")
                require(accepted is None, "resolver plant did not defeat the distinct-recipient journey")
                require(wrong_acceptance is not None and mid in str(wrong_acceptance["References"]),
                        "resolver negative never reached a real acceptance addressed to wrong A")
                evidence["expected_red"] = "acceptance never reached continuing R"
                return
            require(accepted is not None and str(accepted["Message-ID"]) in run.output(recipient), "R did not pick up acceptance")
            (run.evidence / "accepted-pickup.txt").write_text(run.clean(run.output(recipient)))
            run.checked("unregister", "--as", sender["address"])
            require(run.live_pids(sender), "A unregister unexpectedly stopped its runtime")
            call(receiver, f"Completion is now permitted for {work}. Finish the requested file and reply --state completed on your saved original path. "
                 f"Return COMPLETED-{nonce} after the command. Do not poll.", "COMPLETED-" + nonce)
        code, output, error = run.reach("wait", "--as", recipient["address"], "--from", receiver["address"],
            "--reply-to", mid, "--timeout", "300", timeout=305)
        evidence["observer_wait"] = dict(exit_code=code, output=output, error=error)
        if defect in ("send-ring", "wrong-channel"):
            require(code == 4, "send wake fault did not make observer wait time out")
            transcript, _ = cards_export()
            originals = [row for row in transcript if row["Message-ID"] == mid and receiver["address"] in destination(row)]
            require(originals and nonce in originals[0].get_content(), "wake negative never reached original card delivery")
            require(not any(row["X-State"] == "completed" for row in transcript), "completed answer existed despite wait failure")
            evidence["expected_red"] = "completed answer absent at observer wait"
            return
        require(code == 0, "observer did not receive completed answer")
        terminal_path = Path(output.strip())
        terminal_bytes = terminal_path.read_bytes()
        terminal = message(terminal_path)
        require(terminal["X-State"] == "completed" and terminal["X-Work"] == work, "wrong terminal card")
        require(destination(terminal) == [recipient["address"]], "terminal targeted wrong recipient")
        require(getaddresses(terminal.get_all("From", []))[0][1] == receiver["address"], "terminal came from wrong actor")
        require(nonce in terminal.get_content() and "RESULT=42" in terminal.get_content(), "terminal result missing")
        terminal_id = str(terminal["Message-ID"])
        entry(receiver, "reply")
        transcript, raw = cards_export()
        accepted = [row for row in transcript if row["X-State"] == "accepted"]
        require(accepted, "export lacks prior acceptance")
        acceptance = accepted[0]
        accepted_id = str(acceptance["Message-ID"])
        require(accepted_id != terminal_id and mid in str(terminal["References"]) and accepted_id in str(terminal["References"]),
                "completion lost distinct acceptance ancestry")
        require(mid in str(acceptance["References"]) and destination(acceptance) == [recipient["address"]], "acceptance route/ancestry wrong")
        require(acceptance["X-Work"] == work and getaddresses(acceptance.get_all("From", []))[0][1] == receiver["address"],
                "acceptance work or actor is wrong")
        require(raw.find(accepted_id.encode()) < raw.find(terminal_id.encode()), "export order lost acceptance before completion")
        state = run.checked("state", "--work", work)
        require("completed" in state, "projection is not completed")
        result = Path(receiver["cwd"]) / ("result-" + nonce + ".txt")
        require(result.read_text().splitlines() == ["RESULT=42", "NONCE=" + nonce], "native receiver's external file result wrong")
        (run.evidence / "native-result.txt").write_bytes(result.read_bytes())
        ack_started = time.time()
        ack_deadline = min(ack_started + 120, run.deadline, clock()["deadline_epoch"])
        handled = None
        while time.time() < ack_deadline:
            handled = handled_message(run.state, recipient["address"], terminal_path)
            if handled:
                break
            time.sleep(1)
        ack = dict(message_id=terminal_id, started_epoch=ack_started,
                   seconds=time.time() - ack_started, found=handled is not None)
        if defect == "reply-ring":
            (run.evidence / "terminal-ack.json").write_text(json.dumps(ack, indent=2) + "\n")
            require(handled is None, "reverse ring omission did not defeat sender acknowledgment")
            evidence["expected_red"] = "answer delivered but sender has no actual terminal ID in assistant output"
            return
        require(handled is not None, "sender did not acknowledge the completed report")
        require(handled.read_bytes() == terminal_bytes, "acknowledgment changed completed report bytes")
        ack.update(path=str(handled), sha256=sha(handled))
        (run.evidence / "terminal-ack.json").write_text(json.dumps(ack, indent=2) + "\n")
        (run.evidence / "terminal-ack.eml").write_bytes(handled.read_bytes())
        inbox = run.checked("inbox", "--as", recipient["address"])
        require(accepted_id not in inbox and terminal_id not in inbox and work not in inbox, "acknowledged reports still actionable")
        after = run.evidence / "thread-after-ack.mbox"
        run.checked("export", "--work", work, "--output", str(after))
        require(after.read_bytes() == raw, "acknowledgment changed exported card bytes")
        fresh_id, fresh_work = f"<fresh-{nonce}@{os.uname().nodename}>", "fresh-" + nonce
        fresh = question(receiver, recipient, "Hold this work until separately instructed.", identity=fresh_id, work_id=fresh_work)
        call(receiver, f"Create this card and send it through sno reach send --as {receiver['address']} --no-ring. "
             f"Reply FRESH-{nonce}, then stop.\n" + fresh, "FRESH-" + nonce)
        selected = run.checked("wait", "--as", recipient["address"], "--timeout", "0")
        require(message(selected.strip())["Message-ID"] == fresh_id, "fresh work lost to handled reports")
        (run.evidence / "fresh-selected.eml").write_bytes(Path(selected.strip()).read_bytes())
        call(recipient, f"Now refuse the held fresh work {fresh_work}: find its original card using your inbox, "
             f"then sno reach reply --as {recipient['address']} --card ITS_PATH --state refused with body 'selection check finished'. "
             f"Print FRESH-CLOSED-{nonce}, then end without polling.", "FRESH-CLOSED-" + nonce)
        evidence.update(accepted_id=accepted_id, completed_id=terminal_id, result_sha256=sha(result), state=state,
                        picked_up=True, fresh_selected=fresh_id)
    finally:
        if defect == "wrong-channel":
            record_path.write_bytes(record_before)
        if accept_only and not (run.state / sender["address"] / "reachable.json").exists():
            run.checked("register", "--as", sender["address"], "--channel", sender["channel"], "--handle", sender["handle"])


def calls():
    selected = [actors[mode.removeprefix("call-") + "_sender"]] if mode != "call" else [actors["acp_sender"], actors["tmux_sender"]]
    for actor in selected:
        marker = "REACH-OK-" + uuid.uuid4().hex
        code, output, error = run.reach("call", actor["address"], f"Reply with exactly {marker}. Then end the turn.",
                                      "--expect", marker, "--timeout", "120", timeout=125)
        if defect == "call-read":
            require(code == 4 and marker not in output, "lost caller-read plant did not cause public receipt failure4")
            require(run.wait_output(actor, marker, 120), "plant did not preserve actual delivery and native reply")
            evidence["expected_red"] = "actual assistant output exists, public caller lost output and exits4"
            return
        require(code == 0 and marker in output and marker in run.output(actor), "live call nonce did not reach caller")
    actor = actors["acp_sender"]
    run.checked("unregister", "--as", actor["address"])
    try:
        code, _, _ = run.reach("call", actor["address"], "This must not be delivered", "--timeout", "120")
        require(code == 5, "unregistered live seat did not return5")
    finally:
        run.checked("register", "--as", actor["address"], "--channel", "acp", "--handle", actor["handle"])
    actor = actors["tmux_sender"]
    pane = run.record(actor)["identity"]["value"]
    tmux = run.context["tools"]["tmux"]["path"]
    # Since 2.0.4 a composer draft is cleared, not refused; the remaining refusal is a pane
    # whose send lock another send holds. Hold that pane's own lock as a concurrent sender.
    code, token, error = run.command([tmux, "show-options", "-p", "-v", "-t", pane, "@agent-window-token"])
    require(code == 0 and token.strip(), "live tmux seat has no Reach pane token: " + error)
    with open(run.state / ".channels/tmux" / token.strip() / "send.lock", "a") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        code, _, _ = run.reach("call", actor["address"], "This must not be delivered", "--timeout", "120", timeout=125)
    require(code == 3, "runtime refusal of a pane with an active send did not return3")
    evidence["live_codes"] = [0, 3, 5]


def timeout_call():
    # Claude Code blocks a foreground sleep and announces the marker it will print later, so
    # the ACP timeout uses the Codex ACP seat; the deadline under test is Reach's own.
    actor = actors["acp_receiver" if mode == "timeout-acp" else "tmux_sender"]
    marker = "AFTER-DEADLINE-" + nonce
    started_file = Path(actor["cwd"]) / ("began-" + nonce + ".txt")
    prompt = (f"Write {started_file.name} in your cwd containing {nonce}. Then run sleep 150 and wait for it to finish; "
              "if your shell tool has a time limit, set it above 200 seconds. "
              f"Only AFTER that wait output {marker}. Do not output that marker earlier or start any other work.")
    begun = time.monotonic()
    code, output, error = run.reach("call", actor["address"], prompt, "--expect", marker,
                                   "--timeout", "120", timeout=130)
    elapsed = time.monotonic() - begun
    require(code == 4 and elapsed >= 119, "accepted work did not reach the real120-second missing-result deadline")
    require(started_file.read_text().strip() == nonce, "native actor did not start the accepted work")
    native = run.output(actor)
    require(marker not in native, "expected result arrived before the tested timeout")
    (run.evidence / "timeout-native-at-deadline.txt").write_text(run.clean(native))
    (run.evidence / "timeout-started.txt").write_bytes(started_file.read_bytes())
    evidence.update(timeout_code=code, timeout_seconds=elapsed, timeout_marker=marker, timeout_output=output, timeout_error=error)
    evidence["timeout_oracle_met"] = True
    # A runtime may cancel work when its caller times out. Eventual completion
    # is synchronization only, never an additional Reach product requirement.
    try:
        late = run.wait_output(actor, marker, 35)
    except RuntimeError as error:
        raise RuntimeError("ENVIRONMENT: timeout oracle met, but owned runtime stopped during recovery: " + str(error)) from error
    if late:
        evidence["recovery"] = "late completion observed; owned actor ready"
    else:
        reset = "RESET-" + nonce
        code, output, error = run.reach("call", actor["address"],
            f"The timeout experiment is over. Stop any still-running sleep from that experiment in your own cwd. "
            f"If it was cancelled, that is expected. Reply {reset}, then end the turn without polling.",
            "--expect", reset, "--timeout", "45", timeout=50)
        if code or reset not in output:
            raise RuntimeError("ENVIRONMENT: timeout oracle met; owned fixture did not reset after cancellation: " + error)
        evidence["recovery"] = "explicit owned fixture reset after timeout/cancellation"


def watch():
    actor = actors["acp_sender"]
    session_id = run.acpx(actor, "show")["acpSessionId"]
    def prompts():
        return sum(row["role"] == "user" for row in run.acpx(actor, "read")["entries"])
    def sessions():
        code, output, error = run.command([run.context["tools"]["acpx"]["path"], "--cwd", actor["cwd"], "--format", "json",
                                          actor["kind"], "sessions", "list", "--local"])
        require(code == 0, "session inventory failed: " + error)
        return sorted(row["acpxRecordId"] for row in json.loads(output))
    initial = prompts()
    marker = "WATCH-WORK-" + nonce
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(call, actor, f"Run sleep 10 in your own shell, then output {marker}. Do not send mail or poll.", marker)
        until = min(time.time() + 60, run.deadline)
        while prompts() == initial and time.time() < until:
            time.sleep(.5)
        require(prompts() == initial + 1, "working prompt was not recorded exactly once")
        before_count, before_sessions = prompts(), sessions()
        output = run.checked("watch", actor["address"], "--idle", "20", timeout=125)
        future.result(timeout=max(.1, run.deadline - time.time()))
        after_count, after_sessions = prompts(), sessions()
    require(marker in assistant_events(output, session_id), "watch did not print the working actor's actual fresh nonce event")
    require(before_sessions == after_sessions, "watch created a new ACP session")
    evidence.update(prompt_count_before=before_count, prompt_count_after=after_count, sessions=before_sessions, watch_output=output, watch_session_id=session_id)
    if defect == "watch-prompt":
        require(after_count > before_count, "watch prompt plant did not trip prompt-count oracle")
        evidence["expected_red"] = "watch added a user prompt"
    else:
        require(after_count == before_count, "read-only watch added a user prompt")


try:
    plant = "call-read-tmux" if mode == "call-tmux" else "none" if defect == "wrong-channel" else defect
    with variant(run, plant):
        if mode in ("acp", "tmux", "continuing"):
            exchange()
        elif mode.startswith("timeout-"):
            timeout_call()
        elif mode.startswith("call"):
            calls()
        else:
            watch()
    evidence["passed"] = True
except Exception as error:
    evidence.update(passed=False, error=run.clean(str(error)), failure_kind=
        "environment/fixture recovery; timeout product oracle already met" if str(error).startswith("ENVIRONMENT:") else
        "untriaged; inspect command and receiver evidence")
    lowered = str(error).lower()
    if any(word in lowered for word in ("quota", "usage limit", "rate limit", "capacity")):
        for kind in kinds:
            run.context.setdefault("blocked_vendors", {})[kind] = run.clean(str(error))
        run.save()
finally:
    evidence["seconds"] = time.time() - evidence["started_epoch"]
    evidence["payload_after"] = manifest(run.context["release"])
    (run.evidence / "journey.json").write_text(run.clean(json.dumps(evidence, indent=2)) + "\n")
print(f"{mode}/{defect}: {'GREEN' if evidence['passed'] else 'RED'} {run.evidence / 'journey.json'}")
raise SystemExit(0 if evidence["passed"] else 1)
