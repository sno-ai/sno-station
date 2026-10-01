#!/usr/bin/env bash
# Run the preserved behavioural suites against this repository's application.
set -Eeuo pipefail
export LC_ALL=C
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd -- "$HERE/../../../apps/heartbeat" && pwd)"
export HEARTBEAT="$APP/bin/heartbeat"

printf 'TAP version 13\n'
count=0
for suite in heartbeat registry; do
  if ! bash "$HERE/$suite.t"; then
    printf 'FAIL %s.t\n' "$suite" >&2
    exit 1
  fi
  count=$((count + 1))
done
printf '1..%s\nheartbeat selftest: ALL PASS (%s stage(s))\n' "$count" "$count"
