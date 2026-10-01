#!/usr/bin/env bash
set -Eeuo pipefail
export REACH_UNDER_TEST="${1:?installed candidate command required}" REACH_KEEP_TEST_ROOT=1
proof="${2:?new proof directory required}"
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
APP="$(dirname -- "$(dirname -- "$(readlink -f -- "$REACH")")")"
[[ "$APP" == */releases/* ]] || fail 'startup requires installed release'
participants
initialize "worker.spawn@$HOST" Spawn
mkdir -p "$TEST_HOME/.config/sno-reach"
printf '%s\n' '{"codex":{"acpx_agent":"codex"}}' >"$TEST_HOME/.config/sno-reach/agents.json"
card "startup-$$@$HOST" "$SENDER" "$RECEIVER" question startup >"$WORK/card"
sed "/^X-Work:/a Delivered-To: $RECEIVER" "$WORK/card" >"$STATE/$RECEIVER/new/work"
card "startup-report-$$@$HOST" "$RECEIVER" "$SENDER" status startup |
  sed "/^X-Work:/a Delivered-To: $SENDER" >"$STATE/$SENDER/new/report"
mkdir -p "$STATE/$SENDER/outbox/fixture"
cp "$WORK/card" "$STATE/$SENDER/outbox/fixture/message"
printf '%s\n' "$RECEIVER" >"$STATE/$SENDER/outbox/fixture/recipients"
SNO_REACH_ROOT="$STATE" SNO_REACH_WAKE_NO_DETACH=1 \
  SNO_REACH_WAKE_STANDIN="$TEST_DIR/fixtures/wake-standin.sh" SNO_REACH_WAKE_OUTCOME=busy \
  "$APP/lib/reach-wake" start --root "$STATE" --sender "$SENDER" --recipient "$RECEIVER" \
  --message-id "<startup-$$@$HOST>" --work startup --mechanism /missing >"$WORK/wake.out" 2>"$WORK/wake.err"
pending="$(find "$STATE" -path '*/wake-attempts/*.json' -type f -print -quit)"
mv "$pending" "$WORK/wake-template.json"
python3 "$TEST_DIR/startup-fixture.py" "$WORK" "$STATE" "$APP" "$SENDER" "$RECEIVER" "$OTHER" "$TEST_PANE" "$TEST_TMUX" "$TEST_HOME"
python3 "$TEST_DIR/startup-trace.py" "$REACH" "$WORK/startup-fixture.json" "$proof"
# The same actual adopter glob now contains one additional genuine pending row.
cp "$WORK/wake-template.json" "$pending"
mail_hashes() {
  find "$STATE" -type f \( -path '*/new/*' -o -path '*/cur/*' \) -print0 |
    sort -z | xargs -0 sha256sum
}
mail_hashes >"$WORK/cards-before-adoption"
reach inbox --as "$RECEIVER" >"$WORK/adoption-inbox"
attempt="$(jq -r .attempt_id "$pending")"
pid="$(jq -r .child_pid "$pending")"
if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]] || ! kill -0 "$pid"; then
  fail 'inbox did not schedule an actual retry child'
fi
[[ "$(test_process_command "$pid")" == *"$pending"* ]] || fail 'scheduled child is not this attempt'
reach inbox --as "$RECEIVER" >"$WORK/adoption-inbox-second"
jq -se --arg attempt "$attempt" '[.[] | select(.attempt_id == $attempt and .event == "adopted")] | length == 1' \
  "$STATE/$RECEIVER/wake.log" >/dev/null || fail 'inbox adoption was not scheduled exactly once'
mail_hashes >"$WORK/cards-after-adoption"
cmp "$WORK/cards-before-adoption" "$WORK/cards-after-adoption"
python3 - "$WORK/terminal-manifest.json" "$proof/adoption.json" "$pid" <<'PY'
import hashlib, json, pathlib, sys
manifest = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert len(manifest) == 3500
for path, expected in manifest.items():
    assert hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest() == expected, path
pathlib.Path(sys.argv[2]).write_text(json.dumps(dict(terminal_files=3500, unchanged=True, additional_pending=1, adopted_events=1, observed_child_pid=int(sys.argv[3]))) + "\n")
PY
pass 'installed inbox adopts exactly one added pending attempt; 3500 terminal records and all cards unchanged'
