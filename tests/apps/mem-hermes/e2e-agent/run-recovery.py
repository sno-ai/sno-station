from __future__ import annotations

import getpass
import json
import os
import urllib.request
import uuid
from pathlib import Path

from run_agent import AIAgent

profile = Path(os.environ["SNO_PROFILE_DIR"]).resolve()
workspace_root = Path(os.environ["MEM_HERMES_WORKSPACE"]).resolve()
discovery = json.loads((profile / "station" / "sidecar.json").read_text())


def build_agent(cwd: Path, session_id: str) -> AIAgent:
    return AIAgent(
        model="gpt-5.6-terra",
        provider="custom",
        base_url="http://localhost:8070/codex/v1",
        api_key="isolated-e2e",
        api_mode="codex_responses",
        enabled_toolsets=[],
        max_iterations=1,
        max_tokens=96,
        quiet_mode=True,
        skip_context_files=True,
        skip_background_review=True,
        session_id=session_id,
        platform="cli",
        cwd=str(cwd),
    )


def inspect_count(project: Path, session_id: str) -> int:
    body = {
        "scope": {
            "principal": getpass.getuser(),
            "project": str(project),
            "session": session_id,
            "host": {"sessionId": session_id},
        },
        "op": {"op": "list"},
    }
    request = urllib.request.Request(
        f"http://127.0.0.1:{discovery['port']}/v1/inspect",
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "x-sno-station-mem-skin": "hermes",
            "x-sidecar-token": discovery["token"],
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.load(response)
    assert result.get("degraded") is False, result
    inspected = result.get("result")
    assert isinstance(inspected, dict) and inspected.get("op") == "list", result
    entries = inspected.get("entries")
    assert isinstance(entries, list), result
    return len(entries)


workspace = workspace_root / f"recovery-{uuid.uuid4().hex[:12]}"
workspace.mkdir(parents=True)
session_id = f"recovery-{uuid.uuid4().hex[:10]}"
marker = f"recovery-{uuid.uuid4().hex[:10]}"
agent = build_agent(workspace, session_id)
result = agent.run_conversation(
    f"Remember that project recovery marker {marker} is ready. Reply exactly READY."
)
assert result.get("completed"), result
manager = agent._memory_manager
assert manager is not None
assert manager.flush_pending(timeout=60), "capture did not drain"
messages = [
    {"role": "user", "content": f"Project recovery marker {marker} is ready."},
    {"role": "assistant", "content": "READY"},
]
manager.on_pre_compress(
    messages,
    evidence_messages=messages,
    require_checkpoint=True,
    checkpoint_api_version=2,
)
provider = manager.get_provider("sno-mem-hermes")
recalled = provider.prefetch(f"project recovery marker {marker}", session_id=session_id)
status = provider.recall_status()
assert marker in recalled, recalled
assert status is not None and status.count > 0, status

empty_workspace = workspace_root / f"empty-{uuid.uuid4().hex[:12]}"
empty_workspace.mkdir()
empty_agent = build_agent(empty_workspace, f"empty-{uuid.uuid4().hex[:10]}")
empty_manager = empty_agent._memory_manager
assert empty_manager is not None
empty_provider = empty_manager.get_provider("sno-mem-hermes")
assert empty_provider.prefetch("no matching project memory") == ""
assert empty_provider.recall_status() is None
assert empty_provider.unavailable_reason() == "recall empty"

interrupted_workspace = workspace_root / f"interrupted-{uuid.uuid4().hex[:12]}"
interrupted_workspace.mkdir()
interrupted_session = f"interrupted-{uuid.uuid4().hex[:10]}"
interrupted = build_agent(interrupted_workspace, interrupted_session)
before = inspect_count(interrupted_workspace, interrupted_session)
interrupted._sync_external_memory_for_turn(
    original_user_message="Store this interrupted turn.",
    final_response="Partial response.",
    interrupted=True,
    messages=[
        {"role": "user", "content": "Store this interrupted turn."},
        {"role": "assistant", "content": "Partial response."},
    ],
)
assert interrupted._memory_manager is not None
assert interrupted._memory_manager.flush_pending(timeout=10)
after = inspect_count(interrupted_workspace, interrupted_session)
assert before == after == 0, (before, after)

print(
    json.dumps(
        {
            "status": "PASS",
            "workspace": str(workspace),
            "marker": marker,
            "main_reply_completed": True,
            "capture_committed": True,
            "checkpoint_succeeded": True,
            "recall_status_count": status.count,
            "empty_recall_status": "recall empty",
            "interrupted_rows_before": before,
            "interrupted_rows_after": after,
        },
        sort_keys=True,
    )
)
