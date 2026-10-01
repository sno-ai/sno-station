#!/usr/bin/env bash
# Contract under test: the tmux ring submits the message and confirms it honestly.
#
#   1. the body and the submit key are two separate sends with a real gap between them,
#      so the message is actually submitted rather than left sitting in the composer
#   2. a pane that only ECHOES the text back never yields `rang` — the sender's own
#      words are not evidence that anyone read them
#   3. that case terminates as `rang-unverified`, never `failed`; `failed` is reserved
#      for the transport itself breaking
#   4. a record pointing at a tmux pane that no longer exists yields `unresolved`,
#      the outcome that already means "no unique live window" — no new outcome is added
#
# Real dependencies: a real tmux session running `cat`, which prints a line only once a
# newline arrives. That is the whole point — `cat` cannot be fooled about whether the
# submit key was delivered, and it produces no output of its own, so it is also the
# perfect negative case for row 2. No mock stands between the test and the helper.
set -Eeuo pipefail
export HOST="$(hostname)"
export REACH_TEST_TMUX="$(command -v tmux)"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd -- "$SCRIPT_DIR/../../../../apps/reach" && pwd)"
HELPER="$APP/lib/reach-ring"
MBOX_BIN="$APP/bin/sno-reach"

root="$(mktemp -d)"
export HOME="$root/home" test_server="reach-ring-local-$$" REACH_TMUX_SEND_TRACE="$root/send-events"
mkdir -p "$HOME"
tmux() {
    if [[ "${1:-}" == send-keys ]]; then printf '%s\t%s\n' "$(date +%s%N)" "$*" >>"$REACH_TMUX_SEND_TRACE"; fi
    command "$REACH_TEST_TMUX" -L "$test_server" "$@"
}
export -f tmux
echo_session="walk-ring-echo-$$"
gone_session="walk-ring-gone-$$"
cleanup() {
    local status=$?
    tmux kill-session -t "ring-prompt-$$" 2>/dev/null || true
    tmux kill-session -t "$echo_session" 2>/dev/null || true
    tmux kill-session -t "$gone_session" 2>/dev/null || true
    tmux kill-server 2>/dev/null || true
    if ((status != 0 || ${fail:-0} != 0)); then printf "test evidence: %s\n" "$root"; else rm -r -- "$root"; fi
}
trap cleanup EXIT

export SNO_REACH_RING_LOG="$root/mailbox-doorbell.jsonl"
mail="$root/mail"
mkdir -p "$mail" "$root/bin"
ln -s "$(command -v cat)" "$root/bin/codex"

seat() {
    SNO_REACH_ROOT="$mail" "$MBOX_BIN" init --as "$1" --name "$2" >/dev/null
}

register_tmux() {
    local address="$1" pane="$3"
    SNO_REACH_ROOT="$mail" "$MBOX_BIN" register --as "$address" --channel tmux --handle "$pane" >/dev/null
}

seat tpm.sender@"${HOST}" sender
seat lead.echoseat@"${HOST}" lead-echo
seat executor.goneseat@"${HOST}" exec-gone

tmux new-session -d -s "$echo_session" -x 200 -y 50 "$root/bin/codex"
tmux new-session -d -s "$gone_session" -x 200 -y 50 "$root/bin/codex"

echo_pane="$(tmux list-panes -t "$echo_session" -F '#{pane_id}' | head -1)"
gone_pane="$(tmux list-panes -t "$gone_session" -F '#{pane_id}' | head -1)"
TMUX="$(tmux display-message -p '#{socket_path},#{pid},0')"
export TMUX
register_tmux lead.echoseat@"${HOST}" "$echo_session" "$echo_pane"
register_tmux executor.goneseat@"${HOST}" "$gone_session" "$gone_pane"

# The second session is killed AFTER registration, so its record points at a window
# that is genuinely gone — the ordinary way this happens in production.
tmux kill-session -t "$gone_session"

ring() { # recipient message-id -> outcome
    local out
    out="$(SNO_REACH_ROOT="$mail" PATH="$root/bin:$PATH" env -u ORCA_CLI_COMMAND \
        bash "$HELPER" doorbell --to "$1" --from tpm.sender@"${HOST}" \
        --msg-id "$2" 2>"$root/err.$$")" || true
    sed -n 's/^outcome=//p' <<<"$out"
}

n=0
fail=0
check() { # label condition-result
    n=$((n + 1))
    if [[ "$2" == pass ]]; then
        printf 'ok %d - %s\n' "$n" "$1"
    else
        printf 'not ok %d - %s\n' "$n" "$1"
        [[ -z "${3:-}" ]] || printf '#   %s\n' "$3"
        fail=$((fail + 1))
    fi
}

printf 'TAP version 13\n'

# --- rows 1-4: the echo-only pane -------------------------------------------------
tmux send-keys -t "$echo_pane" -- 'stale unsent instruction'
outcome="$(ring lead.echoseat@"${HOST}" '<ring-echo@'"${HOST}"'>')"
pane="$(tmux capture-pane -pt "$echo_pane" 2>/dev/null || true)"

# `cat` writes a line only when a newline reaches it. If the doorbell's text appears in
# the pane on a line of its own, a submit key arrived separately from the body.
submitted=fail
[[ "$(grep -c 'REACH-RING' <<<"$pane")" -ge 2 ]] && submitted=pass
check 'the body and the submit key are sent separately, so cat echoes a completed line' \
    "$submitted" "pane was:
$(sed 's/^/#     /' <<<"$pane" | head -6)"
gap_ok=fail
if python3 - "$REACH_TMUX_SEND_TRACE" <<'PY'
import sys
rows = [line.rstrip('\n').split('\t', 1) for line in open(sys.argv[1])]
gaps = []
for index, (stamp, command) in enumerate(rows):
    if 'REACH-RING' in command:
        next_stamp, next_command = rows[index + 1]
        assert next_command.endswith(' Enter'), next_command
        gaps.append((int(next_stamp) - int(stamp)) / 1e9)
assert gaps and all(gap >= .15 for gap in gaps), gaps
PY
then gap_ok=pass; fi
check 'actual tmux text and Enter commands retain the settling gap' "$gap_ok"

check 'an echo-only pane never yields rang' \
    "$([[ "$outcome" != rang ]] && echo pass || echo fail)" \
    "outcome was $outcome"

check 'the echo-only case terminates as rang-unverified, not failed' \
    "$([[ "$outcome" == rang-unverified ]] && echo pass || echo fail)" \
    "outcome was $outcome"

check 'the doorbell clears stale unsubmitted text before sending its neutral cue' \
    "$(grep -Fq 'stale unsent instruction' <<<"$pane" && echo fail || echo pass)" \
    "pane was: $(head -3 <<<"$pane")"
if [[ "${1:-}" == echo ]]; then exit "$fail"; fi

# --- row 5: the window is gone ----------------------------------------------------
gone_outcome="$(ring executor.goneseat@"${HOST}" '<ring-gone@'"${HOST}"'>')"
check 'a record pointing at a dead tmux pane yields unresolved' \
    "$([[ "$gone_outcome" == unresolved ]] && echo pass || echo fail)" \
    "outcome was $gone_outcome"

# --- row 5: two agents in ONE session must not share an address -------------------
# This is the defect the code review caught: identifying a seat by its session name means
# `send-keys -t <session>` reaches whichever pane tmux considers active, so one agent can
# be handed — and can answer — another agent's mail while the intended one sleeps.
two_session="walk-ring-two-$$"
tmux new-session -d -s "$two_session" -x 200 -y 50 "$root/bin/codex"
tmux split-window -t "$two_session" "$root/bin/codex"
mapfile -t two_panes < <(tmux list-panes -t "$two_session" -F '#{pane_id}')
seat executor.paneone@"${HOST}" exec-p1
seat executor.panetwo@"${HOST}" exec-p2
register_tmux executor.paneone@"${HOST}" "$two_session" "${two_panes[0]}"
register_tmux executor.panetwo@"${HOST}" "$two_session" "${two_panes[1]}"

distinct=fail
[[ "${two_panes[0]}" != "${two_panes[1]}" ]] && distinct=pass
check 'two agents in one session register two different identities' "$distinct" \
    "panes were ${two_panes[0]} and ${two_panes[1]}"

ring executor.paneone@"${HOST}" '<ring-pane-one@'"${HOST}"'>' >/dev/null &
ring_pid=$!
sleep 12
addressed="$(tmux capture-pane -pt "${two_panes[0]}" 2>/dev/null || true)"
other="$(tmux capture-pane -pt "${two_panes[1]}" 2>/dev/null || true)"
kill "$ring_pid" 2>/dev/null || true
wait "$ring_pid" 2>/dev/null || true
tmux kill-session -t "$two_session" 2>/dev/null || true

isolated=fail
if grep -q 'REACH-RING' <<<"$addressed" && ! grep -q 'REACH-RING' <<<"$other"; then
    isolated=pass
fi
check 'the ring reaches only the addressed pane, never its neighbour' "$isolated" \
    "addressed-hits=$(grep -c 'REACH-RING' <<<"$addressed") other-hits=$(grep -c 'REACH-RING' <<<"$other")"

# --- the shell-prompt pane: the exact shape that reported a false success ----------
# Found by the blind acceptance verifier. A pane sitting at a SHELL PROMPT echoes the sent
# line with the prompt in front of it; the line is long, tmux wraps it, and the wrapped
# continuation row carries the nonce without the doorbell token. The old confirmation
# tested exactly that — nonce present, token absent — and reported `rang` for a seat where
# nobody was home. `cat` never showed it, because its echo starts at column 0.
prompt_session="ring-prompt-$$"
tmux new-session -d -s "$prompt_session" -x 60 -y 20 "PS1='executor@host:~/some/deep/path\$ ' bash --norc -i"
sleep 1
prompt_pane="$(tmux list-panes -t "$prompt_session" -F '#{pane_id}' | head -1)"
seat executor.promptseat@"${HOST}" exec-prompt
register_tmux executor.promptseat@"${HOST}" "$prompt_session" "$prompt_pane"
prompt_outcome="$(ring executor.promptseat@"${HOST}" '<ring-prompt@'"${HOST}"'>')"
prompt_screen="$(tmux capture-pane -pt "$prompt_pane" -S -80 2>/dev/null || true)"
tmux kill-session -t "$prompt_session" 2>/dev/null || true
check 'a retired executor pane with only a shell is unresolved and receives no nudge' \
    "$([[ "$prompt_outcome" == unresolved ]] && echo pass || echo fail)" \
    "outcome was $prompt_outcome; pane showed:
$(sed 's/^/#     /' <<<"$prompt_screen" | head -8)"
check 'and the acknowledgement string the check looks for was never sent into the pane' \
    "$(grep -qE 'ACK-[0-9a-f]{8}' <<<"$prompt_screen" && echo fail || echo pass)" \
    "a sent ACK token would confirm every ring from its own echo"

printf '1..%d\n' "$n"
((fail == 0)) || { printf '# %d of %d failed\n' "$fail" "$n" >&2; exit 1; }
