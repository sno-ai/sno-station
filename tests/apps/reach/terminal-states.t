#!/usr/bin/env bash
# Preserve all four terminal writers, acceptance guards and duplicate refusal.
set -Eeuo pipefail
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
mode="${1:-all}"
case "$mode" in all|completed-after|failed-after|cancelled-before|cancelled-after|refused-before|refused-after) ;; *) exit 2;; esac
for scenario in completed-after failed-after cancelled-before cancelled-after refused-before refused-after; do
  [[ "$mode" == all || "$mode" == "$scenario" ]] || continue
  state="${scenario%-*}"; phase="${scenario#*-}"
  STATE="$WORK/$scenario"
  initialize "$SENDER" Sender
  initialize "$RECEIVER" Worker
  register "$SENDER"
  register "$RECEIVER"
  id="$scenario-$$@$HOST"; work="$scenario-$$"
  card "$id" "$SENDER" "$RECEIVER" question "$work" >"$WORK/question"
  invoke send --as "$SENDER" --no-ring <"$WORK/question"; expect_rc 0
  original="$(message_path "$RECEIVER" "$id")"
  if [[ "$phase" == after ]]; then
    cp "$original" "$WORK/original"
    invoke reply --as "$RECEIVER" --card "$original" --state accepted <<<'accepted'; expect_rc 0
    cmp "$WORK/original" "$original"
    snapshot >"$WORK/before"
    invoke reply --as "$RECEIVER" --card "$original" --state accepted <<<'duplicate acceptance'
    [[ "$RC" != 0 ]] || fail 'second acceptance was delivered'
    snapshot >"$WORK/after"; cmp "$WORK/before" "$WORK/after"
  fi
  extra="X-State: $state"$'\n'"In-Reply-To: <$id>"$'\n'"References: <$id>"
  card "raw-$id" "$RECEIVER" "$SENDER" answer "$work" "$extra" >"$WORK/raw-terminal"
  snapshot >"$WORK/before"
  invoke send --as "$RECEIVER" --no-ring <"$WORK/raw-terminal"
  [[ "$RC" != 0 ]] || fail 'raw send authored a terminal state'
  has "$WORK/err" reply
  snapshot >"$WORK/after"; cmp "$WORK/before" "$WORK/after"
  invoke reply --as "$RECEIVER" --card "$original" --state "$state" --reason "$scenario" <<<'terminal result'
  expect_rc 0
  invoke wait --as "$SENDER" --reply-to "<$id>" --timeout 0; expect_rc 0
  answer="$(<"$WORK/out")"
  [[ "$(header x-state "$answer")" == "$state" ]]
  invoke state --work "$work" --json; expect_rc 0
  jq -se --arg id "<$id>" --arg state "$state" 'any(.[]; .message_id==$id and .state==$state)' "$WORK/out" >/dev/null
  handled="$(message_path "$RECEIVER" "$id")"
  [[ "$handled" == */cur/*:2,*R* ]] || fail 'terminal delivery did not mark the original replied'
  snapshot >"$WORK/before"
  invoke reply --as "$RECEIVER" --card "$handled" --state "$state" <<<'duplicate terminal'
  [[ "$RC" != 0 ]] || fail 'second terminal reply was delivered'
  snapshot >"$WORK/after"; cmp "$WORK/before" "$WORK/after"
  pass "$scenario: terminal answer, original R flag, projection and duplicate guards"
done
