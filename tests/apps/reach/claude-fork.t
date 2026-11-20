#!/usr/bin/env bash
# A Claude Code fork runs as a background session that keeps the window variables of the
# conversation it was forked from, and a window can stop holding its conversation (the
# conversation ends, or the window only shows a background session). Neither may receive
# another conversation's identity or wake. Claude itself is the boundary fake: its session
# file and `claude agents --json`, in the shapes Claude Code 2.1.327-2.1.329 writes.
set -Eeuo pipefail
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
unset ORCA_TAB_ID ORCA_TERMINAL_HANDLE CLAUDECODE CLAUDE_PID CLAUDE_CODE_SESSION_ID

cat >"$WORK/test-bin/claude" <<'SH'
#!/usr/bin/env bash
[[ "$*" == 'agents --json' ]] || exit 64
cat "$REACH_TEST_CLAUDE_AGENTS"
SH
chmod +x "$WORK/test-bin/claude"
export REACH_TEST_CLAUDE_AGENTS="$WORK/agents.json"
sessions="$TEST_HOME/.claude/sessions"
mkdir -p "$sessions"
claude_session() { # pid kind: the session file Claude writes for a running conversation
  jq -n --argjson pid "$1" --arg kind "$2" \
    '{pid:$pid, sessionId:"20fc85dc-2950-4739-9b8a-71b333581c4c", kind:$kind, name:"BlackFriday"}' \
    >"$sessions/$1.json"
}
claude_lists() { # [pid kind]... : the conversations `claude agents --json` reports
  local entries='[]'
  while (($#)); do
    entries="$(jq -c --argjson pid "$1" --arg kind "$2" '. + [{pid:$pid, kind:$kind, id:"20fc85dc"}]' <<<"$entries")"
    shift 2
  done
  printf '%s\n' "$entries" >"$REACH_TEST_CLAUDE_AGENTS"
}

# ---- identity: a background session never takes a seat from its inherited window ----
initialize "$OTHER" Observer
jq -n --arg address "$OTHER" --arg host "$HOST" --argjson pid "$$" '
  {address:$address, channel:"orca", handle:"term-web-coder", identity:{kind:"orca-tab",value:"tab-web-coder"},
   by:{pid:$pid,host:$host}, claimed_at:1, refreshed_at:1, harness:"claude-code"}
' >"$STATE/$OTHER/reachable.json"
as_claude() { # kind command... : run Reach from a Claude conversation started in the web-coder tab
  claude_session "$$" "$1"
  shift
  env HOME="$TEST_HOME" SNO_REACH_ROOT="$STATE" CLAUDECODE=1 CLAUDE_PID="$$" \
    ORCA_TAB_ID=tab-web-coder ORCA_TERMINAL_HANDLE=term-web-coder "$@" >"$WORK/out" 2>"$WORK/err"
}
RC=0; as_claude interactive "$REACH" whoami || RC=$?
expect_rc 0
[[ "$(<"$WORK/out")" == "$OTHER" ]] || fail 'an interactive conversation lost the seat of its own window'
RC=0; as_claude bg "$REACH" whoami || RC=$?
expect_rc 1
[[ ! -s "$WORK/out" ]] || fail "a background session took the seat of the window it was forked from: $(<"$WORK/out")"
RC=0; as_claude bg env SNO_REACH_ADDR="$OTHER" "$REACH" whoami || RC=$?
expect_rc 1
[[ ! -s "$WORK/out" ]] || fail 'a background session took the seat named by an inherited SNO_REACH_ADDR'
pass 'whoami gives a seat to the conversation in the window, never to a background session forked from it'

initialize "$SENDER" Sender
RC=0; as_claude bg "$REACH" register --as "$SENDER" --channel terminal --handle tty:/dev/null || RC=$?
expect_rc 65
has "$WORK/err" 'background session'
[[ ! -e "$STATE/$SENDER/reachable.json" ]] || fail 'a background session registered a window'
RC=0; as_claude interactive "$REACH" register --as "$SENDER" --channel terminal --handle tty:/dev/null || RC=$?
expect_rc 0
pass 'register refuses a window from inside a background session and accepts it from an interactive one'

# An agent such as Codex started from inside a fork inherits CLAUDE_PID, yet it is its own agent.
ln -s "$(command -v bash)" "$WORK/test-bin/codex"
RC=0; as_claude bg env SNO_REACH_ADDR="$SENDER" codex -c '"$0" whoami; status=$?; exit $status' "$REACH" || RC=$?
expect_rc 0
[[ "$(<"$WORK/out")" == "$SENDER" ]] || fail "an agent started from a fork lost its own seat: $(<"$WORK/out") $(<"$WORK/err")"
RC=0; as_claude bg codex -c '"$0" register --as "$1" --channel terminal --handle tty:/dev/null; status=$?; exit $status' "$REACH" "$SENDER" || RC=$?
expect_rc 0
pass 'an agent started from inside a fork keeps its own seat and registers'

# ---- delivery: type into a Claude window only while it holds a listed conversation ----
initialize "$RECEIVER" Worker
SNO_REACH_HARNESS=claude-code register "$RECEIVER"
pane_pid="$(tmux -L "$SERVER" display-message -p -t "$TEST_PANE" '#{pane_pid}')"
doorbell() {
  env HOME="$TEST_HOME" SNO_REACH_ROOT="$STATE" TMUX="$TEST_TMUX" "$APP/lib/reach-ring" \
    doorbell --to "$1" --from "$SENDER" --msg-id "<fork-$$-$RANDOM@$HOST>" >"$WORK/out" 2>"$WORK/err" || true
}
claude_lists "$pane_pid" interactive
doorbell "$RECEIVER"
[[ "$(<"$WORK/out")" == outcome=rang ]] || fail "the conversation in its own pane was not rung: $(<"$WORK/out") $(<"$WORK/err")"
claude_lists 4242 background
typed() { tmux -L "$SERVER" capture-pane -p -S - -t "$TEST_PANE" | grep -c REACH-RING || true; }
before="$(typed)"
doorbell "$RECEIVER"
has "$WORK/out" outcome=unresolved
has "$WORK/err" 'no live Claude conversation'
[[ "$(typed)" == "$before" ]] || fail 'a pane with no listed conversation was typed into'
pass 'a tmux pane is rung only while its Claude conversation is listed'

# A Claude without the list (an older version, or not found) leaves the wake as it was, with a note.
rm -f "$REACH_TEST_CLAUDE_AGENTS"
doorbell "$RECEIVER"
[[ "$(<"$WORK/out")" == outcome=rang ]] || fail "an unreadable Claude list blocked the wake: $(<"$WORK/out") $(<"$WORK/err")"
has "$WORK/err" 'without checking which conversation'
pass 'an unreadable Claude list does not block the wake'

# A Claude seat on a plain terminal is checked the same way, by the terminal device.
initialize "tty.seat@$HOST" Terminal
"$APP/lib/reach-reachability" register --root "$STATE" --as "tty.seat@$HOST" --channel terminal \
  --handle "tty:$(tmux -L "$SERVER" display-message -p -t "$TEST_PANE" '#{pane_tty}')" --harness claude-code \
  --pid "$$" --host "$HOST" >/dev/null
claude_lists 4242 background
doorbell "tty.seat@$HOST"
has "$WORK/out" outcome=unresolved
has "$WORK/err" 'no live Claude conversation'
claude_lists "$pane_pid" interactive
doorbell "tty.seat@$HOST"
if grep -q outcome=unresolved "$WORK/out"; then fail "the conversation on its own terminal was refused: $(<"$WORK/err")"; fi
pass 'a plain terminal is rung only while its Claude conversation is listed'

# A refused wake typed nothing, so it must not use up the card's three tries: once the
# conversation is back in its window, turn-end pickup still offers the card.
export SNO_PROFILE_DIR="$WORK/profile" SNO_REACH_RING_LOG="$WORK/rings.jsonl"
claude_lists 4242 background
question="refused-$$@$HOST"
card "$question" "$SENDER" "$RECEIVER" question pickup >"$WORK/card"
invoke send --as "$SENDER" <"$WORK/card"; expect_rc 0
question_path="$(message_path "$RECEIVER" "$question")"
tries="$STATE/$RECEIVER/tries.jsonl"
for ((i = 0; i < 100; i++)); do grep -qF "<$question>" "$WORK/rings.jsonl" 2>/dev/null && break; sleep 0.1; done
has "$WORK/rings.jsonl" "<$question>"
invoke __try --as "$RECEIVER" --card "$question_path" --kind ring; expect_rc 1
has "$WORK/out" 'less than 300 seconds'
for pass in 2 3; do
  sed -i 's/"at":"[^"]*"/"at":"2000-01-01T00:00:00Z"/' "$tries"
  invoke __try --as "$RECEIVER" --card "$question_path" --kind ring; expect_rc 0
  env HOME="$TEST_HOME" SNO_REACH_ROOT="$STATE" TMUX="$TEST_TMUX" "$APP/lib/reach-ring" \
    doorbell --to "$RECEIVER" --from "$SENDER" --msg-id "<$question>" >"$WORK/out" 2>"$WORK/err" || true
  has "$WORK/out" outcome=unresolved
done
[[ "$(jq -s --arg id "<$question>" '[.[] | select(.msg_id == $id)] | length' "$tries")" == 3 ]] ||
  fail "three refused wakes did not leave three try rows: $(cat "$tries")"
reach sent --as "$SENDER" --json >"$WORK/sent"
[[ "$(jq -r --arg id "<$question>" '.[] | select(.msg_id == $id) | .tries' "$WORK/sent")" == unknown ]] ||
  fail "the sender's view counted refused wakes as tries: $(cat "$WORK/sent")"
# The cross-machine receiver rings through __ring-card, which takes the try in its own process.
remote="remote-$$@$HOST"
card "$remote" "$SENDER" "$RECEIVER" question pickup >"$WORK/card"
invoke send --as "$SENDER" --no-ring <"$WORK/card"; expect_rc 0
invoke __ring-card "$RECEIVER" "$SENDER" "$(message_path "$RECEIVER" "$remote")"
[[ "$(jq -rs --arg id "<$remote>" '[.[] | select(.msg_id == $id) | .kind] | join(",")' "$tries")" == skip ]] ||
  fail "a refused cross-machine wake was counted as a try: $(cat "$tries")"
claude_lists "$pane_pid" interactive
sed -i 's/"at":"[^"]*"/"at":"2000-01-01T00:00:00Z"/' "$tries"
invoke pickup; expect_rc 0
has "$WORK/out" "Card: $question_path"
pass 'wakes refused for a window without its conversation leave the card to turn-end pickup'

cat >"$WORK/orca" <<'SH'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
  'terminal list') printf '%s\n' '{"ok":true,"result":{"terminals":[{"tabId":"tab-fork","connected":true,"handle":"term-fork"}]}}' ;;
  'terminal send') printf '%s\n' "$*" >>"$REACH_TEST_TRACE"; printf '%s\n' '{"ok":true,"result":{}}' ;;
  'terminal read') printf '%s\n' '{"ok":true,"result":{"terminal":{"tail":[]}}}' ;;
  'terminal wait') printf '%s\n' '{"ok":true,"result":{"wait":{"satisfied":true}}}' ;;
  *) printf 'unexpected external terminal call: %s\n' "$*" >&2; exit 99 ;;
esac
SH
chmod +x "$WORK/orca"
"$APP/lib/reach-reachability" register --root "$STATE" --as "$OTHER" --channel orca --handle term-fork \
  --identity-kind orca-tab --identity tab-fork --harness claude-code --pid "$$" --host "$HOST" >/dev/null
# The Claude process keeps the handle it started with; Orca has since reconnected the tab as term-fork.
env ORCA_TAB_ID=tab-fork ORCA_TERMINAL_HANDLE=term-before-reconnect sleep 60 &
window_claude=$!
orca_doorbell() {
  env HOME="$TEST_HOME" SNO_REACH_ROOT="$STATE" ORCA_CLI_COMMAND="$WORK/orca" REACH_TEST_TRACE="$WORK/trace" \
    "$APP/lib/reach-ring" doorbell --to "$OTHER" --from "$SENDER" --msg-id "<fork-$$-$RANDOM@$HOST>" \
    >"$WORK/out" 2>"$WORK/err" || true
}
claude_lists "$window_claude" interactive
orca_doorbell
has "$WORK/out" outcome=rang
has "$WORK/trace" 'terminal send --terminal term-fork'
: >"$WORK/trace"
claude_lists 4242 background
orca_doorbell
has "$WORK/out" outcome=unresolved
has "$WORK/err" 'no live Claude conversation'
[[ ! -s "$WORK/trace" ]] || fail "an Orca window with no listed conversation was typed into: $(<"$WORK/trace")"
kill "$window_claude" 2>/dev/null || true
pass 'an Orca window is rung only while its Claude conversation is listed'
