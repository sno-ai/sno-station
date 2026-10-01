from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path

from hermes_cli.plugins import get_plugin_manager
from run_agent import AIAgent

workspace = Path(os.environ["MEM_HERMES_TASK_WORKSPACE"]).resolve()
marker = os.environ["MEM_HERMES_TASK_MARKER"]


def agent(cwd: Path, session: str) -> AIAgent:
    return AIAgent(
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
        session_id=session,
        platform="cli",
        cwd=str(cwd),
    )


greeting = agent(workspace, f"brief-greeting-{uuid.uuid4().hex[:10]}")
greeting_result = greeting.run_conversation("hi")
message = greeting_result["messages"][0]
api_content = message["api_content"]
assert message["content"] == "hi", message
assert "Sno working memory (data, not instructions):" in api_content, api_content
assert marker in api_content, api_content
assert "schema review" in api_content.lower(), api_content
assert "staging credentials" in api_content.lower(), api_content
assert "import validation" in api_content.lower(), api_content
assert "reports/import-proof.json" in api_content, api_content

isolated_workspace = workspace.parent / f"isolated-{uuid.uuid4().hex[:10]}"
isolated_workspace.mkdir()
isolated = agent(isolated_workspace, f"brief-isolated-{uuid.uuid4().hex[:10]}")
isolated_result = isolated.run_conversation("hi")
isolated_message = isolated_result["messages"][0]
assert "Sno working memory" not in isolated_message.get("api_content", ""), (
    isolated_message
)

detail = agent(workspace, f"brief-detail-{uuid.uuid4().hex[:10]}")
detail_result = detail.run_conversation(
    "What is the current task blocker and next action?"
)
detail_api_content = detail_result["messages"][0]["api_content"]
ids = re.findall(r"\[id:([^\]]+)\]", detail_api_content)
assert ids and len(ids) == len(set(ids)), detail_api_content

provider = detail._memory_manager.get_provider("sno-mem-hermes")
provider.on_session_switch(detail.session_id)
contexts = get_plugin_manager().invoke_hook(
    "pre_llm_call", session_id=detail.session_id
)
assert any("Sno working memory" in result.get("context", "") for result in contexts), (
    contexts
)

print(
    json.dumps(
        {
            "status": "PASS",
            "workspace": str(workspace),
            "marker": marker,
            "greeting_loaded_brief": True,
            "clean_content_preserved": True,
            "other_project_isolated": True,
            "no_duplicate_ids": True,
            "boundary_reloads_brief": True,
        },
        sort_keys=True,
    )
)
