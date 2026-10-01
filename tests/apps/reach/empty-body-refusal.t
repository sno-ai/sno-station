#!/usr/bin/env bash
# A card whose body is blank is delivered, counted, and unanswerable: the
# recipient sees a subject and nothing to act on, and the sender has no signal
# that anything went wrong. `mbox reply` in particular reads its body from stdin,
# so a caller that passes the text as a flag sends a well-formed empty card and
# is told nothing. Both doors are asserted here, each with its accepted
# counterpart, so the gate cannot quietly widen into rejecting ordinary cards.
set -Eeuo pipefail
export HOST="$(hostname)"

# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
reach_command=reach
test_root="$WORK/cases"
mkdir -p "$test_root"
tests=0
failures=0

readonly RECIPIENT="$RECEIVER"
readonly EMPTY_SEND_ERROR='message body is empty'
readonly EMPTY_REPLY_ERROR='reply body is empty'

fail() {
    printf '    %s\n' "$*" >&2
    return 1
}

run_case() {
    local name="$1"
    local function_name="$2"

    tests=$((tests + 1))
    if "$function_name"; then
        printf 'ok %d - %s\n' "$tests" "$name"
    else
        printf 'not ok %d - %s\n' "$tests" "$name"
        failures=$((failures + 1))
    fi
}


# A linted card. `body` is written verbatim after the separator, so the caller
# controls exactly whether there is anything below it.
card() {
    local id="$1" body="$2" delivered_to="${3:-}"

    printf 'From: Fixture <%s>\n' "$SENDER"
    printf 'To: Fixture <%s>\n' "$RECIPIENT"
    printf 'Subject: [DECISION] empty body fixture\n'
    printf 'Date: Thu, 27 Aug 2026 00:00:00 +0000\n'
    printf 'Message-ID: <%s@'"${HOST}"'>\n' "$id"
    printf 'X-Work: j-empty-body\n'
    printf 'X-Type: decision\n'
    [[ -z "$delivered_to" ]] ||
        printf 'Delivered-To: %s\n' "$delivered_to"
    printf '\n%s' "$body"
}

# Every case uses public initialized and registered seats before testing body refusal.

setup() {
    STATE="$1"
    initialize "$SENDER" fixture
    initialize "$RECIPIENT" fixture
    register "$SENDER"
    register "$RECIPIENT"
}

send_as_sender() {
    STATE="$1" reach send --as "$SENDER" --no-ring
}

outbox_entry_count() {
    local mail="$1"

    find "$mail/$SENDER/outbox" -mindepth 1 -maxdepth 1 -type d 2>/dev/null |
        wc -l | tr -d ' '
}

test_send_refuses_an_empty_body() {
    local mail="$test_root/send-empty/mail"
    local rc

    setup "$mail"
    set +e
    card empty-send '' | send_as_sender "$mail" \
        >"$test_root/send-empty.out" 2>"$test_root/send-empty.err"
    rc=$?
    set -e
    [[ "$rc" == 65 ]] ||
        { fail "empty-body send returned $rc instead of 65"; return; }
    grep -Fq "$EMPTY_SEND_ERROR" "$test_root/send-empty.err" ||
        { fail "empty-body send did not name the empty body: $(tr '\n' ' ' <"$test_root/send-empty.err")"; return; }
    [[ "$(outbox_entry_count "$mail")" == 0 ]] ||
        { fail 'refused empty-body send still staged an outbox entry'; return; }
    [[ -z "$(find "$mail/$RECIPIENT/new" "$mail/$RECIPIENT/cur" -type f)" ]] ||
        { fail 'refused empty-body send still reached the recipient'; return; }
}

test_send_refuses_a_whitespace_only_body() {
    local mail="$test_root/send-blank/mail"
    local rc

    setup "$mail"
    set +e
    card blank-send $'   \n\t\n' | send_as_sender "$mail" \
        >"$test_root/send-blank.out" 2>"$test_root/send-blank.err"
    rc=$?
    set -e
    [[ "$rc" == 65 ]] ||
        { fail "whitespace-only send returned $rc instead of 65"; return; }
    grep -Fq "$EMPTY_SEND_ERROR" "$test_root/send-blank.err" ||
        { fail 'whitespace-only send was not reported as an empty body'; return; }
}

test_send_with_a_body_is_delivered() {
    local mail="$test_root/send-full/mail"
    local rc

    setup "$mail"
    set +e
    card full-send $'a real card body\n' | send_as_sender "$mail" \
        >"$test_root/send-full.out" 2>"$test_root/send-full.err"
    rc=$?
    set -e
    [[ "$rc" == 0 ]] ||
        { fail "send with a body returned $rc: $(tr '\n' ' ' <"$test_root/send-full.err")"; return; }
    [[ "$(grep -rl 'full-send@'"${HOST}"'' "$mail/$RECIPIENT/new" 2>/dev/null | wc -l)" == 1 ]] ||
        { fail 'send with a body did not reach the recipient'; return; }
    ! grep -Fq "$EMPTY_SEND_ERROR" "$test_root/send-full.err" ||
        { fail 'a delivered card was also reported as empty'; return; }
}

deliver_source() {
    local id="$2" path
    card "$id" $'please answer this\n' >"$test_root/source-input"
    reach send --as "$SENDER" --no-ring <"$test_root/source-input" >/dev/null
    path="$(message_path "$RECIPIENT" "$id@${HOST}")"
    printf 'accepted\n' | reach reply --as "$RECIPIENT" --card "$path" --state accepted >/dev/null
    printf '%s\n' "$path"
}

test_reply_refuses_an_empty_body() {
    local mail="$test_root/reply-empty/mail"
    local source rc

    setup "$mail"
    source="$(deliver_source "$mail" reply-empty-source)"
    set +e
    SNO_REACH_ROOT="$mail" \
        "$reach_command" reply --as "$RECIPIENT" --card "$source" \
        </dev/null >"$test_root/reply-empty.out" 2>"$test_root/reply-empty.err"
    rc=$?
    set -e
    [[ "$rc" == 65 ]] ||
        { fail "empty-body reply returned $rc instead of 65"; return; }
    grep -Fq "$EMPTY_REPLY_ERROR" "$test_root/reply-empty.err" ||
        { fail "empty-body reply did not name the empty body: $(tr '\n' ' ' <"$test_root/reply-empty.err")"; return; }
    grep -Fq 'stdin' "$test_root/reply-empty.err" ||
        { fail 'empty-body reply did not name stdin as the body source'; return; }
    ! grep -Rl '^X-Type: answer$' "$mail/$SENDER/new" "$mail/$SENDER/cur" >/dev/null ||
        { fail 'refused empty-body reply still delivered an answer'; return; }
}

test_reply_with_a_body_is_delivered() {
    local mail="$test_root/reply-full/mail"
    local source rc

    setup "$mail"
    source="$(deliver_source "$mail" reply-full-source)"
    set +e
    printf 'RESULT=42\n' |
        SNO_REACH_ROOT="$mail" \
        "$reach_command" reply --as "$RECIPIENT" --card "$source" \
        >"$test_root/reply-full.out" 2>"$test_root/reply-full.err"
    rc=$?
    set -e
    [[ "$rc" == 0 ]] ||
        { fail "reply with a body returned $rc: $(tr '\n' ' ' <"$test_root/reply-full.err")"; return; }
    grep -Rq 'RESULT=42' "$mail/$SENDER/new" ||
        { fail 'reply with a body did not reach the original sender'; return; }
}

printf 'TAP version 13\n'
run_case 'send refuses a card with no body' test_send_refuses_an_empty_body
run_case 'send refuses a card whose body is only whitespace' \
    test_send_refuses_a_whitespace_only_body
run_case 'send with a body is delivered, not refused as empty' \
    test_send_with_a_body_is_delivered
run_case 'reply refuses an empty body and names stdin' \
    test_reply_refuses_an_empty_body
run_case 'reply with a body still reaches the original sender' \
    test_reply_with_a_body_is_delivered
printf '1..%d\n' "$tests"

((failures == 0)) || exit 1
