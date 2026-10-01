#!/usr/bin/env bash
# Explicit empty values must never silently select a default identity or pane.
set -Eeuo pipefail
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
mode="${1:?choose handle, as, or idle}"
initialize "$SENDER" Sender
register "$SENDER"
case "$mode" in
  handle)
    snapshot >"$WORK/before"
    invoke register --as "$SENDER" --channel tmux --handle ''
    [[ "$RC" != 0 ]] || fail 'explicit empty handle adopted the current pane'
    snapshot >"$WORK/after"; cmp "$WORK/before" "$WORK/after"
    ;;
  as)
    snapshot >"$WORK/before"
    RC=0
    env HOME="$TEST_HOME" SNO_REACH_ROOT="$STATE" SNO_REACH_ADDR="$SENDER" \
      "$REACH" inbox --as '' >"$WORK/out" 2>"$WORK/err" || RC=$?
    [[ "$RC" != 0 ]] || fail 'explicit empty as fell back to environment identity'
    snapshot >"$WORK/after"; cmp "$WORK/before" "$WORK/after"
    ;;
  idle)
    invoke watch "$SENDER" --timeout 0 --idle ''
    [[ "$RC" != 0 ]] || fail 'explicit empty idle was silently omitted'
    ;;
  *) fail 'unknown blank-option case' ;;
esac
cat "$WORK/err"
pass "$mode explicitly empty value is refused"
