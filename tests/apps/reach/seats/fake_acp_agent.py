#!/usr/bin/env python3
"""ACP V1 external adapter fixture for real ACPX command-line conformance."""
import json
import os
from pathlib import Path
import sys

for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if "id" not in request:
        continue
    if method == "initialize":
        result = {"protocolVersion": 1, "agentCapabilities": {"loadSession": True},
                  "agentInfo": {"name": "acp-contract-fixture", "version": "1.0"}, "authMethods": []}
    elif method == "session/new":
        result = {"sessionId": "fixture-provider-session"}
    elif method == "session/prompt":
        prompt = request["params"]["prompt"]
        Path(os.environ["ACP_FIXTURE"], "protocol-received.json").write_text(json.dumps(prompt))
        print(json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {
            "sessionId": request["params"]["sessionId"], "update": {
                "sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "RECEIVED"}}}}), flush=True)
        result = {"stopReason": "end_turn"}
    else:
        result = {}
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
