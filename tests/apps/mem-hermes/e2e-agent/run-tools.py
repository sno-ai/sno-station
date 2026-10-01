from __future__ import annotations

import getpass
import json
import os
import uuid
from pathlib import Path

from run_agent import AIAgent
from support import post

workspace = (Path(os.environ["MEM_HERMES_WORKSPACE"]) / f"tools-{uuid.uuid4().hex[:12]}").resolve()
workspace.mkdir(parents=True)
session = f"mem-hermes-tools-{uuid.uuid4().hex[:10]}"
agent = AIAgent(
    model="gpt-5.6-terra", provider="custom", base_url="http://localhost:8070/codex/v1",
    api_key="isolated-e2e", api_mode="codex_responses", enabled_toolsets=[],
    max_iterations=1, max_tokens=128, quiet_mode=True, skip_context_files=True,
    skip_background_review=True, session_id=session, platform="cli", cwd=str(workspace),
)


def inspect(op: dict[str, object]) -> dict[str, object]:
    response = post("inspect", {"scope": {"principal": getpass.getuser(), "project": str(workspace),
        "session": session, "host": {"sessionId": session, "workspace": str(workspace)}}, "op": op})
    assert response.get("degraded") is False, response
    return response["result"]


try:
    manager = agent._memory_manager
    assert manager is not None
    assert manager.get_provider("sno-mem-hermes") is not None
    old_text = "The Atlas launch review is scheduled for October 14, 2026."
    new_text = "The Atlas launch review is scheduled for October 21, 2026."
    before = inspect({"op": "stats"})["total"]
    old_id = manager.handle_tool_call("sno_memory_remember", {"content": old_text})
    assert str(uuid.UUID(old_id)) == old_id, old_id
    assert manager.handle_tool_call("sno_memory_get", {"id": old_id}) == f"{old_id}\n{old_text}"
    recalled = manager.handle_tool_call("sno_memory_recall", {"query": "Atlas launch review schedule"})
    assert f"{old_id}\t" in recalled and old_text in recalled, recalled

    new_id = manager.handle_tool_call("sno_memory_correct", {"id": old_id, "content": new_text})
    assert str(uuid.UUID(new_id)) == new_id and new_id != old_id, new_id
    marker = f"retired; superseded by {new_id}"
    assert manager.handle_tool_call("sno_memory_get", {"id": new_id}) == f"{new_id}\n{new_text}"
    assert manager.handle_tool_call("sno_memory_get", {"id": old_id}) == f"{old_id}\n{old_text}\n{marker}"
    persisted_old = inspect({"op": "get", "id": old_id})["entry"]
    assert json.loads(persisted_old["metadata"])["superseded_by"] == new_id, persisted_old
    assert inspect({"op": "get", "id": new_id})["entry"]["text"] == new_text
    assert inspect({"op": "stats"})["total"] == before + 2

    for retry_text in (new_text, "The Atlas launch review is scheduled for October 28, 2026."):
        retry = manager.handle_tool_call("sno_memory_correct", {"id": old_id, "content": retry_text})
        assert retry == f"already-superseded: superseded by {new_id}; correct that id", retry
        assert inspect({"op": "stats"})["total"] == before + 2
    manual = manager.handle_tool_call("sno_memory_recall", {"query": "Atlas launch review schedule"})
    assert f"{old_id}\t" in manual and f"{new_id}\t" in manual, manual
    assert old_text in manual and new_text in manual and marker in manual, manual

    automatic = manager.prefetch_all("When is the Atlas launch review scheduled?", session_id=session)
    assert f"[id:{new_id}]" in automatic and new_text in automatic, automatic
    assert old_id not in automatic and old_text not in automatic, automatic
    assert automatic.count(f"[id:{new_id}]") == 1, automatic
    repeated = manager.prefetch_all("When is the Atlas launch review scheduled?", session_id=session)
    assert f"[id:{new_id}]" not in repeated and old_id not in repeated, repeated
    assert inspect({"op": "stats"})["total"] == before + 2
    print(json.dumps({"status": "PASS", "workspace": str(workspace), "session": session,
        "old_id": old_id, "new_id": new_id, "durable_row_delta": 2, "retry_row_delta": 0,
        "manual_history_marker": True, "automatic_current_only": True,
        "repeated_auto_omits_same_id": True, "native_sdk_manager": True}, sort_keys=True))
finally:
    agent.close()
