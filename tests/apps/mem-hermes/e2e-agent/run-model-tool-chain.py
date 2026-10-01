from __future__ import annotations

import getpass
import json
import os
import uuid
from pathlib import Path

from support import build_agent, post

workspace = (Path(os.environ["MEM_HERMES_WORKSPACE"]) / f"model-tools-{uuid.uuid4().hex[:10]}").resolve()
workspace.mkdir(parents=True)
original = f"ORIGINAL_{uuid.uuid4().hex[:10]}"
corrected = f"CORRECTED_{uuid.uuid4().hex[:10]}"
old_text = f"The project ribbon label is {original}."
new_text = f"The project ribbon label is {corrected}."
session = f"model-tools-{uuid.uuid4().hex[:10]}"
agent = build_agent(workspace, session)
automatic_agent = None


def inspect(op: dict[str, object]) -> dict[str, object]:
    response = post("inspect", {"scope": {"principal": getpass.getuser(), "project": str(workspace),
        "session": session, "host": {"sessionId": session, "workspace": str(workspace)}}, "op": op})
    assert response.get("degraded") is False, response
    return response["result"]


try:
    before = inspect({"op": "stats"})["total"]
    prompt = f"""Use Sno memory tools only, one call at a time, waiting for every result.
1. sno_memory_remember content: {old_text}
2. sno_memory_get the returned old id.
3. sno_memory_correct that old id with content: {new_text}
4. sno_memory_get the returned new id.
5. sno_memory_get the original old id again.
6. sno_memory_recall with query: project ribbon label.
7. Retry sno_memory_correct on the ORIGINAL old id with the SAME corrected content: {new_text}
8. Retry sno_memory_correct on the ORIGINAL old id with DIFFERENT content: The project ribbon label is DIFFERENT_{original}.
The two retries should return already-superseded; do not correct the successor id.
Do all eight calls, then reply DONE."""
    result = agent.run_conversation(prompt)
    assert result.get("completed"), result
    messages = result["messages"]
    # Native memory-provider output is canonical text, not a serialized result object.
    outputs = {message["tool_call_id"]: message["content"] for message in messages
        if message.get("role") == "tool"}
    runs = []
    for message in messages:
        for call in message.get("tool_calls", []):
            function = call["function"]
            runs.append({"name": function["name"], "args": json.loads(function["arguments"]),
                "result": outputs[call["id"]]})
    assert [run["name"] for run in runs] == ["sno_memory_remember", "sno_memory_get",
        "sno_memory_correct", "sno_memory_get", "sno_memory_get", "sno_memory_recall",
        "sno_memory_correct", "sno_memory_correct"], runs
    old_id = runs[0]["result"]
    new_id = runs[2]["result"]
    assert str(uuid.UUID(old_id)) == old_id, runs
    assert str(uuid.UUID(new_id)) == new_id and new_id != old_id, runs
    marker = f"retired; superseded by {new_id}"
    assert runs[1]["args"] == {"id": old_id} and runs[1]["result"] == f"{old_id}\n{old_text}", runs
    assert runs[2]["args"] == {"id": old_id, "content": new_text}, runs
    assert runs[3]["args"] == {"id": new_id} and runs[3]["result"] == f"{new_id}\n{new_text}", runs
    assert runs[4]["args"] == {"id": old_id} and runs[4]["result"] == f"{old_id}\n{old_text}\n{marker}", runs
    manual = runs[5]["result"]
    assert f"{old_id}\t" in manual and f"{new_id}\t" in manual, runs
    assert original in manual and corrected in manual and marker in manual, runs
    for retry in runs[6:]:
        assert retry["args"]["id"] == old_id, runs
        assert retry["result"] == f"already-superseded: superseded by {new_id}; correct that id", runs
    assert runs[6]["args"]["content"] == new_text, runs
    assert runs[7]["args"]["content"] != new_text, runs
    assert json.loads(inspect({"op": "get", "id": old_id})["entry"]["metadata"])["superseded_by"] == new_id
    assert inspect({"op": "get", "id": new_id})["entry"]["text"] == new_text
    assert inspect({"op": "stats"})["total"] == before + 2
    assert agent._memory_manager.flush_pending(timeout=60), "native background memory work did not drain"

    auto_session = f"model-tools-auto-{uuid.uuid4().hex[:10]}"
    automatic_agent = build_agent(workspace, auto_session, max_iterations=1)
    manager = automatic_agent._memory_manager
    assert manager is not None and manager.get_provider("sno-mem-hermes") is not None
    automatic = manager.prefetch_all("What is the current project ribbon label?", session_id=auto_session)
    assert corrected in automatic and f"[id:{new_id}]" in automatic, automatic
    assert original not in automatic and old_id not in automatic, automatic
    assert automatic.count(f"[id:{new_id}]") == 1, automatic
    repeated = manager.prefetch_all("What is the current project ribbon label?", session_id=auto_session)
    assert f"[id:{new_id}]" not in repeated and old_id not in repeated, repeated
    assert inspect({"op": "stats"})["total"] == before + 2
    print(json.dumps({"status": "PASS", "tool_calls": len(runs), "workspace": str(workspace),
        "old_id": old_id, "new_id": new_id, "durable_row_delta": 2, "retry_row_delta": 0,
        "manual_history_marker": True, "automatic_current_only": True,
        "repeated_auto_omits_same_id": True, "model_endpoint": "http://localhost:8070/codex/v1",
        "requested_model": "gpt-5.6-terra"}, sort_keys=True))
finally:
    if automatic_agent is not None:
        automatic_agent.close()
    agent.close()
