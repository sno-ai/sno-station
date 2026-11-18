#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
export SNO_REACH_ROOT="$STATE" PATH="$APP/vendor/bin:$PATH"
participants
report="keeper.reports@$HOST"
initialize "$report" Reports
register "$report"
id="one-taker@$HOST"
card "$id" "$SENDER" "$RECEIVER" decision one-taker "Reply-To: Reports <$report>" |
    sed "s/^To:.*/To: Worker <$RECEIVER>, Observer <$OTHER>/" >"$WORK/card"
reach send --as "$SENDER" --no-ring <"$WORK/card"
left="$(message_path "$RECEIVER" "$id")"
right="$(message_path "$OTHER" "$id")"
(
    rc=0
    printf '%s\n' 'accepted through reply' |
        reach reply --as "$RECEIVER" --card "$left" --state accepted >"$WORK/left" 2>&1 || rc=$?
    printf '%s\n' "$rc" >"$WORK/left.rc"
) &
a=$!
(
    rc=0
    card "raw-accept@$HOST" "$OTHER" "$report" status one-taker "$(printf 'X-State: accepted\nIn-Reply-To: <%s>\nReferences: <%s>' "$id" "$id")" |
        reach send --as "$OTHER" --no-ring >"$WORK/right" 2>&1 || rc=$?
    printf '%s\n' "$rc" >"$WORK/right.rc"
) &
b=$!
wait "$a" "$b"
case "$(<"$WORK/left.rc") $(<"$WORK/right.rc")" in
    '0 75') winner="$RECEIVER"; loser="$OTHER"; lost="$right"; error="$WORK/right" ;;
    '75 0') winner="$OTHER"; loser="$RECEIVER"; lost="$left"; error="$WORK/left" ;;
    *) cat "$WORK/left" "$WORK/right" >&2; fail 'expected exactly one accepted card' ;;
esac
has "$error" "taken by $winner"
[[ "$(find "$STATE/$report/new" -type f | wc -l)" == 1 ]]
invoke reply --as "$loser" --card "$lost" --state accepted <<<again
expect_rc 75
has "$WORK/err" "taken by $winner"

# In-process protocol framing against a different root from the losing client.
remote="$WORK/remote"
SNO_REACH_ROOT="$remote" "$REACH" init --as "$SENDER" --name Sender >/dev/null
frame() { printf '%s %s\n%s\n' "$1" "${#2}" "$2"; }
for candidate in "$winner" "$loser"; do
    {
        printf 'SNO-REACH-REMOTE/1\nTAKE\n'
        frame root "$remote"
        frame address "$SENDER"
        frame sender "$candidate"
        frame message-id "<$id>"
    } | "$REACH" __receive >"$WORK/take"
    [[ "$(<"$WORK/take")" == "$winner" ]]
done

# The remote sender is unreachable when a locally delivered task is accepted.
remote_sender='lead.sender@reach-isolated-host'
mkdir -p "$WORK/bin"
cat >"$WORK/bin/ssh" <<'SH'
#!/bin/bash
printf 'fixture remote receiver offline\n' >&2
exit 255
SH
chmod +x "$WORK/bin/ssh"
export PATH="$WORK/bin:$PATH"
card "remote-original@$HOST" "$remote_sender" "$RECEIVER" decision remote-taker "Reply-To: Reports <$report>" |
    sed "s/^To:.*/To: Worker <$RECEIVER>, Observer <$OTHER>/" |
    "$APP/lib/reach-deliver"
received="$(message_path "$RECEIVER" "remote-original@$HOST")"
invoke reply --as "$RECEIVER" --card "$received" --state accepted <<<waiting
expect_rc 75
has "$WORK/err" 'waiting for confirmation: fixture remote receiver offline'
[[ "$(find "$STATE/$report/new" -type f | wc -l)" == 1 ]]
pass 'concurrent reply and raw acceptance choose one recipient and retain the decision'
