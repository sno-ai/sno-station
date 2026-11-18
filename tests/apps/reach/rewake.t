#!/usr/bin/env bash
set -Eeuo pipefail
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
export SNO_PROFILE_DIR="$WORK/profile" SNO_REACH_RING_LOG="$WORK/rings.jsonl"
unset ORCA_TAB_ID
participants
heartbeat="$APP/../heartbeat/bin/heartbeat"
mkdir "$WORK/heartbeat-bin"
# shellcheck disable=SC2016 # variables in the generated script expand when it runs
printf '#!/usr/bin/env bash\nif [[ "${1:-}" == heartbeat ]]; then shift; exec %q "$@"; fi\nexec %q "$@"\n' \
  "$heartbeat" "$WORK/test-bin/sno" >"$WORK/heartbeat-bin/sno"
chmod +x "$WORK/heartbeat-bin/sno"
export PATH="$WORK/heartbeat-bin:$PATH"
mkdir -p "$SNO_PROFILE_DIR/station/"{agents,handoff}
events="$SNO_PROFILE_DIR/station/agents"
handoff="$SNO_PROFILE_DIR/station/handoff"
: >"$SNO_REACH_RING_LOG"
invoke rewake; expect_rc 0
[[ "$(<"$STATE/.reach-2.5-since")" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]+Z$ ]] || fail 'first pass did not write a UTC start mark'

observe() {
  local address="$1" session="$2" pid="$3" start="$4" at="$5"
  jq -nc --arg address "$address" --arg session "$session" --argjson pid "$pid" --arg start "$start" --arg at "$at" '
    {event:"stop",harness:"codex",sessionId:$session,at:$at,reachAddress:$address,pid:$pid,processStart:$start,input:{}}
  ' >"$events/$session.jsonl"
  printf '# Session %s\n\n## Due\n\n## Notes\nUnchanged notes.\n' "$session" >"$handoff/$session.md"
}
stat_line="$(<"/proc/$$/stat")"
read -r -a fields <<<"${stat_line##*) }"
observe "$RECEIVER" live "$$" "${fields[19]}" '2026-11-18T08:00:00.000Z'
observe "$SENDER" gone 2147483647 1 '2026-11-18T08:00:01.000Z'
observe "$SENDER" older "$$" 1 '2026-11-18T07:00:00.000Z'

send_fixture() {
  card "$1" "$2" "$3" "$4" "$5" "${6:-}" >"$WORK/card"
  invoke send --as "$2" --no-ring <"$WORK/card"; expect_rc 0
}
ring_count() {
  local count
  count="$(jq -s --arg id "<$1>" '[.[] | select(.msg_id == $id)] | length' "$SNO_REACH_RING_LOG")"
  [[ "$count" == "$2" ]] || fail "Message-ID <$1> rang $count times; expected $2"
}
age() {
  jq -c '.at = "2000-01-01T00:00:00Z"' "$1" >"$WORK/aged"
  cat "$WORK/aged" >"$1"
}
job="ring@$HOST"; cc="cc@$HOST"; automatic="automatic@$HOST"; old="old@$HOST"
no_reply="noreply@$HOST"; closed="closed@$HOST"; unknown="unknown@$HOST"; held="held@$HOST"
send_fixture "$job" "$SENDER" "$RECEIVER" decision ring
TEST_PANE="$(jq -r .identity.value "$STATE/$RECEIVER/reachable.json")"
invoke pickup; expect_rc 0
has "$WORK/out" "Subject: [DECISION] $job"
tries="$STATE/$RECEIVER/tries.jsonl"
send_fixture "$cc" "$SENDER" "$OTHER" status filtered "Cc: Observer <$RECEIVER>"
send_fixture "$automatic" "$SENDER" "$RECEIVER" decision filtered $'Auto-Submitted: auto-generated\nX-Name: agent-window'
send_fixture "$no_reply" "$SENDER" "$RECEIVER" status filtered 'X-No-Reply: true'
send_fixture "$old" "$SENDER" "$RECEIVER" decision filtered
touch -t 200001010000 "$(message_path "$RECEIVER" "$old")"
expired="expired@$HOST"; replaced="replaced@$HOST"; replacement="replacement@$HOST"
send_fixture "$expired" "$OTHER" "$RECEIVER" decision filtered 'Expiry-Date: Sat, 01 Jan 2000 00:00:00 +0000'
send_fixture "$replaced" "$OTHER" "$RECEIVER" decision filtered
send_fixture "$replacement" "$OTHER" "$RECEIVER" decision filtered "Supersedes: <$replaced>"
replacement_path="$(message_path "$RECEIVER" "$replacement")"
mv -- "$replacement_path" "$STATE/$RECEIVER/cur/${replacement_path##*/}:2,T"

invoke rewake; expect_rc 0
jq -se --arg expired "<$expired>" --arg replaced "<$replaced>" '
  all(.[]; .msg_id != $expired and .msg_id != $replaced)
' "$tries" >/dev/null || { cat "$tries"; fail 'rewake recorded a try for expired or superseded work'; }
ring_count "$expired" 0
ring_count "$replaced" 0
ring_count "$job" 0
age "$tries"
reach rewake >"$WORK/rewake-first" 2>&1 &
first=$!
reach rewake >"$WORK/rewake-second" 2>&1 &
second=$!
wait "$first" || { cat "$WORK/rewake-first"; fail 'first overlapping pass failed'; }
wait "$second" || { cat "$WORK/rewake-second"; fail 'second overlapping pass failed'; }
ring_count "$job" 1
invoke rewake; expect_rc 0
ring_count "$job" 1
age "$tries"
invoke rewake; expect_rc 0
ring_count "$job" 2
age "$tries"
invoke rewake; expect_rc 0
ring_count "$job" 2
for id in "$cc" "$automatic" "$no_reply" "$old"; do ring_count "$id" 0; done
jq -se --arg id "<$job>" 'map(select(.msg_id == $id) | .kind) == ["pickup","ring","ring"]' "$tries" >/dev/null ||
  fail 'the restart did not retain the shared pickup and ring budget'

handled="handled@$HOST"
send_fixture "$handled" "$SENDER" "$RECEIVER" status handled
invoke dismiss --as "$RECEIVER" --card "$(message_path "$RECEIVER" "$handled")" --reason reviewed; expect_rc 0
invoke rewake; expect_rc 0
ring_count "$handled" 0

# The target pane still exists but its ACK fixture is not an agent process.
send_fixture "$closed" "$RECEIVER" "$SENDER" decision closed
send_fixture "$held" "$RECEIVER" "$SENDER" decision held
held_path="$(message_path "$SENDER" "$held")"
invoke reply --as "$SENDER" --card "$held_path" --state accepted <<<'I accepted; there is work left.'
expect_rc 0
send_fixture "$unknown" "$RECEIVER" "$OTHER" decision unknown
invoke rewake; expect_rc 0
record="$handoff/gone.md"
has "$record" "Message-ID <$closed>"
has "$record" "Message-ID <$held>"
has "$record" 'First read the progress of Reach card'
has "$record" 'Stop if it is final or someone else holds it.'
has "$record" 'Ask the developer about any action you cannot confirm.'
has "$record" 'Read the original card itself and continue its work. Reply on that card with --state completed or --state failed when the work ends.'
grep -Eq '^at: [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} UTC$' "$record" || fail 'resume did not use a parseable time'
HOME="$TEST_HOME" "$heartbeat" --due >"$WORK/due"
has "$WORK/due" "Message-ID <$held>"
[[ "$(grep -c '^do: ' "$record")" == 2 ]] || fail 'did not write exactly two due entries to the newest session'
if grep -q '^do: ' "$handoff/live.md" "$handoff/older.md"; then fail 'rewake scheduled the live or older session'; fi
[[ ! -s "$STATE/$OTHER/tries.jsonl" ]] || fail 'rewake tried an unknown process'
ring_count "$unknown" 0

# Release binds the old original and its linked transfer card. A later message
# for the same work is forwarded to the new holder once, even across commands.
original="original@$HOST"; transfer="transfer@$HOST"; followup="followup@$HOST"
send_fixture "$original" "$RECEIVER" "$SENDER" decision transfer
card "$transfer" "$RECEIVER" "$OTHER" decision transfer >"$WORK/card"
printf 'Continue work on <%s>.\n' "$original" >>"$WORK/card"
invoke send --as "$RECEIVER" --no-ring <"$WORK/card"; expect_rc 0
send_fixture "$followup" "$RECEIVER" "$SENDER" status transfer "In-Reply-To: <$original>"$'\n'"References: <$original>"
mv "$events/"{gone,older}.jsonl "$WORK/"
invoke rewake; expect_rc 0
for file in "$STATE/$OTHER"/new/*; do
  [[ "$(header x-forwarded-from "$file" || true)" != "<$followup>" ]] ||
    fail 'the handoff link forwarded mail before the release'
done
mv "$WORK/"{gone,older}.jsonl "$events/"
jq -nc --arg from "$SENDER" --arg to "$OTHER" --arg original "<$original>" --arg transfer "<$transfer>" '
  {event:"handoff-released",harness:"codex",sessionId:"receiver",reachAddress:$to,at:"2026-11-18T08:00:02.000Z",
   input:{source:$from,target:$to,work:"transfer",message_id:$original,target_message_id:$transfer}}
' >"$events/release.jsonl"
invoke rewake; expect_rc 0
invoke rewake; expect_rc 0
for file in "$STATE/$OTHER"/new/*; do
  if [[ "$(header x-forwarded-from "$file" || true)" == "<$followup>" ]]; then
    printf '%s\n' "$file"
  fi
done >"$WORK/forwarded"
[[ "$(wc -l <"$WORK/forwarded")" == 1 ]] || fail 'released handoff did not forward the followup exactly once'
has "$(<"$WORK/forwarded")" 'Please handle transfer.'
jq -se --arg id "<$followup>" 'map(select(.msg_id == $id) | .kind) == ["forward"]' "$STATE/$SENDER/tries.jsonl" >/dev/null ||
  fail 'forward did not consume exactly one try on the old copy'
age "$STATE/$SENDER/tries.jsonl"
TEST_PANE="$(jq -r .identity.value "$STATE/$SENDER/reachable.json")"
invoke pickup; expect_rc 0
if grep -Fq -- "Subject: [STATUS] $followup" "$WORK/out"; then fail 'the forwarded copy was still offered to the old holder'; fi
pass 'rewake shares the try budget, resumes closed conversations and forwards released work once'
