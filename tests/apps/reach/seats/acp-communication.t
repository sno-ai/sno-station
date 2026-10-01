#!/usr/bin/env bash
set -Eeuo pipefail
exec python3 "$(dirname -- "$0")/test_acp_communication.py" "$@"
