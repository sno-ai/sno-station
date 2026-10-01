#!/usr/bin/env bash
# Local integration counterpart of QCG-22; ACK actors are not live AI agents.
set -Eeuo pipefail
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
participants
work="forward-$$"; id="forward-$$@$HOST"
card "$id" "$SENDER" "$RECEIVER" question "$work" "Reply-To: Continuing <$OTHER>" >"$WORK/question"
invoke send --as "$SENDER" --no-ring <"$WORK/question"; expect_rc 0
original="$(message_path "$RECEIVER" "$id")"
invoke reply --as "$RECEIVER" --card "$original" --state accepted <<<'accepted'; expect_rc 0
invoke inbox --as "$OTHER"; expect_rc 0
acceptance="$(awk 'NR==1 {print $1}' "$WORK/out")"
[[ "$(header x-state "$acceptance")" == accepted ]]
[[ "$("$APP/vendor/bin/maddr" -a -h to: "$acceptance")" == "$OTHER" ]]
invoke unregister --as "$SENDER"; expect_rc 0
invoke reply --as "$RECEIVER" --card "$original" --state completed <<<'continuing recipient nonce'
expect_rc 0
invoke wait --as "$OTHER" --reply-to "<$id>" --timeout 0; expect_rc 0
answer="$(<"$WORK/out")"
[[ "$("$APP/vendor/bin/maddr" -a -h to: "$answer")" == "$OTHER" ]]
has "$answer" 'continuing recipient nonce'
[[ -z "$(find "$STATE/$SENDER/new" "$STATE/$SENDER/cur" -type f -print -quit)" ]]
pass 'acceptance and completion use the continuing recipient after original author unregisters'

for value in '' 'Team Lead.invalid@host'; do
  card "invalid-$RANDOM@$HOST" "$OTHER" "$RECEIVER" question invalid "Reply-To: $value" >"$WORK/invalid"
  snapshot >"$WORK/before"
  invoke send --as "$OTHER" --no-ring <"$WORK/invalid"
  [[ "$RC" != 0 ]] || fail 'blank or invalid Reply-To was delivered'
  snapshot >"$WORK/after"; cmp "$WORK/before" "$WORK/after"
done
pass 'blank and malformed Reply-To refuse before delivery'
