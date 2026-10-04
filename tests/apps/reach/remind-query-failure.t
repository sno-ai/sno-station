#!/usr/bin/env bash
# Preserve a real seen-question reminder; surface a failure of its external jq process.
set -Eeuo pipefail
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"

participants
work="remind-query-failure-$$"
id="remind-query-failure-$$@$HOST"
card "$id" "$SENDER" "$RECEIVER" question "$work" >"$WORK/card"
invoke send --as "$SENDER" --no-ring <"$WORK/card"; expect_rc 0
invoke inbox --as "$RECEIVER"; expect_rc 0
has "$WORK/out" "$id"
invoke state --work "$work" --json; expect_rc 0
jq -e --arg to "$RECEIVER" --arg id "<$id>" \
  'select(.recipient == $to) | type == "object" and .state == "seen" and .message_id == $id' \
  "$WORK/out" >/dev/null || fail 'ordinary state query did not return a seen-question JSON object'
invoke remind --as "$RECEIVER"; expect_rc 0
has "$WORK/out" "<$id> is seen but not accepted"
[[ "$(wc -l <"$WORK/out")" == 1 ]] || fail 'normal seen question did not produce exactly one reminder'
pass 'real question delivery, inbox read, JSONL state and ordinary reminder succeed'

# Only the external jq invocation selecting reminder IDs is unavailable; all other jq
# calls exec the real binary. No repository executor or parser is changed/substituted.
real_jq="$(command -v jq)"
mkdir "$WORK/external-bin"
cat >"$WORK/external-bin/jq" <<'JQ'
#!/usr/bin/env bash
set -Eeuo pipefail
for argument in "$@"; do
  if [[ "$argument" == 'select(.recipient == $address and .state == "seen") | .message_id' ]]; then
    cat >"${REACH_TEST_QUERY_ROWS:?}"
    exec "${REACH_TEST_MISSING_JQ:?}"
  fi
done
exec "${REACH_TEST_REAL_JQ:?}" "$@"
JQ
chmod 700 "$WORK/external-bin/jq"
snapshot >"$WORK/before"
PATH="$WORK/external-bin:$PATH" REACH_TEST_REAL_JQ="$real_jq" \
  REACH_TEST_QUERY_ROWS="$WORK/actual-state.jsonl" REACH_TEST_MISSING_JQ="$WORK/unavailable-jq" \
  invoke remind --as "$RECEIVER"
printf 'observed external jq failure: exit=%s stdout_bytes=%s\n' "$RC" "$(wc -c <"$WORK/out")"
has "$WORK/err" unavailable-jq
# jq variables belong to the filter language, not the shell.
# shellcheck disable=SC2016
"$real_jq" -e --arg to "$RECEIVER" --arg id "<$id>" \
  'select(.recipient == $to) | type == "object" and .state == "seen" and .message_id == $id' \
  "$WORK/actual-state.jsonl" >/dev/null || fail 'fault boundary did not receive the real JSONL state'
[[ "$RC" != 0 ]] || fail 'remind swallowed the actual external jq execution failure'
[[ ! -s "$WORK/out" ]] || fail 'failed state selection printed a successful reminder'
snapshot >"$WORK/after"
cmp "$WORK/before" "$WORK/after" || fail 'failed reminder mutated the mailbox'
pass 'external jq execution failure returns nonzero without a false reminder or state mutation'

original="$(message_path "$RECEIVER" "$id")"
printf 'Accepted.\n' | reach reply --as "$RECEIVER" --card "$original" --state accepted \
  >"$WORK/out" 2>"$WORK/err"
invoke remind --as "$RECEIVER"; expect_rc 0
[[ ! -s "$WORK/out" && ! -s "$WORK/err" ]] || fail 'accepted question produced output or an empty-ID error'
pass 'real accepted reply removes the reminder without an empty-ID warning'
