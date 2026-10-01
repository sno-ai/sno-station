#!/usr/bin/env bash
# The real macOS inherited-descriptor branch, before and after the port.
set -Eeuo pipefail
[[ $(uname -s) == Darwin ]] || { printf 'macOS host required\n' >&2; exit 2; }
mode="${1:?expected baseline or fixed}"
[[ $mode == baseline || $mode == fixed ]] || exit 2
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
program="${HEARTBEAT:-$here/../../../apps/heartbeat/bin/heartbeat}"
work="$(mktemp -d "$PWD/.platform-fd.XXXXXX")"
export HEARTBEAT_STATE="$work/state" HEARTBEAT_OWNER=platform-fd
exec 9>"$work/lock"
flock 9
"$program" --interval 1m --label fd-e2e --max-hours 0.05 --log "$work/ticks.log" -- true >"$work/arm.log" 2>&1 &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null || true; wait "$pid" || true' EXIT
exec 9>&-
sleep 1
kill -0 "$pid"
lock_status=0
flock -n "$work/lock" true || lock_status=$?
printf 'host=%s mode=%s pid=%s inherited_lock_exit=%s evidence=%s\n' "$(hostname)" "$mode" "$pid" "$lock_status" "$work"
if [[ $mode == baseline ]]; then
  [[ $lock_status != 0 ]] || { printf 'Expected baseline inherited lock failure\n' >&2; exit 1; }
  printf 'CAUSAL RED: baseline heartbeat retained the inherited lock\n'
else
  [[ $lock_status == 0 ]] || { printf 'Inherited lock was not released within one second\n' >&2; exit 1; }
  printf 'GREEN: inherited lock released within one second\n'
fi
