#!/usr/bin/env bash
set -Eeuo pipefail
[[ $(uname -s) == Darwin ]] || exit 2
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd -- "$here/../../.." && pwd)"
work="$(mktemp -d "$PWD/.platform-guards.XXXXXX")"
mkdir "$work/home" "$work/tmp"
for app in reach heartbeat subscription-quota-check; do
    name="$app" expected=2
    case "$app" in reach) name=sno-reach; expected=69 ;; heartbeat) expected=1 ;; esac
    rc=0
    HOME="$work/home" XDG_STATE_HOME="$work/home/state" TMPDIR="$work/tmp" \
        /bin/bash "$repo/apps/$app/bin/$name" --help >"$work/$app.out" 2>"$work/$app.err" || rc=$?
    [[ $rc == "$expected" && ! -s "$work/$app.out" ]]
    [[ $(wc -l <"$work/$app.err") -eq 1 ]]
    grep -F 'needs Bash 5' "$work/$app.err"
    grep -q '3.2' "$work/$app.err"
    [[ -z $(find "$work/home" "$work/tmp" -mindepth 1 -print) ]]
    printf 'PASS %s refusal=%s, one stderr line, no stdout or state writes\n' "$app" "$rc"
done
printf 'Evidence: %s\n' "$work"
