#!/usr/bin/env bash
# Adapted from old mixed-To/notice tests: one public preflight precedes all effects.
set -Eeuo pipefail
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
participants
unregistered="worker.unregistered@$HOST"
initialize "$unregistered" Unregistered
mkdir -p "$STATE/$RECEIVER/wake-attempts"
pending="$STATE/$RECEIVER/wake-attempts/00000000000000000000000000000001.json"
jq -n --arg root "$STATE" --arg sender "$OTHER" --arg recipient "$RECEIVER" \
  --arg id "<unrelated-preflight-$$@$HOST>" --arg journey "unrelated" --arg mechanism "$APP/lib/reach-ring" \
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
[[ -f "$pending" ]] || fail 'unrelated pending fixture is missing'
jq -e '.state == "pending"' "$pending" >/dev/null
sha256sum "$pending" "$STATE/$RECEIVER/wake.log" >"$WORK/pending-before"
id="preflight-$$@$HOST"
card "$id" "$SENDER" "$RECEIVER" question preflight >"$WORK/card"
sed "s/^To:.*/To: Fixture <$RECEIVER>, Fixture <$unregistered>/" "$WORK/card" >"$WORK/mixed"
snapshot >"$WORK/before"
invoke send --as "$SENDER" <"$WORK/mixed"
[[ "$RC" != 0 ]] || fail 'mixed To with unregistered destination accepted'
has "$WORK/err" "register --as $unregistered"
has "$WORK/err" --channel; has "$WORK/err" --handle
snapshot >"$WORK/after"; cmp "$WORK/before" "$WORK/after"
pass 'one unregistered To refuses all delivery before any state write'

for malformed in blank invalid-to missing-header old-header; do
  case "$malformed" in
    blank) sed '/^$/,$d' "$WORK/card" >"$WORK/invalid"; printf '\n \t\n' >>"$WORK/invalid" ;;
    invalid-to) sed 's/^To:.*/To: Team Lead.x@host/' "$WORK/card" >"$WORK/invalid" ;;
    missing-header) sed '/^Message-ID:/d' "$WORK/card" >"$WORK/invalid" ;;
    old-header) sed 's/^X-Work:/X-Journey:/' "$WORK/card" >"$WORK/invalid" ;;
  esac
  snapshot >"$WORK/before"
  invoke send --as "$SENDER" <"$WORK/invalid"
  [[ "$RC" != 0 ]] || fail "$malformed input accepted"
  if [[ "$malformed" == invalid-to ]]; then has "$WORK/err" 'rule='; fi
  if [[ "$malformed" == old-header ]]; then has "$WORK/err" X-Work; fi
  snapshot >"$WORK/after"; cmp "$WORK/before" "$WORK/after"
done
invoke send --as "$SENDER" --no-ring <"$WORK/card"; expect_rc 0
[[ ! -s "$WORK/err" ]] || fail 'explicit no-ring emitted a notice'
message_path "$RECEIVER" "$id" >/dev/null
[[ "$(find "$STATE" -path '*/wake-attempts/*.json' -type f | wc -l)" == 1 ]] || fail 'no-ring created a wake attempt'
sha256sum "$pending" "$STATE/$RECEIVER/wake.log" >"$WORK/pending-after"
cmp "$WORK/pending-before" "$WORK/pending-after" || fail 'no-ring adopted the unrelated pending attempt'
pass 'malformed cards leave no effects; valid no-ring delivers without a wake or notice'
