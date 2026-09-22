from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

from run_agent import AIAgent

workspace = (
    Path(os.environ["MEM_HERMES_WORKSPACE"]) / f"tools-{uuid.uuid4().hex[:12]}"
).resolve()
workspace.mkdir(parents=True)
agent = AIAgent(
    model="gpt-5.6-terra",
    provider="custom",
    base_url="http://localhost:8070/codex/v1",
    api_key="isolated-e2e",
    api_mode="codex_responses",
    enabled_toolsets=[],
    max_iterations=1,
    max_tokens=128,
    quiet_mode=True,
    skip_context_files=True,
    skip_background_review=True,
    session_id=f"mem-hermes-tools-{uuid.uuid4().hex[:10]}",
    platform="cli",
    cwd=str(workspace),
)
manager = agent._memory_manager
assert manager is not None
provider = manager.get_provider("sno-mem-hermes")
assert provider is not None

remembered = json.loads(
    provider.handle_tool_call(
        "sno_memory_remember",
        {"content": "The Atlas launch review is scheduled for October 14, 2026."},
    )
)
old_id = remembered["result"]["details"]["id"]

recalled = json.loads(
    provider.handle_tool_call(
        "sno_memory_recall", {"query": "Atlas launch review schedule"}
    )
)
assert old_id in json.dumps(recalled), recalled

inspected = json.loads(provider.handle_tool_call("sno_memory_get", {"id": old_id}))
assert inspected["result"]["entry"]["id"] == old_id, inspected

corrected = json.loads(
    provider.handle_tool_call(
        "sno_memory_correct",
        {
            "id": old_id,
            "content": "The Atlas launch review is scheduled for October 21, 2026.",
        },
    )
)
new_id = corrected["newId"]
assert new_id != old_id, corrected
new = json.loads(provider.handle_tool_call("sno_memory_get", {"id": new_id}))
assert "October 21, 2026" in new["result"]["entry"]["text"], new

old = json.loads(provider.handle_tool_call("sno_memory_get", {"id": old_id}))
old_metadata = old["result"]["entry"]["metadata"]
if isinstance(old_metadata, str):
    old_metadata = json.loads(old_metadata)
assert old_metadata["supersededBy"] == new_id, old

automatic = provider.prefetch(
    "When is the Atlas launch review?", session_id=agent.session_id
)
assert new_id in automatic, automatic
assert old_id not in automatic, automatic

print(
    json.dumps(
        {
            "status": "PASS",
            "workspace": str(workspace),
            "old_id": old_id,
            "new_id": new_id,
            "remember": True,
            "recall": True,
            "get": True,
            "correct": True,
            "corrected_content_verified": True,
            "automatic_excludes_superseded": True,
        },
        sort_keys=True,
    )
)
