#!/usr/bin/env bash
set -Eeuo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
target="$here/../../../../apps/reach/lib/reach-call"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/reach-foreign-pipe.XXXXXX")"
export SNO_REACH_ROOT="$scratch/state"
export REACH_PIPE_TEST_SOCKET="reach-foreign-$$-$RANDOM"
tmux() { command tmux -L "$REACH_PIPE_TEST_SOCKET" "$@"; }
export -f tmux
trap 'tmux kill-server 2>/dev/null || true; printf "evidence: %s\n" "$scratch"' EXIT

pane="$(tmux new-session -d -P -F '#{pane_id}' -x 160 -y 30 'bash --norc')"
TMUX="$(tmux display-message -pt "$pane" '#{socket_path},#{pid},0')"
export TMUX
sleep 0.3
tmux pipe-pane -o -t "$pane" "echo \$\$ > '$scratch/writer.pid'; exec cat >> '$scratch/foreign.log'"
tmux send-keys -t "$pane" "printf 'BEFORE-EXCHANGE\\n'" C-m
sleep 0.2
before="$(wc -c <"$scratch/foreign.log")"
writer_pid="$(<"$scratch/writer.pid")"
writer_start="$(ps -o lstart= -p "$writer_pid")"
rc=0
bash "$target" --terminal "$pane" --text "printf 'FOREIGN-%s\\n' PIPE-ANSWER" \
    --expect '^FOREIGN-PIPE-ANSWER$' --timeout 3 --every 1 \
    >"$scratch/send.json" 2>"$scratch/send.stderr" || rc=$?
printf 'foreign send exit=%s\n' "$rc"
[[ "$rc" == 0 ]] || { cat "$scratch/send.stderr"; exit 1; }
jq -e '.verified and .mode == "screen-fallback" and
    (.cursorAfter | test(":screen:[0-9]+$")) and
    (.output | contains("FOREIGN-PIPE-ANSWER"))' "$scratch/send.json"
cursor="$(jq -r .cursorAfter "$scratch/send.json")"
tmux send-keys -t "$pane" "printf 'AFTER-EXCHANGE\\n'" C-m
sleep 0.2
bash "$target" --terminal "$pane" --since "$cursor" --expect '^AFTER-EXCHANGE$' \
    --timeout 2 --every 1 >"$scratch/read.json"
jq -e '.verified and .mode == "screen-fallback" and
    (.output | contains("FOREIGN-PIPE-ANSWER") | not)' "$scratch/read.json"
[[ "$(tmux display-message -pt "$pane" '#{pane_pipe}')" == 1 ]]
[[ "$(wc -c <"$scratch/foreign.log")" -gt "$before" ]]
grep -q '^FOREIGN-PIPE-ANSWER' "$scratch/foreign.log"
grep -q 'AFTER-EXCHANGE' "$scratch/foreign.log"
[[ "$(ps -o lstart= -p "$writer_pid")" == "$writer_start" ]]
kill -0 "$writer_pid"
printf 'foreign log kept growing: %s -> %s bytes\n' "$before" "$(wc -c <"$scratch/foreign.log")"

public="$here/../../../../apps/reach/bin/sno-reach"
seat="worker.foreign-pipe@$(hostname)"
"$public" init --as "$seat" --name ForeignPipe >"$scratch/init.log"
"$public" register --as "$seat" --channel tmux --handle "$pane" >"$scratch/register.log"
"$public" call "$seat" "printf 'PUBLIC-%s\\n' PIPE-ANSWER" \
    --expect '^PUBLIC-PIPE-ANSWER$' --timeout 3 --every 1 \
    >"$scratch/public.out" 2>"$scratch/public.stderr"
grep -q '^PUBLIC-PIPE-ANSWER$' "$scratch/public.out"
grep -q 'screen-fallback' "$scratch/public.stderr"
grep -q '^PUBLIC-PIPE-ANSWER' "$scratch/foreign.log"
[[ "$(ps -o lstart= -p "$writer_pid")" == "$writer_start" ]]

echo_pane="$(tmux new-window -d -P -F '#{pane_id}' cat)"
tmux pipe-pane -o -t "$echo_pane" "cat >> '$scratch/echo.log'"
rc=0
bash "$target" --terminal "$echo_pane" --text 'Only echo this input' \
    --timeout 1 --every 1 >"$scratch/echo.json" 2>"$scratch/echo.stderr" || rc=$?
[[ "$rc" == 4 ]]
printf 'PASS: public call delivers; foreign-pipe echo alone cannot verify\n'

plain="$(tmux new-window -d -P -F '#{pane_id}' 'bash --norc')"
sleep 0.3
bash "$target" --terminal "$plain" --text "printf 'BYTE-%s\\n' CAPTURE-ANSWER" \
    --expect '^BYTE-CAPTURE-ANSWER$' --timeout 3 --every 1 >"$scratch/byte.json"
jq -e '.verified and .mode == "screen-fallback" and (.cursorAfter | test("^[^:]+:screen:[0-9]+$"))' "$scratch/byte.json"
[[ "$(tmux display-message -pt "$plain" '#{pane_pipe}')" == 0 ]]
printf 'PASS: foreign transcript preserved; screen reads verified without creating a pipe\n'

# Set the server default before creating the pane: history-limit is inherited
# at pane creation, so changing an existing pane alone does not prove scrolling.
tmux set-option -g history-limit 5
scroll="$(tmux new-window -d -P -F '#{pane_id}' 'bash --norc')"
sleep 0.3
tmux pipe-pane -o -t "$scroll" "cat >> '$scratch/scroll-foreign.log'"
# shellcheck disable=SC2016
tmux send-keys -t "$scroll" -l -- 'for i in {1..100}; do printf "FILL-%03d\n" "$i"; done'
tmux send-keys -t "$scroll" C-m
sleep 0.3
tmux display-message -pt "$scroll" '#{history_limit} #{history_size}' >"$scratch/history.txt"
[[ "$(cut -d ' ' -f 1 "$scratch/history.txt")" == 5 ]]
[[ "$(cut -d ' ' -f 2 "$scratch/history.txt")" -gt 0 ]]
bash "$target" --terminal "$scroll" >"$scratch/scroll-before.json"
scroll_cursor="$(jq -r .cursorAfter "$scratch/scroll-before.json")"
tmux capture-pane -p -S - -t "$scroll" >"$scratch/scroll-before.txt"
tmux send-keys -t "$scroll" -l -- "printf 'SCROLL-NEW-ONE\\nSCROLL-NEW-TWO\\n'"
tmux send-keys -t "$scroll" C-m
sleep 0.3
tmux capture-pane -p -S - -t "$scroll" >"$scratch/scroll-after.txt"
[[ "$(wc -l <"$scratch/scroll-before.txt")" == "$(wc -l <"$scratch/scroll-after.txt")" ]]
rc=0
bash "$target" --terminal "$scroll" --since "$scroll_cursor" --expect '^SCROLL-NEW-TWO$' \
    --timeout 1 --every 1 >"$scratch/scroll-read.json" 2>"$scratch/scroll-read.stderr" || rc=$?
printf 'full-history read exit=%s\n' "$rc"
[[ "$rc" == 0 ]] || { cat "$scratch/scroll-read.stderr"; exit 1; }
jq -e '.verified and (.output | contains("SCROLL-NEW-ONE\nSCROLL-NEW-TWO"))' "$scratch/scroll-read.json"
bash "$target" --terminal "$scroll" --since "$scroll_cursor" --expect '^SCROLL-NEW-TWO$' \
    --timeout 1 --every 1 >"$scratch/scroll-repeat.json"
cmp "$scratch/scroll-read.json" "$scratch/scroll-repeat.json"
bash "$target" --terminal "$scroll" --text "printf 'SCROLL-%s\\n' DELIVERY-ANSWER" \
    --expect '^SCROLL-DELIVERY-ANSWER$' --timeout 3 --every 1 >"$scratch/scroll-send.json"
jq -e '.verified and (.output | split("\n") | index("SCROLL-DELIVERY-ANSWER") != null)' "$scratch/scroll-send.json"
jq -r '.deliveryReceipt as $receipt | .output | split("\n")[] | select(. == $receipt)' \
    "$scratch/scroll-send.json" >"$scratch/scroll-receipt.txt"
[[ -s "$scratch/scroll-receipt.txt" ]]
cat "$scratch/scroll-receipt.txt"
grep -q '^SCROLL-DELIVERY-ANSWER' "$scratch/scroll-foreign.log"
[[ "$(tmux display-message -pt "$scroll" '#{pane_pipe}')" == 1 ]]
printf 'PASS: fixed-height scrollback read, repeated cursor and scrolling delivery receipt\n'

scroll_cursor="$(jq -r .cursorAfter "$scratch/scroll-send.json")"
# shellcheck disable=SC2016
tmux send-keys -t "$scroll" -l -- 'for i in {1..100}; do printf "LATER-%03d\n" "$i"; done'
tmux send-keys -t "$scroll" C-m
sleep 0.3
bash "$target" --terminal "$scroll" --since "$scroll_cursor" --expect '^LATER-100$' \
    --timeout 1 --every 1 >"$scratch/scroll-no-overlap.json"
jq -e '.verified and .newLineCount > 0' "$scratch/scroll-no-overlap.json"

# A real alternate-screen repaint changes contents without changing row count.
repaint="$(tmux new-window -d -P -F '#{pane_id}' 'bash --norc')"
sleep 0.3
tmux pipe-pane -o -t "$repaint" "cat >> '$scratch/repaint-foreign.log'"
tmux send-keys -t "$repaint" -l -- "stty -echo; PS1=''; printf '\\033[?1049h\\033[H\\033[2JOLD-ONE\\nOLD-TWO\\nOLD-THREE\\n'"
tmux send-keys -t "$repaint" C-m
sleep 0.3
bash "$target" --terminal "$repaint" >"$scratch/repaint-before.json"
repaint_cursor="$(jq -r .cursorAfter "$scratch/repaint-before.json")"
tmux send-keys -t "$repaint" -l -- "printf '\\033[H\\033[2JNEW-ONE\\nNEW-TWO\\nNEW-THREE\\n'"
tmux send-keys -t "$repaint" C-m
sleep 0.3
bash "$target" --terminal "$repaint" --since "$repaint_cursor" --expect '^NEW-THREE$' \
    --timeout 1 --every 1 >"$scratch/repaint-after.json"
jq -e '.verified and .output == "NEW-ONE\nNEW-TWO\nNEW-THREE" and .newLineCount == 3' \
    "$scratch/repaint-after.json"
bash "$target" --terminal "$repaint" --since "$repaint_cursor" --expect '^NEW-THREE$' \
    --timeout 1 --every 1 >"$scratch/repaint-repeat.json"
cmp "$scratch/repaint-after.json" "$scratch/repaint-repeat.json"
printf 'PASS: complete anchor loss and same-height repaint remain readable and idempotent\n'
