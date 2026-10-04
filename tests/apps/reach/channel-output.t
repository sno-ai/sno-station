#!/usr/bin/env bash
# Real tmux input and repaint output exercise the public ring/watch commands.
set -Eeuo pipefail
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
failed=0
ring_pid=''
watch_pid=''
finish_test() {
  local status=$? pid
  for pid in "$ring_pid" "$watch_pid"; do
    [[ -n "$pid" ]] || continue
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  ((status == 0)) || REACH_KEEP_TEST_ROOT=1
  cleanup
  return "$status"
}
trap finish_test EXIT
initialize "$RECEIVER" Receiver
mkdir -p "$WORK/actor"
cat >"$WORK/actor/delayed-ack" <<'ACTOR'
#!/usr/bin/env bash
set -Eeuo pipefail
stty -echo
: >"$1/ready"
while IFS= read -r line; do
  [[ "$line" == REACH-RING* ]] || continue
  printf '%s\n' "$line" >>"$1/received"
  [[ "$line" =~ and\ then\ ([0-9a-f]{8}) ]] || exit 1
  nonce="${BASH_REMATCH[1]}"
  if [[ "$(wc -l <"$1/received")" == 1 ]]; then sleep 35; fi
  printf 'ACK-%s\n' "$nonce"
done
ACTOR
tmux -L "$SERVER" -f /dev/null new-session -d -s proof 'cat'
TEST_TMUX="$(tmux -L "$SERVER" display-message -p '#{socket_path},#{pid},0')"
printf -v command 'bash %q %q' "$WORK/actor/delayed-ack" "$WORK/actor"
TEST_PANE="$(tmux -L "$SERVER" new-window -d -P -F '#{pane_id}' -t proof "$command")"
deadline=$((SECONDS + 5))
until [[ -f "$WORK/actor/ready" ]]; do
  ((SECONDS < deadline)) || fail 'delayed ACK actor did not start'
  sleep 0.05
done
reach register --as "$RECEIVER" --channel tmux --handle "$TEST_PANE"
reach ring "$RECEIVER" >"$WORK/ring.out" 2>"$WORK/ring.err" &
ring_pid=$!
ring_status=0
wait "$ring_pid" || ring_status=$?
ring_pid=''
received="$(wc -l <"$WORK/actor/received")"
if [[ "$ring_status" == 0 && "$(cat "$WORK/ring.out")" == rang && "$received" == 1 ]]; then
  pass 'delayed real ACK receives one submitted notification, not a retry at thirty seconds'
else
  printf 'FAIL delayed ACK: exit=%s actual-received=%s outcome=%s\n' "$ring_status" "$received" "$(cat "$WORK/ring.out")" >&2
  failed=1
fi
cat >"$WORK/actor/repaint" <<'ACTOR'
#!/usr/bin/env bash
set -Eeuo pipefail
for ((i=0; i<200; i++)); do printf 'WATCH-HISTORY-%03d\n' "$i"; done
printf 'WATCH-REPAINT-00'
: >"$1/watch-ready"
while [[ ! -f "$1/watch-go" ]]; do sleep 0.05; done
for ((i=1; i<=20; i++)); do printf '\rWATCH-REPAINT-%02d' "$i"; sleep 0.12; done
printf '\nWATCH-UPDATE-FINAL\n'
sleep 10
ACTOR
printf -v command 'bash %q %q' "$WORK/actor/repaint" "$WORK/actor"
TEST_PANE="$(tmux -L "$SERVER" new-window -d -P -F '#{pane_id}' -t proof "$command")"
deadline=$((SECONDS + 5))
until [[ -f "$WORK/actor/watch-ready" ]]; do
  ((SECONDS < deadline)) || fail 'repaint actor did not start'
  sleep 0.05
done
tmux -L "$SERVER" capture-pane -p -t "$TEST_PANE" -S - >"$WORK/watch-before"
has "$WORK/watch-before" WATCH-HISTORY-000
reach register --as "$RECEIVER" --channel tmux --handle "$TEST_PANE"
reach watch "$RECEIVER" --timeout 5 >"$WORK/watch.out" 2>"$WORK/watch.err" &
watch_pid=$!
sleep 0.5
: >"$WORK/actor/watch-go"
watch_status=0
wait "$watch_pid" || watch_status=$?
watch_pid=''
if [[ "$watch_status" == 0 ]] && grep -Fq WATCH-UPDATE-FINAL "$WORK/watch.out" && ! grep -Fq WATCH-HISTORY- "$WORK/watch.out"; then
  pass 'real tmux repaint emits changed output without repeating existing scrollback'
else
  printf 'FAIL repaint: exit=%s repeated-history-lines=%s\n' "$watch_status" "$(grep -Fc WATCH-HISTORY- "$WORK/watch.out" || true)" >&2
  failed=1
fi
printf 'channel evidence: %s\n' "$WORK"
exit "$failed"
