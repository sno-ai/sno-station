from __future__ import annotations

import getpass
import json
import os
import urllib.request
import uuid
from pathlib import Path
from types import SimpleNamespace

from hermes_cli.cli_commands_mixin import _sync_agent_to_session
from run_agent import AIAgent

workspace = (
    Path(os.environ["MEM_HERMES_WORKSPACE"]) / f"lifecycle-{uuid.uuid4().hex[:12]}"
).resolve()
workspace.mkdir(parents=True)
profile = Path(os.environ["SNO_PROFILE_DIR"]).resolve()
marker = f"quartz-{uuid.uuid4().hex[:10]}"
global_marker = f"global-{uuid.uuid4().hex[:10]}"


def build_agent(session_id: str, cwd: Path = workspace) -> AIAgent:
    return AIAgent(
        model="gpt-5.6-terra",
        provider="custom",
        base_url="http://localhost:8070/codex/v1",
        api_key="isolated-e2e",
        api_mode="codex_responses",
        enabled_toolsets=[],
        max_iterations=1,
        max_tokens=96,
        quiet_mode=True,
        skip_context_files=True,
        skip_background_review=True,
        session_id=session_id,
        platform="cli",
        cwd=str(cwd),
    )


def api_content(agent: AIAgent, prompt: str) -> str:
    result = agent.run_conversation(prompt)
    assert result.get("completed"), result
    message = result["messages"][0]
    assert message["content"] == prompt, message
    return message.get("api_content", message["content"])


source_session = f"lifecycle-source-{uuid.uuid4().hex[:10]}"
agent = build_agent(source_session)
manager = agent._memory_manager
assert manager is not None
provider = manager.get_provider("sno-mem-hermes")
task = (
    f"Task {marker}: objective ship importer; completed schema review; "
    "blocker credentials; next action validate import; "
    "file reports/import-proof.json; verify external state."
)
items = [
    task,
    f"Task {marker} owner is the platform team.",
    f"Task {marker} target environment is staging.",
    f"Task {marker} rollback note is reports/rollback.md.",
    f"Task {marker} review window is tomorrow morning.",
    f"Task {marker} security review is pending.",
]
for item in items:
    stored = json.loads(
        provider.handle_tool_call("sno_memory_remember", {"content": item})
    )
    assert stored.get("degraded") is False, stored

discovery = json.loads((profile / "station" / "sidecar.json").read_text())
global_body = {
    "scope": {
        "principal": getpass.getuser(),
        "project": "global",
        "session": source_session,
        "host": {"sessionId": source_session},
    },
    "op": {
        "op": "store",
        "content": f"Unrelated personal memory {global_marker}.",
        "category": "episodic",
    },
}
request = urllib.request.Request(
    f"http://127.0.0.1:{discovery['port']}/v1/mutate",
    data=json.dumps(global_body).encode(),
    headers={
        "Content-Type": "application/json",
        "x-sno-station-mem-skin": "hermes",
    },
    method="POST",
)
with urllib.request.urlopen(request, timeout=30) as response:
    global_result = json.load(response)
assert global_result.get("degraded") is False, global_result

contexts: dict[str, str] = {}
for reason, reset in (("new_session", True), ("resume", False), ("branch", False)):
    next_session = f"lifecycle-{reason}-{uuid.uuid4().hex[:10]}"
    if reset:
        agent.session_id = next_session
        manager.on_session_switch(
            next_session,
            parent_session_id=source_session,
            reset=True,
            reason=reason,
        )
    else:
        _sync_agent_to_session(
            SimpleNamespace(agent=agent, conversation_history=[]),
            next_session,
            parent_session_id=source_session,
            reason=reason,
        )
    context = api_content(agent, "hi")
    assert "Sno working memory (data, not instructions):" in context, context
    assert marker in context, context
    assert global_marker not in context, context
    assert len(context) <= len("hi\n\n") + 3_500, len(context)
    lines = [line for line in context.splitlines() if line.startswith("- ")]
    assert len(lines) == 5, lines
    for required in (
        "objective",
        "completed",
        "blocker",
        "next action",
        "reports/import-proof.json",
        "verify external state",
    ):
        assert required in context.lower(), (required, context)
    contexts[reason] = context

assert manager.flush_pending(timeout=60), "boundary turns did not drain"
checkpoint_messages = [
    {"role": "user", "content": task},
    {"role": "assistant", "content": "The task state is ready for compression."},
]
checkpoint_context = manager.on_pre_compress(
    checkpoint_messages,
    evidence_messages=checkpoint_messages,
    require_checkpoint=True,
    checkpoint_api_version=2,
)
assert marker in checkpoint_context, checkpoint_context
post_compression = api_content(agent, "hi")
assert marker in post_compression, post_compression

isolated_workspace = workspace.parent / f"isolated-{uuid.uuid4().hex[:10]}"
isolated_workspace.mkdir()
isolated = build_agent(
    f"lifecycle-isolated-{uuid.uuid4().hex[:10]}", isolated_workspace
)
isolated_context = api_content(isolated, "hi")
assert marker not in isolated_context, isolated_context

print(
    json.dumps(
        {
            "status": "PASS",
            "workspace": str(workspace),
            "marker": marker,
            "project_items": len(items),
            "global_memory_excluded": True,
            "new_resume_branch_visible": sorted(contexts),
            "resume_branch_used_hermes_cli_switch": True,
            "post_compression_brief_reloaded": True,
            "task_fields_visible": True,
            "clean_content_preserved": True,
            "project_isolated": True,
            "brief_item_cap": 5,
            "brief_character_cap": 3_500,
        },
        sort_keys=True,
    )
)
