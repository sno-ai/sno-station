#!/usr/bin/env bash
set -Eeuo pipefail
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"

initialize "$SENDER" Sender
initialize "$OTHER" Observer
for number in $(seq 1 80); do
    card "selected-$number-$$@$HOST" "$SENDER" "$SENDER" question export-live >"$STATE/$SENDER/new/selected-$number"
done
unrelated="$STATE/$OTHER/new/unrelated"
card "unrelated-$$@$HOST" "$OTHER" "$OTHER" question another-work >"$unrelated"
(
    sleep 0.5
    printf '\n' >>"$unrelated"
) &
writer=$!
invoke export --work export-live --output "$WORK/export.mbox"
wait "$writer"
expect_rc 0
[[ "$(grep -c '^From MAILER-DAEMON ' "$WORK/export.mbox")" == 80 ]]
for number in $(seq 1 80); do
    card "moved-$number-$$@$HOST" "$SENDER" "$SENDER" question export-move >"$STATE/$SENDER/new/moved-$number"
done
(
    sleep 0.5
    mv "$STATE/$SENDER/new/moved-1" "$STATE/$SENDER/cur/moved-1:2,T"
) &
writer=$!
invoke export --work export-move --output "$WORK/moved.mbox"
wait "$writer"
expect_rc 0
[[ "$(grep -c '^From MAILER-DAEMON ' "$WORK/moved.mbox")" == 80 ]]
(
    sleep 2
    printf '\n' >>"$STATE/$SENDER/new/selected-1"
) &
writer=$!
invoke export --work export-live --output "$WORK/changed.mbox"
wait "$writer"
expect_rc 65
has "$WORK/err" 'selected export message changed; retry export after mailbox activity stops'
pass 'export ignores concurrent changes to an unrelated journey'
