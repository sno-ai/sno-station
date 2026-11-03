"""Real-agent fixtures: private homes, source packages and a private tmux server.

Reuse tests/apps/*/e2e-agent and tests/apps/reach/seats isolation conventions.
No simulated agents, fabricated host events or production settings are used.
"""
import json
import http.client
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import shlex
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import tomllib
import uuid


REPO = Path(__file__).resolve().parents[3]
SKILLS = Path(os.environ.get("SNO_SKILLS_SOURCE", REPO.parent / "sno-station-skills-core"))
SNO = Path(os.environ.get("SNO_BINARY", REPO.parent / "sno-cli-core/target/debug/sno"))


class CodexProxy(BaseHTTPRequestHandler):
    """Preserve native developer context across ccproxy's observed array-content loss."""

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        converted = 0
        for item in body.get("input", []):
            if isinstance(item, dict) and item.get("role") in ("system", "developer") and isinstance(item.get("content"), list):
                item["content"] = "\n".join(part["text"] for part in item["content"] if isinstance(part.get("text"), str))
                converted += 1
        payload = json.dumps(body).encode()
        self.forward(payload, converted)

    def do_GET(self):
        self.forward(None, 0)

    def forward(self, payload, converted):
        headers = {k: v for k, v in self.headers.items() if k.lower() not in ("host", "content-length", "connection")}
        if payload is not None:
            headers["Content-Length"] = str(len(payload))
        with closing(http.client.HTTPConnection("localhost", 8070, timeout=90)) as upstream:
            upstream.request(self.command, self.path, payload, headers)
            response = upstream.getresponse()
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in ("content-length", "transfer-encoding", "connection"):
                    self.send_header(key, value)
            self.end_headers()
            while chunk := response.read1(65536):
                self.wfile.write(chunk)
                self.wfile.flush()
        with self.server.evidence.open("a") as out:
            out.write(json.dumps(dict(path=self.path, developer_arrays_preserved=converted, status=response.status)) + "\n")

    def log_message(self, *_args):
        pass


class Unavailable(RuntimeError):
    pass


class Fixture:
    def __init__(self, name, agents=("claude", "codex")):
        self.root = Path(tempfile.mkdtemp(prefix="tag-team-" + name + "-"))
        self.home = self.root / "home"
        self.project = self.root / "project"
        self.profile = self.home / ".sno"
        self.server = "tag-team-" + uuid.uuid4().hex[:12]
        self.credentials = []
        self.sidecar = None
        self.codex_proxy = None
        self.started = time.monotonic()
        self.deadline = self.started + 270  # Reserve cleanup within the 295-second total budget.
        self.agents = agents
        for directory in (self.project, self.profile, self.home / "bin", self.home / ".claude",
                          self.home / ".codex", self.home / ".config/sno", self.root / "reach"):
            directory.mkdir(parents=True, exist_ok=True)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(
            ("CLAUDE", "CODEX", "SNO_REACH", "SNO_EXECUTOR", "CURSOR")) and k not in
            ("TMUX", "TMUX_PANE", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SNO_PROFILE_DIR")}
        self.env.update(HOME=str(self.home), CODEX_HOME=str(self.home / ".codex"),
                        CLAUDE_CONFIG_DIR=str(self.home / ".claude"), SNO_PROFILE_DIR=str(self.profile),
                        XDG_CONFIG_HOME=str(self.home / ".config"), XDG_STATE_HOME=str(self.home / ".local/state"),
                        XDG_CACHE_HOME=str(self.home / ".cache"), SNO_REACH_ROOT=str(self.root / "reach"),
                        REM_REFLECT_STORE=str(self.root / "experience"), SNO_CAPTURE_SCRIPTED="1",
                        DISABLE_AUTOUPDATER="1", CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION="0", TERM="xterm-256color",
                        npm_config_prefix=str(self.root / "prefix"), SNO_EXECUTABLE=str(SNO),
                        PATH=str(self.home / "bin") + ":" + os.environ["PATH"])
        self.tmux = shutil.which("tmux")
        self.node = shutil.which("node")
        print("evidence: " + str(self.root), flush=True)

    def setup(self):
        if not SNO.is_file():
            raise Unavailable("Set SNO_BINARY to the current built Sno CLI")
        (self.home / "bin/sno").symlink_to(SNO)
        (self.home / "bin/tmux").write_text(
            "#!/bin/sh\nexec " + shlex.quote(self.tmux) + " -L " + self.server + ' "$@"\n')
        (self.home / "bin/tmux").chmod(0o755)
        (self.home / ".config/sno/cli.json").write_text('{"auto":{"enabled":false}}\n')
        prefix = self.root / "prefix/lib/node_modules/@snoai"
        prefix.mkdir(parents=True)
        for name, path in {"memory": "packages/memory", "mem-claude": "apps/mem-claude",
                           "mem-codex": "apps/mem-codex", "mem-cursor": "apps/mem-cursor",
                           "observability": "packages/observability"}.items():
            (prefix / name).symlink_to(REPO / path)
        scripts = SKILLS / "skills/R-recursive-self-improvement/rem-reflect/skill/scripts"
        rem = self.home / "bin/rem-reflect"
        rem.write_text("#!/bin/sh\nexec " + shlex.quote(self.node) + " --experimental-strip-types " +
                       shlex.quote(str(scripts / "rem-reflect.ts")) + ' "$@"\n')
        rem.chmod(0o755)
        programs = {"reach": REPO / "apps/reach/bin/sno-reach", "rem-reflect": rem,
                    "handoff-checkpoint": SKILLS / "skills/S-communication-and-handoff/handoff/skill/scripts/handoff-checkpoint",
                    "rotate-agent-resume": SKILLS / "skills/S-communication-and-handoff/rotate-agent/skill/scripts/rotate-agent-resume"}
        manifest = dict(generation="test", files={}, directories=[], skills_version="", skill_destinations={},
                        contract_sha256="", requirements_fixture_sha256="", hooks=[], timer=False,
                        memory_pieces={"memory": {"location": str(prefix / "memory"), "node": self.node}},
                        programs={k: {"entry": str(v), "version": "1.0", "sha256": "", "dependencies": []}
                                  for k, v in programs.items()})
        (self.home / ".config/sno/assemble.json").write_text(json.dumps(manifest))
        self.run(["git", "init", "-q"], check=True)
        self.run(["git", "-c", "user.name=Journey fixture", "-c", "user.email=test@example.invalid",
                  "commit", "--allow-empty", "-qm", "Fixture"], check=True)
        for agent in self.agents:
            if agent == "claude":
                source = Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude")) / ".credentials.json"
                target = self.home / ".claude/.credentials.json"
            elif agent == "codex":
                source = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "auth.json"
                target = self.home / ".codex/auth.json"
            else:
                source = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "cursor/auth.json"
                target = self.home / ".config/cursor/auth.json"
            if not source.is_file() or not shutil.which("cursor-agent" if agent == "cursor" else agent):
                raise Unavailable("Real " + agent + " CLI/login unavailable")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            target.chmod(0o600)
            self.credentials.append(target)
        onboarding = dict(hasCompletedOnboarding=True, bypassPermissionsModeAccepted=True,
                          projects={str(self.project): {"hasTrustDialogAccepted": True}})
        for p in (self.home / ".claude.json", self.home / ".claude/.claude.json"):
            p.write_text(json.dumps(onboarding))
        source_config = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "config.toml"
        selected = tomllib.loads(source_config.read_text()) if source_config.exists() else {}
        if "codex" in self.agents:
            self.codex_proxy = ThreadingHTTPServer(("127.0.0.1", 0), CodexProxy)
            self.codex_proxy.evidence = self.root / "ccproxy-context.jsonl"
            threading.Thread(target=self.codex_proxy.serve_forever, daemon=True).start()
        codex_endpoint = ("http://127.0.0.1:" + str(self.codex_proxy.server_port) + "/codex/v1"
                          if self.codex_proxy else "http://localhost:8070/codex/v1")
        # The user-level Codex E2E convention uses ccproxy, never a direct OpenAI endpoint.
        config = 'model = ' + json.dumps(selected.get("model", "gpt-6.1-sol")) + '\n'
        config += 'model_reasoning_effort = "low"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n'
        config += 'model_provider = "ccproxy"\n[model_providers.ccproxy]\nname = "ccproxy"\n'
        config += 'base_url = ' + json.dumps(codex_endpoint) + '\nwire_api = "responses"\nrequires_openai_auth = false\n'
        config += '[projects.' + json.dumps(str(self.project)) + ']\ntrust_level = "trusted"\n'
        (self.home / ".codex/config.toml").write_text(config)
        (self.home / ".config/sno/models.toml").write_text('[models]\nhandoff_order="claude-code,codex"\n')
        settings = json.loads((REPO / "packages/memory/settings.default.json").read_text())
        settings.update(mode="local-first", memoryPackage={"path": str(REPO / "packages/memory"), "node": self.node})
        settings["store"].update(path=str(self.profile / "memory.sqlite"), encryptionKey=os.urandom(32).hex())
        settings["embedding"].update(cacheDir=str(Path.home() / ".cache/sno-station/models"), offline=True)
        settings["rerank"]["mode"] = "none"
        settings["rem"]["tick"] = False
        settings["capture"]["ambient"] = False
        for section in ("memoryUsage", "observe"):
            settings["telemetry"][section]["enabled"] = False
        (self.profile / "settings.json").write_text(json.dumps(settings))
        for agent in self.agents:
            directory = self.home / (".cursor" if agent == "cursor" else "." + agent)
            directory.mkdir(exist_ok=True)
            flag = {"claude": "--config-dir", "codex": "--codex-home", "cursor": "--cursor-home"}[agent]
            self.run([self.node, REPO / ("apps/mem-" + agent + "/dist/cli.js"), "install", flag, directory], check=True)
        # Recovery uses a fresh headless CLI process, so task authorization must persist in this test home.
        if "state" not in self.root.name and "cursor-status" not in self.root.name:
            settings_path = self.home / ".claude/settings.json"
            config = json.loads(settings_path.read_text())
            config.setdefault("permissions", {}).setdefault("allow", []).extend(["Bash", "Read", "Write", "Edit"])
            settings_path.write_text(json.dumps(config))
        # Start only this profile's actual memory service. Its PID is the only service cleaned up.
        self.run([self.node, "--input-type=module", "-e", """
import {connect} from './packages/memory/dist/client.js';
import {writeFileSync} from 'node:fs';
const c=await connect({skinId:'codex'});
if(c.degraded) throw Error(c.error??c.reason);
writeFileSync(process.env.SNO_PROFILE_DIR+'/test-sidecar.json',JSON.stringify({pid:c.pid,port:c.port}));
console.log(JSON.stringify({pid:c.pid,port:c.port}));
"""], cwd=REPO, check=True, timeout=35)
        self.sidecar = json.loads((self.profile / "test-sidecar.json").read_text())
        self.mux("-f", "/dev/null", "new-session", "-d", "-x", "200", "-y", "55", "-s", "fixture", "cat")
        self.env["TMUX"] = self.mux("display-message", "-p", "#{socket_path},#{pid},0").stdout.strip()
        versions = {a: self.run(["cursor-agent" if a == "cursor" else a, "--version"]).stdout.strip()
                    for a in self.agents}
        (self.root / "provenance.json").write_text(json.dumps(dict(host=socket.gethostname(), versions=versions,
            sno=str(SNO), source=str(REPO), codex_model=selected.get("model"), codex_endpoint="http://localhost:8070/codex/v1",
            codex_test_relay=codex_endpoint,
            sidecar=self.sidecar), indent=2))

    def run(self, args, *, timeout=30, check=False, input=None, cwd=None, env=None):
        left = self.deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError("Journey exceeded its 295 second total budget")
        args = list(map(str, args))
        try:
            r = subprocess.run(args, input=input, cwd=cwd or self.project, env=env or self.env,
                               capture_output=True, text=True, timeout=min(timeout, left))
        except subprocess.TimeoutExpired as e:
            with (self.root / "commands.jsonl").open("a") as out:
                out.write(json.dumps(dict(args=args, timeout=True, stdout=str(e.stdout), stderr=str(e.stderr))) + "\n")
            raise
        with (self.root / "commands.jsonl").open("a") as out:
            out.write(json.dumps(dict(args=args, status=r.returncode, stdout=r.stdout, stderr=r.stderr)) + "\n")
        if check and r.returncode:
            raise AssertionError(f"{args[0:3]} exited {r.returncode}: {r.stderr[-1500:]} {r.stdout[-1500:]}")
        return r

    def sno(self, *args, **kw):
        return self.run([SNO, *args], **kw)

    def mux(self, *args):
        return self.run([self.tmux, "-L", self.server, *args], timeout=10, check=True)

    def launch(self, agent, prompt=None, permission=False):
        if agent == "claude":
            args = ["claude", "--permission-mode", "default" if permission else "bypassPermissions"]
        elif agent == "codex":
            args = ["codex", "--no-alt-screen", "-a", "on-request" if permission else "never",
                    "-s", "read-only" if permission else "danger-full-access"]
        else:
            args = ["cursor-agent", "--trust", "--workspace", str(self.project)]
        if prompt:
            args.append(prompt)
        # Cursor's existing E2E helper removes proxies for its streaming transport.
        if agent == "cursor":
            args = ["env", "-u", "HTTP_PROXY", "-u", "HTTPS_PROXY", "-u", "http_proxy", "-u", "https_proxy",
                    "-u", "ALL_PROXY", "-u", "all_proxy", "CURSOR_CONFIG_DIR=" + str(self.home / ".cursor"), *args]
        return self.mux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "fixture", "-c", str(self.project),
                        shlex.join(args)).stdout.strip()

    def send(self, pane, text):
        self.mux("send-keys", "-t", pane, "-l", "--", text)
        # Both native TUIs treat an immediate Enter after a burst as pasted text.
        time.sleep(.4)
        self.mux("send-keys", "-t", pane, "Enter")

    def screen(self, pane, label="screen"):
        text = self.mux("capture-pane", "-p", "-S", "-", "-t", pane).stdout
        (self.root / (label + ".txt")).write_text(text)
        return text

    def until(self, check, label, seconds=90):
        until = min(time.monotonic() + seconds, self.deadline)
        while time.monotonic() < until:
            value = check()
            if value:
                print("observed: " + label, flush=True)
                return value
            time.sleep(.3)
        raise AssertionError(label + "; evidence " + str(self.root))

    def transcripts(self, agent):
        directory = self.home / (".claude/projects" if agent == "claude" else ".codex/sessions")
        rows = []
        for p in directory.rglob("*.jsonl"):
            for line in p.read_text(errors="replace").splitlines():
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass  # A live transcript can have a partially appended last line.
        return rows

    def replies(self, agent):
        result = []
        for row in self.transcripts(agent):
            if agent == "claude" and row.get("type") == "assistant":
                result.extend(b["text"] for b in row.get("message", {}).get("content", []) if b.get("type") == "text")
            p = row.get("payload", {})
            if agent == "codex" and row.get("type") == "response_item" and p.get("type") == "message" and p.get("role") == "assistant":
                result.extend(b.get("text", "") for b in p.get("content", []) if b.get("type") == "output_text")
        return result

    def view(self, label):
        result = self.sno("--json", "squad", check=True)
        (self.root / (label + ".json")).write_text(result.stdout)
        return json.loads(result.stdout)

    def stop_codex(self):
        # Abrupt interruption also stops the private app-server; native hook shutdown can outlive SIGTERM.
        owned = []
        marker = ("CODEX_HOME=" + str(self.home / ".codex")).encode()
        for proc in Path("/proc").iterdir():
            if not proc.name.isdigit():
                continue
            try:
                if marker in (proc / "environ").read_bytes().split(b"\0") and (proc / "comm").read_text().startswith("codex"):
                    owned.append(int(proc.name))
            except (OSError, PermissionError):
                continue
        for pid in owned:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        def exited():
            return all(not (p := Path("/proc") / str(pid) / "stat").exists() or ") Z " in p.read_text()
                       for pid in owned)
        if owned:
            self.until(exited, "private Codex processes stopped before continuation", 15)

    def close(self):
        self.deadline = self.started + 295
        try:
            subprocess.run([self.tmux, "-L", self.server, "kill-server"], capture_output=True, timeout=10)
        finally:
            try:
                self.stop_codex()
            finally:
                if self.codex_proxy:
                    self.codex_proxy.shutdown()
                    self.codex_proxy.server_close()
                for p in self.credentials:
                    p.unlink(missing_ok=True)
                if self.sidecar:
                    try:
                        os.kill(self.sidecar["pid"], signal.SIGTERM)
                    except ProcessLookupError:
                        pass
