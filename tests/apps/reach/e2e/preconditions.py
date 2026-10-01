"""Pure predicates shared by Chapter0 and its non-live refusal calibration."""
from live_support import FORBIDDEN


def environment(env, home):
    if any(key in env for key in FORBIDDEN):
        raise RuntimeError("forbidden override or trace variable present")
    if env.get("CODEX_HOME") != str(home / ".codex") or env.get("CLAUDE_CONFIG_DIR") != str(home / ".claude"):
        raise RuntimeError("runtime config root is not private")


def credential(data, name, mode, symlink):
    if symlink or mode != 0o600:
        raise RuntimeError("credential copy is not a private regular0600 file")
    if name == "auth.json" and (data.get("auth_mode") != "chatgpt" or not isinstance(data.get("tokens"), dict) or not data["tokens"]):
        raise RuntimeError("Codex subscription credentials missing")
    if name == ".credentials.json" and not data.get("claudeAiOauth", {}).get("accessToken"):
        raise RuntimeError("Claude subscription OAuth missing")
    def paid(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if "api" in key.lower() and "key" in key.lower() and item:
                    raise RuntimeError("paid API key material refused")
                paid(item)
        elif isinstance(value, list):
            for item in value:
                paid(item)
    paid(data)


def ttl(value):
    if value.get("ttl") != 0:
        raise RuntimeError("private ACP session ttl is not0")


def project_trust(value, paths, mode, symlink):
    expected = {path: {"trust_level": "trusted"} for path in paths}
    allowed = {"projects": expected}
    if "tui" in value:
        nux = value["tui"].get("model_availability_nux", {})
        if set(value["tui"]) != {"model_availability_nux"} or set(nux) != {"gpt-6-astra"} or type(nux["gpt-6-astra"]) is not int or nux["gpt-6-astra"] < 0:
            raise RuntimeError("unexpected private native UI config")
        allowed["tui"] = value["tui"]
    if value != allowed or symlink or mode != 0o600:
        raise RuntimeError("private Codex config must trust only the exact declared actor cwd set")


def calibrate(home):
    results = []
    env = {"CODEX_HOME": str(home / ".codex"), "CLAUDE_CONFIG_DIR": str(home / ".claude")}
    environment(env, home)
    good = {"auth_mode": "chatgpt", "tokens": {"access_token": "synthetic"}}
    credential(good, "auth.json", 0o600, False)
    credential({"claudeAiOauth": {"accessToken": "synthetic"}}, ".credentials.json", 0o600, False)
    ttl({"ttl": 0})
    paths = [str(home.parent / "work/actor")]
    trust = {"projects": {paths[0]: {"trust_level": "trusted"}}}
    project_trust(trust, paths, 0o600, False)
    cases = [
        ("paid-env", lambda: environment({**env, "OPENAI_API_KEY": "synthetic"}, home)),
        ("shared-root", lambda: environment({**env, "CODEX_HOME": "/outside/private-home"}, home)),
        ("missing-subscription", lambda: credential({}, "auth.json", 0o600, False)),
        ("paid-credential", lambda: credential({**good, "OPENAI_API_KEY": "synthetic"}, "auth.json", 0o600, False)),
        ("readable-by-others", lambda: credential(good, "auth.json", 0o644, False)),
        ("symlink-credential", lambda: credential(good, "auth.json", 0o600, True)),
        ("missing-oauth", lambda: credential({}, ".credentials.json", 0o600, False)),
        ("idle-cleanup-enabled", lambda: ttl({"ttl": 300})),
        ("missing-trust", lambda: project_trust({}, paths, 0o600, False)),
        ("broad-trust", lambda: project_trust({"projects": {"/tmp": {"trust_level": "trusted"}}}, paths, 0o600, False)),
        ("untrusted-work", lambda: project_trust({"projects": {paths[0]: {"trust_level": "untrusted"}}}, paths, 0o600, False)),
    ]
    for name, action in cases:
        try:
            action()
        except RuntimeError as error:
            results.append(dict(case=name, refused=str(error)))
        else:
            raise AssertionError(f"calibration missed {name}")
    return results
