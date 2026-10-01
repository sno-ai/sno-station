from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

from run_agent import AIAgent

words = ("maple", "otter", "river", "cedar", "meadow", "falcon", "willow", "harbor")
seed = uuid.uuid4().int
marker = " ".join(words[(seed >> shift) % len(words)] for shift in (0, 4, 8))
workspace = (
    Path(os.environ["MEM_HERMES_WORKSPACE"]) / f"checkpoint-{uuid.uuid4().hex[:12]}"
).resolve()
workspace.mkdir(parents=True)
session_id = f"mem-hermes-checkpoint-{uuid.uuid4().hex[:10]}"
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
    session_id=session_id,
    platform="cli",
    cwd=str(workspace),
)
manager = agent._memory_manager
assert manager is not None
user = (
    f"Objective: ship {marker}. Completed: schema review. "
    "Blocker: staging credentials. Next action: run import validation. "
    "Evidence file: reports/import-proof.json."
)
assistant = (
    "I recorded the objective, completed work, blocker, next action, and evidence file."
)
messages = [
    {"role": "user", "content": user},
    {"role": "assistant", "content": assistant},
]
manager.sync_all(user, assistant, session_id=session_id, messages=messages)
summary = manager.on_pre_compress(
    messages,
    evidence_messages=messages,
    require_checkpoint=True,
    checkpoint_api_version=2,
)
assert manager.flush_pending(timeout=60), "background capture did not drain"
assert marker in summary, summary
assert "schema review" in summary.lower(), summary
assert "staging credentials" in summary.lower(), summary
assert "import validation" in summary.lower(), summary
assert "reports/import-proof.json" in summary, summary

print(
    json.dumps(
        {
            "status": "PASS",
            "workspace": str(workspace),
            "session": session_id,
            "marker": marker,
            "checkpoint_api_version": 2,
            "required_checkpoint": True,
            "summary_contains_all_task_fields": True,
        },
        sort_keys=True,
    )
)
