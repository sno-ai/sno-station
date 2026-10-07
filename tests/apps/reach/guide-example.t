#!/usr/bin/env bash
# Execute the installed guide's own acceptance/completion example. This is
# documentation integration, not an agent's independent work or live E2E proof.
set -Eeuo pipefail
export REACH_UNDER_TEST="${1:?installed candidate command required}" REACH_KEEP_TEST_ROOT=1
proof="${2:?new evidence directory required}"
# The guide example types `sno reach`; the real sno must run it (absolute path of a built sno binary).
SNO_BINARY="${SNO_BINARY:?SNO_BINARY must be the absolute path of a built sno binary}"
[[ ! -e "$proof" ]] || exit 2
mkdir -p "$proof"
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
APP="$(dirname -- "$(dirname -- "$(readlink -f -- "$REACH")")")"
[[ "$APP" == */releases/* ]] || fail 'guide proof requires installed release'
guide="$APP/guide/agent-reach.md"
has "$guide" "Reach-Version: $(<"$APP/VERSION")"
sha256sum "$guide" "$APP/bin/sno-reach" >"$proof/inputs.sha256"
participants
id="guide-example-$$@$HOST"
card "$id" "$SENDER" "$RECEIVER" question guide-example >"$WORK/card"
reach send --as "$SENDER" --no-ring <"$WORK/card"
original="$(message_path "$RECEIVER" "$id")"
python3 - "$guide" "$proof/example.sh" <<'PY'
import pathlib, re, sys
blocks = re.findall(r"```sh\n(.*?)\n```", pathlib.Path(sys.argv[1]).read_text(), re.S)
matches = [block for block in blocks if "--state accepted" in block and "--state completed" in block]
assert len(matches) == 1, "installed guide must contain one complete original-card example"
assert "spawn" not in matches[0], "guide reply example must not start a runtime"
pathlib.Path(sys.argv[2]).write_text("set -Eeuo pipefail\n" + matches[0] + "\n")
PY
sno_record_programs "reach=$APP/bin/sno-reach"
env HOME="$TEST_HOME" PATH="$(dirname -- "$SNO_BINARY"):$PATH" SNO_REACH_ROOT="$STATE" \
  SNO_REACH_ADDR="$RECEIVER" original_card="$original" TMUX="$TEST_TMUX" TMUX_PANE="$TEST_PANE" \
  bash "$proof/example.sh" >"$proof/example.out" 2>"$proof/example.err"
reach state --work guide-example --json >"$proof/state.jsonl"
jq -se 'any(.[]; .state == "completed")' "$proof/state.jsonl" >/dev/null
reach export --work guide-example --output "$proof/thread.mbox"
[[ "$(grep -c '^X-State: accepted' "$proof/thread.mbox")" == 1 ]]
[[ "$(grep -c '^X-State: completed' "$proof/thread.mbox")" == 1 ]]
has "$proof/thread.mbox" 'X-Name: Worker'
sha256sum -c "$proof/inputs.sha256"
pass 'installed version-matched guide example runs through actual sno dispatch and produces accepted/completed thread'
