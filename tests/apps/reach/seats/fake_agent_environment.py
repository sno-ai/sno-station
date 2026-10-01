#!/usr/bin/env python3
"""Integration-only agent process: record bootstrap context, never perform agent work."""
import json
import os
from pathlib import Path
import sys
import time

Path(os.environ["ACP_FIXTURE"], "agent-environment.json").write_text(json.dumps({
    "argv": sys.argv[1:],
    "env": {key: os.environ.get(key) for key in ("SNO_REACH_ADDR", "SNO_REACH_ROOT", "SNO_REACH_GUIDE")},
}))
time.sleep(60)
