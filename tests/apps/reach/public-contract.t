#!/usr/bin/env bash
# New or deliberately changed Reach contracts; no legacy entry points are invoked.
set -Eeuo pipefail
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
mode="${1:?choose surface, init, lint, inbox, wait, or reply}"
case "$mode" in
surface)
  invoke --help; expect_rc 0
  cp "$WORK/out" "$WORK/help"
  cp "$WORK/err" "$WORK/help-err"
  invoke -h; expect_rc 0
  cmp -s "$WORK/help" "$WORK/out" || fail '-h stdout differs from --help'
  cmp -s "$WORK/help-err" "$WORK/err" || fail '-h stderr differs from --help'
  verbs=(pair spawn register unregister seats call watch ring send reply inbox wait dismiss log state flush init rebind doctor export lint remind)
  [[ "${#verbs[@]}" == 22 ]]
  for verb in "${verbs[@]}"; do
    grep -Eq "(^|[[:space:],|])$verb([[:space:],|]|$)" "$WORK/help" || fail "help omits $verb"
  done
  printf '%s\n' "${verbs[@]}" | sort >"$WORK/expected-verbs"
  tail -n +2 "$WORK/help" | tr '[:space:]' '\n' | sed '/^$/d' | sort >"$WORK/actual-verbs"
  cmp "$WORK/expected-verbs" "$WORK/actual-verbs"
  invoke; expect_rc 64; cmp "$WORK/help" "$WORK/out"
  invoke frobnicate; expect_rc 64; cmp "$WORK/help" "$WORK/out"
  for old in peek informed standby claim; do invoke "$old"; expect_rc 64; done
  for row in 'state --journey --work' 'init --callsign --name' 'reply --message --card' \
      'wait --interval-secs --every' 'wait --timeout-secs --timeout' 'watch --idle-secs --idle'; do
    read -r verb old new <<<"$row"
    invoke "$verb" "$old" x; expect_rc 64; has "$WORK/err" "$new"
    [[ "$(wc -l <"$WORK/err")" == 1 ]] || fail 'old flag must have one diagnostic line'
  done
  invoke reply --callsign Worker; expect_rc 64; has "$WORK/err" init
  invoke --version; expect_rc 0
  [[ "$(<"$WORK/out")" == "$(<"$APP/VERSION")" ]] || fail 'source version does not match VERSION'
  pass 'exact public vocabulary, retired aliases, old-flag diagnostics and version'
  ;;
init)
  initialize "$SENDER" Fjord
  identity="$STATE/$SENDER/seat.json"
  jq -e --arg address "$SENDER" --arg host "$HOST" --arg machine "$(env HOME="$TEST_HOME" XDG_STATE_HOME="$TEST_HOME/.local/state" "$APP/lib/reach-machine-id")" '
    .address==$address and .role=="lead" and .seat=="sender" and .host==$host and
    .machine_id==$machine and .name=="Fjord" and .runtime=="unbound" and
    .owns==[] and .supervisor==$address and .history==[] and (has("callsign")|not)' "$identity"
  for dir in new cur tmp; do [[ -d "$STATE/$SENDER/$dir" ]]; done
  snapshot >"$WORK/before"
  initialize "$SENDER" Fjord
  snapshot >"$WORK/after"; cmp "$WORK/before" "$WORK/after"
  invoke init --as "$SENDER" --name SomeoneElse
  [[ "$RC" != 0 ]] || fail 'conflicting identity accepted'
  snapshot >"$WORK/after"; cmp "$WORK/before" "$WORK/after"
  invoke doctor --as "$SENDER"
  [[ "$RC" != 0 ]] || fail 'unregistered identity passed doctor'
  has "$WORK/err" register
  register "$SENDER"
  invoke doctor --as "$SENDER"; expect_rc 0
  pass 'role-neutral public initialization, preserved identity and registration prerequisite'
  ;;
lint)
  card "lint-$$@$HOST" "$SENDER" "$RECEIVER" question lint >"$WORK/card"
  invoke lint "$WORK/card"; expect_rc 0
  for row in 'X-Work X-Journey' 'X-Name X-Callsign'; do
    read -r new old <<<"$row"
    if [[ "$old" == X-Journey ]]; then
      sed "s/^X-Work:/$old:/" "$WORK/card" >"$WORK/old"
    else
      sed "/^X-Type:/a $old: Worker" "$WORK/card" >"$WORK/old"
    fi
    invoke lint "$WORK/old"
    [[ "$RC" != 0 ]] || fail "accepted $old"
    has "$WORK/err" "$new"
  done
  sed "s/To: .*/To: Team Lead.x@$HOST/" "$WORK/card" >"$WORK/bad-address"
  invoke lint "$WORK/bad-address"
  [[ "$RC" != 0 ]] || fail 'invalid To address accepted'
  pass 'new card headers accepted; old headers and invalid address refused'
  ;;
inbox)
  participants
  id="inbox-$$@$HOST"
  card "$id" "$SENDER" "$RECEIVER" question inbox "Cc: Observer <$OTHER>" >"$WORK/card"
  invoke send --as "$SENDER" --no-ring <"$WORK/card"; expect_rc 0
  [[ ! -s "$WORK/err" ]] || fail 'no-ring printed a notice'
  action="$(message_path "$RECEIVER" "$id")"
  informed="$(message_path "$OTHER" "$id")"
  cp "$action" "$WORK/action"; cp "$informed" "$WORK/informed"
  invoke inbox --as "$RECEIVER"; expect_rc 0; has "$WORK/out" "$action"; has "$WORK/out" "$id"
  invoke inbox --as "$OTHER"; expect_rc 0; [[ ! -s "$WORK/out" ]]
  invoke inbox --as "$OTHER" --cc; expect_rc 0
  has "$WORK/out" INFORMED-NOT-WORK; has "$WORK/out" "$informed"
  cmp "$WORK/action" "$action"; cmp "$WORK/informed" "$informed"
  pass 'action and informed inbox selections preserve card bytes and paths'
  ;;
wait)
  initialize "$SENDER" Sender
  invoke wait --as "$SENDER" --timeout 0; expect_rc 4
  work="wait-$$"; original="question-$$@$HOST"; accepted="accepted-$$@$HOST"; answer="answer-$$@$HOST"
  extra="Delivered-To: $SENDER"$'\n'"In-Reply-To: <$original>"$'\n'"References: <$original>"
  card "$accepted" "$RECEIVER" "$SENDER" status "$work" "$extra"$'\nX-State: accepted' >"$STATE/$SENDER/new/001-status"
  invoke wait --as "$SENDER" --reply-to "<$original>" --timeout 0; expect_rc 4
  card "$answer" "$RECEIVER" "$SENDER" answer "$work" "$extra"$'\nX-State: completed' >"$STATE/$SENDER/cur/002-answer:2,T"
  sha256sum "$STATE/$SENDER/new/001-status" "$STATE/$SENDER/cur/002-answer:2,T" >"$WORK/cards-before"
  for _ in 1 2; do
    invoke wait --as "$SENDER" --reply-to "<$original>" --timeout 0; expect_rc 0
    [[ "$(<"$WORK/out")" == "$STATE/$SENDER/cur/002-answer:2,T" ]]
  done
  invoke wait --as "$SENDER" --reply-to "<$original>" --from "$OTHER" --timeout 0; expect_rc 4
  invoke wait --as "$SENDER" --reply-to "<$original>" --from "$RECEIVER" --timeout 0; expect_rc 0
  sha256sum -c "$WORK/cards-before"
  started="$SECONDS"
  invoke wait --as "$SENDER" --reply-to '<missing@test>' --timeout 3 --every 1 --idle 1; expect_rc 4
  ((SECONDS - started < 3)) || fail 'idle deadline did not precede overall timeout'
  pass 'answer-only threaded wait, repeat non-consumption, optional sender and idle deadline'
  ;;
reply)
  participants
  work="reply-$$"; id="question-$$@$HOST"
  card "$id" "$SENDER" "$RECEIVER" question "$work" >"$WORK/card"
  invoke send --as "$SENDER" --no-ring <"$WORK/card"; expect_rc 0
  original="$(message_path "$RECEIVER" "$id")"
  snapshot >"$WORK/before"
  for state in completed failed; do
    invoke reply --as "$RECEIVER" --card "$original" --state "$state" <<<'not yet'
    [[ "$RC" != 0 ]] || fail "$state accepted without acceptance"
    has "$WORK/err" accepted
    snapshot >"$WORK/after"; cmp "$WORK/before" "$WORK/after"
  done
  invoke reply --as "$RECEIVER" --card "$original" <<<'not yet'
  [[ "$RC" != 0 ]] || fail 'stateless work reply accepted without acceptance'
  has "$WORK/err" accepted
  cp "$original" "$WORK/original"
  invoke reply --as "$RECEIVER" --card "$original" --state accepted <<<'accepted'
  expect_rc 0
  cmp "$WORK/original" "$original"
  invoke inbox --as "$SENDER"; expect_rc 0
  accepted_path="$(awk 'NR==1 {print $1}' "$WORK/out")"
  [[ -f "$accepted_path" ]] || fail 'acceptance missing from sender inbox'
  [[ "$(header x-state "$accepted_path")" == accepted ]]
  [[ "$(header x-name "$accepted_path")" == Worker ]]
  accepted_id="$(header message-id "$accepted_path")"
  invoke dismiss --as "$SENDER" --card "$accepted_path" --reason acknowledged; expect_rc 0
  invoke reply --as "$RECEIVER" --card "$original" --state completed <<<'completed nonce'
  expect_rc 0
  invoke wait --as "$SENDER" --reply-to "<$id>" --timeout 0; expect_rc 0
  completed_path="$(<"$WORK/out")"
  [[ "$(header x-state "$completed_path")" == completed ]]
  [[ "$(header references "$completed_path")" == *"$accepted_id"* ]] || fail 'terminal answer lost acceptance reference'
  invoke state --work "$work"; expect_rc 0; has "$WORK/out" completed
  invoke export --work "$work" --output "$WORK/thread.mbox"; expect_rc 0
  has "$WORK/thread.mbox" accepted; has "$WORK/thread.mbox" completed
  snapshot >"$WORK/before"
  invoke reply --as "$RECEIVER" --card "$original" --state completed <<<'duplicate'
  [[ "$RC" != 0 ]] || fail 'second terminal reply accepted'
  snapshot >"$WORK/after"; cmp "$WORK/before" "$WORK/after"
  pass 'non-consuming acceptance, same-path completion, reply name and retained thread after acknowledgment'
  ;;
*) fail "unknown test mode: $mode" ;;
esac
