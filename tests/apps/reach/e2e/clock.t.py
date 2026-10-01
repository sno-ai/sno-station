#!/usr/bin/env python3
"""The authorized clock is bounded, immutable on reuse, and keeps history."""
import json
from pathlib import Path
import tempfile
import time
import live_support as live

with tempfile.TemporaryDirectory(prefix="reach-clock-test-") as directory:
    live.CLOCK = Path(directory) / "fourth.json"
    live.PREVIOUS_CLOCK = Path(directory) / "third.json"
    historical = b'{"historical":true}\n'
    live.PREVIOUS_CLOCK.write_bytes(historical)
    assert not live.CLOCK.exists()
    first = live.start_clock(["sno", "reach", "spawn", "codex"])
    assert first["deadline_epoch"] - first["started_epoch"] == live.WINDOW
    assert first["ruling"] == live.RULING
    original = live.CLOCK.read_bytes()
    assert live.start_clock(["different", "command"]) == first
    assert live.CLOCK.read_bytes() == original and live.PREVIOUS_CLOCK.read_bytes() == historical
    first["started_epoch"] = time.time() - live.WINDOW - 1
    first["deadline_epoch"] = first["started_epoch"] + live.WINDOW
    live.CLOCK.write_text(json.dumps(first))
    expired = live.CLOCK.read_bytes()
    try:
        live.start_clock(["must", "not", "reset"])
    except RuntimeError as error:
        assert "ceiling reached" in str(error)
    else:
        raise AssertionError("expired window restarted")
    assert live.CLOCK.read_bytes() == expired and live.PREVIOUS_CLOCK.read_bytes() == historical
print("PASS: the window is bounded; retries do not reset it; old clock unchanged")
