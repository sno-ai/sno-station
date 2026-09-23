from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

from support import build_agent, tool_results

workspace = (
    Path(os.environ["MEM_HERMES_WORKSPACE"]) / f"model-tools-{uuid.uuid4().hex[:10]}"
)
workspace.mkdir(parents=True)
original = f"ORIGINAL_{uuid.uuid4().hex[:10]}"
corrected = f"CORRECTED_{uuid.uuid4().hex[:10]}"
agent = build_agent(workspace, f"model-tools-{uuid.uuid4().hex[:10]}")
prompt = f"""Use Sno memory tools only, one call at a time, waiting for every result.
1. remember: The project ribbon label is {original}.
2. get the returned old id.
3. correct that old id to: The project ribbon label is {corrected}.
4. get the returned new id.
5. get the original old id again.
6. recall with query: project ribbon label.
Do all six calls, then reply DONE."""
result = agent.run_conversation(prompt)
assert result.get("completed"), result
runs = tool_results(result)
assert [run["name"] for run in runs] == [
    "sno_memory_remember",
    "sno_memory_get",
    "sno_memory_correct",
    "sno_memory_get",
    "sno_memory_get",
    "sno_memory_recall",
], runs
old_id = runs[0]["result"]["result"]["details"]["id"]
assert runs[1]["args"] == {"id": old_id}
assert original in json.dumps(runs[1]["result"])
new_id = runs[2]["result"]["newId"]
assert new_id != old_id
assert runs[3]["args"] == {"id": new_id}
assert corrected in json.dumps(runs[3]["result"])
assert runs[4]["args"] == {"id": old_id}
old_metadata = runs[4]["result"]["result"]["entry"]["metadata"]
if isinstance(old_metadata, str):
    old_metadata = json.loads(old_metadata)
assert old_metadata["supersededBy"] == new_id
recall = json.dumps(runs[5]["result"])
assert corrected in recall and original not in recall, recall
print(
    json.dumps(
        {
            "status": "PASS",
            "tool_calls": len(runs),
            "old_id": old_id,
            "new_id": new_id,
            "corrected": corrected,
        },
        sort_keys=True,
    )
)
