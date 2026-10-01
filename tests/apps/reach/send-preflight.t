#!/usr/bin/env bash
# Adapted from old mixed-To/notice tests: one public preflight precedes all effects.
set -Eeuo pipefail
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
participants
unregistered="worker.unregistered@$HOST"
initialize "$unregistered" Unregistered
SNO_REACH_ROOT="$STATE" SNO_REACH_WAKE_NO_DETACH=1 \
  SNO_REACH_WAKE_STANDIN="$TEST_DIR/fixtures/wake-standin.sh" SNO_REACH_WAKE_OUTCOME=busy \
  "$APP/lib/reach-wake" start --root "$STATE" --sender "$OTHER" --recipient "$RECEIVER" \
  --message-id "<unrelated-preflight-$$@$HOST>" --work unrelated --mechanism /missing >/dev/null 2>"$WORK/wake.err"
pending="$(find "$STATE" -path '*/wake-attempts/*.json' -type f -print -quit)"
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
