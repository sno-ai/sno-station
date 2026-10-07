#!/usr/bin/env bash
set -Eeuo pipefail
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
STATE="$WORK/state space"
mkdir -p "$STATE" "$WORK/commands" "$WORK/ssh-log"
ln -s "$TEST_DIR/fixtures/isolated-ssh.sh" "$WORK/commands/ssh"
export PATH="$WORK/commands:$PATH" REACH_SSH_ROOT="$STATE" REACH_SSH_LOG="$WORK/ssh-log"
REMOTE='worker.remote@reach-isolated-host'
initialize "$SENDER" Sender
invoke init --as "$REMOTE" --name Remote
expect_rc 0
has "$WORK/out" INIT-CREATED
remote_hash="$(sha256sum "$STATE/$REMOTE/seat.json")"
invoke init --as "$REMOTE" --name Remote
expect_rc 0
has "$WORK/out" INIT-UNCHANGED
[[ "$(sha256sum "$STATE/$REMOTE/seat.json")" == "$remote_hash" ]]
invoke init --as "$REMOTE" --name Conflict
expect_rc 65
[[ "$(sha256sum "$STATE/$REMOTE/seat.json")" == "$remote_hash" ]]
reach register --as "$REMOTE" --channel acp --handle "acp-codex:$WORK:fixture" >/dev/null
card "remote-card@$HOST" "$SENDER" "$REMOTE" question remote >"$WORK/card"
invoke send --as "$SENDER" --no-ring <"$WORK/card"
expect_rc 0
copy="$(message_path "$REMOTE" "remote-card@$HOST")"
[[ "$(header delivered-to "$copy")" == "$REMOTE" ]]
has "$copy" 'Please handle remote.'
grep -l '^DELIVER$' "$WORK/ssh-log/"wire.* >"$WORK/delivery-wires"
[[ "$(wc -l <"$WORK/delivery-wires")" == 1 ]]
has "$WORK/ssh-log/hosts" reach-isolated-host

# The captured request really reached the production parser, not a fixture parser.
snapshot >"$WORK/before"
rc=0
printf 'SNO-REACH-REMOTE/1\nINIT\nroot 99\nshort' |
  /bin/sh -c "$(<"$WORK/ssh-log/receiver")" >"$WORK/protocol.out" 2>"$WORK/protocol.err" || rc=$?
[[ "$rc" == 64 ]] || fail 'truncated fixed-protocol frame was accepted'
has "$WORK/protocol.err" PROTOCOL
snapshot >"$WORK/after"; cmp "$WORK/before" "$WORK/after"

jq '.machine_id="00000000000000000000000000000000"' "$STATE/$REMOTE/seat.json" >"$WORK/wrong-machine"
mv "$WORK/wrong-machine" "$STATE/$REMOTE/seat.json"
snapshot >"$WORK/before"
invoke send --as "$SENDER" --no-ring <"$WORK/card"
expect_rc 65
snapshot >"$WORK/after"; cmp "$WORK/before" "$WORK/after"
invoke rebind --as "$REMOTE" --reason 'Isolated receiver moved to the current host.'
expect_rc 0
has "$WORK/out" REBOUND
jq -e --arg machine "$(env HOME="$TEST_HOME" XDG_STATE_HOME="$TEST_HOME/.local/state" "$APP/lib/reach-machine-id")" '.machine_id == $machine and (.history | length) == 1' "$STATE/$REMOTE/seat.json" >/dev/null
# The sending machine keeps a copy of every card it delivered elsewhere (progress is derived from it).
sent=("$STATE/$SENDER"/sent/*)
[[ -f "${sent[0]}" && "$(header delivered-to "${sent[0]}")" == "$REMOTE" ]] || fail 'remote delivery left no sent copy'

# A remote recipient is rung on its own machine, through the fixed receiver. The recorder stands at
# the process boundary only to capture the argv the receiver hands to `sno`; it is not sno.
mkdir -p "$TEST_HOME/.local/bin"
printf '#!/bin/sh\necho "$SNO_REACH_ADDR $*" >>"%s"\necho rang\n' "$WORK/ring-log" >"$TEST_HOME/.local/bin/sno"
chmod +x "$TEST_HOME/.local/bin/sno"
card "remote-ring@$HOST" "$SENDER" "$REMOTE" question ring >"$WORK/card-ring"
invoke send --as "$SENDER" <"$WORK/card-ring"
expect_rc 0
has "$WORK/err" 'wake rang reached'
has "$WORK/ring-log" "$SENDER reach ring $REMOTE"
pass 'isolated SSH argv, framed actual receiver, remote init/delivery/sent copy/ring/refusal/rebind'
