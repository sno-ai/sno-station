#!/usr/bin/env bash
# PRD sections 5.2 and 5.5 are the oracle; only public CLI and disk results count.
set -Eeuo pipefail
export HOST="$(hostname)"
repo="$(cd -- "$(dirname -- "$0")/../../../apps/reach" && pwd)"
tmp="$(mktemp -d)"
trap 'find "$tmp" -depth -delete' EXIT
export HOME="$tmp/home"
mkdir -p "$HOME/.config/sno-reach"
config="$HOME/.config/sno-reach/agents.json"
reader="${REACH_TRANSPORT_UNDER_TEST:-$repo/lib/reach-transport}"
output="$("$reader" for-kind codex)"
[[ "$output" == '' ]]
printf '{"codex":{"acpx_agent":"codex"},"hermes":{"acpx_agent":"hermes"}}\n' >"$config"
output="$("$reader" for-kind codex)"
[[ "$output" == codex ]]
output="$("$reader" for-kind other)"
[[ "$output" == '' ]]
printf 'ok - absent, listed and unlisted transport\n'
for broken in '{' '[]' '{"codex":{}}' '{"codex":{"acpx_agent":""}}' '{"codex":{"acpx_agent":"   "}}' '{"codex":{"acpx_agent":1}}' '{"codex":{"acpx_agent":"codex","command":"bad"}}'; do
    printf '%s\n' "$broken" >"$config"
    if "$reader" for-kind codex >"$tmp/out" 2>"$tmp/err"; then exit 1; fi
    [[ ! -s "$tmp/out" ]]
    grep -Fq agents.json "$tmp/err"
done
printf '{"codex":{"acpx_agent":"codex"}}\n' >"$config"
if "$reader" for-kind >"$tmp/out" 2>"$tmp/err"; then exit 1; fi
[[ ! -s "$tmp/out" ]]
grep -Fq usage "$tmp/err"
printf 'ok - malformed config and arguments refuse\n'

mkdir -p "$tmp/mail/executor.probe@${HOST}/"{new,cur,tmp} "$tmp/mail/executor.other@${HOST}/"{new,cur,tmp}
reach="$repo/lib/reach-reachability"
export SNO_REACH_NOW=1000
"$reach" register --root "$tmp/mail" --as executor.other@"${HOST}" --channel tmux --handle tmux-server:other --identity-kind tmux-pane --identity %3 >/dev/null
cp "$tmp/mail/executor.other@${HOST}/reachable.json" "$tmp/other"
register() { "$reach" register --root "$tmp/mail" --as executor.probe@"${HOST}" --channel acp --handle "$1" --identity-kind "$2" --identity "$3"; }
register 'acp-codex:/repo with spaces:probe' acp-session probe >/dev/null
jq -e '.channel == "acp" and .identity == {kind:"acp-session",value:"probe"} and .handle == "acp-codex:/repo with spaces:probe"' "$tmp/mail/executor.probe@${HOST}/reachable.json" >/dev/null
"$reach" status --root "$tmp/mail" --as executor.probe@"${HOST}" | grep -q $'^present\t1000\t0\tacp\t'
cp "$tmp/mail/executor.probe@${HOST}/reachable.json" "$tmp/prior"
for handle in acp-codex: acp-codex acp-codex::probe acp-codex:relative:probe acp-codex:/repo:wrong; do
    if register "$handle" acp-session probe >"$tmp/out" 2>"$tmp/err"; then exit 1; fi
    cmp "$tmp/prior" "$tmp/mail/executor.probe@${HOST}/reachable.json"
done
if register acp-codex:/repo:probe tmux-pane probe >"$tmp/out" 2>"$tmp/err"; then exit 1; fi
jq '.identity.extra=true' "$tmp/prior" >"$tmp/mail/executor.probe@${HOST}/reachable.json"
if "$reach" status --root "$tmp/mail" --as executor.probe@"${HOST}" >"$tmp/out" 2>"$tmp/err"; then exit 1; fi
cp "$tmp/prior" "$tmp/mail/executor.probe@${HOST}/reachable.json"
"$reach" unregister --root "$tmp/mail" --as executor.probe@"${HOST}" >/dev/null
[[ "$("$reach" status --root "$tmp/mail" --as executor.probe@"${HOST}")" == absent ]]
cmp "$tmp/other" "$tmp/mail/executor.other@${HOST}/reachable.json"
register acp-codex:/repo:probe acp-session probe >/dev/null
SNO_REACH_NOW=1901 "$reach" evict --root "$tmp/mail" --as executor.probe@"${HOST}" >/dev/null
[[ ! -e "$tmp/mail/executor.probe@${HOST}/reachable.json" ]]
cmp "$tmp/other" "$tmp/mail/executor.other@${HOST}/reachable.json"
printf 'ok - ACP shape, rejection, unregister and stale eviction\n'
