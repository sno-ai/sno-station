#!/usr/bin/env bash
set -Eeuo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
app="$(cd -- "$here/../../../apps/reach" && pwd)"
if [[ "${1:-}" == --seed ]]; then
    trap 'printf "cleanup seed failed at line %s\n" "$LINENO" >&2' ERR
    root="${2:?}" label="${3:?}" proof="${4:?}"
    host="$(hostname)"
    mkdir -p "$root"
    for address in "sender.cleanup@$host" "worker.cleanup@$host"; do
        SNO_REACH_ROOT="$root" "$app/bin/sno-reach" init --as "$address" --name Fixture >/dev/null
    done
    printf '#!/usr/bin/env bash\ntrap "" TERM\nexec sleep "$1"\n' >"$proof/resistant-sleep"
    chmod +x "$proof/resistant-sleep"
    SNO_REACH_NOW=0 SNO_REACH_WAKE_NO_DETACH=0 \
        SNO_REACH_SLEEP_COMMAND="$proof/resistant-sleep" \
        SNO_REACH_WAKE_STANDIN="$here/fixtures/wake-standin.sh" SNO_REACH_WAKE_OUTCOME=busy \
        "$app/lib/reach-wake" start --root "$root" --sender "sender.cleanup@$host" \
        --recipient "worker.cleanup@$host" --message-id "<cleanup-$label@$host>" \
        --work cleanup-proof --mechanism '' >"$proof/$label.seed.out" 2>"$proof/$label.seed.err"
    state="$(find "$root" -path '*/wake-attempts/*.json' -type f -print -quit)"
    pid="$(jq -r .child_pid "$state")"
    [[ "$pid" =~ ^[1-9][0-9]*$ ]]
    kill -0 "$pid"
    deadline=$((SECONDS + 5))
    until [[ "$(ps -o pgid= -p "$pid" | tr -d ' ')" == "$pid" ]]; do
        ((SECONDS < deadline)) || { ps -o pid=,ppid=,pgid=,comm= -p "$pid" >&2; exit 1; }
        sleep 0.02
    done
    printf '%s\n' "$pid" >"$proof/$label.pid"
    printf '%s\n' "$state" >"$proof/$label.state"
    deadline=$((SECONDS + 5))
    until ps -axo ppid=,comm= | awk -v parent="$pid" '$1==parent && $2 ~ /(^|\/)g?sleep$/ {found=1} END {exit !found}'; do
        ((SECONDS < deadline)) || exit 1
        sleep 0.02
    done
    ps -axo pid=,ppid=,pgid=,lstart=,comm= | awk -v parent="$pid" \
        '$2==parent && $3==parent && $9 ~ /(^|\/)g?sleep$/ {print}' >"$proof/$label.children"
    [[ -s "$proof/$label.children" ]]
    exit 0
fi
proof="$(mktemp -d)"
sleep 300 &
foreign=$!
cleanup() {
    local label pid state command child recorded current
    for label in agent wake; do
        [[ -f "$proof/$label.pid" ]] || continue
        pid="$(<"$proof/$label.pid")" state="$(<"$proof/$label.state")"
        command="$(ps -ww -o args= -p "$pid" 2>/dev/null || true)"
        if [[ "$command" == *"$app/lib/reach-wake run --state $state"* &&
              "$(ps -o pgid= -p "$pid" | tr -d ' ')" == "$pid" ]]; then
            kill -KILL -- "-$pid" 2>/dev/null || true
        fi
        [[ -f "$proof/$label.children" ]] || continue
        while read -r child recorded; do
            recorded="$(printf '%s\n' "$recorded" | xargs)"
            current="$(ps -o ppid=,pgid=,lstart=,comm= -p "$child" 2>/dev/null | xargs || true)"
            # Parent exit changes PPID, but the recorded group/start/command must match.
            if [[ -n "$current" && "${current#* }" == "${recorded#* }" ]]; then
                kill -KILL -- "-$pid" 2>/dev/null || true
            fi
        done <"$proof/$label.children"
    done
    kill -TERM "$foreign" 2>/dev/null || true
    wait "$foreign" 2>/dev/null || true
    printf 'cleanup proof evidence: %s\n' "$proof"
}
trap cleanup EXIT
failures=0
for label in agent wake; do
    script=agent-mailbox-commands.t
    [[ "$label" != wake ]] || script=reachability-wake.t
    rc=0
    REACH_CLEANUP_PROOF="$proof" timeout --kill-after=5 30 bash "$here/$script" cleanup-proof \
        >"$proof/$label.exit.out" 2>"$proof/$label.exit.err" || rc=$?
    [[ -f "$proof/$label.pid" ]] || { cat "$proof/$label.exit.out" "$proof/$label.exit.err"; exit 1; }
    pid="$(<"$proof/$label.pid")"
    alive=yes
    group_empty=no
    for _ in {1..50}; do
        if ! kill -0 "$pid" 2>/dev/null; then alive=no; fi
        if ! kill -0 -- "-$pid" 2>/dev/null; then group_empty=yes; break; fi
        sleep 0.02
    done
    kill -0 "$foreign"
    printf 'fixture=%s exit=%s worker_pid=%s worker_alive=%s group_empty=%s foreign_pid=%s foreign_alive=yes\n' "$label" "$rc" "$pid" "$alive" "$group_empty" "$foreign"
    [[ "$rc" == 0 && "$alive" == no && "$group_empty" == yes ]] || failures=$((failures + 1))
done
((failures == 0))
