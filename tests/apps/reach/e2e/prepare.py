#!/usr/bin/env python3
"""Explicit setup, separate from the preflight checker. Does not start models."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid
from live_support import FORBIDDEN, CLOCK, manifest, sha

if len(sys.argv) not in (3, 7) or (len(sys.argv) == 7 and (sys.argv[3] != "--reuse-context" or sys.argv[5] != "--after-cleanup")):
    raise SystemExit("usage: prepare.py <archive> <new-context> [--reuse-context <old-context> --after-cleanup <cleanup.json>]")
archive = Path(sys.argv[1]).resolve()
context_path = Path(sys.argv[2]).resolve()
if context_path.exists():
    raise SystemExit("context path already exists")
checksum = Path(str(archive) + ".sha256").read_text().split()
if checksum != [sha(archive), archive.name]:
    raise SystemExit("candidate checksum mismatch")
reuse = None
if len(sys.argv) == 7:
    reuse = json.loads(Path(sys.argv[4]).read_text())
    cleanup = json.loads(Path(sys.argv[6]).read_text())
    previous_run = Path(reuse["run"]).resolve()
    if previous_run.parent != Path("/tmp") or not previous_run.name.startswith("reach-live-") or Path(reuse["state"]).resolve() != previous_run / "state":
        raise SystemExit("reuse context is not the declared private run")
    if cleanup["candidate"] != reuse["archive_sha256"] or not cleanup["passed"]:
        raise SystemExit("matching completed cleanup is required")
    actor_cwds = {actor["cwd"] for actor in reuse["actors"]}
    if len(actor_cwds) != len(reuse["actors"]) or any(not Path(cwd).resolve().is_relative_to(previous_run / "work") for cwd in actor_cwds):
        raise SystemExit("reuse must preserve every declared private actor path")
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            if os.readlink(process / "cwd") in actor_cwds:
                raise SystemExit("owned actor still alive; cannot prepare replacement")
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
    if any("handle" in actor or (Path(reuse["state"]) / actor["address"] / "reachable.json").exists() for actor in reuse["actors"]):
        raise SystemExit("run reset.py before preparing replacement")
    clock_before = CLOCK.read_bytes()
original_home = Path.home()
credentials = [(original_home / ".codex/auth.json", ".codex/auth.json"),
               (original_home / ".claude/.credentials.json", ".claude/.credentials.json")]
for source, relative in credentials:
    data = json.loads(source.read_text())
    if relative.startswith(".codex"):
        assert data.get("auth_mode") == "chatgpt" and isinstance(data.get("tokens"), dict), "Codex must use subscription auth"
        assert not data.get("OPENAI_API_KEY"), "paid API key material refused"
    else:
        assert isinstance(data.get("claudeAiOauth"), dict) and data["claudeAiOauth"].get("accessToken"), "Claude must use subscription OAuth"
    def refuse_keys(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if "api" in key.lower() and "key" in key.lower() and child:
                    raise RuntimeError("paid API key material refused")
                refuse_keys(child)
        elif isinstance(value, list):
            for child in value:
                refuse_keys(child)
    refuse_keys(data)

run = previous_run if reuse else Path(tempfile.mkdtemp(prefix="reach-live-", dir="/tmp"))
home = run / ("home-" + sha(archive)[:12] if reuse else "home")
home.mkdir(mode=0o700)
copied = []
for source, relative in credentials:
    target = home / relative
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    shutil.copyfile(source, target)
    target.chmod(0o600)
    copied.append(str(target))
version = subprocess.check_output(["tar", "-xOf", str(archive), "VERSION"], text=True).strip()
release = home / f".local/lib/sno-reach/releases/{version}"
release.mkdir(parents=True)
subprocess.run(["tar", "-xzf", str(archive), "-C", str(release)], check=True)
assert (release / "VERSION").read_text().strip() == version
(home / ".local/lib/sno-reach/current").symlink_to(release)
(home / ".config/sno-reach").mkdir(parents=True)
(home / ".config/sno-reach/agents.json").write_text('{"codex":{"acpx_agent":"codex"},"claude":{"acpx_agent":"claude"}}\n')
(home / ".acpx").mkdir()
(home / ".acpx/config.json").write_text('{"ttl":0}\n')
tools = {name: dict(path=str(Path(shutil.which(name)).resolve())) for name in ("sno", "acpx", "codex", "claude", "tmux")}
for value in tools.values():
    value["sha256"] = sha(value["path"])
environment = {key: os.environ[key] for key in ("USER", "LOGNAME", "LANG") if key in os.environ}
environment.update(HOME=str(home), CODEX_HOME=str(home / ".codex"), CLAUDE_CONFIG_DIR=str(home / ".claude"),
    INITIAL_AGENT_MODE="agent-full-access",
    # A Claude TUI in a fresh HOME otherwise installs its own launcher into <HOME>/.local/bin,
    # which shadows the recorded claude tool mid-run (observed 2026-09-26).
    DISABLE_AUTOUPDATER="1",
    XDG_CONFIG_HOME=str(home / ".config"), XDG_STATE_HOME=str(home / ".local/state"), XDG_CACHE_HOME=str(home / ".cache"),
    PATH=str(home / ".local/bin") + ":" + os.environ["PATH"], TERM="xterm-256color", SNO_REACH_ROOT=str(run / "state"))
assert not any(key in environment for key in FORBIDDEN)
nonce = uuid.uuid4().hex[:10]
actors = [dict(actor) for actor in reuse["actors"]] if reuse else []
if reuse:
    priority = {"tmux_sender": 1, "tmux_receiver": 2}
    actors.sort(key=lambda actor: priority.get(actor["label"], 3))
if not reuse:
    # Every journey pairs the two vendors: Claude sends on ACP and receives on tmux.
    for label, kind, channel, role in (("acp_sender", "claude", "acp", "tpm"), ("acp_receiver", "codex", "acp", "executor"),
            ("acp_continuing", "codex", "acp", "lead"), ("tmux_sender", "codex", "tmux", "tpm"),
            ("tmux_receiver", "claude", "tmux", "executor")):
        cwd = run / "work" / label
        cwd.mkdir(parents=True)
        actors.append(dict(label=label, kind=kind, channel=channel, address=f"{role}.{nonce}-{label.replace('_','-')}@{os.uname().nodename}", cwd=str(cwd)))
trust = home / ".codex/config.toml"
trust.write_text("\n".join(f"[projects.{json.dumps(actor['cwd'])}]\ntrust_level = \"trusted\"\n" for actor in actors if actor["kind"] == "codex"))
trust.chmod(0o600)
# A fresh CLAUDE_CONFIG_DIR stops the Claude TUI at its login-method screen; mark onboarding done
# and trust exactly the Claude actor cwds, as the Codex config above does for Codex.
claude_version = subprocess.check_output([tools["claude"]["path"], "--version"], text=True).split()[0]
claude_config = home / ".claude/.claude.json"
claude_config.write_text(json.dumps(dict(hasCompletedOnboarding=True, lastOnboardingVersion=claude_version,
    bypassPermissionsModeAccepted=True,
    projects={actor["cwd"]: dict(hasTrustDialogAccepted=True) for actor in actors if actor["kind"] == "claude"})) + "\n")
claude_config.chmod(0o600)
context = dict(run=str(run), home=str(home), state=str(run / "state"), release=str(release), archive=str(archive),
               archive_sha256=sha(archive), version=version, payload=manifest(release), environment=environment, tools=tools,
               credentials=copied, actors=actors, server=f"reach-live-{nonce}", intentional_spawned=0)
if reuse:
    context["previous_context"] = dict(path=str(Path(sys.argv[4]).resolve()), sha256=sha(sys.argv[4]),
                                       cleanup=str(Path(sys.argv[6]).resolve()), old_home=reuse["home"])
    if CLOCK.read_bytes() != clock_before:
        raise RuntimeError("replacement preparation changed the live clock")
context_path.parent.mkdir(parents=True, exist_ok=True)
context_path.write_text(json.dumps(context, indent=2) + "\n")
context_path.chmod(0o600)
print(f"Prepared private archive-only environment: {context_path}; no model started; credentials are outside evidence")
