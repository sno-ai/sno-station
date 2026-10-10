"""A finished skill_view call reported by Hermes runs `sno observe append skill.run --agent=hermes ...` from the
session's cwd (or, when the session has none, from the Hermes process's directory); other tools run nothing. A `sno`
stand-in first on PATH records its argv and working directory.

Needs the Hermes modules on the path, so run it with the Hermes interpreter:
  PYTHONPATH=<hermes-agent dir> <hermes python> tests/apps/mem-hermes/test_skill_runs.py"""

from __future__ import annotations

import importlib.util
import os
import stat
import sys
import tempfile
import time
import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[3] / "apps" / "mem-hermes" / "sno-mem-hermes" / "__init__.py"


class SkillRunAppendTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        bin_dir = self.root / "observe-bin"
        bin_dir.mkdir()
        self.capture = self.root / "observe-capture.log"
        stand_in = bin_dir / "sno"
        stand_in.write_text('#!/bin/sh\nprintf \'%s\\t%s\\n\' "$PWD" "$*" >> "$SNO_OBSERVE_CAPTURE"\n')
        stand_in.chmod(stand_in.stat().st_mode | stat.S_IXUSR)
        keys = ("PATH", "SNO_OBSERVE_CAPTURE", "HERMES_HOME", "SNO_PROFILE_DIR")
        self.previous = {key: os.environ.get(key) for key in keys}
        os.environ["PATH"] = f"{bin_dir}:{os.environ['PATH']}"
        os.environ["SNO_OBSERVE_CAPTURE"] = str(self.capture)
        os.environ["HERMES_HOME"] = str(self.root / "hermes-home")
        os.environ["SNO_PROFILE_DIR"] = str(self.root / "sno-profile")
        spec = importlib.util.spec_from_file_location("sno_mem_hermes_skill_runs", PLUGIN)
        assert spec is not None and spec.loader is not None
        self.module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = self.module
        spec.loader.exec_module(self.module)

    def tearDown(self) -> None:
        for key, value in self.previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        sys.modules.pop("sno_mem_hermes_skill_runs", None)
        self.tmp.cleanup()

    def tool_call(self, tool_name: str, args: dict[str, object], **session: object) -> list[tuple[str, str]]:
        provider = self.module.SnoMemoryProvider()
        provider.initialize("session-a", agent_context="primary", **session)
        provider.report_host_tool_call(
            "session-a",
            {"tool_name": tool_name, "args": args, "result": '{"success": true}', "duration_ms": 1234.4},
        )
        deadline = time.monotonic() + 5
        while not self.capture.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
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
