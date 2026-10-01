#!/usr/bin/env bash
# Migrated concurrent sign-on case: an old inventory result must not overwrite
# a newly registered stable identity or send into a reused transient handle.
set -Eeuo pipefail
# shellcheck source=../test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../test-lib.sh"
initialize "$SENDER" Sender
initialize "$RECEIVER" Worker
SNO_REACH_NOW=1000 "$APP/lib/reach-reachability" register --root "$STATE" \
  --as "$RECEIVER" --channel orca --handle term_old --identity-kind orca-tab \
  --identity old-window-tab --pid "$$" --host "$HOST" >/dev/null
env -u TMUX HOME="$TEST_HOME" SNO_REACH_ROOT="$STATE" SNO_REACH_NOW=1002 \
  REACH_TEST_COUNTER="$WORK/counter" REACH_TEST_TRACE="$WORK/trace" \
  REACH_TEST_APP="$APP" REACH_TEST_SEAT="$RECEIVER" \
  ORCA_CLI_COMMAND="$TEST_DIR/fixtures/orca-reregistration.sh" \
  "$REACH" ring "$RECEIVER" >"$WORK/out" 2>"$WORK/err"
has "$WORK/out" 'rang-unverified'
jq -e '.handle == "term_current" and .identity == {kind:"orca-tab",value:"new-window-tab"}' \
  "$STATE/$RECEIVER/reachable.json" >/dev/null
has "$WORK/trace" 'terminal send --terminal term_current'
if grep -Eq 'terminal send --terminal (term_old|term_new)( |$)' "$WORK/trace"; then
  fail 'ring reached stale or reused handle'
fi
pass 'concurrent reregistration retains new identity and rings only its current handle'
