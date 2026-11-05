#!/usr/bin/env bash
# `pair --help` printed nothing and started two agents with "--help" as their task.
set -Eeuo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
reach="$here/../../../../apps/reach/bin/sno-reach"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/bin" "$work/home" "$work/root" "$work/repo"
for cmd in claude codex cursor-agent hermes openclaw tmux orca; do
    printf '#!/usr/bin/env bash\nprintf "%%s %%s\\n" "%s" "$*" >> "%s/launches"\nexit 1\n' "$cmd" "$work" > "$work/bin/$cmd"
    chmod +x "$work/bin/$cmd"
done
run() {
    (cd "$work/repo" && env -i PATH="$work/bin:/usr/bin:/bin" HOME="$work/home" SNO_REACH_ROOT="$work/root" \
        "$reach" pair "$@" > "$work/out" 2> "$work/err") && status=0 || status=$?
}
fail() { printf 'not ok - %s\n' "$1"; cat "$work/out" "$work/err" "$work/launches" 2>/dev/null; exit 1; }

for arg in --help -h; do
    run "$arg"
    [[ $status == 0 ]] || fail "pair $arg exits 0 (got $status)"
    grep -qi 'usage' "$work/out" || fail "pair $arg prints usage on stdout"
    [[ ! -e "$work/launches" ]] || fail "pair $arg starts nothing"
    printf 'ok - pair %s prints usage and starts nothing\n' "$arg"
done

run -x
[[ $status == 64 ]] || fail "pair -x exits 64 (got $status)"
grep -qi 'usage' "$work/err" || fail "pair -x prints usage on stderr"
[[ ! -e "$work/launches" ]] || fail "pair -x starts nothing"
printf 'ok - pair -x is refused and starts nothing\n'
