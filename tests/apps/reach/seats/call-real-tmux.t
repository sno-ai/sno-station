#!/usr/bin/env bash
# Independent test plan: 09cbc922118051bea01512db7245e3a893fb2890c18d8e9f122b3b7747d85f3d
# T1: terminal echo alone never verifies a send without --expect.
# T3: --follow still enforces --expect when its watch window expires.
# Real dependencies: the target CLI and real tmux panes running /usr/bin/cat.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$(cd "$SCRIPT_DIR/../../../../apps/reach" && pwd)/lib/reach-call"
test_root="$(mktemp -d)"
test_run_id="pr5-message-window-$$-$(date +%s)"
sessions=()
export HOME="$test_root/home" SNO_REACH_ROOT="$test_root/mail"
mkdir -p "$HOME" "$test_root/commands"
real_tmux_binary="$(command -v tmux)"
export REACH_REAL_TMUX="$real_tmux_binary" REACH_TEST_SOCKET="$test_run_id" REACH_TMUX_TIMING="$test_root/key-times.tsv"
printf '#!/usr/bin/env bash\nexec bash %q "$@"\n' "$SCRIPT_DIR/../fixtures/tmux-timing.sh" >"$test_root/commands/tmux"
chmod +x "$test_root/commands/tmux"
export PATH="$test_root/commands:$PATH"

cleanup() {
    local status=$?
	local session
	for session in "${sessions[@]:-}"; do
		[[ -z "$session" ]] || tmux kill-session -t "$session" 2>/dev/null || true
	done
	tmux kill-server 2>/dev/null || true
    if ((status != 0 || fail != 0)); then printf 'test evidence: %s\n' "$test_root"; else rm -r -- "$test_root"; fi
}
trap cleanup EXIT

n=0
fail=0
check() {
	local label="$1" result="$2" detail="${3:-}"
	n=$((n + 1))
	if [[ "$result" == pass ]]; then
		printf 'ok %d - %s\n' "$n" "$label"
	else
		printf 'not ok %d - %s\n' "$n" "$label"
		[[ -z "$detail" ]] || printf '#   %s\n' "$detail"
		fail=$((fail + 1))
	fi
}

printf 'TAP version 13\n'

echo_session="$test_run_id-echo"
tmux new-session -d -s "$echo_session" -x 120 -y 30 "$(command -v cat)"
sessions+=("$echo_session")
echo_pane="$(tmux list-panes -t "$echo_session" -F '#{pane_id}')"
echo_text="Please inspect the active branch and report only independently observed output for $test_run_id."
set +e
XDG_STATE_HOME="$test_root/echo-state" bash "$TARGET" \
	--terminal "$echo_pane" --text "$echo_text" \
	--timeout 2 --every 1 \
	>"$test_root/echo.stdout" 2>"$test_root/echo.stderr"
echo_rc=$?
set -e

echo_result=fail
if [[ "$echo_rc" -eq 4 ]] &&
	! grep -Eq '"verified"[[:space:]]*:[[:space:]]*true|"reason"[[:space:]]*:[[:space:]]*"cursor-advanced"' \
		"$test_root/echo.stdout" "$test_root/echo.stderr"; then
	echo_result=pass
fi
check 'send without --expect rejects terminal echo as verification' "$echo_result" \
	"rc=$echo_rc stdout=$(tr '\n' ' ' <"$test_root/echo.stdout") stderr=$(tr '\n' ' ' <"$test_root/echo.stderr")"
gap="$(awk '/ -l / {text=$1} / C-m / && text {printf "%.6f", $1-text; exit}' "$REACH_TMUX_TIMING")"
gap_result=fail
if awk -v gap="$gap" 'BEGIN {exit !(gap >= 0.29)}'; then gap_result=pass; fi
check 'actual tmux text and submit commands have a settle gap' "$gap_result" "gap=${gap}s"
printf '# actual tmux text/submit gap: %ss\n' "$gap"

follow_session="$test_run_id-follow"
tmux new-session -d -s "$follow_session" -x 120 -y 30 "$(command -v cat)"
sessions+=("$follow_session")
follow_pane="$(tmux list-panes -t "$follow_session" -F '#{pane_id}')"
set +e
XDG_STATE_HOME="$test_root/follow-state" bash "$TARGET" \
	--terminal "$follow_pane" --follow \
	--expect 'PR5-FOLLOW-COMPLETE-[0-9]+' --timeout 1 --every 1 \
	>"$test_root/follow.stdout" 2>"$test_root/follow.stderr"
follow_rc=$?
set -e

follow_result=fail
if [[ "$follow_rc" -eq 4 ]] &&
	grep -Eq 'stopped: .*watch window elapsed|expected-output-absent|never matched --expect' \
		"$test_root/follow.stdout" "$test_root/follow.stderr" &&
	! grep -Eq '"verified"[[:space:]]*:[[:space:]]*true' \
		"$test_root/follow.stdout" "$test_root/follow.stderr"; then
	follow_result=pass
fi
check '--follow --expect exits 4 when its regex never appears' "$follow_result" \
	"rc=$follow_rc stdout=$(tr '\n' ' ' <"$test_root/follow.stdout") stderr=$(tr '\n' ' ' <"$test_root/follow.stderr")"

# A tmux server restart reuses %0. The cursor's pane token must distinguish the
# new pane incarnation from the old pane that had the same handle.
real_tmux="$real_tmux_binary"
wrapper_dir="$test_root/tmux-wrapper"
mkdir -p "$wrapper_dir"
# The generated wrapper expands these values when it runs.
# shellcheck disable=SC2016
printf '#!/usr/bin/env bash\nexec %q -L "$AGENT_WINDOW_TEST_SOCKET" "$@"\n' "$real_tmux" >"$wrapper_dir/tmux"
chmod +x "$wrapper_dir/tmux"
export AGENT_WINDOW_TEST_SOCKET="$test_run_id-restart"
restart_path="$wrapper_dir:$PATH"
old_pane="$(PATH="$restart_path" tmux new-session -d -P -F '#{pane_id}' -s old 'bash --norc')"
old_json="$(PATH="$restart_path" XDG_STATE_HOME="$test_root/restart-state" \
	bash "$TARGET" --terminal "$old_pane" --timeout 1 --every 1)"
old_cursor="$(printf '%s' "$old_json" | jq -r '.cursorAfter')"
PATH="$restart_path" tmux kill-server
sleep 0.3
new_pane="$(PATH="$restart_path" tmux new-session -d -P -F '#{pane_id}' -s new 'bash --norc')"
set +e
PATH="$restart_path" XDG_STATE_HOME="$test_root/restart-state" bash "$TARGET" \
	--terminal "$new_pane" --since "$old_cursor" --timeout 1 --every 1 \
	>"$test_root/restart.stdout" 2>"$test_root/restart.stderr"
restart_rc=$?
set -e
restart_result=fail
if [[ "$old_pane" == %0 && "$new_pane" == %0 && "$restart_rc" -eq 5 ]] &&
	grep -q 'another pane incarnation' "$test_root/restart.stderr"; then
	restart_result=pass
fi
check 'cursor rejects a reused pane handle after tmux server restart' "$restart_result" \
	"old=$old_pane new=$new_pane rc=$restart_rc stderr=$(tr '\n' ' ' <"$test_root/restart.stderr")"
PATH="$restart_path" tmux kill-server 2>/dev/null || true

printf '1..%d\n' "$n"
((fail == 0)) || { printf '# %d of %d failed\n' "$fail" "$n" >&2; exit 1; }
