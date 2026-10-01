#!/usr/bin/env bash
set -Eeuo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
target="$here/../../../../apps/reach/lib/reach-call"
proof="$(mktemp -d "${TMPDIR:-/tmp}/reach-short-popup.XXXXXX")"
export REACH_SHORT_SOCKET="reach-short-$$" SNO_REACH_ROOT="$proof/state"
tmux() { command tmux -L "$REACH_SHORT_SOCKET" "$@"; }
# Only the identifier timestamp is shortened; deadline/elapsed time stays real.
date() { if [[ "$*" == +%s%N ]]; then printf '1\n'; else command date "$@"; fi; }
export -f tmux date
trap 'tmux kill-server 2>/dev/null || true; printf "evidence: %s\n" "$proof"' EXIT
printf -v actor 'stty raw echo; printf "\nno matches\nenter insert · esc close\n"; cat >%q' "$proof/input"
tmux -f /dev/null new-session -d -s fixture 'sleep 60'
tmux set-option -g default-shell /bin/bash
pane="$(tmux new-window -d -P -F '#{pane_id}' -t fixture "$actor")"
sleep 0.3
rc=0
bash "$target" --terminal "$pane" --text abc --timeout 1 --every 1 \
    >"$proof/stdout" 2>"$proof/stderr" || rc=$?
[[ "$rc" == 4 ]]
controls="$(od -An -t u1 "$proof/input" | tr -s ' ' '\n' | grep -E '^(13|27)$' | paste -sd ' ' -)"
compact_size="$(tr -d '[:space:]\r\033' <"$proof/input" | wc -c)"
printf 'short payload bytes=%s; controls=%s\n' "$compact_size" "$controls"
[[ "$compact_size" -lt 64 && "$controls" == '13 27 13' ]]
printf 'PASS: short message still receives popup recovery Escape and second return\n'
