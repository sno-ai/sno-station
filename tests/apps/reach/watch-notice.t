#!/usr/bin/env bash
# Follow a real tmux pane running a stand-in job, with no developer notifications sent.
set -Eeuo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP="$HERE/../../../apps/reach"
work="$(mktemp -d)"
export SNO_REACH_ROOT="$work/reach" WATCH_TEST_WORK="$work"
socket="$work/tmux.sock"
tmux() { command tmux -S "$socket" "$@"; }
export -f tmux
export socket
cleanup() {
    tmux kill-server 2>/dev/null || true
    rm -rf -- "$work"
}
trap cleanup EXIT
unset TMUX
mkdir -p -- "$work/bin" "$SNO_REACH_ROOT"
cat >"$work/bin/sno" <<'SNO'
#!/usr/bin/env bash
printf '%s\n' "$@" >>"$WATCH_TEST_WORK/notice"
SNO
chmod +x "$work/bin/sno"
export PATH="$work/bin:$PATH"

wait_for_line() {
    local i
    for ((i=0;i<100;i++)); do
        grep -Fxq -- "$2" "$1" 2>/dev/null && return 0
        sleep 0.05
    done
    printf 'missing line [%s] in %s\n' "$2" "$1" >&2
    return 1
}

pane="$(tmux -f /dev/null new-session -d -P -F '#{pane_id}' 'read -r line')"
tmux set-option -w remain-on-exit on
"$APP/lib/reach-call" --terminal "$pane" --follow --every 1 --timeout 8 >"$work/watch" &
watch_pid=$!
for ((i=0;i<100;i++)); do
    grep -qF "# watching $pane from cursor " "$work/watch" && break
    sleep 0.05
done
grep -qF "# watching $pane from cursor " "$work/watch"
tmux send-keys -t "$pane" C-m
wait "$watch_pid"
grep -Fxq "# EVENT: window dead terminal=$pane reason=exited" "$work/watch"
wait_for_line "$work/notice" "finished: $pane"
printf '%s\n' reach notify --type result --subject "finished: $pane" | diff -u - "$work/notice"
printf 'watch: exited pane produced one developer notice\n'
