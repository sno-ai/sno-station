from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

from support import build_agent, inspect_entries

workspace = (
    Path(os.environ["MEM_HERMES_WORKSPACE"]) / f"subagent-{uuid.uuid4().hex[:10]}"
)
workspace.mkdir(parents=True)
sub_marker = f"SUBAGENT_{uuid.uuid4().hex[:10]}"
sub = build_agent(
    workspace,
    f"subagent-{uuid.uuid4().hex[:10]}",
    platform="subagent",
    max_iterations=1,
)
before = inspect_entries(workspace, sub.session_id)
result = sub.run_conversation(
    f"The private subagent label is {sub_marker}. Reply ACK only."
)
assert result.get("completed"), result
assert sub._memory_manager is not None and sub._memory_manager.flush_pending(timeout=30)
after_sub = inspect_entries(workspace, sub.session_id)
assert len(after_sub) == len(before), (before, after_sub)
primary_marker = f"PRIMARY_{uuid.uuid4().hex[:10]}"
primary = build_agent(workspace, f"primary-{uuid.uuid4().hex[:10]}", max_iterations=1)
primary_result = primary.run_conversation(
    f"The primary label is {primary_marker}. Reply ACK only."
)
assert primary_result.get("completed"), primary_result
assert primary._memory_manager is not None and primary._memory_manager.flush_pending(
    timeout=60
)
after_primary = inspect_entries(workspace, primary.session_id)
assert len(after_primary) > len(after_sub), (after_sub, after_primary)
assert primary_marker in json.dumps(after_primary), after_primary
assert sub_marker not in json.dumps(after_primary), after_primary
print(
    json.dumps(
        {
            "status": "PASS",
            "subagent_row_delta": 0,
            "primary_row_delta": len(after_primary) - len(after_sub),
        },
        sort_keys=True,
    )
)
