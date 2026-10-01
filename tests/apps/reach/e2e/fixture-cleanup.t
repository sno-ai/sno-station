#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/../test-lib.sh"
participants
card "stale-report-$$@$HOST" "$SENDER" "$RECEIVER" question "live-report-$$" >"$WORK/card"
reach send --as "$SENDER" --no-ring <"$WORK/card"
original="$(message_path "$RECEIVER" "stale-report-$$@$HOST")"
reach reply --as "$RECEIVER" --card "$original" --state refused <<<'old failed test'
card "stale-work-$$@$HOST" "$SENDER" "$RECEIVER" question "fresh-pending-$$" >"$WORK/card"
reach send --as "$SENDER" --no-ring <"$WORK/card"
pending="$(message_path "$RECEIVER" "stale-work-$$@$HOST")"
invoke dismiss --as "$RECEIVER" --card "$pending" --reason cleanup
expect_rc 65
env HOME="$TEST_HOME" SNO_REACH_ROOT="$STATE" REACH_UNDER_TEST="$REACH" TMUX="$TEST_TMUX" \
  python3 "$TEST_DIR/e2e/harness-regressions.py" "$WORK/cleanup-proof" "$SENDER" "$RECEIVER" "$OTHER"
for address in "$SENDER" "$RECEIVER" "$OTHER"; do
  [[ -z "$(reach inbox --as "$address")" ]] || fail 'stale actionable selection remains'
done
cmp "$pending" "$WORK/cleanup-proof/cards/1/new-$(basename "$pending")" 2>/dev/null || \
  cmp "${pending/new\//cur/}:2,R" "$WORK/cleanup-proof/cards/1/new-$(basename "$pending")"
pass 'actual cleanup refuses stale work, dismisses old/new reports, preserves original bytes and empties every inbox'
