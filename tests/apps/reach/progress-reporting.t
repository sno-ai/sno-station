#!/usr/bin/env bash
# Observable CLI/store assertions from agent-progress-reporting PRD section 8.
# Disposable delivered cards are integration fixtures, not live-agent E2E proof.
set -Eeuo pipefail
export HOST="$(hostname)"
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
mbox="$REACH"
export PATH="$APP/vendor/bin:$PATH" HOME="$TEST_HOME"
test_root="$WORK/cases"
mkdir -p "$test_root"
tests=0 failures=0
sender=cts.repo@${HOST} recipient=tpm.repo@${HOST}

fail() { printf '    %s\n' "$*" >&2; exit 1; }
expect() { [[ "$1" == "$2" ]] || fail "expected [$1], got [$2]"; }
has() { grep -Fq -- "$2" "$1" || fail "missing [$2] in $1"; }
absent() { ! grep -Fq -- "$2" "$1" || fail "unexpected [$2] in $1"; }
call() {
    rc=0
    "$mbox" "$@" >"$case_root/out" 2>"$case_root/err" || rc=$?
}
setup() {
    STATE="$case_root/mail"
    export SNO_REACH_ROOT="$STATE"
    initialize "$sender" Fixture
    initialize "$recipient" Fixture
    initialize executor.worker@"${HOST}" Fixture
    register "$sender"
    register "$recipient"
    register executor.worker@"${HOST}"
    export TMUX="$TEST_TMUX" TMUX_PANE="$TEST_PANE"
}
message() {
    local id="$1" from="$2" to="$3" type="$4" extra="${5:-}"
    printf 'From: Fixture <%s>\nTo: Fixture <%s>\n' "$from" "$to"
    printf 'Subject: [%s] %s\nDate: Thu, 10 Sep 2026 00:00:00 +0000\n' "${type^^}" "$id"
    printf 'Message-ID: <%s@'"${HOST}"'>\nX-Work: progress\nX-Type: %s\n' "$id" "$type"
    [[ -z "$extra" ]] || printf '%s\n' "$extra"
    printf '\nDo the named work.\n'
}
held() {
    local id="$1" from="${2:-$sender}" to="${3:-$recipient}" type="${4:-decision}" extra="${5:-}"
    message "$id" "$from" "$to" "$type" "Delivered-To: $to"$'\n'"$extra" \
        >"$SNO_REACH_ROOT/$to/new/$id"
}
report() {
    local id="$1" state="$2" predecessor="$3" references="$4" type=status
    [[ "$state" != requires-action ]] || type=question
    held "$id" "$recipient" "$sender" "$type" "X-State: $state"$'\n'"In-Reply-To: <$predecessor@${HOST}>"$'\n'"References: $references"
}
state() { call state --work progress; expect 0 "$rc"; }
row() {
    local id="$1" value="$2"
    grep -F $'message_id: <'"$id"$'@'"${HOST}"$'>\t' "$case_root/out" >"$case_root/row" || fail "missing item $id"
    has "$case_root/row" $'\tstate: '"$value"$'\t'
}
count_mail() { find "$SNO_REACH_ROOT/$1/new" "$SNO_REACH_ROOT/$1/cur" -type f | wc -l | tr -d ' '; }

test_reply() {
    held work
    report accepted accepted work '<work@'"${HOST}"'>'
    printf 'The result failed.\n' | "$mbox" reply --as "$recipient" --card "$SNO_REACH_ROOT/$recipient/new/work" --state failed >"$case_root/out" 2>"$case_root/err"
    expect 2 "$(count_mail "$sender")"
    grep -Rl '^X-State: failed$' "$SNO_REACH_ROOT/$sender/new" >/dev/null || fail 'terminal report missing'
    expect 1 "$(find "$SNO_REACH_ROOT/$recipient/cur" -name '*:2,*R*' | wc -l | tr -d ' ')"
    held nonterminal
    rc=0
    printf 'Still working.\n' | "$mbox" reply --as "$recipient" --card "$SNO_REACH_ROOT/$recipient/new/nonterminal" --state running >"$case_root/out" 2>"$case_root/err" || rc=$?
    expect 64 "$rc"
    expect 2 "$(count_mail "$sender")"
}
test_terminal_send() {
    held work
    report accepted accepted work '<work@'"${HOST}"'>'
    message terminal "$recipient" "$sender" status $'X-State: completed\nIn-Reply-To: <accepted@'"${HOST}"$'>\nReferences: <work@'"${HOST}"$'> <accepted@'"${HOST}"$'>' >"$case_root/input"
    call send --no-ring --as "$recipient" <"$case_root/input"
    expect 65 "$rc"; expect 1 "$(count_mail "$sender")"
    has "$case_root/err" 'reply --state'
}
test_closed_reply() {
    local flag
    for flag in R T; do
        held "closed-$flag"
        mv "$SNO_REACH_ROOT/$recipient/new/closed-$flag" "$SNO_REACH_ROOT/$recipient/cur/closed-$flag:2,$flag"
        call reply --as "$recipient" --card "$SNO_REACH_ROOT/$recipient/cur/closed-$flag:2,$flag" --state completed <<<'Done.'
        expect 65 "$rc"; has "$case_root/err" "$flag"
        call reply --as "$recipient" --card "$SNO_REACH_ROOT/$recipient/cur/closed-$flag:2,$flag" <<<'A second plain answer.'
        expect 65 "$rc"
    done
    expect 0 "$(count_mail "$sender")"
}
test_plain_reply() {
    held work
    report accepted accepted work '<work@'"${HOST}"'>'
    call reply --as "$recipient" --card "$SNO_REACH_ROOT/$recipient/new/work" <<<'A plain answer.'
    expect 0 "$rc"; expect 2 "$(count_mail "$sender")"
    local answer
    answer="$(grep -Rl '^X-Type: answer$' "$SNO_REACH_ROOT/$sender/new")"
    [[ -f "$answer" ]] || fail 'plain reply did not deliver an answer'
    ! grep -qi '^X-State:' "$answer" || fail 'plain reply invented state'
}
test_nonwork_plain_reply() {
    held question "$sender" "$recipient" question $'X-State: requires-action\nIn-Reply-To: <parent@'"${HOST}"$'>\nReferences: <parent@'"${HOST}"$'>'
    call reply --as "$recipient" --card "$SNO_REACH_ROOT/$recipient/new/question" <<<'The decision is yes.'
    expect 0 "$rc"; expect 1 "$(count_mail "$sender")"
    grep -Rl '^X-Type: answer$' "$SNO_REACH_ROOT/$sender/new" >/dev/null || fail 'non-work question did not receive an answer'
}
test_untaken_terminal() {
    local value
    for value in cancelled refused; do
        held "$value"
        call reply --as "$recipient" --card "$SNO_REACH_ROOT/$recipient/new/$value" --state "$value" <<<'Work was not taken.'
        expect 0 "$rc"
        grep -Rl "^X-State: $value$" "$SNO_REACH_ROOT/$sender/new" >/dev/null || fail "missing $value report"
    done
}
test_cancel() {
    held work
    held cancel "$sender" "$recipient" cancel $'In-Reply-To: <work@'"${HOST}"$'>\nReferences: <work@'"${HOST}"$'>'
    call inbox --as "$recipient"; expect 0 "$rc"; has "$case_root/out" '/new/work'
    [[ -f "$SNO_REACH_ROOT/$recipient/new/work" ]] || fail 'cancel closed work'
    state; row work cancel-requested
    call reply --as "$recipient" --card "$SNO_REACH_ROOT/$recipient/new/work" --state cancelled <<<'Cancel confirmed.'
    expect 0 "$rc"; state; row work cancelled
}
test_chain() {
    held work
    report accepted accepted work '<work@'"${HOST}"'>'
    report running running accepted '<work@'"${HOST}"'> <accepted@'"${HOST}"'>'
    report question requires-action running '<work@'"${HOST}"'> <accepted@'"${HOST}"'> <running@'"${HOST}"'>'
    sed -i 's/00:00:00/03:00:00/' "$SNO_REACH_ROOT/$sender/new/accepted"
    sed -i 's/00:00:00/02:00:00/' "$SNO_REACH_ROOT/$sender/new/running"
    sed -i 's/00:00:00/01:00:00/' "$SNO_REACH_ROOT/$sender/new/question"
    state; row work requires-action
    has "$case_root/row" 'blocked_on: <question@'"${HOST}"'>'; has "$case_root/row" 'answered: no'
    held answer "$sender" "$recipient" answer $'In-Reply-To: <question@'"${HOST}"$'>\nReferences: <work@'"${HOST}"$'> <accepted@'"${HOST}"$'> <running@'"${HOST}"$'> <question@'"${HOST}"$'>'
    state; row work requires-action; has "$case_root/row" 'answered: yes'
    report fork running work '<work@'"${HOST}"'>'
    state; row work ambiguous
    grep '^ANOMALY' "$case_root/out" >"$case_root/anomalies"
    has "$case_root/anomalies" '<accepted@'"${HOST}"'>'; has "$case_root/anomalies" '<fork@'"${HOST}"'>'
}
test_projection_readonly() {
    held expired "$sender" "$recipient" decision "Expiry-Date: $(date -u -R -d '1 hour ago')"
    held old
    held replacement "$sender" "$recipient" decision 'Supersedes: <old@'"${HOST}"'>'
    find "$SNO_REACH_ROOT" -printf '%P\t%y\t%s\t%T@\n' | LC_ALL=C sort >"$case_root/before"
    state; cp "$case_root/out" "$case_root/first"
    row expired expired; has "$case_root/row" 'reason: not-yet-peeked'
    row old superseded; has "$case_root/row" 'reason: not-yet-peeked'
    row replacement queued
    expect 3 "$(wc -l <"$case_root/out" | tr -d ' ')"
    awk -F '\t' 'NF != 7 || $1 !~ /^message_id: / || $2 !~ /^recipient: / ||
        $3 !~ /^state: / || $4 !~ /^since: / || $5 !~ /^blocked_on: / ||
        $6 !~ /^answered: / || $7 !~ /^reason: / {exit 1}' "$case_root/out" ||
        fail 'state does not have the seven fields in contract order'
    state; cmp "$case_root/first" "$case_root/out"
    find "$SNO_REACH_ROOT" -printf '%P\t%y\t%s\t%T@\n' | LC_ALL=C sort >"$case_root/after"
    cmp "$case_root/before" "$case_root/after"
}
test_late_report() {
    held work
    report accepted accepted work '<work@'"${HOST}"'>'
    call reply --as "$recipient" --card "$SNO_REACH_ROOT/$recipient/new/work" --state completed <<<'Done.'
    expect 0 "$rc"
    local terminal_id
    terminal_id="$(grep -Rl '^X-State: completed$' "$SNO_REACH_ROOT/$sender/new" | xargs mhdr -h message-id)"
    held late "$recipient" "$sender" status "X-State: running"$'\n'"In-Reply-To: $terminal_id"$'\n'"References: <work@${HOST}> <accepted@${HOST}> $terminal_id"
    state; row work completed
    grep '^ANOMALY' "$case_root/out" >"$case_root/anomalies"; has "$case_root/anomalies" '<late@'"${HOST}"'>'
}
test_state_inventory() {
    local value source reason
    held queued
    held seen
    printf '{"version":1,"message_id":"<seen@'"${HOST}"'>","seen_at":"2026-09-10T01:00:00Z"}\n' >"$SNO_REACH_ROOT/$recipient/seen.jsonl"
    for value in accepted running requires-action; do
        held "$value"
        report "report-$value" "$value" "$value" "<$value@${HOST}>"
    done
    held cancel-requested
    held cancel "$sender" "$recipient" cancel $'In-Reply-To: <cancel-requested@'"${HOST}"$'>\nReferences: <cancel-requested@'"${HOST}"$'>'
    for value in completed failed cancelled refused replied; do
        held "$value"
        source="$SNO_REACH_ROOT/$recipient/new/$value"
        mv "$source" "$SNO_REACH_ROOT/$recipient/cur/$value:2,R"
        if [[ "$value" == replied ]]; then
            held "reply-$value" "$recipient" "$sender" answer "In-Reply-To: <$value@${HOST}>"$'\n'"References: <$value@${HOST}>"
        else
            report "reply-$value" "$value" "$value" "<$value@${HOST}>"
        fi
    done
    for value in dismissed superseded expired; do
        held "$value"
        mv "$SNO_REACH_ROOT/$recipient/new/$value" "$SNO_REACH_ROOT/$recipient/cur/$value:2,T"
        reason=expired
        [[ "$value" != dismissed ]] || reason='No longer needed.'
        [[ "$value" != superseded ]] || reason='superseded:<replacement@'"${HOST}"'>'
        jq -cn --arg id "<$value@${HOST}>" --arg reason "$reason" \
            '{message_id:$id,reason:$reason,dismissed_at:"2026-09-10T01:00:00Z"}' >>"$SNO_REACH_ROOT/$recipient/dismissals.jsonl"
    done
    find "$SNO_REACH_ROOT" -printf '%P\t%y\t%s\t%T@\n' | LC_ALL=C sort >"$case_root/before"
    state
    for value in queued seen accepted running requires-action cancel-requested completed failed cancelled refused replied dismissed superseded expired; do
        row "$value" "$value"
    done
    find "$SNO_REACH_ROOT" -printf '%P\t%y\t%s\t%T@\n' | LC_ALL=C sort >"$case_root/after"
    cmp "$case_root/before" "$case_root/after"
}
test_invalid_reports() {
    held work
    held missing-parent "$recipient" "$sender" status 'X-State: running'
    report unheld running nonexistent '<nonexistent@'"${HOST}"'>'
    message cc "$sender" executor.worker@"${HOST}" decision $'Cc: tpm.repo@'"${HOST}"$'\nDelivered-To: tpm.repo@'"${HOST}"$'' >"$SNO_REACH_ROOT/$recipient/new/cc"
    report cc-report running cc '<cc@'"${HOST}"'>'
    state; row work queued
    grep '^ANOMALY' "$case_root/out" >"$case_root/anomalies"
    expect 3 "$(wc -l <"$case_root/anomalies" | tr -d ' ')"
    has "$case_root/anomalies" '<missing-parent@'"${HOST}"'>'
    has "$case_root/anomalies" '<unheld@'"${HOST}"'>'
    has "$case_root/anomalies" '<cc-report@'"${HOST}"'>'
}
test_item_count_order() {
    held z
    held a
    held middle
    sed -i 's/00:00:00/01:00:00/' "$SNO_REACH_ROOT/$recipient/new/middle"
    report accepted-z accepted z '<z@'"${HOST}"'>'
    report running-z running accepted-z '<z@'"${HOST}"'> <accepted-z@'"${HOST}"'>'
    report accepted-a accepted a '<a@'"${HOST}"'>'
    report completed-a completed accepted-a '<a@'"${HOST}"'> <accepted-a@'"${HOST}"'>'
    mv "$SNO_REACH_ROOT/$recipient/new/a" "$SNO_REACH_ROOT/$recipient/cur/a:2,R"
    call export --work progress --output "$case_root/export.mbox"; expect 0 "$rc"
    state
    cut -f1 "$case_root/out" >"$case_root/ids"
    printf '%s\n' 'message_id: <a@'"${HOST}"'>' 'message_id: <z@'"${HOST}"'>' 'message_id: <middle@'"${HOST}"'>' >"$case_root/expected"
    cmp "$case_root/expected" "$case_root/ids"
    grep '^Message-ID: ' "$case_root/export.mbox" | sed 's/^Message-ID: /message_id: /' |
        grep -Fx -f "$case_root/ids" >"$case_root/export-ids"
    cmp "$case_root/ids" "$case_root/export-ids"
    row a completed; row z running
    rm -- "$SNO_REACH_ROOT/$recipient/new/middle"
    state; expect 2 "$(wc -l <"$case_root/out" | tr -d ' ')"
    row a completed; row z running
}
remind() {
    rc=0
    "$mbox" remind --as "$recipient" >"$case_root/reminder" 2>"$case_root/reminder.err" || rc=$?
    expect 0 "$rc"
}
test_reminder() {
    remind; [[ ! -s "$case_root/reminder" ]] || fail 'empty seat produced reminder'
    held work
    call inbox --as "$recipient"; expect 0 "$rc"
    remind; has "$case_root/reminder" '<work@'"${HOST}"'>'
    expect 1 "$(wc -l <"$case_root/reminder" | tr -d ' ')"
    message acceptance "$recipient" "$sender" status $'X-State: accepted\nIn-Reply-To: <work@'"${HOST}"$'>\nReferences: <work@'"${HOST}"$'>' >"$case_root/input"
    call send --no-ring --as "$recipient" <"$case_root/input"; expect 0 "$rc"
    remind; [[ ! -s "$case_root/reminder" ]] || fail 'accepted item still prompted'
}
test_reminder_unavailable() {
    local missing="$case_root/absent"
    rc=0
    SNO_REACH_ROOT="$missing" "$mbox" remind --as "$recipient" >"$case_root/reminder" 2>"$case_root/reminder.err" || rc=$?
    [[ "$rc" != 0 ]] || fail 'missing store silently accepted'
    [[ ! -s "$case_root/reminder" && ! -e "$missing" ]] || fail 'missing store created state or output'
    mkdir -p "$case_root/unreadable"
    chmod 000 "$case_root/unreadable"
    [[ ! -r "$case_root/unreadable" ]] || fail 'test user can read permission-denied store'
    rc=0
    SNO_REACH_ROOT="$case_root/unreadable" "$mbox" remind --as "$recipient" >"$case_root/reminder" 2>"$case_root/reminder.err" || rc=$?
    chmod 700 "$case_root/unreadable"
    [[ "$rc" != 0 && ! -s "$case_root/reminder" ]] || fail 'unreadable store silently accepted'
}

test_reminder_deadline() {
    held deadline-one
    held deadline-two
    sed 's/^X-Work:.*/X-Work: second-work/' "$STATE/$recipient/new/deadline-two" >"$case_root/second"
    mv "$case_root/second" "$STATE/$recipient/new/deadline-two"
    call inbox --as "$recipient"; expect 0 "$rc"
    snapshot >"$case_root/before"
    local begun ended elapsed
    begun="$(date +%s.%N)"
    rc=0
    BASH_ENV="$TEST_DIR/fixtures/remind-delay-env.sh" REACH_DEADLINE_TRACE="$case_root/delays" \
        timeout 8 "$mbox" remind --as "$recipient" >"$case_root/out" 2>"$case_root/err" || rc=$?
    ended="$(date +%s.%N)"
    elapsed="$(awk -v before="$begun" -v after="$ended" 'BEGIN {print after-before}')"
    [[ "$rc" != 0 && "$rc" != 124 ]] || fail "expected whole-command deadline, got $rc after $elapsed seconds"
    has "$case_root/err" 'whole-command deadline'
    expect 1 "$(grep -c '^validation ' "$case_root/delays")"
    expect 2 "$(grep -c '^state ' "$case_root/delays")"
    awk -v elapsed="$elapsed" 'BEGIN {exit !(elapsed>=4.5 && elapsed<5.2)}' || fail "whole command took $elapsed seconds"
    snapshot >"$case_root/after"; cmp "$case_root/before" "$case_root/after"
    printf 'measured reminder deadline: host=%s seconds=%s status=%s\n' "$HOST" "$elapsed" "$rc"
}

run_case() {
    local name="$1" group="$2" status
    [[ "${1:-}" != '' ]] || exit 64
    [[ "${mode}" == all || "$mode" == "$group" || "$mode" == "$name" ]] || return 0
    tests=$((tests + 1)); case_root="$test_root/$name"; mkdir -p -- "$case_root"
    set +e
    (set -e; trap 'tmux -L "$SERVER" kill-server 2>/dev/null || true' EXIT; setup; "test_$name")
    status=$?
    set -e
    if ((status == 0)); then printf 'ok %s - %s\n' "$tests" "$name"
    else printf 'not ok %s - %s\n' "$tests" "$name"; [[ ! -f "$case_root/err" ]] || cat "$case_root/err" >&2; failures=$((failures + 1)); fi
}
mode="${1:-all}"
run_case terminal_send reply
run_case reply reply
run_case closed_reply reply
run_case plain_reply reply
run_case nonwork_plain_reply reply
run_case untaken_terminal reply
run_case cancel state
run_case chain state
run_case projection_readonly state
run_case late_report state
run_case state_inventory state
run_case invalid_reports state
run_case item_count_order state
run_case reminder reminder
run_case reminder_unavailable reminder
run_case reminder_deadline reminder
((tests > 0)) || fail "unknown case group $mode"
printf '1..%s\n' "$tests"
((failures == 0))
