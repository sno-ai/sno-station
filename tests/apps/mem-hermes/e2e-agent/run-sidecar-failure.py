from __future__ import annotations

import json
import os
import subprocess
import uuid
from pathlib import Path

from agent.conversation_compression import (
    CompressionCheckpointUnavailable,
    _pre_compress_memory_context,
)
from run_agent import AIAgent

workspace = Path("/tmp") / f"mem-hermes-sidecar-down-{uuid.uuid4().hex[:10]}"
workspace.mkdir()
agent = AIAgent(
    model="gpt-5.6-terra",
    provider="custom",
    base_url="http://localhost:8070/codex/v1",
    api_key="isolated-e2e",
    api_mode="codex_responses",
    enabled_toolsets=[],
    max_iterations=1,
    max_tokens=64,
    quiet_mode=True,
    skip_context_files=True,
    skip_background_review=True,
    session_id=f"mem-hermes-sidecar-down-{uuid.uuid4().hex[:10]}",
    platform="cli",
    cwd=str(workspace),
)
# The plugin starts the sidecar itself on connect, so the failure is injected only after the
# provider is live: the turn below then cannot commit, and the required checkpoint must block.
profile = Path(os.environ["SNO_PROFILE_DIR"])
sidecar_pid = json.loads((profile / "station" / "sidecar.json").read_text())["pid"]
sidecar_unit = Path(f"/proc/{sidecar_pid}/cgroup").read_text().strip().rsplit("/", 1)[-1]
assert sidecar_unit.startswith("sno-station-mem-") and sidecar_unit.endswith(".service"), sidecar_unit
subprocess.run(["systemctl", "--user", "stop", sidecar_unit], check=True)
try:
    result = agent.run_conversation("Reply exactly READY.")
    assert result.get("completed"), result
    assert "READY" in str(result.get("final_response")), result
    assert agent._memory_manager is not None
    assert agent._memory_manager.supports_pre_compress_checkpoint(2)

    try:
        _pre_compress_memory_context(agent, result["messages"], True)
    except CompressionCheckpointUnavailable as error:
        checkpoint_error = str(error)
    else:
        raise AssertionError("required checkpoint did not block")
finally:
    subprocess.run(["systemctl", "--user", "start", sidecar_unit], check=True)

print(
    json.dumps(
        {
            "status": "PASS",
            "main_reply_completed": True,
            "memory_manager_active": True,
            "checkpoint_provider_active": True,
            "checkpoint_blocked": True,
            "checkpoint_error": checkpoint_error,
        },
        sort_keys=True,
    )
)
