from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

from run_agent import AIAgent

words = ("maple", "otter", "river", "cedar", "meadow", "falcon", "willow", "harbor")
seed = uuid.uuid4().int
phrase = "Atlas harbor review " + " ".join(
    words[(seed >> shift) % len(words)] for shift in (0, 4, 8)
)
workspace = (
    Path(os.environ["MEM_HERMES_WORKSPACE"]) / f"rem-host-{uuid.uuid4().hex[:12]}"
).resolve()
workspace.mkdir(parents=True)
agent = AIAgent(
    model="gpt-5.6-terra",
    provider="custom",
    base_url="http://localhost:8070/codex/v1",
    api_key="isolated-e2e",
    api_mode="codex_responses",
    enabled_toolsets=["memory"],
    max_iterations=3,
    max_tokens=256,
    quiet_mode=True,
    skip_context_files=True,
    skip_background_review=True,
    session_id=f"mem-hermes-rem-host-{uuid.uuid4().hex[:10]}",
    platform="cli",
    cwd=str(workspace),
)
result = agent.run_conversation(
    f"Call sno_memory_remember exactly once to store: {phrase} is scheduled for October 14, 2026. Then reply STORED."
)
assert result.get("completed"), result
tool_calls = [
    call for message in result["messages"] for call in message.get("tool_calls", [])
]
remember_calls = [
    call for call in tool_calls if call["function"]["name"] == "sno_memory_remember"
]
assert len(remember_calls) == 1, result
tool_messages = [
    message
    for message in result["messages"]
    if message.get("role") == "tool"
    and message.get("tool_call_id") == remember_calls[0]["id"]
]
assert len(tool_messages) == 1, result
tool_result = json.loads(tool_messages[0]["content"])
stored_id = tool_result["result"]["details"]["id"]

manager = agent._memory_manager
assert manager is not None
provider = manager.get_provider("sno-mem-hermes")
stored = json.loads(provider.handle_tool_call("sno_memory_get", {"id": stored_id}))
assert phrase in stored["result"]["entry"]["text"], stored
recalled = json.loads(provider.handle_tool_call("sno_memory_recall", {"query": phrase}))
assert phrase in json.dumps(recalled), recalled

print(
    json.dumps(
        {
            "status": "PASS",
            "workspace": str(workspace),
            "phrase": phrase,
            "tool_call": "sno_memory_remember",
            "tool_result_id": stored_id,
            "tool_result_readback": True,
            "readback": True,
        },
        sort_keys=True,
    )
)
