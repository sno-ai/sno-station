from __future__ import annotations

import getpass
import hashlib
import json
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Protocol

from agent.memory_provider import MemoryProvider

__all__ = ["SnoMemoryProvider", "register"]

_SKIN_ID = "hermes"
_PROVIDER_NAME = "sno-mem-hermes"
_SIDECAR_COMMAND = "sno-station-mem"
_HTTP_TIMEOUT_SECONDS = 900
_LATER_RECALL_LIMIT = 3
_LATER_RECALL_MAX_CHARS = 1_500


class RegistrationContext(Protocol):
    def register_memory_provider(self, provider: MemoryProvider) -> object: ...

    def register_hook(self, hook_name: str, callback: object) -> object: ...


class SidecarClient:
    def __init__(self, profile_dir: Path) -> None:
        self._profile_dir = profile_dir

    def connect(self) -> None:
        if self._healthy():
            return
        executable = shutil.which(_SIDECAR_COMMAND)
        if executable is None:
            raise RuntimeError("sidecar unavailable")
        subprocess.run(
            [executable, "sidecar", "start"],
            check=True,
            capture_output=True,
            text=True,
            timeout=40,
        )
        if not self._healthy():
            raise RuntimeError("sidecar unavailable")

    def post(self, method: str, body: dict[str, object]) -> dict[str, object]:
        port = self._port()
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/v1/{method}",
            data=json.dumps(body).encode(),
            headers={
                "Content-Type": "application/json",
                "x-sno-station-mem-skin": _PROVIDER_NAME,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(
                request, timeout=_HTTP_TIMEOUT_SECONDS
            ) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(error.read().decode()) from error
        if not isinstance(result, dict):
            raise RuntimeError("invalid sidecar response")
        return result

    def _healthy(self) -> bool:
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{self._port()}/healthz",
                timeout=5,
            ) as response:
                return response.status == 200
        except (OSError, ValueError):
            return False

    def _port(self) -> int:
        discovery = json.loads(
            (self._profile_dir / "station" / "sidecar.json").read_text()
        )
        port = discovery["port"]
        if not isinstance(port, int) or port < 1:
            raise ValueError("invalid sidecar discovery")
        return port


class SnoMemoryProvider(MemoryProvider):
    def __init__(self) -> None:
        self._client: SidecarClient | None = None
        self._project = ""
        self._session_id = ""
        self._primary = False

    @property
    def name(self) -> str:
        return _PROVIDER_NAME

    def is_available(self) -> bool:
        return True

    def initialize(self, session_id: str, **kwargs: object) -> None:
        profile_dir = Path(
            os.environ.get("SNO_PROFILE_DIR", Path.home() / ".sno")
        ).resolve()
        client = SidecarClient(profile_dir)
        client.connect()
        cwd = kwargs.get("cwd")
        identity = str(kwargs.get("agent_identity") or "default")
        self._project = (
            str(Path(cwd).resolve())
            if isinstance(cwd, str) and cwd
            else f"hermes:{identity}"
        )
        self._session_id = session_id
        self._primary = kwargs.get("agent_context", "primary") == "primary"
        self._client = client
        result = client.post(
            "init",
            {
                "scope": self._scope(session_id),
                "registration": {"skinId": _SKIN_ID, "inheritInstalled": True},
            },
        )
        if result.get("degraded"):
            raise RuntimeError(str(result.get("reason") or "sidecar unavailable"))

    def get_tool_schemas(self) -> list[dict[str, object]]:
        return []

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        client = self._require_client()
        result = client.post(
            "get-recall",
            {
                "query": query,
                "scope": self._scope(session_id or self._session_id),
                "options": {
                    "source": "native",
                    "limit": _LATER_RECALL_LIMIT,
                    "includeMetadata": True,
                },
            },
        )
        if result.get("degraded"):
            return ""
        return _render_native_hits(result.get("nativeHits"))

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        **_kwargs: object,
    ) -> None:
        if not self._primary:
            return
        active_session = session_id or self._session_id
        normalized = [
            {"role": "user", "content": user_content},
            {"role": "assistant", "content": assistant_content},
        ]
        identity = json.dumps(
            {"sessionId": active_session, "rewindEpoch": 0, "messages": normalized},
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
        now = int(time.time() * 1000)
        result = self._require_client().post(
            "capture",
            {
                "scope": self._scope(active_session),
                "turn": {
                    "turnId": hashlib.sha256(identity).hexdigest(),
                    "rewindEpoch": 0,
                    "messages": [
                        {**normalized[0], "at": now},
                        {**normalized[1], "at": now},
                    ],
                },
            },
        )
        if result.get("committed") is not True:
            raise RuntimeError(str(result.get("reason") or "capture not committed"))

    def _scope(self, session_id: str) -> dict[str, object]:
        return {
            "principal": getpass.getuser(),
            "project": self._project,
            "session": session_id,
            "host": {"sessionId": session_id},
        }

    def _require_client(self) -> SidecarClient:
        if self._client is None:
            raise RuntimeError("provider not initialized")
        return self._client


def _render_native_hits(raw_hits: object) -> str:
    if not isinstance(raw_hits, list):
        return ""
    lines: list[str] = []
    for raw_hit in raw_hits[:_LATER_RECALL_LIMIT]:
        if not isinstance(raw_hit, dict):
            continue
        snippet = raw_hit.get("snippet")
        path = raw_hit.get("path")
        if (
            not isinstance(snippet, str)
            or not snippet.strip()
            or not isinstance(path, str)
        ):
            continue
        memory_id = Path(path).stem
        line = f"- {snippet.strip()} [{memory_id}]"
        candidate = "\n".join([*lines, line])
        if len(candidate) > _LATER_RECALL_MAX_CHARS:
            break
        lines.append(line)
    return "\n".join(lines)


def _pre_llm_call(**_kwargs: object) -> None:
    return None


def register(ctx: RegistrationContext) -> None:
    ctx.register_memory_provider(SnoMemoryProvider())
    ctx.register_hook("pre_llm_call", _pre_llm_call)
