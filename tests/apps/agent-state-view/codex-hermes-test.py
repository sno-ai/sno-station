"""Real plugin callbacks and files; only the unavailable external Hermes host modules are substitutes."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[3] / "apps/mem-hermes/sno-mem-hermes/__init__.py"


class HermesObservationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.profile = Path(self.temporary.name)
        self.previous_profile = os.environ.get("SNO_PROFILE_DIR")
        os.environ["SNO_PROFILE_DIR"] = str(self.profile)
        self.previous_modules = {name: sys.modules.get(name) for name in (
            "agent", "agent.memory_provider", "hermes_constants", "sno_state_hermes",
        )}
        agent = types.ModuleType("agent")
        memory = types.ModuleType("agent.memory_provider")
        memory.MemoryProvider = type("MemoryProvider", (), {})
        memory.RecallStatus = type("RecallStatus", (), {})
        constants = types.ModuleType("hermes_constants")
        constants.get_hermes_home = lambda: self.profile
        sys.modules.update({"agent": agent, "agent.memory_provider": memory, "hermes_constants": constants})
        spec = importlib.util.spec_from_file_location("sno_state_hermes", PLUGIN)
        assert spec is not None and spec.loader is not None
        self.module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = self.module
        spec.loader.exec_module(self.module)

    def tearDown(self) -> None:
        if self.previous_profile is None:
            os.environ.pop("SNO_PROFILE_DIR", None)
        else:
            os.environ["SNO_PROFILE_DIR"] = self.previous_profile
        for name, original in self.previous_modules.items():
            if original is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original
        self.temporary.cleanup()

    def events(self, filename: str = "hermes--session%2Fone.jsonl") -> list[dict[str, object]]:
        return [json.loads(line) for line in (self.profile / "station/agents" / filename).read_text().splitlines()]

    def test_existing_registered_callbacks_append_without_a_sidecar_or_provider(self) -> None:
        callbacks = {}
        context = types.SimpleNamespace(
            register_memory_provider=lambda provider: None,
            register_hook=lambda name, callback: callbacks.update({name: callback}),
        )
        self.module.register(context)
        callbacks["pre_llm_call"](session_id="session/one", cwd=str(self.profile))
        callbacks["post_tool_call"](session_id="session/one", tool_name="terminal", result="done")
        callbacks["post_approval_response"](session_id="session/one", choice="allow")
        callbacks["on_session_reset"](old_session_id="session/one")
        records = self.events()
        self.assertEqual([record["event"] for record in records], [
            "pre-model-call", "post-tool-use", "approval-response", "session-end",
        ])
        self.assertTrue(all(record["sessionId"] == "session/one" for record in records))
        self.assertEqual(records[0]["pid"], os.getpid())
        self.assertEqual(records[0]["processStart"], Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split()[19])
        self.assertEqual(records[0]["cwd"], str(self.profile))
        self.assertFalse((self.profile / "station/sidecar.json").exists())

    def test_provider_observes_prompt_and_actual_final_reply_without_memory(self) -> None:
        provider = self.module.SnoMemoryProvider()
        provider._session_id = "session/one"
        provider._primary = True
        provider.on_turn_start(1, "Inspect this")
        provider.on_turn_start(2, "A teammate replied", author_is_bot=True)
        provider.on_session_end([
            {"role": "assistant", "content": "Earlier."},
            {"role": "tool", "content": "not the final reply?"},
            {"role": "assistant", "content": "Proceed？"},
        ])
        records = self.events()
        self.assertEqual(records[0]["event"], "user-prompt-submit")
        self.assertEqual(records[1]["event"], "agent-prompt-submit")
        self.assertEqual(records[2]["event"], "stop")
        self.assertEqual(records[2]["input"]["last_assistant_message"], "Proceed？")

    def test_callbacks_store_only_bounded_fields_in_owner_only_files(self) -> None:
        secret = "SECRET-PAYLOAD " * 400
        callbacks = {}
        context = types.SimpleNamespace(
            register_memory_provider=lambda provider: None,
            register_hook=lambda name, callback: callbacks.update({name: callback}),
        )
        self.module.register(context)
        callbacks["pre_llm_call"](session_id="session/one", cwd=str(self.profile), conversation_history=[secret], user_message=secret)
        callbacks["post_tool_call"](session_id="session/one", tool_name="terminal", result=secret, args={"command": secret})
        provider = self.module.SnoMemoryProvider()
        provider._session_id = "session/one"
        provider._primary = True
        provider.on_turn_start(1, "Fix the parser " + "x" * 5000)
        provider.on_session_end([{"role": "assistant", "content": secret + "Should I continue?"}])
        directory = self.profile / "station/agents"
        stored = (directory / "hermes--session%2Fone.jsonl").read_text()
        self.assertNotIn("SECRET-PAYLOAD SECRET-PAYLOAD SECRET-PAYLOAD SECRET-PAYLOAD SECRET-PAYLOAD SECRET-PAYLOAD "
                         "SECRET-PAYLOAD SECRET-PAYLOAD SECRET-PAYLOAD SECRET-PAYLOAD SECRET-PAYLOAD SECRET-PAYLOAD "
                         "SECRET-PAYLOAD SECRET-PAYLOAD", stored)
        self.assertLess(len(stored), 3000)
        records = self.events()
        self.assertEqual(records[1]["input"], {"tool_name": "terminal"})
        self.assertEqual(len(records[2]["input"]["prompt"]), 200)
        self.assertTrue(records[3]["input"]["last_assistant_message"].endswith("Should I continue?"))
        self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual((directory / "hermes--session%2Fone.jsonl").stat().st_mode & 0o777, 0o600)

    def test_append_failure_is_logged_and_does_not_stop_callback(self) -> None:
        (self.profile / "station").write_text("not a directory")
        with self.assertLogs(self.module._LOG, level="ERROR") as captured:
            self.module._post_approval_response(session_id="session/one", choice="allow")
        self.assertIn("observation append failed", "\n".join(captured.output))

    def test_missing_identity_is_logged_and_never_merges_agents(self) -> None:
        with self.assertLogs(self.module._LOG, level="ERROR") as captured:
            self.module._pre_llm_call()
        self.assertIn("missing session identity", "\n".join(captured.output))
        self.assertFalse((self.profile / "station/agents").exists())


if __name__ == "__main__":
    unittest.main()
