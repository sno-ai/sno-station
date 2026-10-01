from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path

from support import build_agent, tool_results

workspace = Path(os.environ["MEM_HERMES_WORKSPACE"]) / f"detail-{uuid.uuid4().hex[:10]}"
workspace.mkdir(parents=True)
agent = build_agent(workspace, f"detail-{uuid.uuid4().hex[:10]}")
manager = agent._memory_manager
assert manager is not None
provider = manager.get_provider("sno-mem-hermes")
tail = f"FULL_DETAIL_{uuid.uuid4().hex[:10]}"
content = (
    "Task objective: inspect the long deployment record. "
    + ("bounded overview filler " * 18)
    + tail
)
stored = json.loads(
    provider.handle_tool_call("sno_memory_remember", {"content": content})
)
stored_id = stored["result"]["details"]["id"]
greeting = agent.run_conversation("hi")
overview = greeting["messages"][0]["api_content"]
visible = re.findall(r"\[id:([^\]]+)\]", overview)
assert stored_id in visible, overview
assert tail not in overview, overview
result = agent.run_conversation(
    f"Call sno_memory_get exactly once with id {stored_id}. Then reply DONE."
)
assert result.get("completed"), result
runs = tool_results(result)
assert [run["name"] for run in runs] == ["sno_memory_get"], runs
assert runs[0]["args"] == {"id": stored_id}
assert tail in json.dumps(runs[0]["result"]), runs[0]
print(
    json.dumps(
        {
            "status": "PASS",
            "overview_id": stored_id,
            "overview_omitted_tail": True,
            "get_returned_full_tail": True,
        },
        sort_keys=True,
    )
)
