#!/usr/bin/env bash
# A heartbeat armed from a Cursor IDE chat delivers each tick as a status card to the chat's Reach
# seat, and the chat's stop hook hands the cards over. Armed before the chat registers, the first
# tick reaches only the log with the reason, and the seat registered afterwards gets the next.
set -Eeuo pipefail
export LC_ALL=C
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
reach="${REACH_UNDER_TEST:-$here/../../../../apps/reach/bin/sno-reach}"
heartbeat="${HEARTBEAT:-$here/../../../../apps/heartbeat/bin/heartbeat}"
work="$(mktemp -d "${TMPDIR:-/tmp}/reach-cursor-heartbeat.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
unset CLAUDECODE CURSOR_INVOKED_AS SNO_REACH_ADDR TMUX TMUX_PANE
export HOME="$work" SNO_REACH_ROOT="$work/reach" SNO_PROFILE_DIR="$work/profile" HEARTBEAT_STATE="$work/state"
chat=11111111-2222-4333-8444-555555555555 seat="executor.ide@$(hostname)"
mkdir -p "$work/bin"
# shellcheck disable=SC2016 # the shim body is written literally
printf '#!/usr/bin/env bash\n[[ "$1" == reach ]] && shift && exec %q "$@"\nexit 64\n' "$reach" >"$work/bin/sno"
chmod +x "$work/bin/sno"
export PATH="$work/bin:$PATH"
failures=0
check() { if grep -qF -- "$3" "$2"; then printf 'ok    %s\n' "$1"; else printf 'FAIL  %s\n      missing [%s] in: %s\n' "$1" "$3" "$(head -c 800 "$2")"; failures=$((failures + 1)); fi; }

"$reach" init --as "$seat" --name IDE >/dev/null
CURSOR_AGENT=1 CURSOR_CONVERSATION_ID="$chat" \
  "$heartbeat" --interval 3s --label ide --log "$work/ide.log" --max-ticks 2 -- echo ide-tick >"$work/arm.out" 2>&1 &
armed=$!
for ((i = 0; i < 50; i++)); do grep -q 'tick=1 cursor ide delivery FAILED' "$work/ide.log" 2>/dev/null && break; sleep 0.1; done
CURSOR_AGENT=1 CURSOR_CONVERSATION_ID="$chat" "$reach" register --as "$seat" >/dev/null
wait "$armed"
check 'arming without a seat says ticks reach only the log' "$work/arm.out" 'this IDE chat is not a Reach seat yet'
check 'the tick before registration is logged with its reason' "$work/ide.log" \
  'tick=1 cursor ide delivery FAILED exit=1 stderr=no Reach seat is registered for this IDE chat'
printf '{"conversation_id":"%s","hook_event_name":"stop","status":"completed","loop_count":0}' "$chat" |
  timeout 60 "$reach" cursor-hook stop >"$work/stop.json"
jq -r '.followup_message' "$work/stop.json" >"$work/followup"
check 'the stop hook hands over the tick sent after registration' "$work/followup" '[ide] tick=2 ok ide-tick'
check 'the card is a heartbeat status card' "$work/followup" 'Subject: [STATUS] heartbeat ide tick 2'
check 'the ending is delivered too' "$work/followup" 'STOPPED: reached --max-ticks 2'
((failures == 0)) || { printf 'cursor heartbeat: %d FAILED\n' "$failures"; exit 1; }
printf 'cursor heartbeat: ALL PASS\n'
