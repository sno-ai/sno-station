#!/usr/bin/env bash
# Registration replaces ambient pane scans. Preserve real pane death/incarnation
# safety; matching arbitrary paths/titles/branches is not a public Reach contract.
set -Eeuo pipefail
# shellcheck source=../test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../test-lib.sh"
participants
invoke ring "$RECEIVER"
expect_rc 0
has "$WORK/out" rang
receiver_pane="$(jq -r .identity.value "$STATE/$RECEIVER/reachable.json")"
tmux -L "$SERVER" capture-pane -p -t "$receiver_pane" -S - >"$WORK/pane"
grep -q '^REACH-RING' "$WORK/pane" || fail 'actual receiver pane did not show ring line'
invoke ring "worker.never-registered@$HOST"
expect_rc 1
has "$WORK/out" unregistered
invoke seats --json
expect_rc 0
jq -se 'length == 3 and all(.[]; .channel == "tmux" and .state == "live" and (.handle | startswith("tmux-")))' "$WORK/out" >/dev/null
jq --argjson old "$(($(date +%s) - 901))" '.claimed_at=$old | .refreshed_at=$old' "$STATE/$OTHER/reachable.json" >"$WORK/stale"
mv "$WORK/stale" "$STATE/$OTHER/reachable.json"
invoke seats --json
expect_rc 0
jq -se --arg other "$OTHER" 'length == 3 and any(.[]; .address == $other and .state == "stale")' "$WORK/out" >/dev/null
card "stale-delivery-$$@$HOST" "$SENDER" "$OTHER" question stale >"$WORK/card"
invoke send --as "$SENDER" --no-ring <"$WORK/card"
expect_rc 0
message_path "$OTHER" "stale-delivery-$$@$HOST" >/dev/null
reach unregister --as "$OTHER"
invoke seats --json
expect_rc 0
jq -se 'length == 2' "$WORK/out" >/dev/null

pane="$(jq -r .identity.value "$STATE/$RECEIVER/reachable.json")"
tmux -L "$SERVER" set-option -w -t "$pane" remain-on-exit on
tmux -L "$SERVER" respawn-pane -k -t "$pane" true
deadline=$((SECONDS + 5))
until [[ "$(tmux -L "$SERVER" display-message -p -t "$pane" '#{pane_dead}')" == 1 ]]; do
  ((SECONDS < deadline)) || fail 'fixture pane did not exit'
  sleep 0.05
done
invoke call "$RECEIVER" 'No actor may receive this.' --timeout 1 --every 1
[[ "$RC" != 0 ]] || fail 'dead retained pane accepted a call'
RC=0
timeout 3 env HOME="$TEST_HOME" SNO_REACH_ROOT="$STATE" TMUX="$TEST_TMUX" \
  "$REACH" ring "$RECEIVER" >"$WORK/out" 2>"$WORK/err" || RC=$?
expect_rc 1
has "$WORK/out" failed

# Reuse the exact pane identifier in a newly created private server.
tmux -L "$SERVER" kill-server
sleep 0.3
tmux -L "$SERVER" -f /dev/null new-session -d -s proof cat
TEST_TMUX="$(tmux -L "$SERVER" display-message -p '#{socket_path},#{pid},0')"
while ! tmux -L "$SERVER" list-panes -a -F '#{pane_id}' | grep -Fxq -- "$pane"; do
  tmux -L "$SERVER" new-window -d -t proof cat
done
tmux -L "$SERVER" capture-pane -p -t "$pane" >"$WORK/before"
invoke call "$RECEIVER" 'Wrong incarnation must receive nothing.' --timeout 1 --every 1
expect_rc 5
tmux -L "$SERVER" capture-pane -p -t "$pane" >"$WORK/after"
cmp "$WORK/before" "$WORK/after"
pass 'registered seats list, stale age, unregister, dead pane and reused-server identity'
