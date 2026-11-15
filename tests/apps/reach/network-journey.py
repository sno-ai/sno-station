#!/usr/bin/env python3
"""Public Reach network journey; only hostnames and terminal observers are fixtures."""

import email
import json
import os
from pathlib import Path
import subprocess
import sys
from email.utils import formatdate

reach, directory = sys.argv[1:3]
case = sys.argv[3] if len(sys.argv) > 3 else "all"
assert case in ("all", "recovery", "notification", "authorization"), case
work = Path(directory)
hosts = []


def run(host, *args, body=None, ok=True, timeout=35):
    result = subprocess.run(
        [reach, *args], env=host["env"], input=body,
        text=True, capture_output=True, timeout=timeout,
    )
    with (work / "commands.log").open("a") as log:
        log.write(f"{host['name']} {args}: exit {result.returncode}\n")
        log.write(result.stdout + result.stderr)
    if ok:
        assert result.returncode == 0, (args, result.returncode, result.stdout, result.stderr)
    return result


def message(sender, recipient, identifier, body):
    return "\n".join([
        f"From: Sender <{sender}>", f"To: {recipient}",
        f"Date: {formatdate(localtime=False)}", "Subject: [CALL] network journey",
        f"Message-ID: <{identifier}@example.test>", "X-Type: call",
        f"X-Work: {identifier}", "", body, "",
    ])


def messages(host, identifier, folders=("new", "cur")):
    matches = []
    for folder in folders:
        for path in (host["root"] / host["address"] / folder).glob("*"):
            if path.is_file():
                parsed = email.message_from_string(path.read_text())
                if parsed["Message-ID"] == f"<{identifier}@example.test>":
                    matches.append((path, parsed))
    return matches


try:
    for name in ("fixture-a.test", "fixture-b.test"):
        home = work / name
        bins = home / "bin"
        bins.mkdir(parents=True)
        # A narrow host-identity fixture makes the real remote routing run on one host.
        (bins / "hostname").write_text(f"#!/bin/sh\nprintf '%s\\n' '{name}'\n")
        (bins / "ssh").write_text(
            '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/ssh-called"\nexit 91\n'
        )
        (bins / "reach-channel-network-test").write_text(
            '#!/bin/sh\n[ "$1" = ring ] || exit 2\n'
            'printf "%s\\n" "$3" >> "$HOME/wakes"\n'
        )
        for executable in bins.iterdir():
            executable.chmod(0o755)
        env = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home / ".config"),
                   XDG_STATE_HOME=str(home / ".local/state"),
                   SNO_REACH_ROOT=str(home / "mail"), PATH=f"{bins}:{os.environ['PATH']}")
        for key in ("SNO_REACH_ADDR", "SNO_EXECUTOR_ADDR", "TMUX", "TMUX_PANE"):
            env.pop(key, None)
        host = {"name": name, "home": home, "env": env,
                "root": home / "mail", "address": f"reader.agent@{name}"}
        hosts.append(host)
        run(host, "init", "--as", host["address"], "--name", "Network Reader")
        run(host, "register", "--as", host["address"], "--channel", "network-test", "--handle", name)
        started = json.loads(run(host, "network", "start", "--bind", "127.0.0.1:0").stdout)
        status = json.loads(run(host, "network", "status").stdout)
        assert status["pid"] == started["pid"], (started, status)
        assert Path(status["mailbox_root"]) == host["root"], status
        repeated = json.loads(run(host, "network", "start", "--bind", "127.0.0.1:0").stdout)
        assert repeated["pid"] == status["pid"], repeated
        host["info"] = status
        contact = run(host, "network", "address", "--ip", "127.0.0.1").stdout
        exported = json.loads(contact)
        assert exported["endpoint_id"] == status["endpoint_id"], exported
        host["contact"] = home / "contact.json"
        host["contact"].write_text(contact)
    first, second = hosts
    for sender, recipient in ((first, second), (second, first)):
        run(sender, "peer", "add", recipient["name"], "--file", str(recipient["contact"]))
        assert recipient["name"] in run(sender, "peer", "list").stdout
    print("PASS receiver lifecycle and reciprocal contacts use public commands", flush=True)

    if case == "authorization":
        native = str(Path(reach).resolve().parent.parent / "lib/reach-net")
        command = [native, "connect", "--key-file", str(first["root"] / "network/identity"),
                   "--peer-file", str(first["root"] / "network/peers" / (second["name"] + ".json"))]

        def frame(name, value):
            return f"{name} {len(value.encode())}\n{value}\n"

        def reject(wire, reason):
            result = subprocess.run(command, input=wire, text=True, capture_output=True,
                                    env=first["env"], timeout=10)
            assert result.returncode != 0 and reason in result.stderr, result

        forged = message(second["address"], second["address"], "forged-sender", "Not authorized.")
        wire = "SNO-REACH-REMOTE/1\nDELIVER\n" + frame("root", str(first["root"]))
        wire += frame("address", second["address"]) + frame("basename", "forged-sender")
        wire += f"body {len(forged.encode())}\n" + forged
        reject(wire, "SENDER-NOT-AUTHORIZED")
        assert not messages(second, "forged-sender")
        wire = "SNO-REACH-REMOTE/1\nRING\n" + frame("root", str(first["root"]))
        wire += frame("address", second["address"]) + frame("sender", second["address"])
        reject(wire, "SENDER-NOT-AUTHORIZED")
        assert not (second["home"] / "wakes").exists()
        wire = "SNO-REACH-REMOTE/1\nRING\n" + frame("root", str(first["root"]))
        wire += frame("address", "reader.agent@third.test") + frame("sender", first["address"])
        reject(wire, "OPERATION-NOT-AUTHORIZED")
        assert not (second["home"] / "ssh-called").exists(), "peer used receiver as an SSH relay"
        reject("SNO-REACH-REMOTE/1\nREBIND\n", "OPERATION-NOT-AUTHORIZED")
        print("PASS configured peer cannot forge another host or perform identity administration", flush=True)

    if case != "recovery":
        identifier = "network-original"
        body = "Complete original body: line one\nline two — 中文\n"
        sent = run(first, "send", "--as", first["address"],
                   body=message(first["address"], second["address"], identifier, body))
        received = messages(second, identifier)
        assert len(received) == 1, received
        path, parsed = received[0]
        assert body in parsed.get_payload(), parsed
        assert parsed["Delivered-To"] == second["address"], parsed
        assert second["address"] in (second["home"] / "wakes").read_text()
        assert "notification failed" not in sent.stderr, sent.stderr
        assert not (first["root"] / second["address"]).exists()
        if case == "notification":
            before = (second["home"] / "wakes").read_text().splitlines()
            run(first, "ring", second["address"])
            after = (second["home"] / "wakes").read_text().splitlines()
            assert len(after) > len(before), (before, after)
            assert second["address"] in "\n".join(after[len(before):]), after
            print("PASS accepted receiver wake is not reported as notification failure", flush=True)
            print("PASS public remote ring reaches the receiver notification adapter", flush=True)
            sys.exit(0)
        listing = run(second, "inbox", "--as", second["address"]).stdout
        assert str(path) in listing, listing
        run(second, "reply", "--as", second["address"], "--card", str(path), body="NETWORK-ANSWER-7Q\n")
        reply_path = Path(run(first, "wait", "--as", first["address"], "--reply-to",
                              f"<{identifier}@example.test>", "--from", second["address"],
                              "--timeout", "5").stdout.strip().split("\t")[0])
        reply = email.message_from_string(reply_path.read_text())
        assert "NETWORK-ANSWER-7Q" in reply.get_payload(), reply
        assert reply["In-Reply-To"] == f"<{identifier}@example.test>", reply
        print("PASS real iroh delivery uses the receiver root and returns a threaded reply", flush=True)

    if case == "authorization":
        assert all(not (host["home"] / "ssh-called").exists() for host in hosts)
        sys.exit(0)

    run(second, "network", "stop")
    unavailable = run(first, "send", "--as", first["address"],
                      body=message(first["address"], second["address"], "network-pending", "Retain me."), ok=False)
    assert unavailable.returncode != 0, unavailable
    pending = list((first["root"] / first["address"] / "outbox").glob("*/message"))
    assert any("<network-pending@example.test>" in p.read_text() for p in pending), pending
    assert not messages(second, "network-pending")
    restarted = json.loads(run(second, "network", "start", "--bind", second["info"]["bind_addr"]).stdout)
    assert restarted["endpoint_id"] == second["info"]["endpoint_id"], restarted
    run(first, "flush", "--as", first["address"])
    assert len(messages(second, "network-pending")) == 1
    assert "Retain me." in messages(second, "network-pending")[0][1].get_payload()
    assert not list((first["root"] / first["address"] / "outbox").glob("*/message"))
    print("PASS stopped receiver retains outgoing mail; restart and explicit flush deliver once", flush=True)
    for host in hosts:
        assert not (host["home"] / "ssh-called").exists(), "configured transport fell back to SSH"
    print("PASS configured exchanges never invoked SSH", flush=True)
finally:
    for host in hosts:
        run(host, "network", "stop", ok=False, timeout=15)
