from __future__ import annotations

import json
import os
import sys
import time
import threading
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from run_agent import AIAgent

root = Path(os.environ["MEM_HERMES_WORKSPACE"]).resolve()
workspace_a = root / f"concurrent-a-{uuid.uuid4().hex[:10]}"
workspace_b = root / f"concurrent-b-{uuid.uuid4().hex[:10]}"
workspace_a.mkdir(parents=True)
workspace_b.mkdir(parents=True)
marker_a = f"session-a-{uuid.uuid4().hex[:10]}"
marker_b = f"session-b-{uuid.uuid4().hex[:10]}"
brief_a = f"brief-a-{uuid.uuid4().hex[:10]}"
brief_b = f"brief-b-{uuid.uuid4().hex[:10]}"


def agent(cwd: Path, session_id: str) -> AIAgent:
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


agent_a = agent(workspace_a, f"concurrent-a-{uuid.uuid4().hex[:10]}")
agent_b = agent(workspace_b, f"concurrent-b-{uuid.uuid4().hex[:10]}")
assert agent_a._memory_manager is not None
assert agent_b._memory_manager is not None
provider_a = agent_a._memory_manager.get_provider("sno-mem-hermes")
provider_b = agent_b._memory_manager.get_provider("sno-mem-hermes")
for provider, marker in ((provider_a, brief_a), (provider_b, brief_b)):
    stored = json.loads(
        provider.handle_tool_call(
            "sno_memory_remember",
            {"content": f"Task {marker}: objective preserve concurrent project scope."},
        )
    )
    assert stored.get("degraded") is False, stored
model_before = agent_b.model
agent_b.switch_model(
    new_model="gpt-5.6-sol",
    new_provider="custom",
    api_key="isolated-e2e",
    base_url="http://localhost:8070/codex/v1",
    api_mode="codex_responses",
)
model_after = agent_b.model
assert model_before != model_after, (model_before, model_after)


start_barrier = threading.Barrier(2)


def run(current: AIAgent, marker: str) -> tuple[dict[str, object], int]:
    start_barrier.wait()
    result = current.run_conversation(
        f"Remember project decision {marker}. Reply exactly ACK."
    )
    return result, int(time.time() * 1000)


started_at_ms = int(time.time() * 1000)
with ThreadPoolExecutor(max_workers=2) as executor:
    future_a = executor.submit(run, agent_a, marker_a)
    future_b = executor.submit(run, agent_b, marker_b)
    result_a, main_a_finished_ms = future_a.result()
    result_b, main_b_finished_ms = future_b.result()
assert result_a.get("completed"), result_a
assert result_b.get("completed"), result_b
api_a = result_a["messages"][0]["api_content"]
api_b = result_b["messages"][0]["api_content"]
assert brief_a in api_a and brief_b not in api_a, api_a
assert brief_b in api_b and brief_a not in api_b, api_b
assert agent_a._memory_manager.flush_pending(timeout=120)
assert agent_b._memory_manager.flush_pending(timeout=120)
finished_at_ms = int(time.time() * 1000)

recalled_a = provider_a.prefetch(marker_a, session_id=agent_a.session_id)
recalled_b = provider_b.prefetch(marker_b, session_id=agent_b.session_id)
assert marker_a in recalled_a and marker_b not in recalled_a, recalled_a
assert marker_b in recalled_b and marker_a not in recalled_b, recalled_b
assert provider_a.prefetch(marker_b, session_id=agent_a.session_id) == ""
assert provider_b.prefetch(marker_a, session_id=agent_b.session_id) == ""

module = sys.modules[provider_b.__class__.__module__]
registration = module._RUNTIME.model_registration()
assert registration is not None
agent_b._memory_manager.on_session_switch(
    f"reset-{uuid.uuid4().hex[:10]}", reset=True, reason="reset"
)
request = urllib.request.Request(
    f"{registration['baseUrl']}/chat/completions",
    data=json.dumps({"messages": [{"role": "user", "content": "stale"}]}).encode(),
    headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {registration['credential']}",
    },
    method="POST",
)
try:
    urllib.request.urlopen(request, timeout=5)
except urllib.error.HTTPError as error:
    stale_status = error.code
else:
    raise AssertionError("stale callback remained active")
assert stale_status == 503, stale_status

print(
    json.dumps(
        {
            "status": "PASS",
            "started_at_ms": started_at_ms,
            "finished_at_ms": finished_at_ms,
            "main_a_finished_ms": main_a_finished_ms,
            "main_b_finished_ms": main_b_finished_ms,
            "model_before": model_before,
            "model_after": model_after,
            "session_a": agent_a.session_id,
            "session_b": agent_b.session_id,
            "marker_a": marker_a,
            "marker_b": marker_b,
            "concurrent_main_turns": True,
            "both_captures_drained": True,
            "cross_session_recall_isolated": True,
            "cross_project_brief_isolated": True,
            "stale_callback_status": stale_status,
        },
        sort_keys=True,
    )
)
