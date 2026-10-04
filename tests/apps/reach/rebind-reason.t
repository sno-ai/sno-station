#!/usr/bin/env bash
# Public local rebind uses the fixed receiver and preserves the exact caller reason.
set -Eeuo pipefail
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
initialize "$RECEIVER" Receiver
failed=0
index=0
for reason in 'moved to "other station"' 'C:\new'; do
  index=$((index + 1))
  printf '%s' "$reason" >"$WORK/reason-$index.input"
  invoke rebind --as "$RECEIVER" --reason "$reason"
  cp "$WORK/out" "$WORK/reason-$index.out"
  cp "$WORK/err" "$WORK/reason-$index.err"
  cp "$STATE/$RECEIVER/seat.json" "$WORK/reason-$index.seat.json"
  if [[ "$RC" == 0 ]] && jq -e --arg reason "$reason" '.history[-1].reason == $reason' "$STATE/$RECEIVER/seat.json" >/dev/null; then
    pass "rebind reason $index is preserved exactly in actual seat history"
  else
    printf 'FAIL rebind reason %s: exit=%s actual-history=%s\n' "$index" "$RC" "$(jq -c .history "$STATE/$RECEIVER/seat.json")" >&2
    failed=1
  fi
done
((failed == 0)) || REACH_KEEP_TEST_ROOT=1
printf 'rebind evidence: %s\n' "$WORK"
exit "$failed"
