"""Observe v2 (QCG-9, Hermes half): a finished skill_view call through the real post_tool_call
hook runs `sno observe append skill.run --agent=hermes ...` from the session's cwd (or, when the
session has none, from the Hermes process's directory) and writes no ledger line; other tools run
nothing. A `sno` stand-in first on PATH records its argv and working directory. The
Hermes loader, plugin copy, and sidecar stand-in come from the baseline suite's setUp."""

from __future__ import annotations

import os
import stat
import time
import unittest

import test_plugin_baseline as baseline
from plugins.memory import load_memory_provider


class SkillRunAppendTest(unittest.TestCase):
    def setUp(self) -> None:
        baseline.BaselinePluginTest.setUp(self)
        bin_dir = self.root / "observe-bin"
        bin_dir.mkdir()
        self.capture = self.root / "observe-capture.log"
        stand_in = bin_dir / "sno"
        stand_in.write_text('#!/bin/sh\nprintf \'%s\\t%s\\n\' "$PWD" "$*" >> "$SNO_OBSERVE_CAPTURE"\n')
        stand_in.chmod(stand_in.stat().st_mode | stat.S_IXUSR)
        self.previous = {key: os.environ.get(key) for key in ("PATH", "SNO_OBSERVE_CAPTURE")}
        os.environ["PATH"] = f"{bin_dir}:{os.environ['PATH']}"
        os.environ["SNO_OBSERVE_CAPTURE"] = str(self.capture)

    def tearDown(self) -> None:
        for key, value in self.previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        baseline.BaselinePluginTest.tearDown(self)

    def tool_call(self, tool_name: str, args: dict[str, object], **session: object) -> list[tuple[str, str]]:
        self.manager.discover_and_load()
        provider = load_memory_provider("sno-mem-hermes")
        provider.initialize(
            "session-a",
            hermes_home=os.environ["HERMES_HOME"],
            agent_context="primary",
            **session,
        )
        self.manager.invoke_hook(
            "post_tool_call",
            session_id="session-a",
            tool_name=tool_name,
            args=args,
            result='{"success": true}',
            duration_ms=1234.4,
        )
        provider.shutdown()
        deadline = time.monotonic() + 5
        while not self.capture.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertFalse((self.root / "sno-profile" / "observe" / "ledger.jsonl").exists())
        if not self.capture.exists():
            return []
        return [tuple(line.split("\t", 1)) for line in self.capture.read_text().splitlines()]

    def test_skill_view_runs_sno_observe_from_the_session_cwd(self) -> None:
        workdir = self.root / "work"
        workdir.mkdir()
        calls = self.tool_call("skill_view", {"name": "rem-reflect"}, cwd=str(workdir))
        self.assertEqual(
            calls,
            [(
                str(workdir.resolve()),
                "observe append skill.run --agent=hermes --harness=hermes --skill_name=rem-reflect "
                "--skill_version=local --category=R --duration_ms=1234 --outcome=ok",
            )],
        )

    def test_a_session_without_cwd_runs_from_the_hermes_directory(self) -> None:
        calls = self.tool_call("skill_view", {"name": "rem-reflect"})
        self.assertEqual([cwd for cwd, _ in calls], [os.getcwd()])

    def test_category_prefixed_name_counts_its_last_segment(self) -> None:
        calls = self.tool_call("skill_view", {"name": "sno/rem-reflect"}, cwd=str(self.root))
        self.assertEqual(len(calls), 1)
        self.assertIn("--skill_name=rem-reflect ", calls[0][1])

    def test_skill_view_of_a_supporting_file_is_not_a_run(self) -> None:
        calls = self.tool_call(
            "skill_view", {"name": "rem-reflect", "file_path": "references/loop.md"}, cwd=str(self.root)
        )
        self.assertEqual(calls, [])

    def test_other_tools_run_nothing(self) -> None:
        self.assertEqual(
            self.tool_call("web_search", {"name": "rem-reflect", "query": "rem-reflect"}, cwd=str(self.root)), []
        )


if __name__ == "__main__":
    unittest.main()
