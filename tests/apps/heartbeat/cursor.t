#!/usr/bin/env bash
# A heartbeat armed from a Cursor CLI conversation delivers each tick into that conversation:
#   print  a print-mode run is resumed with the tick on stdin; a run that exits non-zero is
#          logged with its exit code and stderr, and the next tick resumes the chat again
#   pane   an interactive CLI in tmux gets the tick typed into its pane
# The print case arms the way a print-mode agent must: in the background, from a shell that exits
# at once, inside a tmux pane that runs no Cursor, which must never receive typed ticks.
# Cursor is a boundary fake with the real CLI's command-line shape
# (`.../cursor-agent/versions/<ver>/index.js`); `cursor-agent` records what it was given.
# The IDE route needs Reach and is tested with it (tests/apps/reach/seats/cursor-heartbeat.t).
set -Eeuo pipefail
export LC_ALL=C

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HEARTBEAT:-$HERE/../../../apps/heartbeat/bin/heartbeat}"
[[ -x "$SCRIPT" ]] || { printf 'cursor.t: heartbeat not executable: %s\n' "$SCRIPT" >&2; exit 2; }

work="$(mktemp -d "${TMPDIR:-/tmp}/heartbeat-cursor.XXXXXX")"
socket="heartbeat-cursor-$$"
trap 'tmux -L "$socket" kill-server 2>/dev/null || true; rm -rf -- "$work"' EXIT
export HEARTBEAT_STATE="$work/state" HEARTBEAT_OWNER="cursor-selftest-$$"
unset CLAUDECODE CURSOR_AGENT CURSOR_CONVERSATION_ID CURSOR_INVOKED_AS SNO_REACH_ADDR TMUX TMUX_PANE
chat=66666666-7777-4888-8999-aaaaaaaaaaaa
failures=0
ok() { printf 'ok    %s\n' "$1"; }
fail() { printf 'FAIL  %s\n      %s\n' "$1" "${2:-}"; failures=$((failures + 1)); }
expect() { if grep -qF -- "$3" "$2" 2>/dev/null; then ok "$1"; else fail "$1" "missing [$3] in $2: $(head -c 600 "$2" 2>/dev/null)"; fi; }
wait_for() { local i; for ((i = 0; i < 100; i++)); do grep -qF -- "$2" "$1" 2>/dev/null && return 0; sleep 0.1; done; }

cli="$work/install/cursor-agent/versions/2026.10.01-fake/index.js"
mkdir -p "$work/bin" "${cli%/*}"
# cursor-agent: the first run fails the way a refused Cursor run does, later runs succeed.
cat >"$work/bin/cursor-agent" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$work/cursor-calls"
{ cat; printf -- '---\n'; } >>"$work/cursor-stdin"
if [[ ! -e "$work/failed-once" ]]; then : >"$work/failed-once"; printf 'ActionRequiredError: refused once\n' >&2; exit 3; fi
EOF
# The CLI process: with -p it runs the agent's command through a shell that backgrounds it and
# exits, then stays alive like a turn in progress; without -p it is an interactive chat that
# reads what is typed into its pane.
cat >"$cli" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == -p ]]; then shift 2; bash -c '"$@" >"$ARM_OUT" 2>&1 &' _ "$@"; sleep 6; exit 0; fi
cat >"$1"
EOF
chmod +x "$work/bin/cursor-agent" "$cli"
export PATH="$work/bin:$PATH"
tmux -L "$socket" -f /dev/null new-session -d -s shell "cat >'$work/shell.txt'"
tmux -L "$socket" new-session -d -s chat "bash '$cli' '$work/pane.txt'"
tmux_env="$(tmux -L "$socket" display-message -p '#{socket_path},#{pid},0')"
pane_of() { tmux -L "$socket" display-message -p -t "$1" '#{pane_id}'; }

# ---- print mode, armed in the background from inside a tmux pane that runs no Cursor ----
ARM_OUT="$work/print.out" TMUX="$tmux_env" TMUX_PANE="$(pane_of shell)" \
  CURSOR_AGENT=1 CURSOR_CONVERSATION_ID="$chat" CURSOR_INVOKED_AS=cursor-agent \
  bash "$cli" -p --trust "$SCRIPT" --interval 1s --label print --log "$work/print.log" --max-ticks 2 -- echo build-at-42
wait_for "$work/print.log" 'reached --max-ticks 2'
expect 'print: arming names the Cursor route, not a Monitor reader' "$work/print.out" \
  "armed from Cursor conversation $chat. Each tick arrives in this conversation as a message (print route)"
if grep -q 'Monitor(' "$work/print.out"; then fail 'print: no Monitor line' "$(cat "$work/print.out")"; else ok 'print: no Monitor line'; fi
expect 'print: a refused run is logged with exit code and stderr' "$work/print.log" \
  'tick=1 cursor print delivery FAILED exit=3 stderr=ActionRequiredError: refused once'
expect 'print: the next tick resumes the same chat in print mode with --trust' "$work/cursor-calls" "-p --trust --resume $chat"
runs="$(grep -oE 'tick=[0-9]+ (ok|STOPPED)' "$work/cursor-stdin" 2>/dev/null | tr '\n' ',')"
if [[ "$runs" == 'tick=1 ok,tick=2 ok,tick=2 STOPPED,' ]]; then ok 'print: one run per tick and one for the ending, no retry'
else fail 'print: one run per tick and one for the ending, no retry' "$runs"; fi
expect 'print: the tick line arrives on stdin' "$work/cursor-stdin" '[print] tick=2 ok build-at-42'
if [[ -s "$work/shell.txt" ]]; then fail 'print: nothing is typed into the non-Cursor pane' "$(cat "$work/shell.txt")"
else ok 'print: nothing is typed into the non-Cursor pane'; fi

# ---- interactive CLI in tmux ----
TMUX="$tmux_env" TMUX_PANE="$(pane_of chat)" CURSOR_AGENT=1 CURSOR_CONVERSATION_ID="$chat" CURSOR_INVOKED_AS=cursor-agent \
  "$SCRIPT" --interval 1s --label pane --log "$work/pane.log" --max-ticks 1 -- echo pane-tick >"$work/pane.out"
wait_for "$work/pane.txt" 'pane-tick'
expect 'pane: arming names the pane route' "$work/pane.out" '(pane route)'
expect 'pane: the tick is typed into the Cursor pane and submitted' "$work/pane.txt" '[pane] tick=1 ok pane-tick'

# ---- the interactive CLI exits between ticks: the pane then holds the user's shell ----
# The fake CLI takes the first typed line and exits; what the pane's shell reads afterwards is
# what a tick would run as a command, so it must stay empty.
cli_gone="$work/install-gone/cursor-agent/versions/2026.10.01-fake/index.js"
mkdir -p "${cli_gone%/*}"
printf '#!/usr/bin/env bash\nhead -n1 >"$1"\n' >"$cli_gone"
chmod +x "$cli_gone"
tmux -L "$socket" new-session -d -s gone "bash '$cli_gone' '$work/gone-cli.txt'; cat >'$work/gone-shell.txt'"
TMUX="$tmux_env" TMUX_PANE="$(pane_of gone)" CURSOR_AGENT=1 CURSOR_CONVERSATION_ID="$chat" CURSOR_INVOKED_AS=cursor-agent \
  "$SCRIPT" --interval 3s --label gone --log "$work/gone.log" --max-ticks 2 -- echo gone-tick >"$work/gone.out"
expect 'gone: the first tick reaches the running CLI' "$work/gone-cli.txt" '[gone] tick=1 ok gone-tick'
expect 'gone: a tick after the CLI exited is refused and logged' "$work/gone.log" \
  'tick=2 cursor pane delivery FAILED exit=1 stderr=the pane no longer runs the interactive Cursor CLI'
if [[ -s "$work/gone-shell.txt" ]]; then fail 'gone: nothing is typed into the shell the pane fell back to' "$(cat "$work/gone-shell.txt")"
else ok 'gone: nothing is typed into the shell the pane fell back to'; fi

((failures == 0)) || { printf 'heartbeat cursor: %d FAILED\n' "$failures"; exit 1; }
printf 'heartbeat cursor: ALL PASS\n'
