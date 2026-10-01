#!/usr/bin/env bash
set -Eeuo pipefail

root="$(git rev-parse --show-toplevel)"
proof="${1:?provide a fresh proof directory outside the checkout}"
contract="${2:?provide the pinned requirements contract}"
[[ ! -e "$proof" ]] || { printf 'CI proof directory already exists: %s\n' "$proof" >&2; exit 2; }
mkdir -p -- "$proof/tmp"
proof="$(realpath "$proof")"
contract="$(realpath -e "$contract")"
export TMPDIR="$proof/tmp" LC_ALL=C
source_commit="$(git rev-parse HEAD)"
finish() {
    local status=$?
    trap - EXIT
    jq -n --arg source_commit "$source_commit" --arg host "$(hostname)" \
        --arg os "$(uname -s)" --arg arch "$(uname -m)" --argjson exit_code "$status" \
        '{source_commit:$source_commit,host:$host,os:$os,arch:$arch,exit_code:$exit_code,
          boundary:"local source tests and archive installation; no GitHub or live model calls"}' \
        >"$proof/result.json"
    exit "$status"
}
trap finish EXIT
cd "$root"
printf 'CI host=%s os=%s arch=%s source=%s\n' "$(hostname)" "$(uname -s)" "$(uname -m)" "$source_commit"
if [[ "$(uname -s)" == Linux ]]; then
    [[ -r /etc/machine-id && "$(</etc/machine-id)" =~ ^[0-9a-f]{32}$ ]] || {
        printf 'CI needs a valid /etc/machine-id shared by its isolated test homes; mount the builder file read-only.\n' >&2
        exit 2
    }
fi
node --version
acpx --version
make -C apps/reach deps
bash tests/apps/reach/seats/call-echo-receipt.t
for command in \
    'agent-mailbox-commands.t test_direct_answer_send_satisfies_wait' \
    'reachability-wake.t outbox-recovery' \
    'reachability-wake.t outbox-stalled-flush'; do
    read -r script mode <<<"$command"
    timeout --kill-after=5 120 bash "tests/apps/reach/$script" "$mode"
done
bash tests/apps/reach/run.sh
bash tests/apps/heartbeat/run.sh
bash tests/apps/subscription-quota-check/run.sh
bash tests/apps/report-time/run.sh
make -C apps/reach package
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in Linux) os=linux ;; Darwin) os=macos ;; *) exit 2 ;; esac
[[ "$arch" != arm64 ]] || arch=aarch64
archive="$root/apps/reach/dist/reach-$(<apps/reach/VERSION)-$os-$arch.tar.gz"
bash tests/apps/reach/archive.t --direct "$archive" "$proof/archive"
mkdir "$proof/artifacts"
cp "$archive" "$archive.sha256" "$proof/artifacts/"
for program in heartbeat report-time subscription-quota-check; do
    make -C "apps/$program" package "CONTRACT=$contract"
    archive="$root/apps/$program/dist/$program-$(<"apps/$program/VERSION").tar.gz"
    cp "$archive" "$archive.sha256" "$proof/artifacts/"
done
git diff --exit-code HEAD -- apps/reach apps/heartbeat apps/report-time apps/subscription-quota-check tests/apps/reach
printf 'PASS local CI tests, native archive installation, and four artifact pairs\n'
