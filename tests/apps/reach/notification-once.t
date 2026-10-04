#!/usr/bin/env bash
# Real Maildirs and real tmux recipients prove one-shot notification and explicit flush.
set -Eeuo pipefail
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
APP="$(dirname -- "$(dirname -- "$(realpath -- "$REACH")")")"

participants
export SNO_REACH_RING_LOG="$WORK/rings.jsonl"
: >"$SNO_REACH_RING_LOG"
receiver_pane="$(jq -r '.identity.value' "$STATE/$RECEIVER/reachable.json")"

ring_count() {
  jq -s --arg id "<$1>" --arg to "$2" \
    '[.[] | select(.msg_id == $id and .to == $to)] | length' "$SNO_REACH_RING_LOG"
}
expect_rings() {
  local count
  count="$(ring_count "$1" "$2")"
  [[ "$count" == "$3" ]] || fail "<$1> to $2 rang $count times, expected $3"
}
copy_count() {
  local address="$1" id="$2" file count=0
  while IFS= read -r -d '' file; do
    [[ "$(header message-id "$file")" != "<$id>" ]] || count=$((count + 1))
  done < <(find "$STATE/$address/new" "$STATE/$address/cur" -type f -print0)
  printf '%s\n' "$count"
}
expect_copy() {
  [[ "$(copy_count "$1" "$2")" == 1 ]] || fail "<$2> does not have exactly one copy for $1"
  local path
  path="$(message_path "$1" "$2")"
  cmp <(sed '1,/^$/d' "$3") <(sed '1,/^$/d' "$path") || fail 'delivered body changed'
}
expect_no_workers() {
  local pid command_line
  while IFS= read -r pid; do
    command_line="$(test_process_command "$pid" 2>/dev/null)" || continue
    if [[ "$command_line" == *"$STATE"* &&
          ( "$command_line" == *'/lib/reach-wake '* || "$command_line" == *'/bin/sno-reach flush '* ) ]]; then
      fail "background notification or recovery survived: $pid $command_line"
    fi
  done < <(test_process_ids)
}
queue() {
  local entry="$STATE/$SENDER/outbox/$1"
  mkdir -p "$entry"
  cp "$2" "$entry/message"
  shift 2
  printf '%s\n' "$@" >"$entry/recipients"
}

id="notification-normal-$$@$HOST"
card "$id" "$SENDER" "$RECEIVER" question notification-once >"$WORK/card"
invoke send --as "$SENDER" <"$WORK/card"; expect_rc 0
expect_copy "$RECEIVER" "$id" "$WORK/card"
expect_rings "$id" "$RECEIVER" 1
has "$SNO_REACH_RING_LOG" '"outcome":"rang"'
[[ -z "$(find "$STATE" -path '*/wake-attempts/*' -type f -print -quit)" ]] || fail 'normal notification created retry records'
expect_no_workers
pass 'normal To delivery reaches a real tmux recipient once without a worker'

for automatic in auto-generated auto-replied; do
  id="notification-$automatic-$$@$HOST"
  card "$id" "$SENDER" "$RECEIVER" status notification-once "Auto-Submitted: $automatic" >"$WORK/card"
  invoke send --as "$SENDER" <"$WORK/card"; expect_rc 0
  expect_copy "$RECEIVER" "$id" "$WORK/card"
  expect_rings "$id" "$RECEIVER" 0
done
id="notification-not-auto-$$@$HOST"
card "$id" "$SENDER" "$RECEIVER" status notification-once 'Auto-Submitted: no' >"$WORK/card"
invoke send --as "$SENDER" <"$WORK/card"; expect_rc 0
expect_copy "$RECEIVER" "$id" "$WORK/card"
expect_rings "$id" "$RECEIVER" 1
expect_no_workers
pass 'automatic cards are preserved without notification; explicit no still notifies once'

# A genuinely dead terminal causes notification failure after successful mail delivery.
tmux -L "$SERVER" kill-pane -t "$receiver_pane"
id="notification-dead-terminal-$$@$HOST"
card "$id" "$SENDER" "$RECEIVER" question notification-once >"$WORK/card"
invoke send --as "$SENDER" <"$WORK/card"; expect_rc 0
expect_copy "$RECEIVER" "$id" "$WORK/card"
expect_rings "$id" "$RECEIVER" 1
grep -Eiq 'notification|wake|ring' "$WORK/err" || fail 'notification failure was silent'
grep -Eiq 'delivered|saved|stored' "$WORK/err" || fail 'failure did not say the message was delivered'
grep -Eiq 'do not resend|do not re-send|not resend|no resend' "$WORK/err" || fail 'failure did not explain that resending would duplicate delivery'
[[ ! -d "$STATE/$SENDER/outbox" ]] || fail 'delivered message remains queued'
expect_no_workers
pass 'dead terminal reports notification failure but successful delivery returns zero and stays unqueued'
register "$RECEIVER"

# Inject a real filesystem syscall failure after the public command stages its outbox.
# The product executable and its delivery helper remain unchanged.
id="notification-transport-failure-$$@$HOST"
card "$id" "$SENDER" "$RECEIVER" question notification-once >"$WORK/card"
RC=0
strace -f -e trace=linkat -e inject=linkat:error=EIO:when=1 -o "$WORK/link-failure.trace" \
  env -u SNO_TPM_REGISTRY -u TPM_REGISTRY -u MAILBOX_TERMINAL_REGISTRY -u SNO_REACH_ADDR \
  HOME="$TEST_HOME" XDG_CONFIG_HOME="$TEST_HOME/.config" XDG_STATE_HOME="$TEST_HOME/.local/state" \
  SNO_REACH_ROOT="$STATE" TMUX="$TEST_TMUX" TMUX_PANE="$TEST_PANE" \
  "$REACH" send --as "$SENDER" --no-ring <"$WORK/card" >"$WORK/out" 2>"$WORK/err" || RC=$?
[[ "$RC" != 0 ]] || fail 'real hard-link failure incorrectly returned success'
grep -Eq 'linkat\(.*= -1 EIO .*INJECTED' "$WORK/link-failure.trace" || fail 'real hard-link failure was not reached'
[[ "$(copy_count "$RECEIVER" "$id")" == 0 ]] || fail 'failed transport delivered a recipient copy'
mapfile -t queued < <(find "$STATE/$SENDER/outbox" -mindepth 2 -maxdepth 2 -name message -type f)
[[ "${#queued[@]}" == 1 ]] || fail 'failed transport did not preserve exactly one queued message'
cmp "$WORK/card" "${queued[0]}" || fail 'failed transport changed the queued message bytes'
has "$WORK/err" flush
expect_no_workers
invoke flush --as "$SENDER"; expect_rc 0
expect_copy "$RECEIVER" "$id" "$WORK/card"
expect_rings "$id" "$RECEIVER" 1
[[ ! -d "$STATE/$SENDER/outbox" ]] || fail 'manual flush did not retire the completed outbox'
expect_no_workers
pass 'real transport failure retains exact bytes without a worker; explicit flush delivers and notifies once'

# Prepare the exact historical format without invoking the removed background worker.
mkdir -p "$STATE/$RECEIVER/wake-attempts"
python3 - "$STATE" "$SENDER" "$RECEIVER" <<'HISTORY'
import json, pathlib, sys
root, sender, recipient = sys.argv[1:]
directory = pathlib.Path(root, recipient, 'wake-attempts')
for index in range(2000):
    record = dict(version=1, attempt_id=f'{index + 1:032x}', root=root,
                  sender=sender, recipient=recipient, supervisor=recipient,
                  message_id=f'<old-{index}@history>', journey='old-notification',
                  mechanism='/missing', mode='wake', state_owner=recipient,
                  outbox_entry='', standin='', outcome_hint='', started_at=0, last_at=0,
                  attempt=0, max_attempts=45, spacing_seconds=120, bound_seconds=5400,
                  child_pid=0, child_start_ticks=0, state='pending', phase='retry',
                  last_outcome='busy', reachability_state='registered',
                  escalation_sent=False, escalation_delivered=[], outbox_recipients=[],
                  removed_recipients=[])
    (directory / f'{index}.json').write_text(json.dumps(record) + '\n')
(pathlib.Path(root, recipient) / 'wake.log').write_text('{"event":"old-history"}\n')
HISTORY
find "$STATE/$RECEIVER/wake-attempts" -type f -print0 | sort -z | xargs -0 sha256sum >"$WORK/history-before"
sha256sum "$STATE/$RECEIVER/wake.log" >>"$WORK/history-before"
invoke inbox --as "$RECEIVER"; expect_rc 0
register "$RECEIVER"
invoke unregister --as "$RECEIVER"; expect_rc 0
register "$RECEIVER"
find "$STATE/$RECEIVER/wake-attempts" -type f -print0 | sort -z | xargs -0 sha256sum >"$WORK/history-after"
sha256sum "$STATE/$RECEIVER/wake.log" >>"$WORK/history-after"
cmp "$WORK/history-before" "$WORK/history-after" || fail 'read or registration changed historical retries'
expect_no_workers
pass 'inbox, registration and unregister leave 2000 pending records untouched and start no worker'

# Model a partial old send: Cc was delivered, while only the To copy remains queued.
id="notification-flush-$$@$HOST"
card "$id" "$SENDER" "$RECEIVER" question notification-once "Cc: Observer <$OTHER>" >"$WORK/card"
invoke send --as "$SENDER" --no-ring <"$WORK/card"; expect_rc 0
other_copy="$(message_path "$OTHER" "$id")"
cp "$other_copy" "$WORK/cc-before"
receiver_copy="$(message_path "$RECEIVER" "$id")"
mv "$receiver_copy" "$WORK/receiver-before-flush"
queue partial-old-send "$WORK/card" "$RECEIVER"
invoke flush --as "$SENDER"; expect_rc 0
expect_copy "$RECEIVER" "$id" "$WORK/card"
expect_copy "$OTHER" "$id" "$WORK/card"
cmp "$other_copy" "$WORK/cc-before" || fail 'flush changed an already delivered Cc copy'
expect_rings "$id" "$RECEIVER" 1
expect_rings "$id" "$OTHER" 0
invoke flush --as "$SENDER"; expect_rc 0
expect_copy "$RECEIVER" "$id" "$WORK/card"
expect_copy "$OTHER" "$id" "$WORK/card"
expect_rings "$id" "$RECEIVER" 1
expect_no_workers
pass 'explicit flush delivers the pending To once without redelivering or notifying the completed Cc'

# Old automated reports are delivered by manual flush without recursive notification.
id="notification-auto-flush-$$@$HOST"
card "$id" "$SENDER" "$RECEIVER" status notification-once 'Auto-Submitted: auto-generated' >"$WORK/card"
queue automatic-old-send "$WORK/card" "$RECEIVER"
invoke flush --as "$SENDER"; expect_rc 0
expect_copy "$RECEIVER" "$id" "$WORK/card"
expect_rings "$id" "$RECEIVER" 0
[[ ! -d "$STATE/$SENDER/outbox" ]] || fail 'successful manual flush left an outbox'
expect_no_workers
find "$STATE/$RECEIVER/wake-attempts" -type f -print0 | sort -z | xargs -0 sha256sum >"$WORK/history-final"
sha256sum "$STATE/$RECEIVER/wake.log" >>"$WORK/history-final"
cmp "$WORK/history-before" "$WORK/history-final" || fail 'flush changed historical retries'
pass 'manual flush preserves automated report bytes without notifying or reviving old retries'
