#!/usr/bin/env bash
# Public call contract; only the external terminal/ACP actor is substituted.
set -Eeuo pipefail

if [[ "${1:-}" == --actor ]]; then
    stty -echo
    printf 'READY mailbox actor\n'
    while IFS= read -r line; do
        printf '%s\n' "$line" >>"$MAIL_CALL_PROOF/input"
        [[ "$line" =~ REACH-RECEIPT-[0-9]+-[0-9]+-[0-9]+ ]] || continue
        receipt="${BASH_REMATCH[0]}"
        [[ "$line" =~ \<[^\>]+\> ]] || exit 21
        message_id="${BASH_REMATCH[0]}"
        found=''
        while IFS=$'\t' read -r path _; do
            [[ "$("$MAIL_CALL_APP/vendor/bin/mhdr" -h message-id "$path")" == "$message_id" ]] || continue
            found="$path"
            break
        done < <("$MAIL_CALL_APP/bin/sno-reach" inbox --as "$MAIL_CALL_RECEIVER")
        [[ -n "$found" ]] || exit 22
        cp "$found" "$MAIL_CALL_PROOF/read-mail"
        [[ -f "$MAIL_CALL_PROOF/timeout" ]] && continue
        [[ ! -f "$MAIL_CALL_PROOF/echo-only" ]] || { printf '%s\n' "$line"; continue; }
        printf '%s\nACTOR-ANSWER\n' "$receipt"
    done
    exit 0
fi

# shellcheck source-path=SCRIPTDIR
# shellcheck source=../test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../test-lib.sh"
initialize "$RECEIVER" Receiver
mkdir -p "$WORK/actor"
export MAIL_CALL_APP="$APP" MAIL_CALL_PROOF="$WORK/actor" MAIL_CALL_RECEIVER="$RECEIVER"
printf -v actor 'env HOME=%q SNO_REACH_ROOT=%q MAIL_CALL_APP=%q MAIL_CALL_PROOF=%q MAIL_CALL_RECEIVER=%q bash %q --actor' \
    "$TEST_HOME" "$STATE" "$APP" "$WORK/actor" "$RECEIVER" "$(realpath -- "$0")"
tmux -L "$SERVER" -f /dev/null new-session -d -s proof "$actor"
TEST_TMUX="$(tmux -L "$SERVER" display-message -p '#{socket_path},#{pid},0')"
pane="$(tmux -L "$SERVER" display-message -p '#{pane_id}')"
TEST_PANE="$pane"
deadline=$((SECONDS + 5))
until tmux -L "$SERVER" capture-pane -p -t "$pane" | grep -q 'READY mailbox actor'; do
    ((SECONDS < deadline)) || fail 'mailbox actor did not start'
    sleep 0.05
done
reach register --as "$RECEIVER" --channel tmux --handle "$pane"
scenario="${1:-all}"
[[ "$scenario" == all || "$scenario" == delivery-failure ]] || fail "unknown scenario: $scenario"

if [[ "$scenario" == all ]]; then
# Preserve trailing newlines in both the shell argument and byte-level expectation.
text=$'BODY-SECRET HANDOFF_RELEASED request-only\nsecond line\n'
for ((i=0; i<120; i++)); do text+="line-$i: a complete instruction containing Unicode café and punctuation ; []"$'\n'; done
text+=$'last line\n\n'
printf '%s' "$text" >"$WORK/expected"
invoke call "$RECEIVER" "$text" --expect '^ACTOR-ANSWER$' --timeout 3 --every 1
expect_rc 0
has "$WORK/out" ACTOR-ANSWER
python3 - "$WORK/actor/read-mail" "$WORK/expected" "$WORK/actor/input" <<'PY'
from pathlib import Path
import sys
mail, expected, typed = map(Path, sys.argv[1:])
assert mail.read_bytes().split(b'\n\nOriginal call text:\n', 1)[1] == expected.read_bytes()
lines = typed.read_text().splitlines()
assert len(lines) == 1 and lines[0].startswith('REACH-RING'), lines
assert 'BODY-SECRET' not in lines[0] and 'HANDOFF_RELEASED' not in lines[0]
assert len(lines[0]) < len(expected.read_bytes())
assert 'inbox --as ' in lines[0] and 'file' in lines[0]
PY
has "$WORK/actor/read-mail" 'X-Type: call'
! grep -q '^X-State:' "$WORK/actor/read-mail" || fail 'call acquired work state'
[[ "$(header from "$WORK/actor/read-mail")" == *"caller.local@$HOST"* ]] || fail 'automatic caller identity is not stable'
[[ -f "$STATE/caller.local@$HOST/seat.json" && ! -e "$STATE/caller.local@$HOST/reachable.json" ]] || fail 'automatic caller registered an agent or lacked identity'
work="$(header x-work "$WORK/actor/read-mail")"
invoke state --work "$work" --json
expect_rc 0
[[ ! -s "$WORK/out" ]] || fail 'call appears as owned work'
invoke inbox --as "$RECEIVER"
expect_rc 0
has "$WORK/out" '[CALL]'
mail="$(find "$STATE/$RECEIVER/new" -type f | head -1)"
invoke dismiss --as "$RECEIVER" --card "$mail" --reason acknowledged
expect_rc 0
handled="$(cat "$WORK/out")"
cmp "$WORK/actor/read-mail" "$handled" || fail 'dismiss changed call bytes'
pass 'exact long multiline payload precedes one short cue, auto caller, inbox, dismiss and no ownership'

# A marker present only in the stored request is never a receiver answer.
touch "$WORK/actor/echo-only"
invoke call "$RECEIVER" 'ACTOR-ANSWER HANDOFF_RELEASED request-only' --expect ACTOR-ANSWER --timeout 1 --every 1
expect_rc 4
has "$WORK/err" "$RECEIVER"
has "$WORK/err" 'stored'
rm "$WORK/actor/echo-only"
callers="$(find "$STATE" -mindepth 1 -maxdepth 1 -type d -name 'caller.*' | wc -l)"
[[ "$callers" == 1 ]] || fail 'direct calls created repeated sender identities'
pass 'stored request text cannot satisfy expectation; repeated calls reuse caller'

# No implicit second Enter is sent on a mailbox call, even without a response.
touch "$WORK/actor/timeout"
before="$(wc -l <"$WORK/actor/input")"
invoke call "$RECEIVER" 'Persist through observation timeout.' --expect NEVER --timeout 2 --every 1
expect_rc 4
has "$WORK/err" 'stored'
[[ "$(wc -l <"$WORK/actor/input")" == "$((before + 1))" ]] || fail 'mailbox call submitted extra input'
rm "$WORK/actor/timeout"
pass 'timeout retains delivery and submits once'

# Literal raw mode has no mailbox or receipt semantics.
before="$(find "$STATE/$RECEIVER/new" "$STATE/$RECEIVER/cur" -type f | wc -l)"
invoke call "$RECEIVER" 'RAW-LITERAL ; Enter' --raw
expect_rc 0
has "$WORK/out" "typed $RECEIVER"
[[ "$(find "$STATE/$RECEIVER/new" "$STATE/$RECEIVER/cur" -type f | wc -l)" == "$before" ]] || fail 'raw created mail'
deadline=$((SECONDS + 3))
until grep -Fxq 'RAW-LITERAL ; Enter' "$WORK/actor/input"; do
    ((SECONDS < deadline)) || fail 'raw literal did not arrive'
    sleep 0.05
done
pass 'raw still types literal text without mail'

# An actual draft in another private terminal must survive without any submit.
printf -v busy_actor 'printf "❯ "; exec cat'
busy_pane="$(tmux -L "$SERVER" new-window -d -P -F '#{pane_id}' -t proof "$busy_actor")"
busy="worker.busy@$HOST"
initialize "$busy" Busy
reach register --as "$busy" --channel tmux --handle "$busy_pane"
tmux -L "$SERVER" send-keys -t "$busy_pane" -l -- 'unfinished-person-draft'
sleep 0.1
tmux -L "$SERVER" capture-pane -p -t "$busy_pane" >"$WORK/busy-before"
invoke call "$busy" 'BUSY-BODY-SECRET' --timeout 1 --every 1
expect_rc 3
has "$WORK/err" 'stored'
tmux -L "$SERVER" capture-pane -p -t "$busy_pane" >"$WORK/busy-after"
cmp "$WORK/busy-before" "$WORK/busy-after" || fail 'busy call changed input'
grep -rq 'BUSY-BODY-SECRET' "$STATE/$busy/new" || fail 'busy call lost mail'
pass 'busy draft untouched while full mail persists'

missing="worker.unregistered@$HOST"
initialize "$missing" Unregistered
invoke call "$missing" 'UNREGISTERED-SAVED' --timeout 1 --every 1
expect_rc 5
has "$WORK/err" 'stored'
grep -rq 'UNREGISTERED-SAVED' "$STATE/$missing/new" || fail 'missing channel lost mail'
for channel in orca cursor-ide; do
    address="worker.$channel@$HOST"
    initialize "$address" Unsupported
    jq -n --arg address "$address" --arg channel "$channel" '{address:$address,channel:$channel,handle:"fixture",identity:{kind:"fixture",value:"fixture"}}' >"$STATE/$address/reachable.json"
    invoke call "$address" 'UNSUPPORTED-SAVED' --timeout 1 --every 1
    expect_rc 3
    has "$WORK/err" 'stored'
    grep -rq 'UNSUPPORTED-SAVED' "$STATE/$address/new" || fail 'unsupported channel lost mail'
done
pass 'missing and unsupported synchronous channels retain readable mail'
fi

# A real filesystem delivery failure must not notify the live receiver.
initialize "$SENDER" Sender
touch "$WORK/actor/input"
before="$(wc -l <"$WORK/actor/input")"
mv "$STATE/$RECEIVER/new" "$STATE/$RECEIVER/new-held"
printf 'not a directory\n' >"$STATE/$RECEIVER/new"
RC=0
env HOME="$TEST_HOME" SNO_REACH_ROOT="$STATE" SNO_REACH_ADDR="$SENDER" TMUX="$TEST_TMUX" \
    "$REACH" call "$RECEIVER" 'STORAGE-FAILURE-MUST-NOT-TYPE' --timeout 1 --every 1 >"$WORK/out" 2>"$WORK/err" || RC=$?
[[ "$RC" != 0 ]] || fail 'failed storage returned success'
has "$WORK/err" "$RECEIVER"
[[ "$(wc -l <"$WORK/actor/input")" == "$before" ]] || fail 'storage failure notified receiver'
saved=''
for path in "$STATE/$SENDER/tmp/"*; do
    [[ -f "$path" ]] || continue
    if grep -Fq 'STORAGE-FAILURE-MUST-NOT-TYPE' "$path"; then saved="$path"; break; fi
done
[[ -n "$saved" ]] || fail 'failed delivery discarded saved bytes'
has "$WORK/err" "$saved"
rm "$STATE/$RECEIVER/new"
mv "$STATE/$RECEIVER/new-held" "$STATE/$RECEIVER/new"
RC=0
env HOME="$TEST_HOME" SNO_REACH_ROOT="$STATE" SNO_REACH_ADDR="$SENDER" TMUX="$TEST_TMUX" \
    "$REACH" call "$RECEIVER" 'EXPLICIT-SENDER-SUCCESS' --expect '^ACTOR-ANSWER$' --timeout 3 --every 1 >"$WORK/out" 2>"$WORK/err" || RC=$?
expect_rc 0
[[ "$(header from "$WORK/actor/read-mail")" == *"$SENDER"* ]] || fail 'call ignored explicit sender identity'
[[ -f "$saved" ]] || fail 'subsequent successful call discarded failed bytes'
pass 'actual delivery failure retains named saved bytes without cue; explicit sender survives later success'
[[ "$scenario" != delivery-failure ]] || exit 0

# ACP assistant chunks retain the same storage/cue contract; transport fixture only.
mkdir -p "$WORK/bin" "$WORK/acp"
ln -s "$TEST_DIR/seats/fake_acpx.py" "$WORK/bin/acpx"
printf 'reply' >"$WORK/acp/mode"
touch "$WORK/acp/events.ndjson"
acp="worker.acp@$HOST"
initialize "$acp" Adapter
PATH="$WORK/bin:$PATH" ACP_FIXTURE="$WORK/acp" reach register --as "$acp" --channel acp --handle "acp-codex:$WORK/acp:probe"
RC=0
PATH="$WORK/bin:$PATH" ACP_FIXTURE="$WORK/acp" reach call "$acp" 'ACP-BODY-SECRET' --expect RESULT-42 --timeout 2 --every 1 >"$WORK/out" 2>"$WORK/err" || RC=$?
expect_rc 0
has "$WORK/out" RESULT-42
python3 - "$WORK/acp/received.json" <<'PY'
import json, sys
cue=json.load(open(sys.argv[1]))['text']
assert cue.startswith('REACH-RING') and 'ACP-BODY-SECRET' not in cue, cue
PY
grep -rq 'ACP-BODY-SECRET' "$STATE/$acp/new" || fail 'ACP did not persist text'
printf 'echo' >"$WORK/acp/mode"
RC=0
PATH="$WORK/bin:$PATH" ACP_FIXTURE="$WORK/acp" reach call "$acp" 'RESULT-42' --expect RESULT-42 --timeout 1 --every 1 >"$WORK/out" 2>"$WORK/err" || RC=$?
expect_rc 4
pass 'ACP cue and assistant-only receipt return; user chunks never verify'
