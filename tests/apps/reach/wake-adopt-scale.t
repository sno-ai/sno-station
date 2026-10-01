#!/usr/bin/env bash
set -Eeuo pipefail
export HOST="$(hostname)"

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../apps/reach" && pwd)"
wake="$repo_root/lib/reach-wake"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/wake-adopt-scale.XXXXXXXX")"
trap 'status=$?; if ((status)); then printf "test evidence: %s\n" "$test_root"; else rm -r -- "$test_root"; fi' EXIT
root="$test_root/mailbox root"
recipient=worker.adopt-scale@${HOST}
attempt_dir="$root/$recipient/wake-attempts"
mkdir -p -- "$attempt_dir"
# A damaged older record must not hide the pending record that follows it.
printf '{' >"$attempt_dir/truncated.json"

fail() {
    printf 'not ok - %s\n' "$*" >&2
    exit 1
}

# An expired wake without a supervisor is adopted and retired synchronously.
# This exercises recovery without sending mail or leaving a detached worker.
if SNO_REACH_NOW=0 SNO_REACH_WAKE_NO_DETACH=1 "$wake" start \
        --root "$root" --sender worker.sender@"${HOST}" --recipient "$recipient" \
        --message-id '<adopt-scale@'"${HOST}"'>' --work j-adopt-scale --mechanism '' \
        >"$test_root/start.out" 2>"$test_root/start.err"; then
    fail 'fixture unexpectedly confirmed the wake'
else
    [[ "$?" == 5 ]] || fail 'fixture did not create a pending wake'
fi
pending="$(find "$attempt_dir" -type f -name '*.json' ! -name truncated.json -print -quit)"
jq -e '.state == "pending"' "$pending" >/dev/null || fail 'pending fixture missing'
terminal="$(jq -c '.state="confirmed" | .child_pid=0 | .child_start_ticks=0' "$pending")"
for ((index = 1; index <= 2000; index++)); do
    printf '%s\n' "$terminal" >"$attempt_dir/terminal-$index.json"
done
sha256sum "$attempt_dir"/terminal-*.json >"$test_root/terminal-before"

# The original per-file jq scan must exceed the owner's two-second limit.
start_ns="$(date +%s%N)"
SNO_REACH_NOW=5401 "$wake" adopt --root "$root"
end_ns="$(date +%s%N)"
elapsed_ns=$((end_ns - start_ns))
printf 'host=%s root=%s terminal_files=2000 pending_files=1 elapsed_ns=%s\n' \
    "$(hostname)" "$root" "$elapsed_ns"

jq -e '.state == "supervisor-unresolved" and .phase == "escalation" and
    .child_pid == 0 and .terminal_at == 5401' "$pending" >/dev/null ||
    fail 'the pending wake was not adopted and retired'
jq -se --arg id "$(jq -r '.attempt_id' "$pending")" \
    '[.[] | select(.event == "adopted") | .attempt_id] == [$id]' \
    "$root/$recipient/wake.log" >/dev/null || fail 'adopt did not adopt exactly the pending wake'
sha256sum "$attempt_dir"/terminal-*.json >"$test_root/terminal-after"
cmp -s "$test_root/terminal-before" "$test_root/terminal-after" ||
    fail 'adopt changed terminal attempts'
printf 'ok - exactly the pending attempt was adopted; 2000 terminal attempts are unchanged\n'
((elapsed_ns < 2000000000)) || fail "adopt exceeded 2 seconds: elapsed_ns=$elapsed_ns"
printf 'ok - adopt completes under 2 seconds\n'
