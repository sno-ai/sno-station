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

# A hook can run with TMUX_PANE set and TMUX unset; under LC_ALL=C tmux 3.4 then prints "_" for a
# tab in its output, so the seat must be found without one.
(
    export TMUX_TMPDIR="$WORK/plain"
    mkdir "$TMUX_TMPDIR"
    trap 'env -u TMUX tmux kill-server 2>/dev/null || true' EXIT
    env -u TMUX tmux -f /dev/null new-session -d -s plain cat
    plain="plain.seat@$HOST"
    initialize "$plain" Plain
    pane="$(env -u TMUX tmux display-message -p -t plain '#{pane_id}')"
    server="$(printf '%s\t%s\n' "$(env -u TMUX tmux display-message -p -t plain '#{socket_path}')" "$(env -u TMUX tmux display-message -p -t plain '#{pid}')" | sha256sum | cut -d ' ' -f1)"
    jq -n --arg address "$plain" --arg host "$HOST" --argjson pid "$$" --arg at "$(date -u '+%FT%TZ')" \
      --arg handle "tmux-$server:plain" --arg pane "$pane" '
      {address:$address, channel:"tmux", handle:$handle, identity:{kind:"tmux-pane",value:$pane},
       by:{pid:$pid,host:$host}, claimed_at:$at, refreshed_at:$at}
    ' >"$STATE/$plain/reachable.json"
    address="$(env -u TMUX -u SNO_REACH_ADDR -u ORCA_TAB_ID HOME="$TEST_HOME" SNO_REACH_ROOT="$STATE" TMUX_PANE="$pane" "$REACH" whoami)" ||
      fail 'whoami found no seat for a pane when TMUX is unset'
    [[ "$address" == "$plain" ]] || fail "whoami printed $address for the pane of $plain"
)
pass 'whoami resolves a tmux seat when only TMUX_PANE is set'

# Codex runs the tools and hooks of every window under one app-server, whose terminal variables belong
# to the window that started it: there a conversation is its thread, never the pane in TMUX_PANE.
(
    mkdir "$WORK/fake-codex"
    printf '#!/bin/bash\nshift\n"$@"\n' >"$WORK/fake-codex/codex"
    chmod +x "$WORK/fake-codex/codex"
    thread_seat="thread.seat@$HOST"
    initialize "$thread_seat" Thread
    handle="codex:01a20b46-c94d-7152-8829-fdd5e6c914c6:L2hvbWUvbGgvLmNvZGV4"
    jq -n --arg address "$thread_seat" --arg host "$HOST" --argjson pid "$$" --arg at "$(date -u '+%FT%TZ')" \
      --arg handle "$handle" '
      {address:$address, channel:"terminal", handle:$handle, identity:{kind:"terminal",value:$handle},
       by:{pid:$pid,host:$host}, claimed_at:$at, refreshed_at:$at}
    ' >"$STATE/$thread_seat/reachable.json"
    under() { # role thread -- the pane of $RECEIVER is in TMUX_PANE, as in the app-server's environment
        env -u SNO_REACH_ADDR -u ORCA_TAB_ID HOME="$TEST_HOME" SNO_REACH_ROOT="$STATE" \
          TMUX="$TEST_TMUX" TMUX_PANE="$(jq -r .identity.value "$STATE/$RECEIVER/reachable.json")" \
          CODEX_THREAD_ID="$2" "$WORK/fake-codex/codex" "$1" "$REACH" whoami
    }
    address="$(under app-server 01a20b46-c94d-7152-8829-fdd5e6c914c6)" || fail 'whoami found no seat for a joined Codex thread'
    [[ "$address" == "$thread_seat" ]] || fail "a Codex thread resolved to $address instead of its own seat"
    if address="$(under app-server 01a20b46-0000-7000-8000-000000000000)"; then
        fail "a Codex thread with no seat under the app-server took $address from the pane variables"
    fi
    address="$(under tui 01a20b46-0000-7000-8000-000000000000)" || fail 'a Codex window outside the app-server lost its pane seat'
    [[ "$address" == "$RECEIVER" ]] || fail "a Codex window outside the app-server resolved to $address"
)
pass 'whoami identifies a Codex conversation by its thread and ignores the app-server window variables'
