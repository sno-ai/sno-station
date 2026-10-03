#!/usr/bin/env bash
# Read operations leave historical pending wake records and mailbox state untouched.
set -Eeuo pipefail
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
participants
work="read-only-$$"; id="read-only-$$@$HOST"
card "$id" "$SENDER" "$RECEIVER" question "$work" >"$WORK/card"
invoke send --as "$SENDER" --no-ring <"$WORK/card"; expect_rc 0
invoke inbox --as "$RECEIVER"; expect_rc 0
card "read-only-second-$$@$HOST" "$SENDER" "$RECEIVER" question "$work-second" >"$WORK/second-card"
invoke send --as "$SENDER" --no-ring <"$WORK/second-card"; expect_rc 0
invoke inbox --as "$RECEIVER"; expect_rc 0
mkdir -p "$STATE/$RECEIVER/wake-attempts"
pending="$STATE/$RECEIVER/wake-attempts/00000000000000000000000000000001.json"
jq -n --arg root "$STATE" --arg sender "$SENDER" --arg recipient "$RECEIVER" \
  --arg id "<$id>" --arg journey "$work" --arg mechanism "$APP/lib/reach-ring" \
  '{version:1,attempt_id:"00000000000000000000000000000001",root:$root,
    sender:$sender,recipient:$recipient,supervisor:$recipient,message_id:$id,
    journey:$journey,mechanism:$mechanism,mode:"wake",state_owner:$recipient,
    outbox_entry:"",standin:"",outcome_hint:"",started_at:0,last_at:0,attempt:0,
    max_attempts:45,spacing_seconds:120,bound_seconds:5400,child_pid:0,
    child_start_ticks:0,state:"pending",phase:"retry",last_outcome:"busy",
    reachability_state:"registered",escalation_sent:false,escalation_delivered:[],
    outbox_recipients:[],removed_recipients:[]}' >"$pending"
printf '%s\n' '{"event":"historical-pending","attempt_id":"00000000000000000000000000000001"}' \
  >"$STATE/$RECEIVER/wake.log"
for operation in remind state seats log doctor lint export watch; do
  snapshot >"$WORK/before"
  case "$operation" in
    remind) invoke remind --as "$RECEIVER" ;;
    state) invoke state --work "$work" --json ;;
    seats) invoke seats --json ;;
    log) invoke log --as "$RECEIVER" ;;
    doctor) invoke doctor --as "$RECEIVER" ;;
    lint) invoke lint "$WORK/card" ;;
    export) invoke export --work "$work" --output "$WORK/transcript.mbox" ;;
    watch) invoke watch "$RECEIVER" --timeout 1 --idle 1 ;;
  esac
  expect_rc 0
  case "$operation" in
    remind) [[ "$(wc -l <"$WORK/out")" == 2 ]] || fail 'two seen unaccepted work IDs need two reminders' ;;
    state|seats) jq -e . "$WORK/out" >/dev/null ;;
    export) [[ -s "$WORK/transcript.mbox" ]] ;;
  esac
  snapshot >"$WORK/after"; cmp "$WORK/before" "$WORK/after"
  pass "$operation leaves pending wake and entire state tree unchanged"
done
snapshot >"$WORK/before"
invoke export --work "$work" --output "$STATE/forbidden-export.mbox"
[[ "$RC" != 0 ]] || fail 'export accepted a state-root output'
snapshot >"$WORK/after"; cmp "$WORK/before" "$WORK/after"
pass 'export refuses to write into the state root'
