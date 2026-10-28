"""Memory capture runs model extraction, so the Hermes plugin captures a session once it has been quiet for thirty
minutes or reaches a boundary (session switch, reset, shutdown), never after every turn (owner decision, 2026-10-27).

Run: python3 tests/apps/mem-hermes/test_capture_quiet_window.py
The plugin is real; only the Hermes host modules and the sidecar HTTP client are stand-ins."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import threading
import time
import types
import unittest
from dataclasses import dataclass
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[3] / "apps" / "mem-hermes" / "sno-mem-hermes" / "__init__.py"
QUIET_SECONDS = 0.3


def install_host_modules(home: str) -> None:
    agent = types.ModuleType("agent")
    memory = types.ModuleType("agent.memory_provider")

    class MemoryProvider:
        def on_turn_start(self, *args: object, **kwargs: object) -> None:
            pass

    @dataclass
    class RecallStatus:
        provider_label: str
        count: int

    memory.MemoryProvider = MemoryProvider
    memory.RecallStatus = RecallStatus
    hermes = types.ModuleType("hermes_constants")
    hermes.get_hermes_home = lambda: Path(home)
    sys.modules.update({"agent": agent, "agent.memory_provider": memory, "hermes_constants": hermes})


class RecordingSidecar:
    """Records what reaches the sidecar's capture and session-end routes."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.sent: list[tuple[str, str, list[str]]] = []
        self.capture_calls = 0
        self.fail_captures: set[int] = set()

    def post(self, method: str, body: dict[str, object], timeout_seconds: float = 0) -> dict[str, object]:
        scope = body["scope"]
        assert isinstance(scope, dict)
        if method == "capture":
            with self.lock:
                self.capture_calls += 1
                if self.capture_calls in self.fail_captures:
                    raise OSError("capture timed out")
            turn = body["turn"]
            assert isinstance(turn, dict)
            contents = [str(message["content"]) for message in turn["messages"]]
        elif method == "on-session-end":
            contents = [str(message.get("content")) for message in body["messages"]]
        else:
            return {}
        with self.lock:
            self.sent.append((method, str(scope["session"]), contents))
        return {"committed": True}

    def settings(self) -> dict[str, object]:
        limits = {"limit": 5, "maxChars": 2000, "minScore": 0.3, "timeoutMs": 1000}
        return {"recall": {"sessionStart": limits, "prompt": limits}}

    def captures(self) -> list[tuple[str, str, list[str]]]:
        with self.lock:
            return [entry for entry in self.sent if entry[0] == "capture"]


class CaptureQuietWindowTest(unittest.TestCase):
    def setUp(self) -> None:
        self.home = tempfile.TemporaryDirectory()
        install_host_modules(self.home.name)
        spec = importlib.util.spec_from_file_location("sno_mem_hermes_quiet", PLUGIN)
        assert spec is not None and spec.loader is not None
        self.module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = self.module
        spec.loader.exec_module(self.module)
        self.module._CAPTURE_QUIET_SECONDS = QUIET_SECONDS
        self.sidecar = RecordingSidecar()
        self.provider = self.module.SnoMemoryProvider()
        self.provider._session_id = "session-a"
        self.provider._primary = True
        self.provider._project = self.home.name
        self.provider._client = self.sidecar
        self.provider._pending_dir = Path(self.home.name) / "pending-captures"
        self.history: list[dict[str, object]] = []

    def tearDown(self) -> None:
        self.home.cleanup()
        sys.modules.pop("sno_mem_hermes_quiet", None)
        sys.modules.pop("_sno_mem_hermes_shared", None)

    def turn(self, prompt: str, reply: str) -> None:
        # Hermes passes the whole conversation in `messages` after each turn.
        self.history += [{"role": "user", "content": prompt}, {"role": "assistant", "content": reply}]
        self.provider.sync_turn(prompt, reply, session_id="session-a", messages=list(self.history))

    def test_captures_the_session_once_after_it_goes_quiet(self) -> None:
        self.turn("Rename the deploy script", "Renamed it to deploy.sh")
        self.turn("Use port 8443 for staging", "Staging now listens on 8443")
        time.sleep(QUIET_SECONDS / 2)
        self.turn("Keep logs for 14 days", "Retention set to 14 days")
        time.sleep(QUIET_SECONDS / 2)
        self.assertEqual(self.sidecar.sent, [])
        time.sleep(QUIET_SECONDS * 2)
        self.assertEqual(self.sidecar.captures(), [("capture", "session-a", [
            "Rename the deploy script", "Renamed it to deploy.sh",
            "Use port 8443 for staging", "Staging now listens on 8443",
            "Keep logs for 14 days", "Retention set to 14 days",
        ])])
        time.sleep(QUIET_SECONDS * 2)
        self.assertEqual(len(self.sidecar.captures()), 1)

    def test_turns_without_history_accumulate_and_are_captured_before_the_session_switch(self) -> None:
        self.provider.sync_turn("Pin node to 24", "Pinned in .nvmrc", session_id="session-a")
        self.provider.sync_turn("Drop the old cron job", "Removed it", session_id="session-a")
        self.assertEqual(self.sidecar.sent, [])
        self.provider.on_session_switch("session-b")
        self.assertEqual(self.sidecar.sent, [
            ("capture", "session-a", ["Pin node to 24", "Pinned in .nvmrc", "Drop the old cron job", "Removed it"]),
            ("on-session-end", "session-a", []),
        ])
        time.sleep(QUIET_SECONDS * 2)
        self.assertEqual(len(self.sidecar.captures()), 1)

    def test_shutdown_captures_the_pending_session(self) -> None:
        self.turn("The API key lives in vault", "Noted")
        self.assertEqual(self.sidecar.sent, [])
        self.provider.shutdown()
        self.assertEqual([entry[0] for entry in self.sidecar.sent], ["capture", "on-session-end"])
        time.sleep(QUIET_SECONDS * 2)
        self.assertEqual(len(self.sidecar.captures()), 1)

    def test_shutdown_captures_every_held_session(self) -> None:
        self.turn("The API key lives in vault", "Noted")
        self.provider.sync_turn("Rotate the staging cert", "Rotated", session_id="session-b")
        self.provider.shutdown()
        self.assertEqual(sorted(entry[1] for entry in self.sidecar.captures()), ["session-a", "session-b"])
        self.assertEqual(list(self.provider._pending_dir.glob("*.json")), [])

    def test_next_start_captures_turns_a_killed_host_held(self) -> None:
        self.turn("Pin Node 24 in CI", "Pinned it in the workflow")
        self.turn("Cache the pnpm store", "Cached by lockfile hash")
        self.assertEqual(self.sidecar.sent, [])
        # SIGKILL runs no shutdown and its daemon timers die with it; the next process starts with nothing in memory.
        with self.provider._capture_lock:
            for held in self.provider._pending.values():
                held[1].cancel()
        restarted = self.module.SnoMemoryProvider()
        restarted._project = self.home.name
        restarted._client = self.sidecar
        restarted._pending_dir = self.provider._pending_dir
        restarted._capture_left_over()
        self.assertEqual(self.sidecar.captures(), [("capture", "session-a", [
            "Pin Node 24 in CI", "Pinned it in the workflow", "Cache the pnpm store", "Cached by lockfile hash",
        ])])
        self.assertEqual(list(restarted._pending_dir.glob("*.json")), [])

    def held_by_a_killed_host(self, project: str, session_id: str) -> Path:
        other = self.module.SnoMemoryProvider()
        other._project = project
        other._primary = True
        other._client = self.sidecar
        other._pending_dir = self.provider._pending_dir
        other.sync_turn("Use the staging bucket", "Switched it", session_id=session_id)
        with other._capture_lock:
            for held in other._pending.values():
                held[1].cancel()
        return other._pending_path(session_id)

    def test_next_start_removes_what_no_host_can_capture_and_leaves_live_projects_alone(self) -> None:
        live = tempfile.TemporaryDirectory()
        self.addCleanup(live.cleanup)
        gone = tempfile.TemporaryDirectory()
        live_file = self.held_by_a_killed_host(live.name, "session-live")
        self.held_by_a_killed_host(gone.name, "session-gone")
        gone.cleanup()
        # A write cut off by the kill leaves its temporary file behind.
        (self.provider._pending_dir / "cut-off.tmp").write_text('{"project":')
        self.provider._capture_left_over()
        self.assertEqual(self.sidecar.captures(), [])
        self.assertEqual(list(self.provider._pending_dir.iterdir()), [live_file])

    def test_stops_sending_held_turns_after_three_failed_captures_counting_across_restarts(self) -> None:
        self.turn("Pin Node 24 in CI", "Pinned it in the workflow")
        self.sidecar.fail_captures = set(range(1, 10))
        time.sleep(QUIET_SECONDS * 1.5)
        self.assertEqual(self.sidecar.capture_calls, 1)
        # The host is killed while the retry waits; its daemon timers die with it.
        with self.provider._capture_lock:
            for held in self.provider._pending.values():
                held[1].cancel()
        restarted = self.module.SnoMemoryProvider()
        restarted._project = self.home.name
        restarted._client = self.sidecar
        restarted._pending_dir = self.provider._pending_dir
        restarted._capture_left_over()
        time.sleep(QUIET_SECONDS * 4)
        self.assertEqual(self.sidecar.capture_calls, 3)
        self.assertEqual(self.sidecar.captures(), [])
        self.assertEqual(list(restarted._pending_dir.iterdir()), [])

    def test_compression_checkpoint_covers_the_pending_turns(self) -> None:
        self.turn("Store backups in the eu bucket", "Switched the bucket")
        self.assertEqual(self.sidecar.captures(), [])
        self.provider.on_pre_compress(list(self.history))
        self.assertEqual(self.sidecar.captures(), [
            ("capture", "session-a", ["Store backups in the eu bucket", "Switched the bucket"]),
        ])
        time.sleep(QUIET_SECONDS * 2)
        self.assertEqual(len(self.sidecar.captures()), 1)

    # A long session goes out as several captures within the sidecar's single-window input (UTF-8 bytes / 3 <= 3,500
    # tokens), in order and cut only where a turn starts; a failed capture keeps its turns for the next attempt.
    @staticmethod
    def long_session() -> list[str]:
        return [text for index in range(12) for text in (
            f"Turn {index}: " + "Move the nightly backup to the eu-west bucket and keep thirty days of copies. " * 15,
            f"Reply {index}: " + "Done, the job now writes to eu-west and prunes copies older than thirty days. " * 15,
        )]

    def send_long_session(self) -> None:
        contents = self.long_session()
        for index in range(0, len(contents), 2):
            self.turn(contents[index], contents[index + 1])

    def captured_contents(self) -> list[str]:
        return [content for capture in self.sidecar.captures() for content in capture[2]]

    def test_long_session_goes_out_as_bounded_captures_in_order(self) -> None:
        self.send_long_session()
        self.provider.on_session_switch("session-b")
        captures = self.sidecar.captures()
        self.assertGreater(len(captures), 1)
        for capture in captures:
            self.assertLessEqual(sum(len(content.encode()) / 3 for content in capture[2]), 3_500)
            self.assertTrue(capture[2][0].startswith("Turn "))
        self.assertEqual(self.captured_contents(), self.long_session())

    def test_failed_capture_keeps_its_turns_for_the_next_quiet_period(self) -> None:
        self.send_long_session()
        self.sidecar.fail_captures = {2}
        time.sleep(QUIET_SECONDS * 2)
        first = self.captured_contents()
        self.assertTrue(0 < len(first) < len(self.long_session()))
        time.sleep(QUIET_SECONDS * 2)
        self.assertEqual(self.captured_contents(), self.long_session())


    def test_failure_count_restarts_when_a_retry_gets_further_through_a_long_session(self) -> None:
        self.send_long_session()
        self.sidecar.fail_captures = {2, 3, 5}
        time.sleep(QUIET_SECONDS * 6)
        self.assertEqual(self.captured_contents(), self.long_session())

if __name__ == "__main__":
    unittest.main()
