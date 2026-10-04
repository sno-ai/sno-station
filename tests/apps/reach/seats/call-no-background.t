#!/usr/bin/env bash
set -Eeuo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
public="${REACH_UNDER_TEST:-$here/../../../../apps/reach/bin/sno-reach}"
target="$(dirname -- "$(readlink -f -- "$public")")/../lib/reach-call"
proof="$(mktemp -d "${TMPDIR:-/tmp}/reach-call-lifetime.XXXXXX")"
export SNO_REACH_ROOT="$proof/state" REACH_CALL_SOCKET="reach-call-lifetime-$$-$RANDOM"
tmux() { command tmux -L "$REACH_CALL_SOCKET" "$@"; }
export -f tmux
trap 'tmux kill-server 2>/dev/null || true; printf "evidence: %s\n" "$proof"' EXIT
pane="$(tmux -f /dev/null new-session -d -P -F '#{pane_id}' -x 160 -y 30 'bash --norc')"
sleep 0.3
bash "$target" --terminal "$pane" >"$proof/read.json" 2>"$proof/read.stderr"
[[ "$(tmux display-message -pt "$pane" '#{pane_pipe}')" == 0 ]] || {
    printf 'FAIL: read-only call left a tmux output capture process running\n' >&2
    exit 1
}
printf 'PASS: read-only call leaves no tmux output capture process\n'
bash "$target" --terminal "$pane" --text "printf 'LIFETIME-%s\n' ANSWER" \
    --expect '^LIFETIME-ANSWER$' --timeout 3 --every 1 >"$proof/send.json" 2>"$proof/send.stderr"
jq -e '.verified and (.output | contains("LIFETIME-ANSWER")) and
    (.deliveryReceipt as $receipt | .output | split("\n") | index($receipt) != null)' "$proof/send.json"
[[ "$(tmux display-message -pt "$pane" '#{pane_pipe}')" == 0 ]]
printf 'PASS: real receipt and answer verified without background capture\n'
echo_pane="$(tmux new-window -d -P -F '#{pane_id}' cat)"
rc=0
bash "$target" --terminal "$echo_pane" --text 'Only echo this input' \
    --timeout 1 --every 1 >"$proof/echo.json" 2>"$proof/echo.stderr" || rc=$?
[[ "$rc" == 4 && "$(tmux display-message -pt "$echo_pane" '#{pane_pipe}')" == 0 ]]
printf 'PASS: echo is rejected and ordinary timeout leaves no capture process\n'
rc=0
timeout --signal=TERM --kill-after=1 1s bash "$target" --terminal "$pane" \
    --follow --timeout 60 --every 1 >"$proof/signal.out" 2>"$proof/signal.stderr" || rc=$?
[[ "$rc" == 124 && "$(tmux display-message -pt "$pane" '#{pane_pipe}')" == 0 ]]
printf 'PASS: signal interruption leaves no capture process\n'
token="$(jq -r '.cursorAfter | split(":")[0]' "$proof/read.json")"
exec 8>"$SNO_REACH_ROOT/.channels/tmux/$token/capture.lock"
flock 8
started="$SECONDS"
rc=0
timeout --signal=TERM --kill-after=1 8s bash "$target" --terminal "$pane" \
    >"$proof/lock.out" 2>"$proof/lock.stderr" || rc=$?
flock -u 8
exec 8>&-
[[ "$rc" == 5 && $((SECONDS - started)) -lt 8 ]]
grep -q 'screen read lock timed out' "$proof/lock.stderr"
printf 'PASS: an occupied screen lock returns failure within five seconds\n'
tmux pipe-pane -o -t "$pane" "echo \$\$ > '$proof/foreign.pid'; exec cat >> '$proof/foreign.log'"
sleep 0.2
foreign_pid="$(<"$proof/foreign.pid")"
foreign_start="$(ps -o lstart= -p "$foreign_pid")"
bash "$target" --terminal "$pane" --text "printf 'FOREIGN-%s\n' ANSWER" \
    --expect '^FOREIGN-ANSWER$' --timeout 3 --every 1 >"$proof/foreign.json" 2>"$proof/foreign.stderr"
jq -e '.verified and (.output | contains("FOREIGN-ANSWER"))' "$proof/foreign.json"
[[ "$(tmux display-message -pt "$pane" '#{pane_pipe}')" == 1 ]]
[[ "$(ps -o lstart= -p "$foreign_pid")" == "$foreign_start" ]]
kill -0 "$foreign_pid"
grep -q '^FOREIGN-ANSWER' "$proof/foreign.log"
printf 'PASS: existing foreign pipe keeps its original process and transcript\n'
