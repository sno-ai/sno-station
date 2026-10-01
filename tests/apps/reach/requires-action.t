#!/usr/bin/env bash
# Preserve the inherited blocked-question answer projection through the public API.
set -Eeuo pipefail
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
participants
work="blocked-$$"; id="original-$$@$HOST"; blocked="blocked-$$@$HOST"
card "$id" "$SENDER" "$RECEIVER" question "$work" >"$WORK/question"
invoke send --as "$SENDER" --no-ring <"$WORK/question"; expect_rc 0
original="$(message_path "$RECEIVER" "$id")"
invoke reply --as "$RECEIVER" --card "$original" --state accepted <<<'accepted'; expect_rc 0
invoke inbox --as "$SENDER"; expect_rc 0
acceptance="$(awk 'NR==1 {print $1}' "$WORK/out")"
accepted_id="$(header message-id "$acceptance")"
extra="X-State: requires-action"$'\n'"In-Reply-To: $accepted_id"$'\n'"References: <$id> $accepted_id"
card "$blocked" "$RECEIVER" "$SENDER" question "$work" "$extra" >"$WORK/blocked"
invoke send --as "$RECEIVER" <"$WORK/blocked"; expect_rc 0
blocked_path="$(message_path "$SENDER" "$blocked")"
invoke reply --as "$SENDER" --card "$blocked_path" <<<'Here is the requested detail.'
expect_rc 0
invoke wait --as "$RECEIVER" --reply-to "<$blocked>" --timeout 0; expect_rc 0
answer="$(<"$WORK/out")"
[[ "$(header in-reply-to "$answer")" == "<$blocked>" ]] || fail 'answer references the root work instead of the direct blocked question'
invoke state --work "$work" --json; expect_rc 0
jq -se --arg id "<$id>" 'any(.[]; .message_id==$id and .answered=="yes")' "$WORK/out" >/dev/null || {
  cat "$WORK/out"; fail 'original work did not project answered=yes after the blocked-question answer';
}
pass 'stateless answer reaches the direct requires-action question author and updates original answered projection'
