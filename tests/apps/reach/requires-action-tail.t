#!/usr/bin/env bash
# A holder's requires-action question must continue the report chain; one aimed at the root work card forks it.
set -Eeuo pipefail
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
participants
work="tail-$$"; id="work-$$@$HOST"; blocked="blocked-$$@$HOST"
delivered() { find "$STATE/$SENDER/new" "$STATE/$SENDER/cur" -type f | wc -l | tr -d ' '; }
card "$id" "$SENDER" "$RECEIVER" decision "$work" >"$WORK/work"
invoke send --as "$SENDER" --no-ring <"$WORK/work"; expect_rc 0
original="$(message_path "$RECEIVER" "$id")"
invoke reply --as "$RECEIVER" --card "$original" --state accepted <<<'accepted'; expect_rc 0
invoke inbox --as "$SENDER"; expect_rc 0
accepted_id="$(header message-id "$(awk 'NR==1 {print $1}' "$WORK/out")")"
before="$(delivered)"
card "$blocked" "$RECEIVER" "$SENDER" question "$work" \
  "X-State: requires-action"$'\n'"In-Reply-To: <$id>"$'\n'"References: <$id>" >"$WORK/forked"
invoke send --as "$RECEIVER" --no-ring <"$WORK/forked"; expect_rc 65
has "$WORK/err" "In-Reply-To: $accepted_id"
has "$WORK/err" "References: <$id> $accepted_id"
[[ "$(delivered)" == "$before" ]] || fail 'refused requires-action question was delivered'
invoke state --work "$work" --json; expect_rc 0
jq -se --arg id "<$id>" 'any(.[]; .message_id==$id and .state=="accepted")' "$WORK/out" >/dev/null ||
  { cat "$WORK/out"; fail 'refused send changed the work state'; }
card "$blocked" "$RECEIVER" "$SENDER" question "$work" \
  "X-State: requires-action"$'\n'"In-Reply-To: $accepted_id"$'\n'"References: <$id> $accepted_id" >"$WORK/blocked"
invoke send --as "$RECEIVER" --no-ring <"$WORK/blocked"; expect_rc 0
invoke reply --as "$RECEIVER" --card "$original" --state completed <<<'done'; expect_rc 0
invoke state --work "$work" --json; expect_rc 0
jq -se --arg id "<$id>" 'any(.[]; .message_id==$id and .state=="completed")' "$WORK/out" >/dev/null ||
  { cat "$WORK/out"; fail 'work did not close after the corrected question'; }
pass 'send refuses a requires-action question that forks the chain and the corrected question keeps the work closable'
