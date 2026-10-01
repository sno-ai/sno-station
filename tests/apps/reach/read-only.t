#!/usr/bin/env bash
# Read operations must not adopt even an existing actionable wake attempt.
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
rc=0
SNO_REACH_ROOT="$STATE" SNO_REACH_WAKE_NO_DETACH=1 \
  SNO_REACH_WAKE_STANDIN="$TEST_DIR/fixtures/wake-standin.sh" SNO_REACH_WAKE_OUTCOME=busy \
  "$APP/lib/reach-wake" start --root "$STATE" --sender "$SENDER" --recipient "$RECEIVER" \
  --message-id "<$id>" --work "$work" --mechanism /missing >"$WORK/wake.out" 2>"$WORK/wake.err" || rc=$?
[[ "$rc" == 0 || "$rc" == 5 ]] || { cat "$WORK/wake.err"; fail 'could not create real pending wake fixture'; }
[[ -n "$(find "$STATE" -path '*/wake-attempts/*.json' -print -quit)" ]] || fail 'wake fixture produced no state'
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
