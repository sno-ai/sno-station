#!/usr/bin/env bash
set -Eeuo pipefail
# Eligibility assertions migrated from pinned progress-reporting.t. Automatic
# T flags/dismissal journals are replaced by the Reach nonmutating read contract.
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
initialize "$SENDER" Sender
initialize "$RECEIVER" Worker
held() {
  card "$1@$HOST" "$SENDER" "$RECEIVER" decision progress "${2:-}" |
    sed "/^X-Work:/a Delivered-To: $RECEIVER" >"$STATE/$RECEIVER/new/$1"
}
mode="${1:?expiry|supersede|reverse|unheld}"
case "$mode" in
expiry)
  held old "Expiry-Date: $(date -R -d '1 hour ago')"
  held future "Expiry-Date: $(date -R -d '1 hour')"
  expected=future forbidden=old
  ;;
supersede)
  held old
  held replacement "Supersedes: <old@$HOST>"
  expected=replacement forbidden=old
  ;;
reverse)
  for flag in open R T; do
    held "replacement-$flag" "Supersedes: <old-$flag@$HOST>"
    if [[ "$flag" != open ]]; then
      mv "$STATE/$RECEIVER/new/replacement-$flag" "$STATE/$RECEIVER/cur/replacement-$flag:2,$flag"
    fi
    held "old-$flag"
  done
  expected=replacement-open forbidden=old-
  ;;
unheld)
  held closed
  mv "$STATE/$RECEIVER/new/closed" "$STATE/$RECEIVER/cur/closed:2,R"
  held first "Supersedes: <missing@$HOST>"
  held second "Supersedes: <closed@$HOST>"
  expected=first forbidden=closed
  ;;
*) fail "unknown mode $mode" ;;
esac
mail_snapshot() {
  find "$STATE" -type f \( -path '*/new/*' -o -path '*/cur/*' \) -print0 |
    sort -z | xargs -0 sha256sum
}
mail_snapshot >"$WORK/before"
invoke inbox --as "$RECEIVER"
expect_rc 0
has "$WORK/out" "/new/$expected"
! grep -Fq "/new/$forbidden" "$WORK/out" || fail "$mode exposes an ineligible card"
[[ "$mode" != unheld ]] || has "$WORK/out" '/new/second'
mail_snapshot >"$WORK/after"
cmp "$WORK/before" "$WORK/after" || fail 'read changed card bytes or flags'
[[ ! -e "$STATE/$RECEIVER/dismissals.jsonl" ]] || fail 'read wrote automatic dismissal'
pass "inbox $mode eligibility without card mutation"
