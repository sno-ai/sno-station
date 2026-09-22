from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

from support import build_agent

workspace = (
    Path(os.environ["MEM_HERMES_WORKSPACE"]) / f"negative-{uuid.uuid4().hex[:10]}"
)
workspace.mkdir(parents=True)
agent = build_agent(workspace, f"negative-{uuid.uuid4().hex[:10]}", max_iterations=1)
assert agent.run_conversation("hi").get("completed")
manager = agent._memory_manager
assert manager is not None
provider = manager.get_provider("sno-mem-hermes")
irrelevant = f"ORCHID_{uuid.uuid4().hex[:10]}"
provider.handle_tool_call(
    "sno_memory_remember", {"content": f"The orchid catalog label is {irrelevant}."}
)
unrelated = agent.run_conversation("Explain how to sort a Python list in one sentence.")
assert unrelated.get("completed"), unrelated
unrelated_context = unrelated["messages"][0].get("api_content", "")
assert "<memory-context>" not in unrelated_context, unrelated_context
relevant = agent.run_conversation("What is the orchid catalog label?")
assert relevant.get("completed"), relevant
context = relevant["messages"][0]["api_content"]
assert irrelevant in context, context
ids = [part.split("]", 1)[0] for part in context.split("[id:")[1:]]
assert len(ids) == 1, ids
trivial = agent.run_conversation("hi")
assert trivial.get("completed"), trivial
trivial_context = trivial["messages"][0].get("api_content", "")
assert "<memory-context>" not in trivial_context, trivial_context
print(
    json.dumps(
        {
            "status": "PASS",
            "irrelevant_zero_injection": True,
            "relevant_injection": True,
            "later_trivial_zero_injection": True,
        },
        sort_keys=True,
    )
)
