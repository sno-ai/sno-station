#!/usr/bin/env bash
set -Eeuo pipefail
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
export SNO_PROFILE_DIR="$WORK/profile" SNO_REACH_RING_LOG="$WORK/rings.jsonl"
unset ORCA_TAB_ID
participants
TEST_PANE="$(jq -r .identity.value "$STATE/$RECEIVER/reachable.json")"
invoke pickup; expect_rc 0
[[ ! -s "$WORK/out" ]] || fail 'empty mailbox emitted a continuation'

send_fixture() {
  card "$1" "$SENDER" "$2" "$3" pickup "${4:-}" >"$WORK/card"
  invoke send --as "$SENDER" --no-ring <"$WORK/card"; expect_rc 0
}
job="job@$HOST"; question="question@$HOST"; cc="cc@$HOST"; old="old@$HOST"; watch="watch@$HOST"
send_fixture "$job" "$RECEIVER" decision
send_fixture "$question" "$RECEIVER" question $'X-State: requires-action\nIn-Reply-To: <work@local>\nReferences: <work@local>'
send_fixture "$cc" "$OTHER" decision "Cc: Observer <$RECEIVER>"
send_fixture "$old" "$RECEIVER" decision
old_path="$(message_path "$RECEIVER" "$old")"
touch -t 200001010000 "$old_path"
send_fixture "$watch" "$RECEIVER" decision $'Auto-Submitted: auto-generated\nX-Name: agent-window'
job_path="$(message_path "$RECEIVER" "$job")"
question_path="$(message_path "$RECEIVER" "$question")"
cc_path="$(message_path "$RECEIVER" "$cc")"
watch_path="$(message_path "$RECEIVER" "$watch")"
tries="$STATE/$RECEIVER/tries.jsonl"

invoke pickup; expect_rc 0
has "$WORK/out" "Card: $job_path"
has "$WORK/out" "From: Fixture <$SENDER>"
has "$WORK/out" "Subject: [DECISION] $job"
has "$WORK/out" 'Reply --state accepted'
has "$WORK/out" "Card: $question_path"
has "$WORK/out" 'Other work keeps its state.'
has "$WORK/out" "Card: $watch_path"
has "$WORK/out" 'Read the watch report.'
has "$WORK/out" "sno reach dismiss --as developer.human@$HOST --card <card>"
if grep -Fq -e "$cc_path" -e "$old_path" "$WORK/out"; then fail 'Cc or pre-upgrade mail appeared in pickup'; fi
jq -se --arg job "<$job>" --arg question "<$question>" '
  sort_by(.msg_id) | map([.msg_id,.kind]) == [[$job,"pickup"],[$question,"pickup"]]
' "$tries" >/dev/null || fail 'pickup did not record exactly the two ordinary offers'
[[ -f "$job_path" && ! -s "$STATE/$RECEIVER/seen.jsonl" ]] || fail 'pickup marked the task seen or moved it'

age() {
  jq -c '.at = "2000-01-01T00:00:00Z"' "$tries" >"$WORK/aged"
  cat "$WORK/aged" >"$tries"
}
invoke pickup; expect_rc 0
[[ ! -s "$WORK/out" ]] || fail 'immediate pickup repeated an offer'
for count in 2 3; do
  age
  invoke pickup; expect_rc 0
  has "$WORK/out" "Card: $job_path"
  has "$WORK/out" "Card: $question_path"
  if grep -Fq -- "$watch_path" "$WORK/out"; then fail 'pickup repeated a watch report'; fi
  [[ "$(wc -l <"$tries")" == "$((2 * count))" ]] || fail 'unexpected number of pickup tries'
done
age
invoke pickup; expect_rc 0
[[ ! -s "$WORK/out" ]] || fail 'pickup exceeded three tries'

report="report@$HOST"
send_fixture "$report" "$RECEIVER" status
report_path="$(message_path "$RECEIVER" "$report")"
cur="$STATE/$RECEIVER/cur/${report_path##*/}:2,S"
mv -- "$report_path" "$cur"
invoke pickup; expect_rc 0
has "$WORK/out" "Card: $cur"
has "$WORK/out" "sno reach dismiss --as $RECEIVER --card"
[[ -f "$cur" ]] || fail 'pickup moved an offered report'

lost="interrupted@$HOST"
send_fixture "$lost" "$RECEIVER" decision
lost_path="$(message_path "$RECEIVER" "$lost")"
# Fill the hook's pipe and close its reader after the claim, simulating the hook
# losing its output before any continuation can be received.
SNO_REACH_ROOT="$STATE" SNO_REACH_ADDR="$RECEIVER" python3 - "$REACH" "$tries" "<$lost>" <<'PY'
import json
import os
from pathlib import Path
import subprocess
import sys
import time

reach, tries, message_id = sys.argv[1:]
read_fd, write_fd = os.pipe()
os.set_blocking(write_fd, False)
try:
    while True:
        os.write(write_fd, b"x" * 4096)
except BlockingIOError:
    pass
os.set_blocking(write_fd, True)
with subprocess.Popen([reach, "pickup"], stdout=write_fd) as pickup:
    os.close(write_fd)
    deadline = time.monotonic() + 2
    try:
        while time.monotonic() < deadline and pickup.poll() is None:
            if any(json.loads(line)["msg_id"] == message_id
                   for line in Path(tries).read_text().splitlines()):
                break
            time.sleep(0.01)
        else:
            raise SystemExit("pickup did not claim the interrupted offer")
    finally:
        pickup.terminate()
        os.close(read_fd)
PY
[[ -f "$lost_path" ]] || fail 'interrupted pickup consumed the card'
invoke pickup; expect_rc 0
[[ ! -s "$WORK/out" ]] || fail 'interrupted pickup retried before its interval'
age
invoke pickup; expect_rc 0
has "$WORK/out" "Card: $lost_path"

age
export PICKUP_CARD="$lost_path" PICKUP_FIND="$(command -v find)"
mkdir "$WORK/bin"
cat >"$WORK/bin/find" <<'SH'
#!/usr/bin/env bash
if [[ "$1" == "${PICKUP_CARD%/*}" && "${2:-}" == "${PICKUP_CARD%/*/*}/cur" ]]; then
    printf '%s\0' "$PICKUP_CARD"
    exec sleep 4
fi
exec "$PICKUP_FIND" "$@"
SH
chmod +x "$WORK/bin/find"
PATH="$WORK/bin:$PATH" invoke pickup; expect_rc 124
has "$WORK/out" "Card: $PICKUP_CARD"
jq -se --arg id "<$lost>" '[.[] | select(.msg_id == $id and .kind == "pickup")] | length == 3' "$tries" >/dev/null
pass 'pickup claims To mail before printing, leaves its flags intact and retries within the bound'
