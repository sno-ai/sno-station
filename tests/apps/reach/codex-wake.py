#!/usr/bin/env python3
"""Exercise the actual Reach wake executable against an external proxy fixture."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile

binary = str(Path(sys.argv[1]).resolve())
fixture = Path(__file__).with_name("codex-proxy-fixture.cjs").resolve()
thread = "11111111-2222-4333-8444-555555555555"
for case, state in [("idle", "started"), ("busy", "queued"), ("empty", "empty"),
                    ("error", None), ("start-error", None)]:
    with tempfile.TemporaryDirectory(prefix="reach-wake-") as directory:
        root = Path(directory)
        codex = root / "codex"
        codex.write_text(f"#!/bin/sh\nexec node {shlex.quote(str(fixture))} \"$@\"\n")
        codex.chmod(0o755)
        log = root / "requests.jsonl"
        home = str(root / "home with spaces")
        result = subprocess.run([binary, "--codex", str(codex), "--thread", thread],
                                env=dict(os.environ, WAKE_CASE=case, WAKE_LOG=str(log), CODEX_HOME=home),
                                capture_output=True, text=True, timeout=15)
        records = [json.loads(line) for line in log.read_text().splitlines()]
        assert records[0] == {"argv": ["app-server", "proxy"], "home": home}, records
        methods = [record["method"] for record in records[1:]]
        expected = ["initialize", "initialized", "thread/read"]
        if case not in ("busy", "error"):
            expected.append("thread/queue/list")
        if case in ("idle", "start-error"):
            expected.append("thread/queue/start")
        assert methods == expected, (case, methods)
        for record in records[1:]:
            if record["method"].startswith("thread/"):
                assert record["params"]["threadId"] == thread, record
            if record["method"] == "thread/queue/start":
                assert record["params"]["queuedSubmissionId"] == "queued-message-7q", record
        if state is None:
            assert result.returncode != 0, result
            assert "fixture operation refused" in result.stderr, result.stderr
        else:
            assert result.returncode == 0, (case, result.stderr)
            assert json.loads(result.stdout)["state"] == state, result.stdout
        print(f"PASS native wake {case}: expected requests, thread, home and outcome", flush=True)
