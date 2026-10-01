from __future__ import annotations

import getpass
import json
import os
import urllib.request
from pathlib import Path

from run_agent import AIAgent


def build_agent(
    cwd: Path,
    session_id: str,
    *,
    platform: str = "cli",
    max_iterations: int = 12,
) -> AIAgent:
    return AIAgent(
        model="gpt-5.6-terra",
        provider="custom",
        base_url="http://localhost:8070/codex/v1",
        api_key="isolated-e2e",
        api_mode="codex_responses",
        enabled_toolsets=["memory"],
        max_iterations=max_iterations,
        max_tokens=512,
        quiet_mode=True,
        skip_context_files=True,
        skip_background_review=True,
        session_id=session_id,
        platform=platform,
        cwd=str(cwd),
    )


def tool_results(result: dict[str, object]) -> list[dict[str, object]]:
    messages = result["messages"]
    assert isinstance(messages, list)
    outputs = {
        message["tool_call_id"]: json.loads(message["content"])
        for message in messages
        if isinstance(message, dict)
        and message.get("role") == "tool"
        and isinstance(message.get("tool_call_id"), str)
        and isinstance(message.get("content"), str)
    }
    ordered: list[dict[str, object]] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        calls = message.get("tool_calls", [])
        if not isinstance(calls, list):
            continue
        for call in calls:
            assert isinstance(call, dict)
            function = call["function"]
            assert isinstance(function, dict)
            arguments = function["arguments"]
            args = json.loads(arguments) if isinstance(arguments, str) else arguments
            ordered.append(
                {
                    "id": call["id"],
                    "name": function["name"],
                    "args": args,
                    "result": outputs[call["id"]],
                }
            )
    return ordered


def post(method: str, body: dict[str, object]) -> dict[str, object]:
    profile = Path(os.environ["SNO_PROFILE_DIR"]).resolve()
    discovery = json.loads((profile / "station" / "sidecar.json").read_text())
    request = urllib.request.Request(
        f"http://127.0.0.1:{discovery['port']}/v1/{method}",
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "x-sno-station-mem-skin": "hermes",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        value = json.load(response)
    assert isinstance(value, dict)
    return value


def scope(project: Path, session_id: str) -> dict[str, object]:
    return {
        "principal": getpass.getuser(),
        "project": str(project.resolve()),
        "session": session_id,
        "host": {"sessionId": session_id},
    }


def inspect_entries(project: Path, session_id: str) -> list[dict[str, object]]:
    value = post("inspect", {"scope": scope(project, session_id), "op": {"op": "list"}})
    assert value.get("degraded") is False, value
    result = value.get("result")
    assert isinstance(result, dict) and result.get("op") == "list", value
    entries = result.get("entries")
    assert isinstance(entries, list), value
    return entries
