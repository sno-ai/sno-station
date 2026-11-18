#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
export SNO_REACH_ROOT="$STATE" PATH="$WORK:$APP/vendor/bin:$PATH"
participants
remote='worker.remote@reach-isolated-host'
remote_root="$WORK/remote"
export SENT_REMOTE_ROOT="$remote_root" SENT_RECEIVER="$REACH" SENT_OFFLINE="$WORK/offline"
cat >"$WORK/ssh" <<'SH'
#!/bin/bash
set -eu
IFS= read -r version
IFS= read -r op
if [[ "$op" == DELIVER && -e "$SENT_OFFLINE" ]]; then printf 'receiver offline\n' >&2; exit 255; fi
{ printf '%s\n%s\n' "$version" "$op"; cat; } |
    SNO_REACH_RECEIVER_ROOT="$SENT_REMOTE_ROOT" "$SENT_RECEIVER" __receive
SH
chmod +x "$WORK/ssh"
reach init --as "$remote" --name Remote
# The remote preflight checks an existing registration but the local adapter never wakes it.
jq --arg address "$remote" '.address=$address' "$STATE/$RECEIVER/reachable.json" >"$remote_root/$remote/reachable.json"
touch "$SENT_OFFLINE"
id="sent-mixed@$HOST"
card "$id" "$SENDER" "$RECEIVER" decision sent-test "Reply-To: Reports <$OTHER>" |
    sed "s/^To:.*/To: Worker <$RECEIVER>, Remote <$remote>/" >"$WORK/card"
invoke send --as "$SENDER" --no-ring <"$WORK/card"
expect_rc 74
has "$WORK/out" "delivered to $RECEIVER"
has "$WORK/out" "kept in outbox for $remote: receiver offline"
reach sent --as "$SENDER" --work sent-test --json >"$WORK/sent"
jq -e --arg to "$RECEIVER" --arg remote "$remote" '
    any(.[]; .recipient == $to and .placement == "placed" and .tries == "unknown") and
    any(.[]; .recipient == $remote and .placement == "kept-in-outbox" and .answered == "unknown")
' "$WORK/sent" >/dev/null

rm "$SENT_OFFLINE"
invoke flush --as "$SENDER"
expect_rc 0
has "$WORK/out" "delivered to $remote"
[[ "$(header message-id "$remote_root/$remote/new/"*)" == "<$id>" ]]
original="$(message_path "$RECEIVER" "$id")"
reach __try --as "$RECEIVER" --card "$original" --kind pickup
reach reply --as "$RECEIVER" --card "$original" --state accepted <<<accepted
reach reply --as "$RECEIVER" --card "$original" --state completed <<<completed
reach state --work sent-test --json >"$WORK/state-before"
reach sent --as "$SENDER" --work sent-test --json >"$WORK/sent"
jq -e --arg to "$RECEIVER" --arg remote "$remote" '
    any(.[]; .recipient == $to and .placement == "placed" and
        .tries[0].kind == "pickup" and .taker == $to and .accepted != "unknown") and
    any(.[]; .recipient == $remote and .placement == "placed" and .taker == $to and .accepted == "unknown")
' "$WORK/sent" >/dev/null
reach state --work sent-test --json >"$WORK/state-after"
cmp "$WORK/state-before" "$WORK/state-after"
[[ "$(find "$STATE/$SENDER/sent" -type f | wc -l)" == 1 ]]

# The unregistered local call stores its copy but cannot contact a runtime.
call_to="worker.call@$HOST"
initialize "$call_to" Call
rc=0
HOME="$TEST_HOME" XDG_STATE_HOME="$TEST_HOME/.local/state" SNO_REACH_ADDR="$SENDER" \
    "$REACH" call "$call_to" 'mailbox call' --timeout 2 >"$WORK/call" 2>&1 || rc=$?
[[ "$rc" == 5 ]]
reach sent --as "$SENDER" --json >"$WORK/sent"
jq -e --arg to "$call_to" 'any(.[]; .recipient == $to and .subject == "[CALL] instruction" and .placement == "placed")' "$WORK/sent" >/dev/null
pass 'sent shows local and remote placement, tries, taker, reply destination and the call copy'
