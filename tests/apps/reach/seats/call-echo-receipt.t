#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${1:-}" == --actor ]]; then
    stty -echo
    printf 'READY receipt actor\n'
    while IFS= read -r line; do
        [[ "$line" =~ REACH-RECEIPT-[0-9]+-[0-9]+-[0-9]+ ]] || continue
        receipt="${BASH_REMATCH[0]}"
        # Model readline's repeated character at a carriage-return wrap.
        printf '%s\n' "${line/true #/true # X}"
        if [[ "$line" == *spinner-control* ]]; then
            printf '• %s◦3 W\n' "$receipt"
        elif [[ "$line" == *decorated-control* ]]; then
            printf '• %s  › Ask Codex to do anything\n' "$receipt"
        elif [[ "$line" == *painted-control* ]]; then
            # Model a TUI that paints the reply with carriage returns and cursor moves, no newline.
            printf '\r\e[2C\e[3A%s\r\e[2C\e[1BECHO-EXPECTED-ANSWER\r\e[1B\e[K\n' "$receipt"
        else
            printf '%s\n' "$receipt"
        fi
        [[ "$line" != *positive-control* ]] || printf 'ECHO-EXPECTED-ANSWER\n'
    done
    exit 0
fi

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
messenger="$here/../../../../apps/reach/lib/reach-call"
proof="$(mktemp -d "${TMPDIR:-/tmp}/reach-echo-receipt.XXXXXX")"
server="reach-echo-receipt-$$"
export SNO_REACH_ROOT="$proof/state" HOME="$proof/home"
mkdir -p "$HOME"
cleanup() {
    local status=$?
    trap - EXIT
    tmux -L "$server" kill-server 2>/dev/null || true
    printf 'receipt echo evidence: %s\n' "$proof"
    exit "$status"
}
trap cleanup EXIT
printf -v actor 'bash %q --actor' "$here/call-echo-receipt.t"
tmux -L "$server" -f /dev/null new-session -d -s actor "$actor"
pane="$(tmux -L "$server" display-message -p '#{pane_id}')"
TMUX="$(tmux -L "$server" display-message -p '#{socket_path},#{pid},0')"
export TMUX
deadline=$((SECONDS + 5))
until tmux -L "$server" capture-pane -p -t "$pane" | grep -q 'READY receipt actor'; do
    ((SECONDS < deadline)) || exit 1
    sleep 0.05
done
status=0
"$messenger" --terminal "$pane" --text 'true # ECHO-EXPECTED-ANSWER' \
    --expect ECHO-EXPECTED-ANSWER --timeout 2 --every 1 \
    >"$proof/negative.out" 2>"$proof/negative.err" || status=$?
[[ "$status" == 4 ]] || { printf 'FAIL command echo verified: status=%s\n' "$status"; exit 1; }
"$messenger" --terminal "$pane" --text 'true # ECHO-EXPECTED-ANSWER positive-control' \
    --expect ECHO-EXPECTED-ANSWER --timeout 2 --every 1 >"$proof/positive.json"
jq -e '.verified == true' "$proof/positive.json" >/dev/null
"$messenger" --terminal "$pane" --text 'true # ECHO-EXPECTED-ANSWER positive-control decorated-control' \
    --expect ECHO-EXPECTED-ANSWER --timeout 2 --every 1 >"$proof/decorated.json"
jq -e '.verified == true' "$proof/decorated.json" >/dev/null
"$messenger" --terminal "$pane" --text 'true # ECHO-EXPECTED-ANSWER positive-control spinner-control' \
    --expect ECHO-EXPECTED-ANSWER --timeout 2 --every 1 >"$proof/spinner.json"
jq -e '.verified == true' "$proof/spinner.json" >/dev/null
"$messenger" --terminal "$pane" --text 'true # ECHO-EXPECTED-ANSWER painted-control' \
    --expect ECHO-EXPECTED-ANSWER --timeout 2 --every 1 >"$proof/painted.json"
jq -e '.verified == true' "$proof/painted.json" >/dev/null
printf 'PASS repainted command echo is not a reply; actual post-receipt answer verifies\n'
