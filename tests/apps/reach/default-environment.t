#!/usr/bin/env bash
set -Eeuo pipefail
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
STATE="$TEST_HOME/.local/state/sno-reach"
initialize "$SENDER" Sender
register "$SENDER"
mkdir -p "$WORK/legacy/old.seat@$HOST/new"
printf 'legacy state must not be read or altered\n' >"$WORK/legacy/old.seat@$HOST/new/marker"
sha256sum "$WORK/legacy/old.seat@$HOST/new/marker" >"$WORK/legacy-before"
card "default-$$@$HOST" "$RECEIVER" "$SENDER" question default |
  sed "/^X-Work:/a Delivered-To: $SENDER" >"$STATE/$SENDER/new/default"
default_reach() {
  env -u SNO_REACH_ROOT HOME="$TEST_HOME" SNO_REACH_ADDR="$SENDER" \
    SNO_MBOX_ROOT="$WORK/legacy" SNO_EXECUTOR_ADDR="old.seat@$HOST" \
    TMUX="$TEST_TMUX" TMUX_PANE="$TEST_PANE" "$REACH" "$@"
}
default_reach inbox >"$WORK/out" 2>"$WORK/err"
has "$WORK/out" "$STATE/$SENDER/new/default"
default_reach doctor >"$WORK/out" 2>"$WORK/err"
has "$WORK/out" DOCTOR-OK
has "$WORK/err" SNO_MBOX_ROOT
has "$WORK/err" SNO_EXECUTOR_ADDR
[[ "$(grep -c 'warning:' "$WORK/err")" == 1 ]] || fail 'doctor must issue one combined old-variable warning'
sha256sum "$WORK/legacy/old.seat@$HOST/new/marker" >"$WORK/legacy-after"
cmp "$WORK/legacy-before" "$WORK/legacy-after"
[[ "$(find "$WORK/legacy" -type f | wc -l)" == 1 ]] || fail 'legacy root was mutated'
pass 'default state root and environment seat ignore both old variables'
