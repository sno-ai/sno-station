from __future__ import annotations

import getpass
import json
import os
import uuid
from pathlib import Path

from support import build_agent, post, tool_results

root = Path(os.environ["MEM_HERMES_WORKSPACE"])
project_a = root / f"global-a-{uuid.uuid4().hex[:10]}"
project_b = root / f"global-b-{uuid.uuid4().hex[:10]}"
project_a.mkdir(parents=True)
project_b.mkdir(parents=True)
agent_a = build_agent(project_a, f"global-a-{uuid.uuid4().hex[:10]}")
agent_b = build_agent(project_b, f"global-b-{uuid.uuid4().hex[:10]}")
marker = f"GLOBAL_{uuid.uuid4().hex[:10]}"
stored = post(
    "mutate",
    {
        "scope": {
            "principal": getpass.getuser(),
            "project": "global",
            "session": "global-fixture",
            "host": {"sessionId": "global-fixture"},
        },
        "op": {
            "op": "store",
            "content": f"The shared diagnostic label is {marker}.",
            "category": "episodic",
        },
    },
)
global_id = stored["result"]["details"]["id"]


def recall(agent):
    result = agent.run_conversation(
        "Call sno_memory_recall exactly once with query 'shared diagnostic label'. Then reply DONE."
    )
    assert result.get("completed"), result
    clean = result["messages"][0]
    assert marker not in clean.get("api_content", clean["content"]), clean
    runs = tool_results(result)
    assert [run["name"] for run in runs] == ["sno_memory_recall"], runs
    output = json.dumps(runs[0]["result"])
    assert global_id in output and marker in output, output
    return runs[0]["id"]


calls = [recall(agent_a), recall(agent_b)]
print(
    json.dumps(
        {
            "status": "PASS",
            "global_id": global_id,
            "automatic_excluded_in_projects": 2,
            "explicit_model_recalls": len(calls),
        },
        sort_keys=True,
    )
)
