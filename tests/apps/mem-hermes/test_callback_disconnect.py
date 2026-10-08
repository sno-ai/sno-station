"""The memory service asks Hermes for a model answer through the plugin's local callback server. When the service
has already hung up by the time the answer is ready, the plugin must stay quiet: before the fix the failed write
escaped the request handler and Python printed a traceback into the chat window every time.

Needs the Hermes modules on the path, so run it with the Hermes interpreter:
  PYTHONPATH=<hermes-agent dir> <hermes python> tests/apps/mem-hermes/test_callback_disconnect.py
A real plugin runtime, a real HTTP client and a real closed socket; only the model answer is a stand-in."""

from __future__ import annotations

import importlib.util
import io
import json
import os
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from types import SimpleNamespace

PLUGIN = Path(__file__).resolve().parents[3] / "apps" / "mem-hermes" / "sno-mem-hermes" / "__init__.py"


class SlowLlm:
    def __init__(self, delay: float) -> None:
        self.delay = delay
        self.finished = threading.Event()

    def complete(self, **kwargs: object) -> object:
        time.sleep(self.delay)
        self.finished.set()
        return SimpleNamespace(text="the answer")


class CallbackDisconnectTest(unittest.TestCase):
    def setUp(self) -> None:
        self.home = tempfile.TemporaryDirectory()
        os.environ["HERMES_HOME"] = self.home.name
        spec = importlib.util.spec_from_file_location("sno_mem_hermes_under_test", PLUGIN)
        assert spec is not None and spec.loader is not None
        self.module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = self.module
        spec.loader.exec_module(self.module)
        self.runtime = self.module.PluginRuntime()

    def tearDown(self) -> None:
        self.runtime.close()
        self.home.cleanup()
        sys.modules.pop("sno_mem_hermes_under_test", None)

    def post_then_hang_up(self, llm: SlowLlm) -> None:
        context = SimpleNamespace(llm=llm, on_unload=lambda callback: None)
        self.runtime.activate(context)
        port = self.runtime._server.server_port
        body = json.dumps({"messages": [{"role": "user", "content": "hello"}]}).encode()
        request = (
            f"POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n"
            f"Authorization: Bearer {self.runtime._credential}\r\nContent-Length: {len(body)}\r\n\r\n"
        ).encode() + body
        client = socket.create_connection(("127.0.0.1", port))
        client.sendall(request)
        time.sleep(0.2)
        # Linger 0 makes close() send a reset at once: the server's next write fails the way a hung-up service does.
        client.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        client.close()

    def test_a_hung_up_service_leaves_nothing_on_stderr(self) -> None:
        llm = SlowLlm(delay=0.8)
        captured = io.StringIO()
        with redirect_stderr(captured):
            self.post_then_hang_up(llm)
            self.assertTrue(llm.finished.wait(10), "the stand-in model answer never finished")
            time.sleep(0.5)
        self.assertEqual("", captured.getvalue(), "the plugin printed an error for a client that had hung up")


if __name__ == "__main__":
    unittest.main()
