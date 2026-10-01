#!/usr/bin/env bash
# selftest.sh — regression checks for message-agent-window.sh.
#
# Every case here is a failure that actually happened on a live agent window.
# Most of them share one shape: a signal that looks like success and proves
# nothing — an acceptance receipt for a message that never ran, a pipe flag set
# on a dead pipe, a cursor moved by the window echoing back what you just sent.
#
# Runs entirely against a throwaway tmux pane. It never touches a real agent.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="$(cd "$here/../../../../apps/reach" && pwd)"
messenger="$app/lib/reach-call"
session="agent-window-message-selftest-$$"
state_root="$(mktemp -d "${TMPDIR:-/tmp}/agent-window-message-state.XXXXXX")"
export XDG_STATE_HOME="$state_root" SNO_REACH_ROOT="$state_root/mail" HOME="$state_root/home"
mkdir -p "$HOME"
tmux() { command tmux -L "$session" "$@"; }
export -f tmux
export session
failures=0
pane=""
rotation_pane=""
dead_pane=""
external_pane=""
scroll_pane=""
popup_pane=""

cleanup() {
	local status=$?
	tmux kill-server 2>/dev/null || true
	if [[ -n "$dead_pane" ]]; then
		tmux kill-pane -t "$dead_pane" 2>/dev/null || true
	fi
	if ((status != 0 || failures != 0)); then printf "test evidence: %s\\n" "$state_root"; else rm -r -- "$state_root"; fi
	return "$status"
}
trap cleanup EXIT

check() {
	local label="$1" expected="$2" actual="$3"
	if [[ "$expected" == "$actual" ]]; then
		printf 'ok   %s\n' "$label"
	else
		printf 'FAIL %s — expected %s, got %s\n' "$label" "$expected" "$actual" >&2
		failures=$(( failures + 1 ))
	fi
}

run_rc() {
	set +e
	"$@" >/dev/null 2>&1
	local rc=$?
	set -e
	printf '%s' "$rc"
}

wait_for_capture() {
	local file="$1" marker="$2" timeout="$3" deadline
	deadline=$(( SECONDS + timeout ))
	while (( SECONDS < deadline )); do
		grep -Fq -- "$marker" "$file" 2>/dev/null && return 0
		sleep 0.05
	done
	grep -Fq -- "$marker" "$file" 2>/dev/null
}

for tool in tmux jq perl; do
	command -v "$tool" >/dev/null || { printf 'selftest needs %s\n' "$tool" >&2; exit 2; }
done

test_process_start() {
    if [[ -d /proc ]]; then awk '{print $22}' "/proc/$1/stat";
    else ps -o lstart= -p "$1"; fi
}
test_stdout_inode() {
    if [[ -d /proc ]]; then stat -Lc '%d:%i' "/proc/$1/fd/1"; return; fi
    local line device='' inode=''
    while IFS= read -r line; do
        case "$line" in D*) device="${line#D}";; i*) inode="${line#i}";; esac
    done < <(/usr/sbin/lsof -p "$1" -a -d 1 -F Din)
    [[ -n "$device" && -n "$inode" ]] || return 1
    printf '%s:%s\n' "$((device))" "$inode"
}


tmux new-session -d -s "$session" -c "${TMPDIR:-/tmp}" 'bash --norc'
sleep 1
pane="$(tmux list-panes -t "$session" -F '#{pane_id}')"
[[ -n "$pane" ]] || { printf 'selftest could not create a pane\n' >&2; exit 2; }

check "usage error without a terminal" 2 "$(run_rc "$messenger" --text hi)"
check "unknown handle shape is a usage error" 2 "$(run_rc "$messenger" --terminal nonsense --text hi)"
check "removed backend option is rejected" 2 \
	"$(run_rc "$messenger" --backend tmux --terminal "$pane" --timeout 1)"
check "removed Orca backend option is rejected" 2 \
	"$(run_rc "$messenger" --backend orca --terminal "$pane" --timeout 1)"
check "removed automatic backend option is rejected" 2 \
	"$(run_rc "$messenger" --backend auto --terminal "$pane" --timeout 1)"
check "removed Orca handle is rejected" 2 \
	"$(run_rc "$messenger" --terminal term_old --timeout 1)"
check "blank send is rejected before any key" 2 \
	"$(run_rc "$messenger" --terminal "$pane" --text '   ' --timeout 1)"

# Read-only on a quiet pane must answer with the screen, not an empty string.
# "Nothing changed" and "nothing there" are different answers.
read_started=$SECONDS
read_json="$("$messenger" --terminal "$pane" --timeout 4 --every 2)"
read_elapsed=$(( SECONDS - read_started ))
check "read-only succeeds" true "$(printf '%s' "$read_json" | jq -r '.ok')"
check "orientation returns before its timeout" true "$([[ "$read_elapsed" -lt 2 ]] && echo true || echo false)"
check "read-only returns orientation in screen" true \
	"$(printf '%s' "$read_json" | jq -r '.screen | length > 0')"
check "orientation output starts empty" 0 \
	"$(printf '%s' "$read_json" | jq -r '.output | length')"
check "orientation line count starts at zero" 0 \
	"$(printf '%s' "$read_json" | jq -r '.newLineCount')"
check "cursor binds pane token and offset" true \
	"$(printf '%s' "$read_json" | jq -r '.cursorAfter | test("^[^:]+:[0-9]+$")')"
check "JSON has no backend field" false "$(printf '%s' "$read_json" | jq 'has("backend")')"
read_cursor="$(printf '%s' "$read_json" | jq -r '.cursorAfter')"
read_token="${read_cursor%%:*}"
read_state_dir="$SNO_REACH_ROOT/.channels/tmux/$read_token"
check "state directory is private" 700 "$(stat -c '%a' "$read_state_dir")"
check "capture file is private" 600 "$(stat -c '%a' "$read_state_dir/capture.log")"
check "cursor from another pane incarnation is rejected" 5 \
	"$(run_rc "$messenger" --terminal "$pane" --since "wrong-$read_token:0" --timeout 1 --every 1)"

tmux send-keys -t "$pane" -l -- "printf 'BOUNDARY-ONE\\nBOUNDARY-TWO\\n'"
tmux send-keys -t "$pane" C-m
sleep 0.3
boundary_json="$("$messenger" --terminal "$pane" --since "$read_cursor" --timeout 2 --every 1)"
boundary_output="$(printf '%s' "$boundary_json" | jq -r '.output')"
check "post-boundary first marker appears once" 1 "$(printf '%s' "$boundary_output" | grep -c '^BOUNDARY-ONE$' || true)"
check "post-boundary second marker appears once" 1 "$(printf '%s' "$boundary_output" | grep -c '^BOUNDARY-TWO$' || true)"
check "post-boundary markers stay ordered" true \
	"$(printf '%s\n' "$boundary_output" | awk '/^BOUNDARY-ONE$/ {one=NR} /^BOUNDARY-TWO$/ {two=NR} END {exit !(one && two && one<two)}' && echo true || echo false)"

race_pane="$(tmux new-window -d -P -F '#{pane_id}' -t "$session" \
	"for i in \$(seq 1 250); do printf 'RACE-%03d\\n' \"\$i\"; sleep 0.005; done; sleep 5")"
sleep 0.1
race_orientation="$("$messenger" --terminal "$race_pane" --timeout 1 --every 1)"
race_cursor="$(printf '%s' "$race_orientation" | jq -r '.cursorAfter')"
sleep 1.6
race_json="$("$messenger" --terminal "$race_pane" --since "$race_cursor" --timeout 1 --every 1)"
race_numbers="$(printf '%s' "$race_json" | jq -r '.output' | sed -n 's/^RACE-\([0-9][0-9]*\)$/\1/p')"
race_count="$(printf '%s\n' "$race_numbers" | sed '/^$/d' | wc -l)"
race_unique="$(printf '%s\n' "$race_numbers" | sed '/^$/d' | sort -u | wc -l)"
race_consecutive=true
printf '%s\n' "$race_numbers" | sed '/^$/d' | awk '
	NR == 1 { previous = $1 + 0; next }
	($1 + 0) != previous + 1 { exit 1 }
	{ previous = $1 + 0 }
' || race_consecutive=false
check "continuous output crosses orientation boundary" true "$([[ "$race_count" -ge 20 ]] && echo true || echo false)"
check "post-boundary continuous markers are unique" "$race_count" "$race_unique"
check "post-boundary continuous markers have no gap" true "$race_consecutive"

expect_pane="$(tmux new-window -d -P -F '#{pane_id}' -t "$session" -c "${TMPDIR:-/tmp}" 'bash --norc')"
expect_json="$("$messenger" --terminal "$expect_pane" --timeout 1 --every 1)"
expect_cursor="$(printf '%s' "$expect_json" | jq -r '.cursorAfter')"
tmux send-keys -t "$expect_pane" -l -- "printf 'READ-NOT-DONE\\n'"
tmux send-keys -t "$expect_pane" C-m
check "read-only expect rejects unrelated output" 4 \
	"$(run_rc "$messenger" --terminal "$expect_pane" --since "$expect_cursor" \
		--expect '^READ-DONE$' --timeout 1 --every 1)"
expect_json="$("$messenger" --terminal "$expect_pane" --timeout 1 --every 1)"
expect_cursor="$(printf '%s' "$expect_json" | jq -r '.cursorAfter')"
tmux send-keys -t "$expect_pane" -l -- "printf 'READ-DONE\\n'"
tmux send-keys -t "$expect_pane" C-m
check "read-only expect succeeds on its match" 0 \
	"$(run_rc "$messenger" --terminal "$expect_pane" --since "$expect_cursor" \
		--expect '^READ-DONE$' --timeout 2 --every 1)"

scroll_pane="$(tmux new-window -d -P -F '#{pane_id}' -t "$session" -c "${TMPDIR:-/tmp}" 'bash --norc')"
tmux send-keys -t "$scroll_pane" -l -- "for i in {1..80}; do printf 'SCROLL-%03d\\n' \"\$i\"; done"
tmux send-keys -t "$scroll_pane" C-m
sleep 0.3
scroll_json="$("$messenger" --terminal "$scroll_pane" --timeout 1 --every 1)"
check "orientation includes retained scrollback" true \
	"$(printf '%s' "$scroll_json" | jq -r '.screen' | grep -q 'SCROLL-001' && echo true || echo false)"

stale_input="$state_root/stale-composer-input.bin"
stale_command="stty raw -echo; printf '\\n› stale instruction\\n  fixture-model high · Context 100%% left\\n'; dd bs=1 count=1 of=$(printf '%q' "$stale_input") status=none; sleep 1"
stale_pane="$(tmux new-window -d -P -F '#{pane_id}' -t "$session" "$stale_command")"
sleep 0.3
check "pre-existing composer text is cleared, then the send goes out" 4 \
	"$(run_rc "$messenger" --terminal "$stale_pane" --text 'new instruction' --timeout 1 --every 1)"
check "cleared stale composer receives the message bytes" 1 \
	"$(stat -c '%s' "$stale_input" 2>/dev/null || echo 0)"
tmux kill-pane -t "$stale_pane" 2>/dev/null || true

placeholder_input="$state_root/placeholder-input.bin"
placeholder_command="stty raw -echo; printf '\\n› Ask Codex to do anything\\n  fixture-model high · Context 100%% left\\n'; cat >$(printf '%q' "$placeholder_input")"
placeholder_pane="$(tmux new-window -d -P -F '#{pane_id}' -t "$session" "$placeholder_command")"
sleep 0.3
check "Codex placeholder is not stale composer text" 4 \
	"$(run_rc "$messenger" --terminal "$placeholder_pane" --text 'placeholder safety probe' --timeout 2 --every 1)"
check "Codex placeholder permits the initial send" true \
	"$([[ "$(stat -c '%s' "$placeholder_input" 2>/dev/null || echo 0)" -gt 0 ]] && echo true || echo false)"
tmux kill-pane -t "$placeholder_pane" 2>/dev/null || true

# The window computes this value; the sent text never contains it.
check "verified send on computed output" 0 \
	"$(run_rc "$messenger" --terminal "$pane" --text "printf 'RE%s\n' SULT-OK" --expect 'RESULT-OK' --timeout 20 --every 2)"

# A genuine reply can be a substring of the instruction. The echo still must not
# verify, but the independently printed reply must.
check "genuine substring reply verifies" 0 \
	"$(run_rc "$messenger" --terminal "$pane" \
		--text "printf '%s\n' 'REPLY-SUBSTRING' # instruction names REPLY-SUBSTRING" \
		--expect 'REPLY-SUBSTRING' --timeout 8 --every 1)"

# The echo of the sent command must not satisfy --expect. This one passed while
# broken twice: first because the filter compared whole lines against the whole
# message, then because a long message is WRAPPED when echoed and every fragment
# slipped through. A shell echo fails it from the other side — prompt plus
# command is longer than what was sent.
check "sent-only marker does not verify" 4 \
	"$(run_rc "$messenger" --terminal "$pane" --text 'true # SELFTEST-MARKER-NEVER-PRINTED' --expect 'SELFTEST-MARKER-NEVER-PRINTED' --timeout 14 --every 2)"

# The private watch-to-mailbox hook is retired; public watch is independently
# covered by read-only.t. Preserve capture integrity used by call verification.
# The tmux capture retains only the latest 1 MiB, but its cursors stay absolute.
# A cursor still inside that retained window must work; an older one must fail
# loudly instead of falling back to the visible pane or "no new output".
rotation_pane="$(tmux new-window -d -P -F '#{pane_id}' -t "$session" -c "${TMPDIR:-/tmp}" 'bash --norc')"
rotation_baseline="$("$messenger" --terminal "$rotation_pane" --timeout 1 --every 1)"
stale_cursor="$(printf '%s' "$rotation_baseline" | jq -r '.cursorAfter')"
rotation_token="${stale_cursor%%:*}"
rotation_file="$SNO_REACH_ROOT/.channels/tmux/$rotation_token/capture.log"
phase_one="PHASE-ONE-END-$$"
tmux send-keys -t "$rotation_pane" -l -- \
	"head -c 700000 /dev/zero | tr '\\0' A; printf '\\n%s\\n' '$phase_one'" 2>/dev/null
tmux send-keys -t "$rotation_pane" C-m 2>/dev/null
wait_for_capture "$rotation_file" "$phase_one" 10 || true
phase_one_json="$("$messenger" --terminal "$rotation_pane" --since "$stale_cursor" \
	--timeout 1 --every 1)"
retained_cursor="$(printf '%s' "$phase_one_json" | jq -r '.cursorAfter')"

retained_marker="RETAINED-AFTER-ROTATION-$$"
tmux send-keys -t "$rotation_pane" -l -- \
	"head -c 700000 /dev/zero | tr '\\0' B; printf '\\n%s\\n' '$retained_marker'" 2>/dev/null
tmux send-keys -t "$rotation_pane" C-m 2>/dev/null
wait_for_capture "$rotation_file" "$retained_marker" 10 || true
set +e
retained_out="$("$messenger" --terminal "$rotation_pane" --since "$retained_cursor" \
	--timeout 1 --every 1 2>&1)"
retained_rc=$?
set -e
retained_after="$(printf '%s' "$retained_out" | jq -r '.cursorAfter // "0:0"' 2>/dev/null || echo '0:0')"
retained_offset="${retained_after##*:}"
check "capture file is capped at 1 MiB" true \
	"$([[ "$(wc -c <"$rotation_file")" -le 1048576 ]] && echo true || echo false)"
check "retained cursor remains readable after rotation" 0 "$retained_rc"
check "retained cursor returns new output" true \
	"$(printf '%s' "$retained_out" | grep -q "$retained_marker" && echo true || echo false)"
check "cursor remains absolute after rotation" true \
	"$([[ "$retained_offset" =~ ^[0-9]+$ && "$retained_offset" -gt 1048576 ]] && echo true || echo false)"

set +e
stale_out="$("$messenger" --terminal "$rotation_pane" --since "$stale_cursor" \
	--timeout 1 --every 1 2>&1)"
stale_rc=$?
set -e
check "cursor older than retained output exits unreliable" 5 "$stale_rc"
check "stale cursor explains the retained-window failure" true \
	"$(printf '%s' "$stale_out" | grep -q 'cursor is older than retained output' && echo true || echo false)"
check "stale cursor never falls back to a read success" false \
	"$(printf '%s' "$stale_out" | grep -Eq 'read-only-current-screen|read-only-no-new-output' && echo true || echo false)"

# A large payload must survive the read path. Passing captured output as a
# command-line argument dies with "Argument list too long" on a busy window,
# which turned a thirty-minute watch into a wall of identical errors.
tmux send-keys -t "$pane" -l -- "head -c 200000 /dev/urandom | base64 | head -2000" 2>/dev/null
tmux send-keys -t "$pane" C-m 2>/dev/null
sleep 6
big_json="$("$messenger" --terminal "$pane" --timeout 6 --every 2 2>/dev/null || true)"
check "a large capture still parses" true \
	"$(printf '%s' "$big_json" | jq -e '.ok == true' >/dev/null 2>&1 && echo true || echo false)"

# Replacing this messenger's pipe releases its lifetime lease. The next read
# must fail rather than claim or overwrite the external pipe.
external_pane="$(tmux new-window -d -P -F '#{pane_id}' -t "$session" -c "${TMPDIR:-/tmp}" 'bash --norc')"
external_json="$("$messenger" --terminal "$external_pane" --timeout 1 --every 1)"
external_cursor="$(printf '%s' "$external_json" | jq -r '.cursorAfter')"
external_log="$state_root/external-pipe.log"
tmux pipe-pane -t "$external_pane" "cat >> $(printf '%q' "$external_log")"
check "external pipe replacement is rejected" 5 \
	"$(run_rc "$messenger" --terminal "$external_pane" --since "$external_cursor" --timeout 1 --every 1)"
tmux send-keys -t "$external_pane" -l -- "printf 'EXTERNAL-PIPE-KEPT\\n'"
tmux send-keys -t "$external_pane" C-m
wait_for_capture "$external_log" 'EXTERNAL-PIPE-KEPT' 3 || true
check "external pipe remains installed" true \
	"$(grep -q 'EXTERNAL-PIPE-KEPT' "$external_log" 2>/dev/null && echo true || echo false)"

owner_pid_pane="$(tmux new-window -d -P -F '#{pane_id}' -t "$session" -c "${TMPDIR:-/tmp}" 'bash --norc')"
owner_pid_json="$("$messenger" --terminal "$owner_pid_pane" --timeout 1 --every 1)"
owner_pid_cursor="$(printf '%s' "$owner_pid_json" | jq -r '.cursorAfter')"
owner_pid_token="${owner_pid_cursor%%:*}"
owner_pid_file="$SNO_REACH_ROOT/.channels/tmux/$owner_pid_token/owner.tsv"
IFS=$'\t' read -r owner_token owner_lease owner_pid owner_start owner_inode <"$owner_pid_file"
printf '%s\t%s\t%s\t%s\t%s\n' \
	"$owner_token" "$owner_lease" 999999999 "$owner_start" "$owner_inode" >"$owner_pid_file"
check "stale owner PID is rejected" 5 \
	"$(run_rc "$messenger" --terminal "$owner_pid_pane" --since "$owner_pid_cursor" --timeout 1 --every 1)"

owner_inode_pane="$(tmux new-window -d -P -F '#{pane_id}' -t "$session" -c "${TMPDIR:-/tmp}" 'bash --norc')"
owner_inode_json="$("$messenger" --terminal "$owner_inode_pane" --timeout 1 --every 1)"
owner_inode_cursor="$(printf '%s' "$owner_inode_json" | jq -r '.cursorAfter')"
owner_inode_token="${owner_inode_cursor%%:*}"
owner_inode_file="$SNO_REACH_ROOT/.channels/tmux/$owner_inode_token/owner.tsv"
IFS=$'\t' read -r owner_token owner_lease owner_pid owner_start owner_inode <"$owner_inode_file"
printf '%s\t%s\t%s\t%s\t%s\n' \
	"$owner_token" "$owner_lease" "$owner_pid" "$owner_start" '0:0' >"$owner_inode_file"
check "wrong capture inode is rejected" 5 \
	"$(run_rc "$messenger" --terminal "$owner_inode_pane" --since "$owner_inode_cursor" --timeout 1 --every 1)"

owner_fd_pane="$(tmux new-window -d -P -F '#{pane_id}' -t "$session" -c "${TMPDIR:-/tmp}" 'bash --norc')"
owner_fd_json="$("$messenger" --terminal "$owner_fd_pane" --timeout 1 --every 1)"
owner_fd_cursor="$(printf '%s' "$owner_fd_json" | jq -r '.cursorAfter')"
owner_fd_token="${owner_fd_cursor%%:*}"
owner_fd_dir="$SNO_REACH_ROOT/.channels/tmux/$owner_fd_token"
owner_fd_external="$owner_fd_dir/wrong-output.log"
printf -v owner_fd_command \
	'exec 8>%q; flock 8; echo "$$" >%q; exec cat >%q' \
	"$owner_fd_dir/lease.lock" "$owner_fd_dir/fixture.pid" "$owner_fd_external"
tmux pipe-pane -t "$owner_fd_pane" "$owner_fd_command"
owner_fd_pid=""
for _ in {1..40}; do
	owner_fd_pid="$(cat "$owner_fd_dir/fixture.pid" 2>/dev/null || true)"
	[[ "$owner_fd_pid" =~ ^[0-9]+$ ]] && break
	sleep 0.05
done
[[ "$owner_fd_pid" =~ ^[0-9]+$ ]] || { printf 'could not identify fake lease holder\n' >&2; exit 2; }
kill -0 "$owner_fd_pid"
if flock -n "$owner_fd_dir/lease.lock" true; then printf 'fake writer did not hold its lease\n' >&2; exit 2; fi
owner_fd_start="$(test_process_start "$owner_fd_pid")"
[[ "$(test_stdout_inode "$owner_fd_pid")" == "$(stat -Lc '%d:%i' "$owner_fd_external")" ]] || { printf 'fake writer stdout not observable\n' >&2; exit 2; }
owner_fd_inode="$(stat -Lc '%d:%i' "$owner_fd_dir/capture.log")"
printf '%s\t%s\t%s\t%s\t%s\n' \
	"$owner_fd_token" fake-lease "$owner_fd_pid" "$owner_fd_start" "$owner_fd_inode" >"$owner_fd_dir/owner.tsv"
check "writer with wrong output descriptor is rejected" 5 \
	"$(run_rc "$messenger" --terminal "$owner_fd_pane" --since "$owner_fd_cursor" --timeout 1 --every 1)"

owner_lease_pane="$(tmux new-window -d -P -F '#{pane_id}' -t "$session" -c "${TMPDIR:-/tmp}" 'bash --norc')"
owner_lease_json="$("$messenger" --terminal "$owner_lease_pane" --timeout 1 --every 1)"
owner_lease_cursor="$(printf '%s' "$owner_lease_json" | jq -r '.cursorAfter')"
owner_lease_token="${owner_lease_cursor%%:*}"
owner_lease_dir="$SNO_REACH_ROOT/.channels/tmux/$owner_lease_token"
printf -v owner_lease_command \
	'echo "$$" >%q; exec cat >>%q' "$owner_lease_dir/fixture.pid" "$owner_lease_dir/capture.log"
tmux pipe-pane -t "$owner_lease_pane" "$owner_lease_command"
owner_lease_pid=""
for _ in {1..40}; do
	owner_lease_pid="$(cat "$owner_lease_dir/fixture.pid" 2>/dev/null || true)"
	[[ "$owner_lease_pid" =~ ^[0-9]+$ ]] && break
	sleep 0.05
done
[[ "$owner_lease_pid" =~ ^[0-9]+$ ]] || { printf 'could not identify fake unlocked writer\n' >&2; exit 2; }
kill -0 "$owner_lease_pid"
flock -n "$owner_lease_dir/lease.lock" true
owner_lease_start="$(test_process_start "$owner_lease_pid")"
[[ "$(test_stdout_inode "$owner_lease_pid")" == "$(stat -Lc '%d:%i' "$owner_lease_dir/capture.log")" ]] || { printf 'unlocked writer stdout not observable\n' >&2; exit 2; }
owner_lease_inode="$(stat -Lc '%d:%i' "$owner_lease_dir/capture.log")"
printf '%s\t%s\t%s\t%s\t%s\n' \
	"$owner_lease_token" fake-lease "$owner_lease_pid" "$owner_lease_start" "$owner_lease_inode" >"$owner_lease_dir/owner.tsv"
check "writer without the lifetime lease is rejected" 5 \
	"$(run_rc "$messenger" --terminal "$owner_lease_pane" --since "$owner_lease_cursor" --timeout 1 --every 1)"

# One send owns the pane until its verification completes. A second send must
# fail loud instead of interleaving bytes or borrowing the first result.
first_send_out="$state_root/first-send.out"
first_send_started="$state_root/first-send.started"
"$messenger" --terminal "$pane" --text "printf ready > '$first_send_started'; sleep 3; printf 'FIRST-SEND-DONE\\n'" \
	--expect FIRST-SEND-DONE --timeout 8 --every 1 >"$first_send_out" 2>&1 &
first_send_pid=$!
for _ in {1..40}; do
	[[ -s "$first_send_started" ]] && break
	sleep 0.05
done
[[ -s "$first_send_started" ]] || { cat "$first_send_out"; printf 'first send never started\n' >&2; exit 1; }
check "second simultaneous send is refused" 3 \
	"$(run_rc "$messenger" --terminal "$pane" --text "printf 'SECOND-SEND-RAN\\n'" --timeout 2 --every 1)"
first_send_rc=0
wait "$first_send_pid" || first_send_rc=$?
check "first send still completes" 0 "$first_send_rc"
check "refused second send never ran" false \
	"$(tmux capture-pane -p -S - -t "$pane" | grep -q 'SECOND-SEND-RAN' && echo true || echo false)"

# Replay the current real Codex filesystem popup text against a raw-input pane.
# Only the positive oracle may receive Escape (byte 27) during recovery.
popup_input="$state_root/popup-input.bin"
popup_command="stty raw echo; printf '\\nno matches\\nenter insert · esc close · [All Results] Filesystem Only Plugins\\n'; cat >$(printf '%q' "$popup_input")"
popup_pane="$(tmux new-window -d -P -F '#{pane_id}' -t "$session" "$popup_command")"
sleep 0.3
popup_rc=0
"$messenger" --terminal "$popup_pane" --text abc --timeout 3 --every 1 >"$state_root/popup-result" 2>&1 || popup_rc=$?
popup_escapes="$(od -An -t u1 "$popup_input" 2>/dev/null | tr -s ' ' '\n' | grep -c '^27$' || true)"
check "real popup oracle receives one Escape" 1 "$popup_escapes"
popup_controls="$(od -An -t u1 "$popup_input" 2>/dev/null | tr -s ' ' '\n' | grep -E '^(13|27)$' | paste -sd ' ' -)"
check "popup recovery orders submit Escape submit" '13 27 13' "$popup_controls"
if [[ "$popup_controls" != '13 27 13' ]]; then
	printf 'Popup fixture exit=%s; result, screen and received input:\n' "$popup_rc"
	cat "$state_root/popup-result"
	tmux display-message -pt "$popup_pane" '#{pane_current_command} #{pane_width} #{pane_height}'
	tmux capture-pane -p -S - -t "$popup_pane"
	od -An -c "$popup_input"
fi

plain_input="$state_root/plain-input.bin"
plain_command="stty raw -echo; printf '\\nfixture-model high · Context 100%% left\\n'; cat >$(printf '%q' "$plain_input")"
popup_pane="$(tmux new-window -d -P -F '#{pane_id}' -t "$session" "$plain_command")"
sleep 0.3
run_rc "$messenger" --terminal "$popup_pane" --text abc --timeout 3 --every 1 >/dev/null
plain_escapes="$(od -An -t u1 "$plain_input" 2>/dev/null | tr -s ' ' '\n' | grep -c '^27$' || true)"
check "ordinary working screen receives no Escape" 0 "$plain_escapes"

no_match_only_input="$state_root/no-match-only-input.bin"
no_match_only_command="stty raw echo; printf '\\nno matches\\nFilesystem Only\\n'; cat >$(printf '%q' "$no_match_only_input")"
popup_pane="$(tmux new-window -d -P -F '#{pane_id}' -t "$session" "$no_match_only_command")"
sleep 0.3
run_rc "$messenger" --terminal "$popup_pane" --text abc --timeout 3 --every 1 >/dev/null
no_match_only_escapes="$(od -An -t u1 "$no_match_only_input" 2>/dev/null | tr -s ' ' '\n' | grep -c '^27$' || true)"
check "no-matches text without close hint receives no Escape" 0 "$no_match_only_escapes"

close_only_input="$state_root/close-only-input.bin"
close_only_command="stty raw echo; printf '\\nenter insert · esc close\\nFilesystem Only\\n'; cat >$(printf '%q' "$close_only_input")"
popup_pane="$(tmux new-window -d -P -F '#{pane_id}' -t "$session" "$close_only_command")"
sleep 0.3
run_rc "$messenger" --terminal "$popup_pane" --text abc --timeout 3 --every 1 >/dev/null
close_only_escapes="$(od -An -t u1 "$close_only_input" 2>/dev/null | tr -s ' ' '\n' | grep -c '^27$' || true)"
check "close hint without no-matches text receives no Escape" 0 "$close_only_escapes"

# After a submitted message, an approval prompt must never receive an automatic
# second carriage return while the delivery receipt is still absent.
approval_reader="$state_root/approval-reader.pl"
# The generated helper reads INPUT_FILE when it runs.
# shellcheck disable=SC2016
printf '%s\n' \
	'#!/usr/bin/env perl' \
	'use strict; use warnings;' \
	'open my $fh, q{>}, $ENV{INPUT_FILE} or die $!;' \
	'$| = 1;' \
	'while (sysread(STDIN, my $c, 1)) { syswrite($fh, $c); last if ord($c) == 13; }' \
	'print "\nPress enter to confirm\n";' \
	'while (sysread(STDIN, my $c, 1)) { syswrite($fh, $c); }' \
	>"$approval_reader"
chmod +x "$approval_reader"
approval_input="$state_root/approval-input.bin"
approval_command="stty raw -echo; INPUT_FILE=$(printf '%q' "$approval_input") $(printf '%q' "$approval_reader")"
approval_key_pane="$(tmux new-window -d -P -F '#{pane_id}' -t "$session" "$approval_command")"
sleep 0.3
check "approval prompt send remains unverified" 4 \
	"$(run_rc "$messenger" --terminal "$approval_key_pane" --text 'approval safety probe' \
		--timeout 3 --every 1)"
approval_returns="$(od -An -t u1 "$approval_input" 2>/dev/null | tr -s ' ' '\n' | grep -c '^13$' || true)"
check "approval prompt receives no automatic second return" 1 "$approval_returns"

if [[ "$failures" -eq 0 ]]; then
	printf 'agent-window-direct-message selftest: all checks passed\n'
else
	printf 'agent-window-direct-message selftest: %s check(s) failed\n' "$failures" >&2
	exit 1
fi
