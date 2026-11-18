#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
resolved_sno="$(command -v sno || true)"
[[ "$resolved_sno" == "$WORK/test-bin/sno" ]] || fail "isolated PATH resolved sno to ${resolved_sno:-nothing}, expected the test stub"
rc=0
sno 2>"$WORK/sno.err" || rc=$?
[[ "$rc" == 127 ]] || fail "the test stub exited $rc instead of 127"
has "$WORK/sno.err" 'sno is disabled unless the test provides its own executable'
printf 'PASS: command -v sno resolved to %s\n' "$resolved_sno"
export SNO_REACH_ROOT="$STATE" PATH="$WORK:$PATH" WAKE_PROOF="$WORK/wake"
initialize "$SENDER" Sender
initialize "$RECEIVER" Receiver
reach register --as "$RECEIVER" --channel slow-fixture --handle "$WORK"
cat >"$WORK/reach-channel-slow-fixture" <<'SH'
#!/bin/bash
set -eu
touch "$WAKE_PROOF.started"
for ((i=0; i<80; i++)); do
    if [[ -e "$WAKE_PROOF.release" ]]; then touch "$WAKE_PROOF.finished"; exit 0; fi
    sleep .1
done
exit 1
SH
chmod +x "$WORK/reach-channel-slow-fixture"
card "quick@$HOST" "$SENDER" "$RECEIVER" question quick-return >"$WORK/card"
HOME="$TEST_HOME" XDG_STATE_HOME="$TEST_HOME/.local/state" \
    timeout 4 "$REACH" send --as "$SENDER" <"$WORK/card" | cat >"$WORK/result"
has "$WORK/result" "delivered to $RECEIVER"
has "$WORK/result" 'wake running in background'
[[ ! -e "$WAKE_PROOF.finished" ]]
message_path "$RECEIVER" "quick@$HOST" >/dev/null
touch "$WAKE_PROOF.release"
for ((i=0; i<40; i++)); do
    [[ ! -s "$STATE/reach-ring.jsonl" ]] || break
    sleep .1
done
[[ -e "$WAKE_PROOF.started" && -e "$WAKE_PROOF.finished" ]]
jq -e --arg id "<quick@$HOST>" '.msg_id == $id and .outcome == "rang-unverified"' "$STATE/reach-ring.jsonl" >/dev/null
pass 'piped placement returned before the adapter ran to completion; the wake survived wrapper exit'
