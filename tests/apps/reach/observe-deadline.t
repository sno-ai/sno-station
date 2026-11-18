#!/usr/bin/env bash
set -Eeuo pipefail
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
initialize "$SENDER" Sender
export OBSERVE_CHILD_PID="$WORK/observe-child"
cat >"$WORK/sno" <<'SH'
#!/usr/bin/env bash
[[ "$*" == 'observe append reach.register '* ]] || exit 64
(trap '' TERM; exec sleep 12) &
printf '%s\n' "$!" >"$OBSERVE_CHILD_PID"
printf 'stored\n'
wait
SH
chmod +x "$WORK/sno"
(
    trap 'if [[ -s "$OBSERVE_CHILD_PID" ]]; then kill -KILL "$(<"$OBSERVE_CHILD_PID")" 2>/dev/null || true; fi' EXIT
    started=$SECONDS
    PATH="$WORK:$PATH" invoke register --as "$SENDER" --channel fixture --handle "$WORK"
    expect_rc 0
    elapsed=$((SECONDS - started))
    [[ -s "$OBSERVE_CHILD_PID" ]] || fail 'the observation fixture did not create a child'
    has "$STATE/reach.log" 'sno observe append reach.register failed (exit 124); event stored locally, delivery pending'
    ((elapsed < 9)) || fail "reach register took ${elapsed}s while an observation child held stdout"
    jq -e --arg path "$WORK" '.channel == "fixture" and .handle == $path' "$STATE/$SENDER/reachable.json" >/dev/null
    pass "reach register returned in ${elapsed}s with an observation child holding stdout"
)
