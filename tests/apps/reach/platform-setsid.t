#!/usr/bin/env bash
set -Eeuo pipefail
app="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../apps/reach" && pwd)"
wake="${REACH_WAKE_UNDER_TEST:-$app/lib/reach-wake}"
mode="${1:-all}"
case "$mode" in all|helper|public|register|unregister|skip) ;; *) exit 2;; esac
work="$(mktemp -d)"
mkdir -p "$work/bin" "$work/state" "$work/home"
if [[ -n "${REACH_WAKE_UNDER_TEST:-}" ]]; then
    mkdir -p "$work/baseline/lib"
    cp "$wake" "$work/baseline/lib/reach-wake"
    ln -s "$app/vendor" "$work/baseline/vendor"
    ln -s "$app/bin" "$work/baseline/bin"
    wake="$work/baseline/lib/reach-wake"
fi
for tool in bash dirname realpath stat find sed sha256sum timeout flock jq tr awk cat grep date mkdir mktemp chmod ln rm uname ps cut env head hostname mv readlink sleep sort tail tmux wc; do
    ln -s "$(command -v "$tool")" "$work/bin/$tool"
done
host="$(hostname)"
if [[ "$mode" == all || "$mode" == helper ]]; then
for operation in adopt start; do
    args=(adopt --root "$work/state")
    if [[ "$operation" == start ]]; then
        args=(start --root "$work/state" --sender "sender.fixture@$host" --recipient "worker.fixture@$host" --message-id "<fixture@$host>" --work platform-fixture --mechanism '')
    fi
    rc=0
    env PATH="$work/bin" HOME="$work/home" SNO_REACH_WAKE_NO_DETACH=0 "$wake" "${args[@]}" >"$work/$operation.stdout" 2>"$work/$operation.stderr" || rc=$?
    [[ "$rc" == 69 && ! -s "$work/$operation.stdout" && "$(wc -l <"$work/$operation.stderr")" == 1 ]] || { printf 'FAIL setsid %s exit%s; evidence:%s\n' "$operation" "$rc" "$work"; cat "$work/$operation.stderr"; exit 1; }
    grep -q 'needs setsid.*install it and run again' "$work/$operation.stderr"
    [[ -z "$(find "$work/state" "$work/home" -mindepth 1 -print -quit)" ]]
done
printf 'PASS missing setsid adopt/start refuse69 beforestatewrites; evidence:%s\n' "$work"
fi
[[ "$mode" != helper ]] || exit 0
server="platform-setsid-$$"
trap 'tmux -L "$server" kill-server 2>/dev/null || true; printf "setsid public evidence: %s\n" "$work"' EXIT
tmux -L "$server" -f /dev/null new-session -d -s fixture 'cat'
tmux_env="$(tmux -L "$server" display-message -p '#{socket_path},#{pid},0')"
old_pane="$(tmux -L "$server" display-message -p '#{pane_id}')"
target_pane="$(tmux -L "$server" new-window -d -P -F '#{pane_id}' -t fixture 'cat')"
snapshot_case() {
    find "$case_root/home" "$case_root/state" -printf '%P %y %m %l\n' | sort
    find "$case_root/home" "$case_root/state" -type f -print0 | sort -z | xargs -0 sha256sum
    for pane in "$old_pane" "$target_pane"; do
        tmux -L "$server" show-options -p -t "$pane"
    done
}
failures=0
for operation in register unregister; do
    [[ "$mode" == all || "$mode" == public || "$mode" == skip || "$mode" == "$operation" ]] || continue
    case_root="$work/$operation-case"
    mkdir -p "$case_root/home" "$case_root/state"
    address="worker.$operation@$host"
    context=(HOME="$case_root/home" XDG_STATE_HOME="$case_root/home/state" SNO_REACH_ROOT="$case_root/state" TMUX="$tmux_env" TMUX_PANE="$old_pane" SNO_REACH_SKIP_WAKE_ADOPTION=0)
    env "${context[@]}" "$app/bin/sno-reach" init --as "$address" --name Fixture >"$case_root/init.stdout" 2>"$case_root/init.stderr"
    env "${context[@]}" "$app/bin/sno-reach" register --as "$address" --channel tmux --handle "$old_pane" >"$case_root/setup.stdout" 2>"$case_root/setup.stderr"
    args=("$operation" --as "$address")
    if [[ "$operation" == register ]]; then args+=(--channel tmux --handle "$target_pane"); fi
    if [[ "$mode" != skip ]]; then
        snapshot_case >"$case_root/before"
        rc=0
        env "${context[@]}" PATH="$work/bin" "$app/bin/sno-reach" "${args[@]}" >"$case_root/refusal.stdout" 2>"$case_root/refusal.stderr" || rc=$?
        snapshot_case >"$case_root/after"
        printf '%s\n' "$rc" >"$case_root/refusal.status"
        unchanged=yes
        cmp -s "$case_root/before" "$case_root/after" || unchanged=no
        if [[ "$rc" != 69 || -s "$case_root/refusal.stdout" || "$(wc -l <"$case_root/refusal.stderr")" != 1 || "$unchanged" != yes ]] ||
           ! grep -q 'needs setsid.*install it and run again' "$case_root/refusal.stderr"; then
            printf 'FAIL missing setsid public %s: exit=%s unchanged=%s\n' "$operation" "$rc" "$unchanged"
            cat "$case_root/refusal.stderr"
            failures=$((failures + 1))
        else printf 'PASS missing setsid public %s refuses before registration/pane mutation\n' "$operation"; fi
    fi
    env "${context[@]}" "$app/bin/sno-reach" register --as "$address" --channel tmux --handle "$old_pane" >"$case_root/reset.stdout" 2>"$case_root/reset.stderr"
    env "${context[@]}" PATH="$work/bin" SNO_REACH_SKIP_WAKE_ADOPTION=1 "$app/bin/sno-reach" "${args[@]}" >"$case_root/skip.stdout" 2>"$case_root/skip.stderr"
    if [[ "$operation" == register ]]; then
        jq -e --arg pane "$target_pane" '.identity.value == $pane' "$case_root/state/$address/reachable.json" >/dev/null
        [[ "$(tmux -L "$server" show-options -pqv -t "$target_pane" @sno_reach_address)" == "$address" ]]
    else [[ ! -e "$case_root/state/$address/reachable.json" ]]; fi
    [[ ! -s "$case_root/skip.stderr" ]]
    printf 'PASS missing setsid public %s with explicit skip retains normal effect\n' "$operation"
done
((failures == 0))
