#!/usr/bin/env bash
# Preserve the pinned channel-table cases with public initialized seats.
set -Eeuo pipefail
# shellcheck source=../test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../test-lib.sh"
participants
mkdir -p "$WORK/no-orca-bin"
for tool in awk bash cat cut date dirname env find flock grep head hostname jq mkdir mktemp ps realpath rm sed sha256sum sleep sort stat tail timeout tmux tr uname wc; do
  ln -s "$(command -v "$tool")" "$WORK/no-orca-bin/$tool"
done
ring_without_orca() {
  env -u ORCA_CLI_COMMAND HOME="$TEST_HOME" PATH="$WORK/no-orca-bin" SNO_REACH_ROOT="$STATE" \
    TMUX="$TEST_TMUX" TMUX_PANE="$TEST_PANE" "$APP/lib/reach-ring" \
    doorbell --to "$1" --from "$SENDER" --msg-id "<channel-$$-$RANDOM@$HOST>" >"$WORK/out" 2>"$WORK/err"
}
ring_without_orca "$RECEIVER"
[[ "$(<"$WORK/out")" == outcome=rang ]] || fail "expected confirmed ring, got $(<"$WORK/out")"
ring_without_orca "executor.missing@$HOST"
has "$WORK/out" outcome=unregistered
has "$WORK/err" "register --as executor.missing@$HOST"
[[ ! -e "$STATE/executor.missing@$HOST/reachable.json" ]]
"$APP/lib/reach-reachability" register --root "$STATE" --as "$OTHER" --channel orca \
  --handle unavailable --identity-kind orca-tab --identity unavailable --pid "$$" --host "$HOST" >/dev/null
ring_without_orca "$OTHER"
has "$WORK/out" outcome=no-channel
has "$WORK/err" 'terminal command is unavailable'
jq '.channel="carrier-pigeon"' "$STATE/$OTHER/reachable.json" >"$WORK/unknown-channel"
mv "$WORK/unknown-channel" "$STATE/$OTHER/reachable.json"
ring_without_orca "$OTHER"
has "$WORK/out" outcome=no-channel
has "$WORK/err" carrier-pigeon
pass 'tmux works without Orca; missing registration and unknown/unavailable channels stay distinct'
