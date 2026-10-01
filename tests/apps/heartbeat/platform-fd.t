#!/usr/bin/env bash
set -Eeuo pipefail
app="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../apps/heartbeat" && pwd)"
work="$(mktemp -d)"
export HEARTBEAT_STATE="$work/state" HEARTBEAT_OWNER="platform-fd-$$"
pid=''
cleanup() {
  if [[ -n "$pid" ]]; then
    "$app/bin/heartbeat" --stop fd-local >/dev/null 2>&1 || true
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  printf 'fd proof: %s\n' "$work"
}
trap cleanup EXIT
exec 9>"$work/lock"
flock -n 9
"$app/bin/heartbeat" --interval 1m --label fd-local --max-hours 0.02 -- true >"$work/arm.stdout" 2>"$work/arm.stderr" &
pid=$!
exec 9>&-
# $1 belongs to the bounded child shell.
# shellcheck disable=SC2016
timeout 1 bash -c 'until flock -n "$1" true; do sleep 0.02; done' _ "$work/lock" || {
  printf 'FAIL inherited lock still held after1s\n' >&2; exit 1;
}
kill -0 "$pid"
printf 'PASS live heartbeat releases inherited flock descriptor within1s on Linux\n'
