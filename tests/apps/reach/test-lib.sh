#!/usr/bin/env bash
# Shared isolated fixtures; every product action uses the public executable.
set -Eeuo pipefail
TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$TEST_DIR/fixtures/process-observe.sh"
APP="$(cd -- "$TEST_DIR/../../../apps/reach" && pwd)"
REACH="${REACH_UNDER_TEST:-$APP/bin/sno-reach}"
[[ -x "$REACH" ]] || { printf 'missing Reach executable: %s\n' "$REACH" >&2; exit 2; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/reach-public.XXXXXX")"
TEST_HOME="$WORK/home"
STATE="$WORK/state"
SERVER="reach-test-$$"
TEST_TMUX=''
TEST_PANE=''
HOST="$(hostname)"
SENDER="lead.sender@$HOST"
RECEIVER="worker.receiver@$HOST"
OTHER="observer.other@$HOST"
mkdir -p "$TEST_HOME" "$STATE"
cleanup() {
  local status=$?
  local record pid command_line
  while IFS= read -r -d '' record; do
    pid="$(jq -r '.child_pid // empty' "$record" 2>/dev/null)" || continue
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    command_line="$(test_process_command "$pid" 2>/dev/null)" || continue
    [[ "$command_line" == *"$WORK/"* ]] || continue
    kill -TERM "$pid" 2>/dev/null || true
  done < <(find "$WORK" -path '*/wake-attempts/*.json' -type f -print0)
  if [[ -n "$TEST_TMUX" ]]; then tmux -L "$SERVER" kill-server 2>/dev/null || true; fi
  if ((status != 0)) || [[ "${REACH_KEEP_TEST_ROOT:-0}" == 1 ]]; then
    printf 'test evidence: %s\n' "$WORK"
  else
    rm -rf -- "$WORK"
  fi
  return "$status"
}
trap cleanup EXIT
# Tells the real sno where the programs under test are, in the record a `sno setup` writes (isolated home only):
# sno_record_programs reach=/abs/bin/sno-reach heartbeat=/abs/bin/heartbeat ... Then `sno <name>` runs that file.
sno_record_programs() {
  mkdir -p "$TEST_HOME/.config/sno"
  printf '{"auto":{"enabled":false}}\n' >"$TEST_HOME/.config/sno/cli.json"
  jq -n '{generation: "test", files: {}, directories: [], skills_version: "", skill_destinations: {},
    contract_sha256: "", requirements_fixture_sha256: "", hooks: [], timer: false,
    programs: (reduce ($ARGS.positional[] | split("=")) as $p ({}; .[$p[0]] = {version: "1.0", sha256: "", entry: $p[1], dependencies: []}))}' \
    --args "$@" >"$TEST_HOME/.config/sno/assemble.json"
}
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS %s\n' "$*"; }
reach() {
  env -u SNO_TPM_REGISTRY -u TPM_REGISTRY -u MAILBOX_TERMINAL_REGISTRY -u SNO_REACH_ADDR \
    HOME="$TEST_HOME" XDG_CONFIG_HOME="$TEST_HOME/.config" XDG_STATE_HOME="$TEST_HOME/.local/state" \
    SNO_REACH_ROOT="$STATE" TMUX="$TEST_TMUX" TMUX_PANE="$TEST_PANE" "$REACH" "$@"
}
invoke() { RC=0; reach "$@" >"$WORK/out" 2>"$WORK/err" || RC=$?; }
expect_rc() {
  [[ "$RC" == "$1" ]] || { cat "$WORK/out" "$WORK/err" >&2; fail "expected exit $1, got $RC"; }
}
has() { grep -Fq -- "$2" "$1" || { cat "$1" >&2; fail "missing $2 in $1"; }; }
initialize() { reach init --as "$1" --name "$2"; }
register() {
  local address="$1" pane actor_command
  if [[ -z "$TEST_TMUX" ]]; then
    tmux -L "$SERVER" -f /dev/null new-session -d -s proof 'cat'
    TEST_TMUX="$(tmux -L "$SERVER" display-message -p '#{socket_path},#{pid},0')"
  fi
  printf -v actor_command 'bash %q' "$TEST_DIR/fixtures/tmux-ack-actor.sh"
  pane="$(tmux -L "$SERVER" new-window -d -P -F '#{pane_id}' -t proof "$actor_command")"
  local deadline=$((SECONDS + 5))
  until tmux -L "$SERVER" capture-pane -p -t "$pane" | grep -q 'READY integration ACK actor'; do
    ((SECONDS < deadline)) || fail 'integration ACK actor did not start'
    sleep 0.05
  done
  TEST_PANE="$pane"
  reach register --as "$address" --channel tmux --handle "$pane"
  jq -e --arg pane "$pane" '.channel == "tmux" and
    .identity == {kind:"tmux-pane",value:$pane}' "$STATE/$address/reachable.json" >/dev/null ||
    fail 'registered tmux identity is not the actual pane'
}
participants() {
  initialize "$SENDER" Sender
  initialize "$RECEIVER" Worker
  initialize "$OTHER" Observer
  register "$SENDER"
  register "$RECEIVER"
  register "$OTHER"
}
card() {
  local id="$1" from="$2" to="$3" type="$4" work="$5" extra="${6:-}"
  printf 'From: Fixture <%s>\nTo: Fixture <%s>\nDate: %s\nSubject: [%s] %s\nMessage-ID: <%s>\nX-Type: %s\nX-Work: %s\n' \
    "$from" "$to" "$(date -R)" "${type^^}" "$id" "$id" "$type" "$work"
  [[ -z "$extra" ]] || printf '%s\n' "$extra"
  printf '\nPlease handle %s.\n' "$work"
}
header() { "$APP/vendor/bin/mhdr" -h "$1" "$2"; }
message_path() {
  local address="$1" id="$2" file
  while IFS= read -r -d '' file; do
    if [[ "$(header message-id "$file")" == "<$id>" ]]; then printf '%s\n' "$file"; return; fi
  done < <(find "$STATE/$address/new" "$STATE/$address/cur" -type f -print0)
  fail "missing delivered Message-ID <$id> for $address"
}
snapshot() {
  (cd "$STATE" && find . -printf '%P %y %m\n' | sort && find . -type f -print0 | sort -z | xargs -0 -r sha256sum)
}
