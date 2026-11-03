#!/usr/bin/env bash
# Real Reach work parsing and a private tmux server's actual status redraw.
set -Eeuo pipefail
# shellcheck source=../test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../test-lib.sh"
mode="${1:-all}"
case "$mode" in all|work|bar) ;; *) exit 2 ;; esac
mkdir -p "$WORK/commands"
printf '#!/usr/bin/env bash\nexit 127\n' >"$WORK/commands/sno"
chmod +x "$WORK/commands/sno"
export PATH="$WORK/commands:$PATH"
participants

if [[ "$mode" != bar ]]; then
    card "squad-a-$$@$HOST" "$SENDER" "$RECEIVER" question squad-a >"$WORK/card-a"
    invoke send --as "$SENDER" --no-ring <"$WORK/card-a"; expect_rc 0
    card "squad-b-$$@$HOST" "$SENDER" "$OTHER" question squad-b >"$WORK/card-b"
    invoke send --as "$SENDER" --no-ring <"$WORK/card-b"; expect_rc 0
    env HOME="$TEST_HOME" SNO_REACH_ROOT="$STATE" "$APP/lib/reach-agent-view" >"$WORK/work.jsonl"
    jq -se --arg receiver "$RECEIVER" --arg other "$OTHER" --arg sender "$SENDER" \
        'length == 2 and any(.[]; .work == "squad-a" and .owner == $receiver) and
         any(.[]; .work == "squad-b" and .owner == $other) and
         all(.[]; .sender == $sender and .source != "" and .state == "queued")' "$WORK/work.jsonl" >/dev/null
    while IFS= read -r source; do [[ -f "$source" ]]; done < <(jq -r .source "$WORK/work.jsonl")
    if env HOME="$TEST_HOME" SNO_REACH_ROOT="$WORK/missing" "$APP/lib/reach-agent-view" >"$WORK/missing.json" 2>"$WORK/missing.err"; then
        fail 'unreadable work inventory returned success'
    fi
    has "$WORK/missing.err" 'inventory unavailable'
    pass 'machine-wide work uses actual Reach recipients, source messages and work state; unavailable inventory fails'
fi

if [[ "$mode" != work ]]; then
    repo="$(cd "$APP/../.." && pwd)"
    entry="$repo/packages/memory/dist/agent-state-view.js"
    [[ -f "$entry" ]] || fail 'build the affected state-view entry before this check'
    mkdir -p "$WORK/npm/lib/node_modules/@snoai" "$WORK/profile/station/agents"
    ln -s "$repo/packages/memory" "$WORK/npm/lib/node_modules/@snoai/memory"
    printf '#!/usr/bin/env bash\nexec cat\n' >"$WORK/commands/claude"
    chmod +x "$WORK/commands/claude"
    tmux -L "$SERVER" set-option -g status-right 'USER #{session_name}'
    tmux -L "$SERVER" set-option -g status-right-length 180
    tmux -L "$SERVER" set-option -g status-interval 1
    tmux -L "$SERVER" set-option -t proof status-right OTHER
    before_global="$(tmux -L "$SERVER" show-options -gqv status-right)"
    agent="executor.squad-view@$HOST"
    initialize "$agent" SquadView
    env HOME="$TEST_HOME" XDG_CONFIG_HOME="$TEST_HOME/.config" SNO_REACH_ROOT="$STATE" \
        SNO_PROFILE_DIR="$WORK/profile" npm_config_prefix="$WORK/npm" TMUX="$TEST_TMUX" \
        "$REACH" spawn claude --as "$agent" --cwd "$WORK" --window >"$WORK/spawn.out" 2>"$WORK/spawn.err"
    pane="$(jq -r .identity.value "$STATE/$agent/reachable.json")"
    session="$(tmux -L "$SERVER" display-message -pt "$pane" '#S')"
    bar="$(tmux -L "$SERVER" show-options -qv -t "$session" status-right)"
    [[ "$bar" == 'USER #{session_name} '* && "$bar" == *agent-state-view.js* ]] || fail 'spawn did not preserve and compose inherited status-right'
    [[ "$(tmux -L "$SERVER" show-options -gqv status-right)" == "$before_global" ]]
    [[ "$(tmux -L "$SERVER" show-options -qv -t proof status-right)" == OTHER ]]
    python3 - "$SERVER" "$session" "$WORK/profile/station/agents/claude--other.jsonl" <<'PY'
import datetime, fcntl, json, os, pathlib, pty, select, struct, subprocess, sys, termios, time
server, session, event_file = sys.argv[1:]
path = pathlib.Path(event_file)
def append(event, payload):
    with path.open('a') as stream:
        stream.write(json.dumps({'harness':'claude','sessionId':'other','at':datetime.datetime.now(datetime.UTC).isoformat(),'event':event,'input':{'session_id':'other',**payload}})+'\n')
append('user-prompt-submit', {})
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 240, 0, 0))
env = dict(os.environ, TERM='xterm-256color')
client = subprocess.Popen(['tmux','-L',server,'attach-session','-t',session], stdin=slave, stdout=slave, stderr=slave, env=env)
os.close(slave)
def displayed(needle):
    output = b''
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], .25)
        if readable:
            output += os.read(master, 65536)
            if needle in output:
                return output
    raise AssertionError(f'actual tmux client never displayed {needle!r}: {output[-2000:]!r}')
try:
    initial = displayed(b'working')
    assert b'USER' in initial, initial
    append('permission-request', {'tool_name':'Bash','tool_use_id':'approval-one'})
    displayed(b'need you')
    print('PASS actual attached tmux client changed from working to need you on its idle refresh', flush=True)
finally:
    client.terminate()
    client.wait(timeout=5)
    os.close(master)
PY
    [[ "$(tmux -L "$SERVER" show-options -gqv status-right)" == "$before_global" ]]
    [[ "$(tmux -L "$SERVER" show-options -qv -t proof status-right)" == OTHER ]]
    pass 'Reach spawn composes only its own session; inherited text and unrelated/global bars remain intact'
    rm "$WORK/npm/lib/node_modules/@snoai/memory"
    no_bar="executor.no-bar@$HOST"
    initialize "$no_bar" NoBar
    env HOME="$TEST_HOME" XDG_CONFIG_HOME="$TEST_HOME/.config" SNO_REACH_ROOT="$STATE" \
        SNO_PROFILE_DIR="$WORK/profile" npm_config_prefix="$WORK/npm" TMUX="$TEST_TMUX" \
        "$REACH" spawn claude --as "$no_bar" --cwd "$WORK" --window >"$WORK/no-bar.out" 2>"$WORK/no-bar.err"
    has "$WORK/no-bar.err" 'state reader unavailable'
    no_bar_pane="$(jq -r .identity.value "$STATE/$no_bar/reachable.json")"
    [[ "$(tmux -L "$SERVER" display-message -pt "$no_bar_pane" '#{pane_dead}')" == 0 ]]
    pass 'missing optional state reader leaves the spawned agent registered and alive'
fi
