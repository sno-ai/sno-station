#!/usr/bin/env bash
# Real loopback transport with separate homes; live-agent acceptance is separate.
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
python3 "$TEST_DIR/network-journey.py" "$REACH" "$WORK" "$@"
