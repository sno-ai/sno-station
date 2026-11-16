"""Hermes sends its platform and loaded instruction prefixes through its real HTTP client.

Run: python3 tests/apps/mem-hermes/test_memory_precision.py
Only the external Hermes host interfaces and memory service are substitutes.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from test_capture_quiet_window import PLUGIN, install_host_modules


class MemoryPrecisionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.home = self.root / "hermes-home"
        self.profile = self.root / "profile"
        self.cwd = self.root / "project" / "nested"
        self.cwd.mkdir(parents=True)
        (self.cwd.parent / ".git").mkdir()
        (self.home / "memories").mkdir(parents=True)
        (self.profile / "station").mkdir(parents=True)
        environment = patch.dict(os.environ, {
            "HERMES_HOME": str(self.home), "SNO_PROFILE_DIR": str(self.profile),
        })
        environment.start()
        self.addCleanup(environment.stop)
        modules = patch.dict(sys.modules)
        modules.start()
        self.addCleanup(modules.stop)
        install_host_modules(str(self.home))
        spec = importlib.util.spec_from_file_location("sno_mem_hermes_precision", PLUGIN)
        assert spec is not None and spec.loader is not None
        self.module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = self.module
        spec.loader.exec_module(self.module)
        self.requests: list[tuple[str, dict[str, object]]] = []
        requests = self.requests

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                self.reply({})

            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append((self.path, body))
                self.reply({"contextText": "Memory brief.", "memoryIds": [], "committed": True})

            def reply(self, body: dict[str, object]) -> None:
                encoded = json.dumps(body).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, *_args: object) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)
        (self.profile / "station" / "sidecar.json").write_text(json.dumps({
            "pid": os.getpid(), "port": self.server.server_port, "token": "fixture-token",
        }))
        limits = {"limit": 5, "maxChars": 2000, "timeoutMs": 1000, "minChars": 1, "minScore": 0.3}
        (self.profile / "settings.json").write_text(json.dumps({
            "memoryPackage": {"path": str(self.root), "node": "node"},
            "recall": {"auto": True, "explicitLimit": 5, "sessionStart": limits, "prompt": limits},
        }))

    def close_server(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def provider(self, session: str, platform: str = "terminal"):
        provider = self.module.SnoMemoryProvider()
        provider.initialize(session, cwd=str(self.cwd), platform=platform)
        self.addCleanup(provider.shutdown)
        return provider

    def test_platform_survives_initialization_capture_and_deferred_reset(self) -> None:
        for platform in ("terminal", "telegram"):
            with self.subTest(platform=platform):
                provider = self.provider(f"session-{platform}", platform)
                self.assertEqual(provider.startup_brief(f"session-{platform}"), "Memory brief.")
                provider.sync_turn("Keep reports brief.", "Understood.", session_id=f"session-{platform}")
                provider.on_session_end([{"role": "user", "content": "Keep reports brief."}])
                provider.shutdown()
                self.module._on_session_reset(old_session_id=f"session-{platform}")
        self.assertEqual([
            (path, body["scope"]["host"]["surface"])
            for path, body in self.requests
            if path in ("/v1/init", "/v1/get-recall", "/v1/capture", "/v1/on-session-end")
        ], [
            ("/v1/init", "terminal"), ("/v1/get-recall", "terminal"),
            ("/v1/capture", "terminal"), ("/v1/on-session-end", "terminal"),
            ("/v1/on-session-end", "terminal"),
            ("/v1/init", "telegram"), ("/v1/get-recall", "telegram"),
            ("/v1/capture", "telegram"), ("/v1/on-session-end", "telegram"),
            ("/v1/on-session-end", "telegram"),
        ])
        resets = [body for path, body in self.requests
                  if path == "/v1/on-session-end" and body["scope"]["host"].get("boundary") == "reset"]
        self.assertEqual([body["scope"]["host"]["surface"] for body in resets], ["terminal", "telegram"])
        self.assertEqual([body["messages"][0]["content"] for body in resets], [
            "Keep reports brief.", "Keep reports brief.",
        ])

    def test_startup_sends_first_matching_project_file_and_only_loaded_twenty_thousand_characters(self) -> None:
        (self.home / "SOUL.md").write_text("Soul\n")
        (self.home / "memories" / "MEMORY.md").write_text("中" * 20000 + "UNLOADED")
        (self.home / "memories" / "USER.md").write_text("User\n")
        (self.cwd / ".hermes.md").write_text("Nearest\n")
        (self.cwd / "HERMES.md").write_text("Not first\n")
        (self.cwd.parent / "HERMES.md").write_text("Ancestor\n")
        (self.cwd / "AGENTS.override.md").write_text("Override\n")
        (self.cwd / "AGENTS.md").write_text("Not override\n")
        (self.cwd / "CLAUDE.md").write_text("Not fallback\n")
        provider = self.provider("files-nearest")
        self.assertEqual(provider.startup_brief("files-nearest"), "Memory brief.")
        files = [body["options"]["loadedFiles"] for path, body in self.requests if path == "/v1/get-recall"][-1]
        self.assertEqual(files, [
            {"path": str(self.home / "SOUL.md"), "sha256": "bd7867c0be290b8b8927d7addce0e9e90ee4bb17e4e4d3d6ef26278a1f24596a", "bytes": 5},
            {"path": str(self.cwd / ".hermes.md"), "sha256": "bc043336dc65bc9f02d76f808e2965f9fa0666ce5234dc547625f465e86418ac", "bytes": 8},
            {"path": str(self.home / "memories" / "MEMORY.md"), "sha256": "921823c1d35333f35449e9cad671a98d281e8c3874f4b0d96baaa001980fff91", "bytes": 60000},
            {"path": str(self.home / "memories" / "USER.md"), "sha256": "dbbfe69836953d21b884fcbf1464f0482a42ecadc53d153b7feb5a499197163a", "bytes": 5},
        ])
        (self.cwd / ".hermes.md").unlink()
        (self.cwd / "HERMES.md").unlink()
        provider = self.provider("files-ancestor")
        provider.startup_brief("files-ancestor")
        files = [body["options"]["loadedFiles"] for path, body in self.requests if path == "/v1/get-recall"][-1]
        self.assertEqual(files[1], {
            "path": str(self.cwd.parent / "HERMES.md"), "sha256": "fd4d045ac8d67bebc59135e128910c1297df3b0492c6efccd81a076dfe09c507", "bytes": 9,
        })
        (self.cwd.parent / "HERMES.md").unlink()
        provider = self.provider("files-override")
        provider.startup_brief("files-override")
        files = [body["options"]["loadedFiles"] for path, body in self.requests if path == "/v1/get-recall"][-1]
        self.assertEqual(files[1], {
            "path": str(self.cwd / "AGENTS.override.md"), "sha256": "a54aa015b1e53a7c90a2f3c7f7c6c991c3a12f1214196729cc79c7c78e83275a", "bytes": 9,
        })


if __name__ == "__main__":
    unittest.main()
