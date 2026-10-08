"""Public CLI contract from acp-v1-communication PRD 5.5; ACPX is external."""
import json
import os
from pathlib import Path
import subprocess
import shutil
import socket
import tempfile
import threading
import time
import unittest

REPO = Path(__file__).resolve().parents[4]
APP = REPO / "apps/reach"
DOOR = APP / "lib/reach-ring"
MESSAGE = APP / "lib/reach-call"
LOCATE = APP / "bin/sno-reach"
SPAWN = LOCATE
HOST = socket.gethostname()

class Communication(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.preserve_failure)
        self.root = Path(self.tmp.name)
        (self.root / "started-at").write_text(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
        self.home = self.root / "home"
        self.cwd = self.root / "repo with spaces"
        self.cwd.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        release = self.home / ".local/lib/sno-reach"
        release.mkdir(parents=True)
        (release / "current").symlink_to(APP)
        self.mail = self.root / "mail"
        self.address = f"tpm.probe@{HOST}"
        self.record = self.mail / self.address / "reachable.json"
        self.handle = f"acp-codex:{self.cwd}:probe"
        self.env = dict(os.environ, HOME=str(self.home), SNO_REACH_ROOT=str(self.mail),
            PATH=f"{self.bin}:{os.environ['PATH']}", ACP_FIXTURE=str(self.root))
        (self.bin / "tmux").write_text('#!/bin/sh\necho called >>"$ACP_FIXTURE/tmux.calls"\nexit 99\n')
        (self.bin / "tmux").chmod(0o755)
        (self.bin / "acpx").symlink_to(Path(__file__).with_name("fake_acpx.py"))
        self.stream = self.root / "events.ndjson"
        self.stream.write_text('old-event\n')
        self.mode("queue")
        for address in (self.address, f"tpm.sender@{HOST}"):
            result = self.run_cli(SPAWN, "init", "--as", address, "--name", "Fixture")
            self.assertEqual(result.returncode, 0, result.stderr)
        result = self.run_cli(SPAWN, "register", "--as", self.address, "--channel", "acp", "--handle", self.handle)
        self.assertEqual(result.returncode, 0, result.stderr)

    def preserve_failure(self):
        result = self._outcome.result
        if any(test is self for test, _ in result.failures + result.errors):
            evidence = Path(tempfile.mkdtemp(prefix="reach-acp-failure-"))
            shutil.copytree(self.root, evidence / "fixture", symlinks=True)
            print(f"Failed test evidence: {evidence}")
        self.tmp.cleanup()

    def mode(self, value):
        (self.root / "mode").write_text(value)

    def run_cli(self, script, *args, timeout=40):
        return subprocess.run(["bash", str(script), *args], cwd="/tmp", env=self.env,
            capture_output=True, text=True, timeout=timeout)

    def ring(self):
        return self.run_cli(DOOR, "doorbell", "--to", self.address,
            "--from", f"tpm.sender@{HOST}", "--msg-id", f"<literal-message@{HOST}>")

    def no_tmux(self):
        self.assertFalse((self.root / "tmux.calls").exists())

    def test_queue_uses_recorded_locator_and_neutral_message(self):
        result = self.ring()
        self.assertEqual(result.stdout, "outcome=rang-unverified\n", result.stderr)
        got = json.loads((self.root / "received.json").read_text())
        self.assertEqual(got["cwd"], str(self.cwd))
        self.assertEqual(got["name"], "probe")
        self.assertIn(f"<literal-message@{HOST}>", got["text"])
        self.assertIn(f"tpm.probe@{HOST}", got["text"])
        self.assertIn(str(self.mail), got["text"])
        self.assertIn(f"sno reach inbox --as tpm.probe@{HOST}", got["text"])
        self.assertIn(str(APP / "guide/agent-reach.md"), got["text"])
        self.assertNotIn("ACK-", got["text"])
        self.assertTrue(got["no_wait"])
        self.no_tmux()

    def test_errors_stop_without_tmux(self):
        for mode, expected in (("fail", "failed"), ("empty", "failed"),
                ("garbage", "failed"), ("missing", "unresolved"), ("closed", "unresolved")):
            with self.subTest(mode=mode):
                self.mode(mode)
                result = self.ring()
                self.assertEqual(result.stdout, f"outcome={expected}\n", result.stderr)
                self.assertIn("probe", result.stderr)
        self.no_tmux()

    def test_missing_binary(self):
        (self.bin / "acpx").unlink()
        for tool in "awk bash cat cut date dirname env find flock grep head hostname jq mkdir mktemp ps python3 realpath rm sed sha256sum sleep sort stat tail timeout tr uname wc".split():
            binary = shutil.which(tool)
            self.assertIsNotNone(binary, f"real prerequisite {tool} is required")
            (self.bin / tool).symlink_to(binary)
        self.env["PATH"] = str(self.bin)
        self.assertIsNone(shutil.which("acpx", path=self.env["PATH"]))
        result = self.ring()
        self.assertEqual(result.stdout, "outcome=failed\n")
        self.assertIn("acpx", result.stderr)
        self.no_tmux()

    def test_malformed_handles_never_start_acpx(self):
        original = json.loads(self.record.read_text())
        for handle in ("acp-codex:", "acp-codex", "acp-codex::probe", "acp-codex:relative:probe"):
            with self.subTest(handle=handle):
                self.record.write_text(json.dumps(dict(original, handle=handle)))
                result = self.ring()
                self.assertEqual(result.stdout, "outcome=failed\n")
                self.assertIn(handle, result.stderr)
                self.assertFalse((self.root / "acpx.calls").exists())
        self.no_tmux()

    def test_message_requires_assistant_receipt(self):
        self.mode("reply")
        result = self.run_cli(MESSAGE, "--terminal", self.address, "--text", "Report literal result", "--expect", "RESULT-42")
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertTrue(report["verified"])
        self.assertIn("RESULT-42", report["output"])
        self.assertIn(report["deliveryReceipt"], report["output"])
        received = json.loads((self.root / "received.json").read_text())
        self.assertFalse(received["no_wait"])
        self.assertEqual(received["cwd"], str(self.cwd))
        self.assertEqual(received["name"], "probe")
        self.assertIn("Report literal result", received["text"])
        for mode in ("receipt-missing", "receipt-wrong"):
            self.mode(mode)
            refused = self.run_cli(MESSAGE, "--terminal", self.address,
                "--text", "Report literal result", "--expect", "RESULT-42")
            self.assertEqual(refused.returncode, 4, refused.stderr)
            self.assertFalse(json.loads(refused.stdout)["verified"])
        self.mode("echo")
        result = self.run_cli(MESSAGE, "--terminal", self.address, "--text", "RESULT-42")
        self.assertEqual(result.returncode, 4, result.stderr)
        self.assertFalse(json.loads(result.stdout)["verified"])
        self.no_tmux()

    def test_closed_message_refuses(self):
        self.mode("closed")
        result = self.run_cli(MESSAGE, "--terminal", self.address, "--text", "Report result")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "received.json").exists())
        self.no_tmux()

    def test_large_history_read_preserves_output_and_cursor(self):
        history = (json.dumps({"text": "output " * 100}) + "\n") * 400
        self.stream.write_text(history)
        result = self.run_cli(MESSAGE, "--terminal", self.address,
            "--since", "fixture-record:0")
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["output"], history.rstrip("\n"))
        self.assertEqual(report["cursorAfter"], f"fixture-record:{len(history.encode())}")
        reread = self.run_cli(MESSAGE, "--terminal", self.address,
            "--since", report["cursorAfter"])
        self.assertEqual(reread.returncode, 0, reread.stderr)
        self.assertEqual(json.loads(reread.stdout)["output"], "")
        self.assertFalse((self.root / "received.json").exists())
        self.no_tmux()

    def test_large_reply_preserves_receipt_and_result(self):
        self.mode("large-reply")
        result = self.run_cli(MESSAGE, "--terminal", self.address,
            "--text", "Report literal result", "--expect", "RESULT-42")
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertTrue(report["verified"])
        self.assertEqual(report["output"], report["deliveryReceipt"] + " RESULT-42" + "x" * 262144)
        self.no_tmux()

    def test_follow_reads_assistant_events_without_prompting(self):
        self.stream.write_text(json.dumps({"method": "session/update", "params": {
            "update": {"sessionUpdate": "agent_message_chunk", "content": {
                "type": "text", "text": "WATCHED-ASSISTANT-OUTPUT"}}}}) + "\n")
        result = self.run_cli(MESSAGE, "--terminal", self.address, "--follow",
            "--since", "fixture-record:0", "--timeout", "1", "--every", "1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("WATCHED-ASSISTANT-OUTPUT", result.stdout)
        calls = [json.loads(x) for x in (self.root / "acpx.calls").read_text().splitlines()]
        self.assertTrue(calls)
        self.assertTrue(all(args[args.index("sessions") + 1:] == ["show", "probe"]
                            for args in calls), calls)
        self.assertFalse((self.root / "received.json").exists())
        self.no_tmux()

    def test_follow_matches_across_reads_but_not_across_lines(self):
        for first, expected in (("task comp", 0), ("task comp\n", 4)):
            with self.subTest(first=first):
                self.stream.write_text(first)
                captured = self.root / "follow.out"
                with captured.open("w") as output:
                    process = subprocess.Popen(["bash", str(MESSAGE), "--terminal", self.address,
                        "--follow", "--since", "fixture-record:0", "--expect", "task complete",
                        "--timeout", "3", "--every", "1"],
                        env=self.env, stdout=output, stderr=subprocess.PIPE, text=True)
                    try:
                        deadline = time.monotonic() + 5
                        while "task comp" not in captured.read_text() and process.poll() is None:
                            self.assertLess(time.monotonic(), deadline, "watch did not read first fragment")
                            time.sleep(0.02)
                        self.assertIn("task comp", captured.read_text())
                        with self.stream.open("a") as stream:
                            stream.write("lete\n")
                        _, error = process.communicate(timeout=6)
                        self.assertEqual(process.returncode, expected, error)
                    finally:
                        if process.poll() is None:
                            process.kill()
                        process.communicate(timeout=5)
                self.assertIn("lete", captured.read_text())
        self.assertFalse((self.root / "received.json").exists())
        self.no_tmux()

    def test_follow_reads_a_growing_log_without_losing_bytes(self):
        self.stream.write_text("")
        stop = threading.Event()

        def append_output():
            with self.stream.open("ab", buffering=0) as stream:
                for _ in range(100):
                    if stop.is_set():
                        return
                    stream.write(b"x" * 65536 + b"\n")
                    stop.wait(0.001)
                stream.write(b"STREAM-DONE\n")

        writer = threading.Thread(target=append_output)
        writer.start()
        try:
            result = self.run_cli(MESSAGE, "--terminal", self.address, "--follow",
                "--since", "fixture-record:0", "--expect", "STREAM-DONE",
                "--timeout", "3", "--every", "1")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.split("\n", 1)[1], self.stream.read_text())
            self.assertTrue(result.stdout.endswith("STREAM-DONE\n"))
        finally:
            stop.set()
            writer.join(timeout=5)
        self.assertFalse(writer.is_alive())
        self.no_tmux()

    def test_read_expect_never_passes_without_new_matching_output(self):
        for history, cursor in (("", "fixture-record:0"),
                ("task comp\nlete\n", "fixture-record:0"), ("task complete\n", None)):
            with self.subTest(history=history, cursor=cursor):
                self.stream.write_text(history)
                args = ["--since", cursor] if cursor else []
                result = self.run_cli(MESSAGE, "--terminal", self.address,
                    "--expect", "task complete", "--timeout", "0", *args)
                self.assertEqual(result.returncode, 4, result.stderr)
                self.assertNotIn('"ok": true', result.stdout)
        self.no_tmux()

    def test_read_expect_waits_for_split_output(self):
        self.stream.write_text("task comp")
        process = subprocess.Popen(["bash", str(MESSAGE), "--terminal", self.address,
            "--since", "fixture-record:0", "--expect", "task complete",
            "--timeout", "3", "--every", "1"],
            env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            time.sleep(0.2)
            self.assertIsNone(process.poll(), "read returned before expected output arrived")
            with self.stream.open("a") as stream:
                stream.write("lete\n")
            output, error = process.communicate(timeout=6)
            self.assertEqual(process.returncode, 0, error)
            report = json.loads(output)
            self.assertTrue(report["ok"])
            self.assertEqual(report["output"], "task complete")
            self.assertEqual(report["cursorAfter"], "fixture-record:14")
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)
        self.assertFalse((self.root / "received.json").exists())
        self.no_tmux()

    def test_real_acpx_delivers_the_doorbell_prompt(self):
        binary = shutil.which("acpx")
        self.assertIsNotNone(binary, "real ACPX is required")
        (self.bin / "acpx").unlink()
        (self.bin / "acpx").symlink_to(binary)
        config = self.home / ".acpx/config.json"
        config.parent.mkdir(parents=True)
        config.write_text(json.dumps({"agents": {"codex": {"argv": ["python3",
            str(Path(__file__).with_name("fake_acp_agent.py"))]}}, "ttl": 1}))
        created = subprocess.run([str(self.bin / "acpx"), "--cwd", str(self.cwd),
            "--approve-all", "--format", "json", "codex", "sessions", "new", "--name", "probe"],
            env=self.env, capture_output=True, text=True, timeout=15)
        self.assertEqual(created.returncode, 0, created.stderr)
        self.addCleanup(subprocess.run, [str(self.bin / "acpx"), "--cwd", str(self.cwd),
            "codex", "sessions", "close", "probe"], env=self.env, capture_output=True, timeout=10)
        result = self.ring()
        self.assertEqual(result.stdout, "outcome=rang-unverified\n", result.stderr)
        received = self.root / "protocol-received.json"
        deadline = time.monotonic() + 10
        while not received.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertTrue(received.exists(), "real ACPX did not deliver a protocol prompt")
        text = "".join(item["text"] for item in json.loads(received.read_text()))
        self.assertIn(f"<literal-message@{HOST}>", text)
        self.assertIn(f"tpm.probe@{HOST}", text)
        self.assertNotIn("ACK-", text)
        self.no_tmux()

    def test_timeout_fails_without_tmux(self):
        self.mode("timeout")
        self.env["SNO_REACH_WAKE_NO_DETACH"] = "1"
        result = self.run_cli(APP / "lib/reach-wake", "start", "--root", str(self.mail),
            "--sender", f"tpm.sender@{HOST}", "--recipient", self.address,
            "--message-id", f"<literal-message@{HOST}>", "--work", "acp-probe", "--mechanism", str(DOOR))
        self.assertEqual(result.returncode, 5, result.stderr)
        states = list((self.mail / self.address / "wake-attempts").glob("*.json"))
        self.assertEqual(len(states), 1)
        self.assertEqual(json.loads(states[0].read_text())["last_outcome"], "failed")
        self.no_tmux()

    def test_wake_engine_records_queue_ack_despite_vendor_stderr(self):
        self.env["SNO_REACH_WAKE_NO_DETACH"] = "1"
        result = self.run_cli(APP / "lib/reach-wake", "start", "--root", str(self.mail),
            "--sender", f"tpm.sender@{HOST}", "--recipient", self.address,
            "--message-id", f"<literal-message@{HOST}>", "--work", "acp-probe", "--mechanism", str(DOOR))
        self.assertEqual(result.returncode, 0, result.stderr)
        states = list((self.mail / self.address / "wake-attempts").glob("*.json"))
        self.assertEqual(len(states), 1)
        self.assertEqual(json.loads(states[0].read_text())["last_outcome"], "rang-unverified")
        self.no_tmux()

    def test_spawn_registration_failure_closes_session(self):
        self.prepare_spawn("registration-fails")
        result = self.run_cli(SPAWN, "spawn", "codex", "--cwd", str(self.cwd), "--as", self.address)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.root / "closed").exists(), result.stderr)
        self.assertFalse(self.record.is_file())
        self.no_tmux()

    def test_locator_publishes_acp_record(self):
        self.prepare_spawn("absent-new")
        result = self.run_cli(SPAWN, "spawn", "codex", "--cwd", str(self.cwd), "--as", self.address)
        self.assertEqual(result.returncode, 0, result.stderr)
        stored = json.loads(self.record.read_text())
        name = json.loads((self.root / "created").read_text())["name"]
        self.assertEqual(stored["channel"], "acp")
        self.assertEqual(stored["identity"], {"kind": "acp-session", "value": name})
        self.assertIn("handle=" + stored["handle"], result.stdout)
        self.assertFalse((self.root / "closed").exists())
        self.no_tmux()

    def test_acp_spawn_rejects_command_arguments_before_creation(self):
        self.prepare_spawn("absent-new")
        result = self.run_cli(SPAWN, "spawn", "codex", "--cwd", str(self.cwd), "--as", self.address,
            "--command", "codex exec 'perform the assigned task'")
        self.assertEqual(result.returncode, 64, result.stderr)
        self.assertIn("--command", result.stderr)
        self.assertFalse((self.root / "created").exists())
        self.assertFalse((self.root / "acpx.calls").exists())
        self.assertFalse(self.record.exists())
        self.no_tmux()

    def test_launchers_reject_malformed_config_before_creation(self):
        self.prepare_spawn("absent-new")
        config = self.home / ".config/sno-reach/agents.json"
        for invalid in ('{"codex":', '{"codex":{"acpx_agent":""}}',
                        '{"codex":{"acpx_agent":"   "}}', '{"codex":{"acpx_agent":1}}'):
            config.write_text(invalid)
            for window in ([], ["--window"]):
                with self.subTest(window=window, config=invalid):
                    result = self.run_cli(SPAWN, "spawn", "codex", "--as", self.address, "--cwd", str(self.cwd), *window)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("agents.json", result.stderr)
                    self.assertFalse((self.root / "created").exists())
                    self.no_tmux()

    def fake_openclaw_agents(self, agents):
        """A stand-in `openclaw` that answers `agents list --json` the way the real one does."""
        listing = json.dumps([{"id": name, "isDefault": default} for name, default in agents])
        (self.bin / "openclaw").write_text(f"#!/bin/sh\n[ \"$*\" = 'agents list --json' ] && {{ cat <<'JSON'\n{listing}\nJSON\nexit 0; }}\nexit 2\n")
        (self.bin / "openclaw").chmod(0o755)

    def prepare_openclaw_spawn(self):
        self.prepare_spawn("absent-new")
        (self.home / ".config/sno-reach/agents.json").write_text('{"openclaw":{"acpx_agent":"openclaw"}}')

    def test_openclaw_spawn_is_refused_when_several_agents_and_none_is_default(self):
        # OpenClaw refuses the seat's first message in this setup ("Multiple agents are configured, but session ... has no
        # explicit owner"), so a seat that spawn reported as created could never answer.
        self.prepare_openclaw_spawn()
        self.fake_openclaw_agents([("alpha", False), ("beta", False)])
        result = self.run_cli(SPAWN, "spawn", "openclaw", "--cwd", str(self.cwd), "--as", self.address)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("alpha, beta", result.stderr)
        self.assertIn("openclaw config set agents.defaults.systemAgent.agentId", result.stderr)
        self.assertFalse((self.root / "created").exists())
        self.assertFalse((self.root / "acpx.calls").exists())
        self.assertFalse(self.record.exists())
        self.no_tmux()

    def test_openclaw_spawn_goes_ahead_with_a_default_agent_or_a_single_agent(self):
        for agents in ([("alpha", True), ("beta", False)], [("only", False)]):
            with self.subTest(agents=agents):
                self.prepare_openclaw_spawn()
                self.fake_openclaw_agents(agents)
                for leftover in ("created", "closed", "acpx.calls"):
                    (self.root / leftover).unlink(missing_ok=True)
                result = self.run_cli(SPAWN, "spawn", "openclaw", "--cwd", str(self.cwd), "--as", self.address)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue((self.root / "created").exists())

    def test_openclaw_spawn_is_refused_when_its_acpx_route_pins_a_conversation(self):
        # `--session <key>` on the openclaw route makes every ACP session join that one conversation: with
        # `--session agent:main:main` each seat would land in the main conversation and mix its context with it.
        route = self.home / ".acpx/config.json"
        route.parent.mkdir(parents=True)
        for command in ("openclaw acp --session agent:main:main", "openclaw acp --session-label main", "openclaw acp --session=agent:main:main"):
            with self.subTest(command=command):
                self.prepare_openclaw_spawn()
                self.fake_openclaw_agents([("main", True)])
                for leftover in ("created", "closed", "acpx.calls"):
                    (self.root / leftover).unlink(missing_ok=True)
                route.write_text(json.dumps({"agents": {"openclaw": {"command": command}}}))
                result = self.run_cli(SPAWN, "spawn", "openclaw", "--cwd", str(self.cwd), "--as", self.address)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn("--session", result.stderr)
                self.assertIn(str(route), result.stderr)
                self.assertFalse((self.root / "created").exists())
                self.assertFalse(self.record.exists())

    def test_openclaw_spawn_goes_ahead_when_its_acpx_route_pins_nothing(self):
        route = self.home / ".acpx/config.json"
        route.parent.mkdir(parents=True)
        route.write_text(json.dumps({"agents": {"openclaw": {"command": "openclaw acp"}}}))
        self.prepare_openclaw_spawn()
        self.fake_openclaw_agents([("main", True)])
        result = self.run_cli(SPAWN, "spawn", "openclaw", "--cwd", str(self.cwd), "--as", self.address)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.root / "created").exists())

    def prepare_spawn(self, mode):
        self.record.unlink(missing_ok=True)
        config = self.home / ".config/sno-reach/agents.json"
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text('{"codex":{"acpx_agent":"codex"}}')
        self.mode(mode)

    def spawn_until_runtime(self, window=False, fallback=False):
        self.prepare_spawn("absent-new")
        if fallback:
            (self.home / ".config/sno-reach/agents.json").write_text('{}')
        if window or fallback:
            binary = shutil.which("tmux")
            self.assertIsNotNone(binary)
            server = "reach-bootstrap-" + str(os.getpid())
            subprocess.run([binary, "-L", server, "-f", "/dev/null", "new-session", "-d", "-s", "fixture", "sleep", "60"], check=True, env=self.env)
            self.addCleanup(subprocess.run, [binary, "-L", server, "kill-server"], capture_output=True)
            self.env["TMUX"] = subprocess.check_output([binary, "-L", server, "display-message", "-p", "#{socket_path},#{pid},0"], text=True).strip()
            (self.bin / "tmux").unlink()
            (self.bin / "tmux").symlink_to(binary)
            (self.bin / "codex").symlink_to(Path(__file__).with_name("fake_agent_environment.py"))
            resolved = subprocess.check_output([binary, "-L", server, "show-environment", "-g", "PATH"], text=True)
            self.assertEqual(resolved.strip(), "PATH=" + self.env["PATH"])
            (self.root / "tmux-fixture-path").write_text(resolved)
        result = self.run_cli(SPAWN, "spawn", "codex", "--as", self.address, "--cwd", str(self.cwd), *(["--window"] if window else []))
        self.assertEqual(result.returncode, 0, result.stderr)
        if window or fallback:
            self.assertIn("channel=tmux", result.stdout)
            if fallback:
                self.assertIn("not ACP-capable", result.stderr)
            output = self.root / "agent-environment.json"
            deadline = time.monotonic() + 10
            while not output.exists() and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertTrue(output.exists(), "tmux actor never received bootstrap environment")
            return json.loads(output.read_text())["env"]
        return json.loads((self.root / "created").read_text())

    def test_window_runner_exports_executor_address(self):
        observed = self.spawn_until_runtime(window=True)
        self.assertEqual(observed["SNO_REACH_ADDR"], self.address)
        self.assertEqual(observed["SNO_REACH_ROOT"], str(self.mail))
        self.assertEqual(observed["SNO_REACH_GUIDE"], str(APP / "guide/agent-reach.md"))

    def test_uninitialized_spawn_refuses_before_runtime(self):
        self.prepare_spawn("absent-new")
        result = self.run_cli(SPAWN, "spawn", "codex", "--as", f"worker.uninitialized@{HOST}", "--cwd", str(self.cwd))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("init", result.stderr)
        self.assertFalse((self.root / "created").exists())
        self.assertFalse((self.root / "acpx.calls").exists())
        self.no_tmux()

    def test_unlisted_agent_automatically_uses_tmux(self):
        observed = self.spawn_until_runtime(fallback=True)
        self.assertEqual(observed["SNO_REACH_ADDR"], self.address)
        self.assertEqual(observed["SNO_REACH_ROOT"], str(self.mail))

    def test_wrong_channel_plant_reaches_delivery_then_fails_wake(self):
        self.spawn_until_runtime(window=True)
        saved = json.loads(self.record.read_text())
        self.mode("missing")
        for valid_shape in (False, True):
            broken = dict(saved, channel="acp")
            if valid_shape:
                broken.update(handle=f"acp-codex:{self.cwd}:wrong-channel",
                              identity={"kind": "acp-session", "value": "wrong-channel"})
            self.record.write_text(json.dumps(broken))
            identity = f"<wrong-channel-{valid_shape}@{HOST}>"
            card = (f"From: Sender <tpm.sender@{HOST}>\nTo: Fixture <{self.address}>\n"
                    "Date: Sun, 13 Sep 2026 09:00:00 +0000\nSubject: [QUESTION] wrong channel\n"
                    f"Message-ID: {identity}\nX-Work: wrong-channel-{valid_shape}\nX-Type: question\n\nDo the named work.\n")
            result = subprocess.run([str(SPAWN), "send", "--as", f"tpm.sender@{HOST}"], input=card,
                                    env=self.env, capture_output=True, text=True, timeout=10)
            delivered = any(identity in path.read_text() for folder in ("new", "cur")
                            for path in (self.mail / self.address / folder).iterdir() if path.is_file())
            print(json.dumps(dict(wrong_channel_shape="valid-acp" if valid_shape else "channel-only",
                                  exit_code=result.returncode, delivered=delivered)))
            if valid_shape:
                self.assertIn(result.returncode, (5, 6), result.stderr)
                self.assertTrue(delivered, "schema-valid wrong channel failed before actual delivery")
                self.assertFalse((self.root / "received.json").exists(), "missing session unexpectedly received a prompt")
        self.record.write_text(json.dumps(saved))

    def test_acp_launch_passes_executor_environment(self):
        observed = self.spawn_until_runtime()
        self.assertEqual(observed["SNO_REACH_ADDR"], self.address)
        self.assertEqual(observed["SNO_REACH_ROOT"], str(self.mail))
        self.assertEqual(observed["SNO_REACH_GUIDE"], str(APP / "guide/agent-reach.md"))
        prompt = json.loads((self.root / "received.json").read_text())["text"]
        self.assertIn(str(APP / "guide/agent-reach.md"), prompt)
        self.assertIn(self.address, prompt)
        self.no_tmux()


if __name__ == "__main__":
    unittest.main()
