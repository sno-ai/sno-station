from __future__ import annotations

import getpass
import json
import os
import time
import urllib.request
import uuid
from pathlib import Path

from run_agent import AIAgent

MODEL = "gpt-5.6-terra"
BASE_URL = "http://localhost:8070/codex/v1"
WORKSPACE = (
    Path(os.environ["MEM_HERMES_WORKSPACE"]) / f"run-{uuid.uuid4().hex[:12]}"
).resolve()
WORKSPACE.mkdir(parents=True)
PROFILE = Path(os.environ["SNO_PROFILE_DIR"]).resolve()
WORDS = ("maple", "otter", "river", "cedar", "meadow", "falcon", "willow", "harbor")
SEED = uuid.uuid4().int
DECISION = "cobalt lantern " + " ".join(
    WORDS[(SEED >> shift) % len(WORDS)] for shift in (0, 4, 8)
)


def build_agent(session_id: str) -> AIAgent:
    return AIAgent(
        model=MODEL,
        provider="custom",
        base_url=BASE_URL,
        api_key="isolated-e2e",
        api_mode="codex_responses",
        enabled_toolsets=[],
        max_iterations=2,
        max_tokens=256,
        quiet_mode=True,
        skip_context_files=True,
        skip_background_review=True,
        session_id=session_id,
        platform="cli",
        cwd=str(WORKSPACE),
    )


def recall(session_id: str) -> dict[str, object]:
    discovery = json.loads((PROFILE / "station" / "sidecar.json").read_text())
    body = {
        "scope": {
            "principal": getpass.getuser(),
            "project": str(WORKSPACE),
            "session": session_id,
            "host": {"sessionId": session_id},
        },
        "query": f"launch color project decision {DECISION}",
        "options": {"source": "manual", "limit": 5, "includeMetadata": True},
    }
    request = urllib.request.Request(
        f"http://127.0.0.1:{discovery['port']}/v1/get-recall",
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "x-sno-station-mem-skin": "hermes",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.load(response)
    assert isinstance(result, dict)
    return result


first_session = f"mem-hermes-a-{uuid.uuid4().hex[:10]}"
first = build_agent(first_session)
first_result = first.run_conversation(
    f"Remember this project decision: the launch color phrase is {DECISION}. Reply exactly ACK."
)
assert first_result.get("completed"), first_result
assert first._memory_manager is not None
assert first._memory_manager.flush_pending(timeout=60), "capture did not drain"

second_session = f"mem-hermes-b-{uuid.uuid4().hex[:10]}"
readback = recall(second_session)
assert not readback.get("degraded"), readback
assert DECISION in json.dumps(readback), readback

second = build_agent(second_session)
question = "What exact launch color phrase did this project decide? Reply with only the phrase."
second_result = second.run_conversation(question)
assert second_result.get("completed"), second_result
assert DECISION in str(second_result.get("final_response")).lower(), second_result

third_session = f"mem-hermes-c-{uuid.uuid4().hex[:10]}"
third = build_agent(third_session)
assert third._memory_manager is not None
native_context = third._memory_manager.prefetch_all(question, session_id=third_session)
assert DECISION in native_context.lower(), native_context

print(
    json.dumps(
        {
            "status": "PASS",
            "hermes_commit": os.environ["MEM_HERMES_COMMIT"],
            "model": MODEL,
            "sidecar_pid": json.loads(
                (PROFILE / "station" / "sidecar.json").read_text()
            )["pid"],
            "workspace": str(WORKSPACE),
            "first_session": first_session,
            "second_session": second_session,
            "third_session": third_session,
            "decision": DECISION,
            "capture_drained": True,
            "direct_readback": True,
            "fresh_session_native_recall": True,
            "fresh_session_answer": second_result.get("final_response"),
            "finished_at_ms": int(time.time() * 1000),
        },
        sort_keys=True,
    )
)
