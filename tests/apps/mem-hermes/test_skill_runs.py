"""Observe v2 (QCG-10, Hermes half): a finished skill_view call through the real post_tool_call
hook appends one skill.run row to the profile's observe ledger; other tools append nothing.
The Hermes loader, plugin copy, and sidecar stand-in come from the baseline suite's setUp."""

from __future__ import annotations

import json
import os
import unittest

import test_plugin_baseline as baseline
from plugins.memory import load_memory_provider


class SkillRunLedgerTest(unittest.TestCase):
    setUp = baseline.BaselinePluginTest.setUp
    tearDown = baseline.BaselinePluginTest.tearDown

    def tool_call(self, tool_name: str, args: dict[str, object]) -> list[dict[str, object]]:
        self.manager.discover_and_load()
        provider = load_memory_provider("sno-mem-hermes")
        provider.initialize(
            "session-a",
            hermes_home=os.environ["HERMES_HOME"],
            agent_context="primary",
            cwd=str(self.root),
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
        ledger = self.root / "sno-profile" / "observe" / "ledger.jsonl"
        if not ledger.exists():
            return []
        return [json.loads(line) for line in ledger.read_text().splitlines()]

    def test_skill_view_appends_one_skill_run(self) -> None:
        rows = self.tool_call("skill_view", {"name": "rem-reflect"})
        self.assertEqual(len(rows), 1)
        self.assertIsInstance(rows[0]["ts_ms"], int)
        self.assertEqual(
            {key: rows[0][key] for key in ("event_type", "lane", "payload")},
            {
                "event_type": "skill.run",
                "lane": "skill",
                "payload": {
                    "harness": "hermes",
                    "skill_name": "rem-reflect",
                    "skill_version": "local",
                    "category": "R",
                    "duration_ms": 1234,
                    "outcome": "ok",
                },
            },
        )

    def test_category_prefixed_name_counts_its_last_segment(self) -> None:
        rows = self.tool_call("skill_view", {"name": "sno/rem-reflect"})
        self.assertEqual([row["payload"]["skill_name"] for row in rows], ["rem-reflect"])

    def test_skill_view_of_a_supporting_file_is_not_a_run(self) -> None:
        rows = self.tool_call(
            "skill_view", {"name": "rem-reflect", "file_path": "references/loop.md"}
        )
        self.assertEqual(rows, [])

    def test_other_tools_append_nothing(self) -> None:
        self.assertEqual(
            self.tool_call("web_search", {"name": "rem-reflect", "query": "rem-reflect"}), []
        )


if __name__ == "__main__":
    unittest.main()
