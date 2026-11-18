#!/usr/bin/env bash
set -Eeuo pipefail
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
export SNO_PROFILE_DIR="$WORK/profile" SNO_REACH_RING_LOG="$WORK/rings.jsonl"
unset ORCA_TAB_ID
initialize "$RECEIVER" Worker
register "$RECEIVER"
invoke whoami; expect_rc 0
[[ "$(<"$WORK/out")" == "$RECEIVER" ]] || fail 'whoami did not resolve the registered tmux pane'

(
    registered_pane="$TEST_PANE"
    socket="$WORK/unregistered.sock"
    trap 'tmux -S "$socket" kill-server 2>/dev/null || true' EXIT
    tmux -S "$socket" -f /dev/null new-session -d -s proof cat
    TEST_TMUX="$(tmux -S "$socket" display-message -p '#{socket_path},#{pid},0')"
    TEST_PANE="$(tmux -S "$socket" new-window -d -P -F '#{pane_id}' -t proof cat)"
    [[ "$TEST_PANE" == "$registered_pane" ]] || fail 'the two tmux servers did not assign the same pane number'
    invoke whoami; expect_rc 1
    [[ ! -s "$WORK/out" ]] || fail 'an unregistered tmux pane emitted an address from another tmux server'
)

initialize "$OTHER" Observer
# This fixture is the registration shape written by Reach for an existing Orca tab.
jq -n --arg address "$OTHER" --arg host "$HOST" --argjson pid "$$" --arg at "$(date -u '+%FT%TZ')" '
  {address:$address, channel:"orca", handle:"term-whoami", identity:{kind:"orca-tab",value:"tab-whoami"},
   by:{pid:$pid,host:$host}, claimed_at:$at, refreshed_at:$at}
' >"$STATE/$OTHER/reachable.json"
TEST_PANE=''
ORCA_TAB_ID=tab-whoami invoke whoami; expect_rc 0
[[ "$(<"$WORK/out")" == "$OTHER" ]] || fail 'whoami did not resolve the registered Orca tab'

TEST_PANE="$(tmux -L "$SERVER" new-window -d -P -F '#{pane_id}' -t proof cat)"
ORCA_TAB_ID=tab-whoami invoke whoami; expect_rc 1
[[ ! -s "$WORK/out" ]] || fail 'an unregistered tmux pane emitted an address for an Orca tab'
TEST_PANE=''

address="$(SNO_REACH_ROOT="$STATE" SNO_REACH_ADDR="$SENDER" ORCA_TAB_ID=tab-whoami "$REACH" whoami)"
[[ "$address" == "$SENDER" ]] || fail 'explicit seat did not take precedence'
ORCA_TAB_ID=unregistered invoke whoami; expect_rc 1
[[ ! -s "$WORK/out" ]] || fail 'unregistered session emitted a seat'
pass 'whoami resolves explicit, tmux and Orca seats, and prints nothing for an unregistered session'
