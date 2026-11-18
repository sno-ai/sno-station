#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
export SNO_REACH_ROOT="$STATE" SNO_PROFILE_DIR="$WORK/profile" PATH="$WORK:$APP/vendor/bin:$PATH"
export NOTICE_OUTPUT="$WORK/shown"
developer="developer.human@$HOST"
mkdir -p "$SNO_PROFILE_DIR/station/agents"
cat >"$WORK/notify-send" <<'SH'
#!/bin/bash
printf '%s\n' "$2" >>"$NOTICE_OUTPUT"
SH
chmod +x "$WORK/notify-send"
printf '%s\n' '{"event":"user-prompt-submit","at":"2026-11-18T00:00:00.123Z"}' \
    '{"event":"agent-prompt-submit","at":"2026-11-19T00:00:00.000Z"}' >"$SNO_PROFILE_DIR/station/agents/test.jsonl"
initialize "$SENDER" Sender
card "developer@$HOST" "$SENDER" "$developer" question developer-notice >"$WORK/card"
reach send --as "$SENDER" <"$WORK/card" &
a=$!
reach send --as "$SENDER" <"$WORK/card" &
b=$!
wait "$a" "$b"
jq -e --arg addr "$developer" '.address == $addr' "$STATE/$developer/seat.json" >/dev/null
for ((i=0; i<40; i++)); do
    [[ ! -s "$NOTICE_OUTPUT" ]] || break
    sleep .1
done
has "$NOTICE_OUTPUT" "[QUESTION] developer@$HOST"
reach notify --type routine --subject 'background bookkeeping'
reach notify --type approval --subject 'approval needed' --session abc
for ((i=0; i<40; i++)); do
    grep -Fq '[APPROVAL] approval needed' "$NOTICE_OUTPUT" && break
    sleep .1
done
has "$NOTICE_OUTPUT" '[APPROVAL] approval needed'
! grep -Fq 'background bookkeeping' "$NOTICE_OUTPUT"
[[ "$(grep -Fc "[QUESTION] developer@$HOST" "$NOTICE_OUTPUT")" == 1 ]]
approval="$(grep -Flx 'X-Session: abc' "$STATE/$developer"/new/*)"
mv -- "$approval" "$STATE/$developer/new/reach-deliver.fixture00T"
reach notify --dismiss-session abc
[[ "$(find "$STATE/$developer/cur" -name '*:2,*T*' | wc -l)" == 1 ]] ||
    fail 'the answered approval with a new filename ending in T was not dismissed'

frame() { printf '%s %s\n%s\n' "$1" "${#2}" "$2"; }
{
    printf 'SNO-REACH-REMOTE/1\nTYPED\n'
    frame root "$STATE"
    frame address "$developer"
    frame sender "$SENDER"
} | "$REACH" __receive >"$WORK/typed"
[[ "$(<"$WORK/typed")" == 'TYPED 2026-11-18T00:00:00.123Z' ]]

# Exercise the production receive path in a second root and ensure a marked copy shows
# even though this machine has no typed history in the isolated profile.
remote="$WORK/remote"
forwarded='developer.human@other-host'
card "forwarded@$HOST" "$SENDER" "$forwarded" question forwarded "X-Reach-Notice: forwarded" >"$WORK/forwarded"
size="$(wc -c <"$WORK/forwarded")"
{
    printf 'SNO-REACH-REMOTE/1\nDELIVER\n'
    frame root "$remote"
    frame address "$forwarded"
    frame basename forwarded
    printf 'body %s\n' "$size"
    cat "$WORK/forwarded"
} | SNO_PROFILE_DIR="$WORK/empty-profile" "$REACH" __receive >"$WORK/received"
has "$WORK/received" PLACED
for ((i=0; i<40; i++)); do
    grep -Fq "[QUESTION] forwarded@$HOST" "$NOTICE_OUTPUT" && break
    sleep .1
done
has "$NOTICE_OUTPUT" "[QUESTION] forwarded@$HOST"
has "$remote/$forwarded/new/forwarded" 'X-Reach-Notice: forwarded'

# The real transport fails to read this unavailable peer contact.
mkdir -p "$STATE/network/peers"
printf '{}\n' >"$STATE/network/peers/unavailable-peer.json"
reach notify --type question --subject 'question with an unavailable peer'
for ((i=0; i<40; i++)); do
    grep -Fxq '[QUESTION] question with an unavailable peer' "$NOTICE_OUTPUT" && break
    sleep .1
done
has "$NOTICE_OUTPUT" '[QUESTION] question with an unavailable peer'
pass 'developer mail is created, shown once, cleared by session, and displayed at the forwarding destination'
