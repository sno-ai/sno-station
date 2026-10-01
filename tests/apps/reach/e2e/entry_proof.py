"""Bounded validation of actual ACP shell tool calls, never assistant prose."""
import json
import re


def records(text):
    # Only an unterminated last record may still be streaming.
    lines = text.splitlines(keepends=True)
    return [json.loads(line) for line in lines if line.endswith("\n")]


def commands(rows):
    result = []
    for row in rows:
        payload = row.get("payload", {})
        item = payload.get("item", {})
        if row.get("type") == "event_msg" and payload.get("type") == "item_completed" and item.get("type") == "CommandExecution":
            argv = item.get("command", [])
            if len(argv) == 3 and argv[1] in ("-lc", "-c") and all(isinstance(arg, str) for arg in argv):
                result.append(argv[2])
        if row.get("type") == "response_item" and payload.get("type") == "function_call":
            try:
                arguments = json.loads(payload.get("arguments", ""))
            except json.JSONDecodeError:
                continue
            if isinstance(arguments, dict) and isinstance(arguments.get("cmd"), str):
                result.append(arguments["cmd"])
        if row.get("type") == "assistant":
            # Claude session file: the Bash tool's input carries the command.
            for item in row.get("message", {}).get("content", []):
                if isinstance(item, dict) and item.get("type") == "tool_use" and item.get("name") == "Bash":
                    if isinstance(item.get("input", {}).get("command"), str):
                        result.append(item["input"]["command"])
        update = row.get("params", {}).get("update", {})
        # Claude over ACP sends an empty rawInput on tool_call and the command on tool_call_update.
        if update.get("sessionUpdate") not in ("tool_call", "tool_call_update"):
            continue
        raw = update.get("rawInput")
        if isinstance(raw, dict) and isinstance(raw.get("command"), str):
            result.append(raw["command"])
    return result


def validate(observed, verb):
    if any(re.search(r"/[^\s'\"]*/sno-reach(?=[\s'\";]|$)", command) for command in observed):
        raise AssertionError("native tool bypassed public PATH with an absolute sno-reach executable")
    # Only the observed plain public command form is admitted. Shell aliases,
    # substitutions and arbitrary scripts are not reconstructed as proof.
    prefix = r"(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]+[ \t]+)*"
    matching = [command for command in observed if re.search(
        r"(?m)(?:^|\|[ \t]*)" + prefix + r"sno reach " + re.escape(verb) + r"(?:\s|$)", command)]
    if not matching:
        raise AssertionError("cannot determine actual public " + verb + " entry from native tool commands")
    return matching
