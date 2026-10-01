"""Observe only the newly spawned TUI bootstrap; never send runtime input."""
from datetime import datetime
import json
import time


def completed(rows, cwd, spawned):
    meta = next((row for row in rows if row.get("type") == "session_meta"), None)
    if not meta or meta["payload"].get("cwd") != cwd:
        return None
    if datetime.fromisoformat(meta["timestamp"].replace("Z", "+00:00")).timestamp() < spawned:
        return None
    starts = set()
    for row in rows:
        data = row.get("payload", {})
        if row.get("type") != "event_msg":
            continue
        if data.get("type") == "task_started":
            starts.add(data.get("turn_id"))
        if data.get("type") == "task_complete" and data.get("turn_id") in starts:
            return dict(session_id=meta["payload"]["id"], session_timestamp=meta["timestamp"],
                        turn_id=data["turn_id"], completed_timestamp=row["timestamp"])
    return None


def claude_completed(rows, spawned):
    # Claude closes each finished turn with a turn_duration system row.
    for row in rows:
        if row.get("type") == "system" and row.get("subtype") == "turn_duration":
            if datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00")).timestamp() >= spawned:
                return dict(session_id=row.get("sessionId"), completed_timestamp=row["timestamp"])
    return None


def wait(run, actor):
    deadline = min(time.time() + 90, run.deadline - 130)
    while time.time() < deadline:
        if actor["kind"] == "claude":
            result = claude_completed(run.claude_rows(actor), actor["spawn_started_epoch"])
            if result:
                pids = run.live_pids(actor)
                if not pids:
                    raise RuntimeError("bootstrap completed but owned runtime is no longer alive")
                result.update(path=str(run.claude_transcript(actor)), observed_pids=pids, spawn_started_epoch=actor["spawn_started_epoch"])
                (run.evidence / (actor["label"] + "-bootstrap.json")).write_text(json.dumps(result, indent=2) + "\n")
                return result
            time.sleep(.2)
            continue
        for path in (run.home / ".codex/sessions").rglob("*.jsonl"):
            rows = []
            for line in path.read_text().splitlines():
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
            result = completed(rows, actor["cwd"], actor["spawn_started_epoch"])
            if result:
                pids = run.live_pids(actor)
                if not pids:
                    raise RuntimeError("bootstrap completed but owned runtime is no longer alive")
                result.update(path=str(path), observed_pids=pids, spawn_started_epoch=actor["spawn_started_epoch"])
                (run.evidence / (actor["label"] + "-bootstrap.json")).write_text(json.dumps(result, indent=2) + "\n")
                return result
        time.sleep(.2)
    raise RuntimeError("fresh owned TUI bootstrap completion not observed before readiness deadline")


def calibrate():
    rows = [dict(type="session_meta", timestamp="2026-09-13T10:00:01Z", payload=dict(id="fresh", cwd="/owned")),
            dict(type="event_msg", payload=dict(type="task_started", turn_id="turn")),
            dict(type="event_msg", timestamp="2026-09-13T10:00:02Z", payload=dict(type="task_complete", turn_id="turn"))]
    spawn = datetime.fromisoformat("2026-09-13T10:00:00+00:00").timestamp()
    assert completed(rows, "/owned", spawn)["session_id"] == "fresh"
    assert completed(rows, "/other", spawn) is None
    assert completed(rows, "/owned", spawn + 3) is None
    assert completed(rows[:2], "/owned", spawn) is None
    assert completed([rows[0], rows[2]], "/owned", spawn) is None
    policy(dict(sandbox_policy=dict(type="danger-full-access"), approval_policy="never"))
    for bad in ({}, dict(sandbox_policy=dict(type="workspace-write"), approval_policy="on-request")):
        try:
            policy(bad)
        except RuntimeError:
            pass
        else:
            raise AssertionError("wrong native policy accepted")
    return "fresh paired completion accepted; old session, wrong cwd, incomplete and unpaired completion refused"


def native_policy(run, actor):
    for path in (run.home / ".codex/sessions").rglob("*.jsonl"):
        rows = []
        for line in path.read_text().splitlines():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
        meta = next((r for r in rows if r.get("type") == "session_meta"), None)
        if not meta or meta["payload"].get("cwd") != actor["cwd"]:
            continue
        if datetime.fromisoformat(meta["timestamp"].replace("Z", "+00:00")).timestamp() < actor["spawn_started_epoch"]:
            continue
        turns = [r for r in rows if r.get("type") == "turn_context"]
        if not turns:
            continue
        for row in turns:
            policy(row["payload"])
        result = dict(path=str(path), session_id=meta["payload"]["id"], turns=[dict(timestamp=r["timestamp"],
            sandbox_policy=r["payload"]["sandbox_policy"], approval_policy=r["payload"]["approval_policy"]) for r in turns])
        (run.evidence / (actor["label"] + "-native-policy.json")).write_text(json.dumps(result, indent=2) + "\n")
        return result
    raise RuntimeError("fresh owned native turn_context is absent")


def policy(value):
    if value.get("sandbox_policy", {}).get("type") != "danger-full-access" or value.get("approval_policy") != "never":
        raise RuntimeError("native child does not use approved disposable full-access mode")
