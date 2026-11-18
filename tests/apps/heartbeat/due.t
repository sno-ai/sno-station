#!/usr/bin/env bash
# Exercise the public commands with external-agent substitutes using the probed JSON events.
set -Eeuo pipefail
export LC_ALL=C
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HEARTBEAT:-$HERE/../../../apps/heartbeat/bin/heartbeat}"
work="$(mktemp -d "${TMPDIR:-/tmp}/heartbeat-due.XXXXXX")"
work="$(cd -- "$work" && pwd -P)" # macOS temporary folders sit behind the /var symlink
export TMPDIR="$work" HEARTBEAT_STATE="$work/state" SNO_PROFILE_DIR="$work/profile"
export SNO_REACH_ROOT="$work/reach"
export CLAUDE_CONFIG_DIR="$work/claude" CODEX_HOME="$work/codex"
export DUE_TEST_WORK="$work" DUE_TEST_MODE=reply
mkdir -p "$work/bin" "$work/checkout space" "$CLAUDE_CONFIG_DIR/sessions" "$CODEX_HOME" "$SNO_PROFILE_DIR/station/handoff"
cleanup() {
  local file pid
  for file in "$work"/calls/*/pid "$work"/calls/*/runner "$work"/calls/*/background; do
    [[ -f $file ]] || continue
    pid="$(cat "$file")"; kill -TERM "$pid" 2>/dev/null || true
  done
  rm -rf -- "$work"
}
trap cleanup EXIT
failures=0
ok() { printf 'ok    %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures+1)); }
expect() { if grep -qF -- "$3" "$2"; then ok "$1"; else fail "$1: missing [$3]"; fi; }
absent() { if grep -qF -- "$3" "$2"; then fail "$1: found [$3]"; else ok "$1"; fi; }
equal() { if [[ $2 == "$3" ]]; then ok "$1"; else fail "$1: expected [$3], got [$2]"; fi; }
wait_for() {
  local i
  for ((i=0;i<200;i++)); do
    grep -qF -- "$2" "$1" 2>/dev/null && return 0
    sleep 0.05
  done
  fail "wait for [$2] in $1"
  return 1
}
cat >"$work/bin/claude" <<'AGENT'
#!/usr/bin/env bash
set -Eeuo pipefail
call="$(mktemp -d "$DUE_TEST_WORK/calls/call.XXXXXX")"
printf '%s\n' "$$" >"$call/pid"
printf '%s\n' "$PPID" >"$call/runner"
printf '%s\n' "$PWD" >"$call/cwd"
printf '%s\n' "${CODEX_HOME:-}" >"$call/home"
printf '%s\n' "${SNO_DUE_RUN:-}" >"$call/due-run"
printf '%s\n' "${@: -1}" >"$call/prompt"
printf '%s\n' "$@" >"$call/argv"
if [[ /dev/stdin -ef /dev/null ]]; then printf 'devnull\n' >"$call/stdin"; else printf 'wrong\n' >"$call/stdin"; fi
printf '%s\n' "$call" >>"$DUE_TEST_WORK/invocations"
mode="$DUE_TEST_MODE"
if [[ $mode == missing && " $* " != *' resume '* && " $* " != *' --resume '* ]]; then mode=reply; fi
if [[ $mode == before ]]; then
  printf 'waiting\n' >"$DUE_TEST_WORK/before"
  while [[ ! -f $DUE_TEST_WORK/release ]]; do sleep 0.05; done
fi
case "$mode" in
  login)
    if [[ ${0##*/} == claude ]]; then
      printf '%s\n' '{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"Not logged in · Please run /login"}]}}' '{"type":"result","is_error":true,"result":"Not logged in · Please run /login","usage":{"output_tokens":0}}'
    else
      printf '%s\n' '{"type":"item.completed","item":{"type":"error","message":"401 Unauthorized"}}' '{"type":"turn.failed","error":{"message":"Not logged in"}}'
    fi
    exit 1 ;;
  missing) printf '%s\n' '{"type":"error","message":"conversation not found"}'; exit 1 ;;
esac
if [[ ${0##*/} == claude ]]; then
  printf '%s\n' '{"type":"assistant","message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"Working"}]}}'
else
  printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Working"}}'
fi
printf 'first reply\n' >"$call/replied"
if [[ $mode == hold ]]; then
  while [[ ! -f $DUE_TEST_WORK/release ]]; do sleep 0.05; done
fi
if [[ $mode == failed ]]; then printf 'agent crashed\n' >&2; exit 7; fi
if [[ $mode == noresult ]]; then exit 0; fi
result="DUE_RESULT ${DUE_TEST_RESULT:-done}"
if [[ ${0##*/} == claude ]]; then
  jq -nc --arg result "$result" '{type:"result",result:$result,is_error:false}'
else
  jq -nc --arg result "$result" '{type:"item.completed",item:{type:"agent_message",text:$result}}'
fi
if [[ $mode == background ]]; then
  sleep 30 </dev/null >/dev/null 2>&1 &
  printf '%s\n' "$!" >"$call/background"
fi
AGENT
cp "$work/bin/claude" "$work/bin/codex"
# Substitute only the external clock, leaving GNU date to parse and convert every time.
DUE_TEST_DATE="$(type -P date)"; export DUE_TEST_DATE
cat >"$work/bin/date" <<'CLOCK'
#!/usr/bin/env bash
if [[ -n ${DUE_TEST_NOW:-} ]]; then
  if [[ $# == 1 && $1 == +%s ]]; then printf '%s\n' "$DUE_TEST_NOW"; exit; fi
  if [[ $# == 1 && $1 == +* ]]; then exec "$DUE_TEST_DATE" -d "@$DUE_TEST_NOW" "$1"; fi
fi
exec "$DUE_TEST_DATE" "$@"
CLOCK
cat >"$work/bin/sno" <<'SNO'
#!/usr/bin/env bash
set -Eeuo pipefail
case "$1 $2" in
  'reach notify')
    printf -v args '%s\t' "$@"
    printf '%s\n' "$args" >>"$DUE_TEST_WORK/notices" ;;
  'reach rewake')
    [[ -f "$DUE_TEST_WORK/hold-rewake" ]] || exit 0
    printf '%s\n' "$*" >>"$DUE_TEST_WORK/rewake-started"
    for ((i=0;i<100;i++)); do
      [[ ! -f "$DUE_TEST_WORK/hold-rewake" ]] || { sleep 0.05; continue; }
      printf 'rewake finished\n'
      exit 0
    done
    printf 'rewake fixture was not released\n' >&2
    exit 1 ;;
  *) exit 64 ;;
esac
SNO
chmod +x "$work/bin/claude" "$work/bin/codex" "$work/bin/date" "$work/bin/sno"
export PATH="$work/bin:$PATH"
mkdir -p "$work/calls"
record="$SNO_PROFILE_DIR/station/handoff/task.md"
new_record() {
  rm -f "$work/release" "$work/before" "$work/invocations"
  export DUE_TEST_MODE=reply
  cat >"$record" <<RECORD
# Progress
<!-- machine-record:start -->
checkout: $work/checkout space
runtime: ${1:-claude-code}
session-id: ${2:-}
<!-- machine-record:end -->
## Next
Something unrelated now
RECORD
}
set_due() { "$SCRIPT" --due-set "$record" "$1" "$2" "${@:3}"; }
tick() { "$SCRIPT" --due-tick >"$work/tick.out"; }
finished() { wait_for "$record" "${1:-DUE_RESULT done}"; }
calls() { if [[ -f $work/invocations ]]; then wc -l <"$work/invocations"; else printf '0'; fi; }
last_call() { tail -1 "$work/invocations"; }
wait_exit() {
  local pid="$1" state i
  for ((i=0;i<200;i++)); do
    state="$(ps -o stat= -p "$pid" 2>/dev/null)" || return 0
    [[ $state == Z* ]] && return 0
    sleep 0.05
  done
  fail 'runner did not exit after external agent finished'
  return 1
}
notice() {
  local args
  printf -v args '%s\t' reach notify --type failure --subject "$1" --body
  args+="$record: $2"
  if wait_for "$work/notices" "$args"; then
    equal "one failure notice for $1" "$(grep -Fc -- "$args" "$work/notices")" 1
  fi
}

# Keep all tools needed by interval and until-file heartbeats, but no jq.
mkdir -p "$work/no-jq"
for tool in bash timeout tail flock awk sha256sum dirname mkdir rm mv date mktemp head cat sleep id true; do
  ln -s "$(type -P "$tool")" "$work/no-jq/$tool"
done
status=0
log_path="$work/no jq.log"
PATH="$work/no-jq" CURSOR_AGENT='' "$SCRIPT" --label no-jq --log "$log_path" \
  --max-ticks 1 --interval 1s -- true >"$work/no-jq.out" 2>"$work/no-jq.err" || status=$?
equal 'plain heartbeat without jq exits successfully' "$status" 0
expect 'plain heartbeat without jq runs its hook' "$log_path" '[no-jq] tick=1 ok (no output)'
reader="$(sed -n 's/^heartbeat:   Monitor({command: \(.*\), persistent: true, description: .*$/\1/p' "$work/no-jq.out" | jq -er 'select(startswith("tail "))')"
status=0
timeout 5 bash -c "$reader" >"$work/reader.out" 2>"$work/reader.err" || status=$?
equal 'printed reader exits successfully for a log path with spaces' "$status" 0
equal 'printed reader opens the log path with spaces' "$(cat "$work/reader.err")" ''
status=0
PATH="$work/no-jq" CURSOR_AGENT='' "$SCRIPT" --label no-jq-until --log "$work/no-jq-until.log" \
  --max-ticks 1 --interval 1s --until-file "$work/not-created" >"$work/no-jq.out" 2>"$work/no-jq.err" || status=$?
equal 'until-file heartbeat without jq exits successfully' "$status" 0
expect 'until-file heartbeat without jq waits' "$work/no-jq-until.log" '[no-jq-until] tick=1 waiting'
for verb in --due-run --due-tick --due --due-set --due-cancel; do
  status=0
  PATH="$work/no-jq" "$SCRIPT" "$verb" >"$work/no-jq.out" 2>"$work/no-jq.err" || status=$?
  equal "$verb without jq exits 1" "$status" 1
  equal "$verb without jq prints one clear error" "$(cat "$work/no-jq.err")" \
    'heartbeat: needs jq — read agent reply events; install it and run again.'
  equal "$verb without jq has no stdout" "$(cat "$work/no-jq.out")" ''
done

# A surviving agent child must not keep the entry running or prevent its next occurrence.
new_record
export DUE_TEST_MODE=background DUE_TEST_NOW=1793725200 # 2026-11-03 17:00 UTC
set_due '2026-11-03 07:00 UTC' 'leave a background child' daily
tick; finished
call="$(last_call)"
wait_exit "$(cat "$call/runner")"
if kill -0 "$(cat "$call/background")" 2>/dev/null; then ok 'agent background child is still alive'; else fail 'agent background child exited too soon'; fi
"$SCRIPT" --due >"$work/list"
expect 'finished entry remains listed with a live agent child' "$work/list" 'do: leave a background child'
absent 'finished runner with a live agent child is not running' "$work/list" 'running since'
export DUE_TEST_NOW=1793811600 # 2026-11-04 17:00 UTC
tick
equal 'next occurrence launches while the agent child lives' "$(cat "$work/tick.out")" 'task.md | leave a background child | runner launched'
if grep -qF 'runner launched' "$work/tick.out"; then
  wait_for "$record" 'at: 2026-11-05 07:00 UTC'
  wait_exit "$(cat "$(last_call)/runner")"
  expect 'next occurrence saves a real reply' "$record" 'DUE_RESULT done'
fi
equal 'both occurrences reached the external agent' "$(calls)" 2
for file in "$work"/calls/*/background; do
  [[ -f $file ]] || continue
  kill -TERM "$(cat "$file")" 2>/dev/null || true
done
unset DUE_TEST_NOW

new_record
if "$SCRIPT" --due-set "$record" tomorrow action >"$work/refused" 2>&1; then fail 'refuses malformed time'; else expect 'refusal names format' "$work/refused" 'YYYY-MM-DD HH:MM'; fi
for at in '2026-02-30 07:00 UTC' '2026-11-01 07:00' '2026-11-01 07:00 Unknown/Zone'; do
  if "$SCRIPT" --due-set "$record" "$at" action >/dev/null 2>&1; then fail "refuses $at"; else ok "refuses $at"; fi
done
cp "$record" "$work/outside.md"
if "$SCRIPT" --due-set "$work/outside.md" '2026-11-01 07:00 UTC' action >"$work/refused" 2>&1; then fail 'refuses outside record'; else expect 'outside refusal explains directory' "$work/refused" 'only records directly inside'; fi
if "$SCRIPT" --due-set "$record" '2026-11-01 07:00 UTC' action monthly >/dev/null 2>&1; then fail 'refuses unsupported repeat'; else ok 'refuses unsupported repeat'; fi
if "$SCRIPT" --due-set "$record" '2026-11-01 07:00 UTC' $'two\nlines' >/dev/null 2>&1; then fail 'refuses multiline action'; else ok 'refuses multiline action'; fi

set_due '2026-10-31 07:00 America/Los_Angeles' 'write the promised report'
set_due '2026-10-31 07:00 America/Los_Angeles' 'check the build'
printf '\n## Notes\nat: keep this unrelated text\n' >>"$record"
tick
finished
# Wait for both results rather than just the faster of the two concurrent updates.
for ((i=0;i<200;i++)); do [[ $(grep -c 'DUE_RESULT done' "$record") == 2 ]] && break; sleep 0.05; done
equal 'both entries run once' "$(calls)" 2
equal 'both entries finish without lost writes' "$(grep -c 'DUE_RESULT done' "$record")" 2
absent 'one-time occurrences cleared' "$record" 'at: 2026-10-31'
expect 'unrelated heading preserved' "$record" 'at: keep this unrelated text'
tick
equal 'used-up entries do not run again' "$(calls)" 2
for call in "$work"/calls/*; do
  expect 'record checkout used' "$call/cwd" "$work/checkout space"
  expect 'stdin closed' "$call/stdin" devnull
  equal 'due agent carries SNO_DUE_RUN' "$(cat "$call/due-run")" 1
  expect 'stream-json requested' "$call/argv" stream-json
  expect 'record path in prompt' "$call/prompt" "$record"
done
grep -lF 'Do: write the promised report' "$work"/calls/*/prompt >"$work/matching"
equal 'prompt uses promised action after Next moved' "$(wc -l <"$work/matching")" 1
expect 'late start recorded' "$record" 'late by '
"$SCRIPT" --due >"$work/list"
expect 'used-up entries stay visible' "$work/list" 'write the promised report'
expect 'listing next time absent' "$work/list" 'next: none'
"$SCRIPT" --due --problems >"$work/problems"
equal 'successful entries are not problems' "$(cat "$work/problems")" ''

new_record
set_due '2099-01-01 07:00 UTC' 'future action'
tick
equal 'future does not launch' "$(calls)" 0
TZ=UTC "$SCRIPT" --due >"$work/list"
expect 'future displayed' "$work/list" '2099-01-01'
"$SCRIPT" --due-cancel "$record" 'future action'
absent 'cancel selected action' "$record" 'future action'
set_due '2099-01-01 07:00 UTC' one
set_due '2099-01-02 07:00 UTC' two
cp -- "$record" "$work/before-cancel"
status=0
"$SCRIPT" --due-cancel "$record" '' >"$work/refused" 2>&1 || status=$?
equal 'cancel rejects an explicitly empty action' "$status" 2
expect 'empty cancellation uses the argument error' "$work/refused" '--due-cancel needs <record> [<do text>]'
if cmp -s -- "$record" "$work/before-cancel"; then ok 'empty action preserves the record'; else fail 'empty action changed the record'; fi
"$SCRIPT" --due-cancel "$record"
absent 'cancel whole section' "$record" '## Due'
expect 'cancel preserves other sections' "$record" 'Something unrelated now'

# Calendar dates, not 86400-second increments: both cross the 25-hour DST day.
export DUE_TEST_NOW=1793518200 # 2026-11-01 00:30 PDT
for repeat in daily weekly; do
  new_record
  if [[ $repeat == daily ]]; then at='2026-10-31 07:00 America/Los_Angeles'; else at='2026-10-25 07:00 America/Los_Angeles'; fi
  set_due "$at" "repeat $repeat" "$repeat"
  tick; finished
  expect "$repeat preserves 07:00 across DST" "$record" 'at: 2026-11-01 07:00 America/Los_Angeles'
done
export DUE_TEST_NOW=1793725200 # 2026-11-03 09:00 PST, after three missed daily occurrences.
new_record
set_due '2026-10-31 07:00 America/Los_Angeles' 'missed daily' daily
tick; finished
equal 'three missed days run once' "$(calls)" 1
expect 'missed repeat moves to first future day' "$record" 'at: 2026-11-04 07:00 America/Los_Angeles'
unset DUE_TEST_NOW

new_record
export DUE_TEST_NOW=1793725320 # 2026-11-03 17:02 UTC, 22:32 in Kolkata
set_due '2026-10-31 07:15 Asia/Kolkata' 'repeat hourly' hourly
tick; finished
expect 'hourly advances to the next local whole hour' "$record" 'at: 2026-11-03 23:00 Asia/Kolkata'
expect 'hourly repeat is preserved' "$record" 'repeat: hourly'
tick
equal 'the next hour does not run early' "$(calls)" 1
new_record
export DUE_TEST_NOW=1793521800 # 2026-11-01 01:30 PDT, before the repeated 01:00 PST
set_due '2026-10-31 07:15 America/Los_Angeles' 'repeat across fallback' hourly
tick; finished
expect 'repeated local hour is saved as an unambiguous future time' "$record" 'at: 2026-11-01 09:00 UTC'
tick
equal 'the repeated hour does not run early' "$(calls)" 1
unset DUE_TEST_NOW

for runtime in claude-code codex; do
  new_record "$runtime" closed-session
  set_due '2026-10-31 07:00 UTC' 'cannot log in'
  export DUE_TEST_MODE=login
  export DUE_TEST_NOW=1793725200 # 2026-11-03 17:00 UTC
  tick
  wait_for "$record" 'not started:'
  notice 'not started: cannot log in' "not started: resume closed-session Not logged in"
  expect "$runtime failed start keeps time" "$record" 'at: 2026-10-31 07:00 UTC'
  expect "$runtime first failure records controlled minute" "$record" 'last: 2026-11-03 17:00 UTC not started:'
  equal "$runtime login never falls back" "$(calls)" 1
  wait_exit "$(cat "$(last_call)/runner")"
  cp "$record" "$work/once"
  cp "$HEARTBEAT_STATE/log/due.log" "$work/log-once"
  export DUE_TEST_NOW=1793725320 # 2026-11-03 17:02 UTC
  tick
  for ((i=0;i<200;i++)); do [[ $(calls) == 2 ]] && break; sleep 0.05; done
  equal "$runtime second failure actually runs" "$(calls)" 2
  wait_exit "$(cat "$(last_call)/runner")"
  notice 'not started: cannot log in' 'not started: resume closed-session Not logged in'
  if cmp -s "$record" "$work/once" && cmp -s "$HEARTBEAT_STATE/log/due.log" "$work/log-once"; then ok "$runtime unchanged failure written once"; else fail "$runtime rewrote identical failure"; fi
  "$SCRIPT" --due --problems >"$work/problems"
  expect "$runtime failure displayed" "$work/problems" 'not started:'
  rm -f -- "$work/notices"
done
unset DUE_TEST_NOW

new_record
cat >>"$record" <<'BAD'
## Due
at: nonsense
do: invalid manual time
BAD
tick
expect 'unreadable manual time recorded' "$record" 'not started: time not understood: at: nonsense'
cp "$record" "$work/once"
tick
if cmp -s "$record" "$work/once"; then ok 'unreadable time written once'; else fail 'unreadable time rewritten'; fi

for runtime in claude-code codex; do
  new_record "$runtime" closed-session
  set_due '2026-10-31 07:00 UTC' 'resume task'
  tick; finished
  call="$(last_call)"
  if [[ $runtime == claude-code ]]; then expect 'closed Claude resumes' "$call/argv" --resume; else expect 'closed Codex resumes' "$call/argv" resume; fi
  expect 'closed session id passed' "$call/argv" closed-session
  expect 'resume recorded' "$record" 'resumed conversation closed-session'
  new_record "$runtime"
  set_due '2026-10-31 07:00 UTC' 'fresh task'
  tick; finished
  call="$(last_call)"
  absent "$runtime fresh has no resume" "$call/argv" resume
  expect "$runtime fresh recorded" "$record" 'fresh conversation'
  new_record "$runtime" missing-session
  export DUE_TEST_MODE=missing
  set_due '2026-10-31 07:00 UTC' 'missing context'
  tick; finished
  equal "$runtime missing context gets one fresh start" "$(calls)" 2
  expect "$runtime missing context named in fresh prompt" "$(last_call)/prompt" 'Earlier context was not found'
done

new_record claude-code open-session
printf '{"pid":%s,"sessionId":"open-session","status":"idle"}\n' "$$" >"$CLAUDE_CONFIG_DIR/sessions/$$.json"
set_due '2026-10-31 07:00 UTC' 'fork Claude'
tick; finished
equal 'open Claude exact routing arguments' "$(head -n4 "$(last_call)/argv")" $'-p\n--resume\nopen-session\n--fork-session'
expect 'open Claude forks' "$(last_call)/argv" --fork-session
expect 'fork recorded' "$record" 'copy of open conversation open-session'
rm "$CLAUDE_CONFIG_DIR/sessions/$$.json"
new_record codex open-codex
mkdir -p "$work/other home/thread-writer-locks"
exec 8>"$work/other home/thread-writer-locks/open-codex.lock"
set_due '2026-10-31 07:00 UTC' 'fork Codex'
tick; finished
equal 'open Codex exact routing arguments' "$(head -n4 "$(last_call)/argv")" $'exec\nfork\nopen-codex\n--json'
expect 'open Codex forks' "$(last_call)/argv" fork
expect 'Codex may run outside a repository' "$(last_call)/argv" --skip-git-repo-check
expect 'open Codex uses thread home' "$(last_call)/home" "$work/other home"
exec 8>&-

for mode in before hold; do
  new_record
  export DUE_TEST_MODE="$mode"
  export DUE_TEST_NOW=1793725200 # 2026-11-03 17:00 UTC
  set_due '2026-10-31 07:00 UTC' "held $mode"
  tick
  if [[ $mode == before ]]; then wait_for "$work/before" waiting; else wait_for "$record" 'result pending'; fi
  tick
  equal "$mode held lock prevents duplicate" "$(calls)" 1
  # Give the real running lock a known start time; queries must retain it as the clock advances.
  touch -d '2026-11-03 17:00 UTC' "$HEARTBEAT_STATE"/due/*.lock
  TZ=UTC "$SCRIPT" --due >"$work/list"
  equal "$mode running time displayed" "$(sed -n 's/.*running since //p' "$work/list")" '2026-11-03 17:00 UTC'
  export DUE_TEST_NOW=1793725320 # 2026-11-03 17:02 UTC
  TZ=UTC "$SCRIPT" --due >"$work/list"
  equal "$mode query preserves running start time in later minute" "$(sed -n 's/.*running since //p' "$work/list")" '2026-11-03 17:00 UTC'
  "$SCRIPT" --due --problems >"$work/problems"
  equal 'running pending not shown as problem' "$(cat "$work/problems")" ''
  if [[ $mode == before ]]; then
    set_due '2099-01-01 07:00 UTC' "held $mode"
    touch "$work/release"
    finished
    expect 'time edited before reply kept' "$record" 'at: 2099-01-01 07:00 UTC'
  else
    absent 'occurrence consumed before exit' "$record" 'at: 2026-10-31'
    call="$(last_call)"
    kill -TERM "$(cat "$call/runner")" "$(cat "$call/pid")" 2>/dev/null || true
    for ((i=0;i<200;i++)); do "$SCRIPT" --due --problems >"$work/problems"; grep -q 'result pending' "$work/problems" && break; sleep 0.05; done
    expect 'killed runner pending becomes problem' "$work/problems" 'result pending'
    tick
    equal 'killed runner does not rerun used occurrence' "$(calls)" 1
  fi
done
unset DUE_TEST_NOW

new_record claude-code closed-session
export DUE_TEST_MODE=failed
set_due '2026-10-31 07:00 UTC' 'replied then failed'
tick
finished 'ended with error 7'
notice 'ended with error: replied then failed' 'ended with error 7 agent crashed'
equal 'reply then failure never starts fresh' "$(calls)" 1
"$SCRIPT" --due --problems >"$work/problems"
expect 'exit failure displayed' "$work/problems" 'ended with error 7'
new_record
export DUE_TEST_MODE=noresult
set_due '2026-10-31 07:00 UTC' 'no final answer'
tick; finished 'no result line'
notice 'no result line: no final answer' 'no result line'
"$SCRIPT" --due --problems >"$work/problems"
expect 'missing result displayed' "$work/problems" 'no result line'
new_record codex
export DUE_TEST_RESULT='done file written and checked'
set_due '2026-10-31 07:00 UTC' 'write and check file'
tick; finished 'started,'
wait_exit "$(cat "$(last_call)/runner")"
grep '^last: ' "$record" >"$work/last"
expect 'Codex done text saved in last' "$work/last" 'DUE_RESULT done file written and checked'
absent 'Codex done text is not a missing result' "$work/last" 'no result line'
unset DUE_TEST_RESULT
for result in 'unfinished work remains' 'waiting-for-you approval needed'; do
  new_record
  export DUE_TEST_RESULT="$result"
  set_due '2026-10-31 07:00 UTC' 'needs attention'
  tick; finished "DUE_RESULT ${result:-done}"
  if [[ $result == waiting-for-you* ]]; then
    notice 'waiting-for-you: needs attention' 'DUE_RESULT waiting-for-you approval needed'
  fi
  "$SCRIPT" --due --problems >"$work/problems"
  if [[ -n $result ]]; then expect "$result displayed" "$work/problems" "$result"; fi
done
unset DUE_TEST_RESULT
new_record
export DUE_TEST_MODE=before
set_due '2026-10-31 07:00 UTC' 'cancel while running'
tick; wait_for "$work/before" waiting
"$SCRIPT" --due-cancel "$record" 'cancel while running'
touch "$work/release"
wait_exit "$(cat "$(last_call)/runner")"
absent 'cancelled entry not recreated' "$record" 'cancel while running'

for i in 1 2 3 4; do
  record="$SNO_PROFILE_DIR/station/handoff/pipe-$i.md"
  new_record
  set_due '2026-10-31 07:00 UTC' '012345678901234567890123456789012345678901234567890123456789 beyond sixty'
done
cat >>"$SNO_PROFILE_DIR/station/handoff/pipe-3.md" <<'BAD'

at: broken pipe time
do: invalid time after closed pipe

at: 2026-10-31 07:00 UTC
repeat: monthly
do: invalid repeat after closed pipe
BAD
set +e
"$SCRIPT" --due-tick | head -c 40 >"$work/short-output"
tick_status=${PIPESTATUS[0]}
set -e
equal 'closed output pipe does not fail tick' "$tick_status" 0
for ((i=0;i<200;i++)); do [[ $(calls) == 4 ]] && break; sleep 0.05; done
for i in 1 2 3 4; do
  record="$SNO_PROFILE_DIR/station/handoff/pipe-$i.md"
  grep -lF -- "Timed task in record: $record" "$work"/calls/*/argv >"$work/matching" || true
  equal "closed output pipe starts agent for pipe-$i.md" "$(wc -l <"$work/matching")" 1
done
for file in "$SNO_PROFILE_DIR/station/handoff/pipe-3.md" "$HEARTBEAT_STATE/log/due.log"; do
  expect 'closed output pipe preserves invalid time failure' "$file" 'not started: time not understood: at: broken pipe time'
  expect 'closed output pipe preserves invalid repeat failure' "$file" 'not started: repeat not understood: monthly'
done
# Remove unlaunched entries too, so a failed regression cannot affect later checks.
for i in 1 2 3 4; do
  record="$SNO_PROFILE_DIR/station/handoff/pipe-$i.md"
  if grep -qF -- "$record" "$work"/calls/*/argv; then finished; fi
  rm -- "$record"
done
record="$SNO_PROFILE_DIR/station/handoff/task.md"
new_record
set_due '2026-10-31 07:00 UTC' '012345678901234567890123456789012345678901234567890123456789 beyond sixty'
tick
equal 'tick prints filename and first sixty action characters' "$(cat "$work/tick.out")" 'task.md | 012345678901234567890123456789012345678901234567890123456789 | runner launched'
finished
"$SCRIPT" --due >"$work/list"
expect 'due listing keeps full record path' "$work/list" "$record"
expect 'due listing keeps full action' "$work/list" '012345678901234567890123456789012345678901234567890123456789 beyond sixty'

rm -- "$record"
touch "$work/hold-rewake"
"$SCRIPT" --due-tick | cat >"$work/rewake-tick.out"
wait_for "$work/rewake-started" 'reach rewake'
absent 'tick pipe closes while rewake is still running' "$HEARTBEAT_STATE/log/due.log" 'rewake fixture was not released'
if flock -n "$SNO_REACH_ROOT/.rewake.lock" true; then
  fail 'tick released the rewake lock before its pass ended'
else
  ok 'background rewake holds the store lock'
fi
rm -- "$work/hold-rewake"
wait_for "$HEARTBEAT_STATE/log/due.log" 'rewake finished'
equal 'one rewake from the tick' "$(cat "$work/rewake-started")" 'reach rewake'

((failures == 0)) || { printf 'heartbeat due: %d FAILED\n' "$failures"; exit 1; }
printf 'heartbeat due: ALL PASS\n'
