#!/usr/bin/env bash
# Historical 2.0.x worker regression, excluded from the current test inventory.
# Current notification behavior is covered by notification-once.t.
set -Eeuo pipefail
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"

participants
export SNO_REACH_WAKE_STANDIN="$TEST_DIR/fixtures/wake-standin.sh"
export SNO_REACH_WAKE_OUTCOME=busy
export SNO_REACH_WAKE_SPACING_SECONDS=1
export SNO_REACH_WAKE_ATTEMPTS=10

status_id="status-$$@$HOST"
cc_status_id="cc-status-$$@$HOST"
info_id="info-$$@$HOST"
cc_question_id="cc-question-$$@$HOST"
action_id="action-$$@$HOST"
card "$status_id" "$SENDER" "$RECEIVER" status "wake-once-$$" >"$WORK/status"
printf 'From: Sender <%s>\nCc: Observer <%s>\nDate: %s\nSubject: [STATUS] Cc wake once\nMessage-ID: <%s>\nX-Type: status\nX-Work: wake-once-%s\n\nStatus only.\n' \
  "$SENDER" "$OTHER" "$(date -R)" "$cc_status_id" "$$" >"$WORK/cc-status"
printf 'From: Sender <%s>\nCc: Observer <%s>\nDate: %s\nSubject: [FYI] Wake once\nMessage-ID: <%s>\nX-Type: info\nX-Work: wake-once-%s\n\nInformation only.\n' \
  "$SENDER" "$OTHER" "$(date -R)" "$info_id" "$$" >"$WORK/info"
printf 'From: Sender <%s>\nCc: Observer <%s>\nDate: %s\nSubject: [QUESTION] Cc wake once\nMessage-ID: <%s>\nX-Type: question\nX-Work: wake-once-%s\n\nFor information only.\n' \
  "$SENDER" "$OTHER" "$(date -R)" "$cc_question_id" "$$" >"$WORK/cc-question"

invoke send --as "$SENDER" <"$WORK/status"; expect_rc 0
SNO_REACH_WAKE_OUTCOME=failed invoke send --as "$SENDER" <"$WORK/cc-status"; expect_rc 0
invoke send --as "$SENDER" <"$WORK/info"; expect_rc 0
invoke send --as "$SENDER" <"$WORK/cc-question"; expect_rc 0
sleep 3

for entry in "$status_id:$RECEIVER:1" "$cc_status_id:$OTHER:0" "$info_id:$OTHER:0" "$cc_question_id:$OTHER:0"; do
  IFS=: read -r id recipient expected <<<"$entry"
  log="$STATE/$recipient/wake.log"
  count=0
  [[ ! -f "$log" ]] || count="$(jq -s --arg id "<$id>" '[.[] | select(.message_id == $id and .event == "attempt")] | length' "$log")"
  [[ "$count" == "$expected" ]] || fail "<$id> had $count wake attempts, expected $expected"
done
pass 'To status rings once and Cc-only copies never ring'

card "$action_id" "$SENDER" "$RECEIVER" question "wake-once-$$" >"$WORK/action"
invoke send --as "$SENDER" <"$WORK/action"; expect_rc 0
sleep 2
log="$STATE/$RECEIVER/wake.log"
before="$(jq -s --arg id "<$action_id>" '[.[] | select(.message_id == $id and .event == "attempt")] | length' "$log")"
((before >= 2)) || fail "unopened action had only $before wake attempt(s)"
invoke inbox --as "$RECEIVER"; expect_rc 0
has "$WORK/out" "$action_id"
before="$(jq -s --arg id "<$action_id>" '[.[] | select(.message_id == $id and .event == "attempt")] | length' "$log")"
sleep 2
after="$(jq -s --arg id "<$action_id>" '[.[] | select(.message_id == $id and .event == "attempt")] | length' "$log")"
[[ "$after" == "$before" ]] || fail "opened action kept ringing: $before then $after"
pass 'To action retries before inbox pickup and stops after pickup'

# An answer picked up with `wait --reply-to` stops ringing, like one read through inbox.
question_id="wait-question-$$@$HOST"
card "$question_id" "$RECEIVER" "$SENDER" question "wake-once-$$" >"$WORK/wait-question"
invoke send --as "$RECEIVER" <"$WORK/wait-question"; expect_rc 0
question_path="$(message_path "$SENDER" "$question_id")"
printf 'Accepted.\n' | reach reply --as "$SENDER" --card "$question_path" --state accepted >"$WORK/out" 2>"$WORK/err" || { cat "$WORK/err" >&2; fail "accept reply failed"; }
printf 'Done.\n' | reach reply --as "$SENDER" --card "$question_path" --state completed >"$WORK/out" 2>"$WORK/err" || { cat "$WORK/err" >&2; fail "completed reply failed"; }
sleep 2
invoke wait --as "$RECEIVER" --reply-to "<$question_id>" --timeout 5 --every 1; expect_rc 0
answer_path="$(tr -d '\n' <"$WORK/out")"
answer_id="$(header message-id "$answer_path")"; answer_id="${answer_id#<}"; answer_id="${answer_id%>}"
log="$STATE/$RECEIVER/wake.log"
before="$(jq -s --arg id "<$answer_id>" '[.[] | select(.message_id == $id and .event == "attempt")] | length' "$log")"
sleep 3
after="$(jq -s --arg id "<$answer_id>" '[.[] | select(.message_id == $id and .event == "attempt")] | length' "$log")"
[[ "$after" == "$before" ]] || fail "answer picked up by wait kept ringing: $before then $after"
pass 'An answer picked up by wait --reply-to stops ringing'
