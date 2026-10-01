#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../apps/reach" && pwd)"
deliver="$repo_root/lib/reach-deliver"
export PATH="$repo_root/vendor/bin:$PATH"

test_root="$(mktemp -d "${TMPDIR:-/tmp}/reach-local-delivery.XXXXXX")"
trap 'if (( $? != 0 || failures != 0 )); then printf "test evidence: %s\n" "$test_root"; else rm -r -- "$test_root"; fi' EXIT

tests=0
failures=0

fail() {
    printf '    %s\n' "$*" >&2
    exit 1
}

assert_eq() {
    local expected="$1"
    local actual="$2"
    local label="$3"

    [[ "$actual" == "$expected" ]] ||
        fail "$label: expected [$expected], got [$actual]"
}

require_deliver() {
    [[ -x "$deliver" ]] ||
        fail "lib/reach-deliver is absent or not executable"
}

make_maildirs() {
    local root="$1"
    local recipient

    for recipient in agent.a@h agent.b@h agent.c@h; do
        mkdir -p "$root/$recipient/tmp" "$root/$recipient/new" \
            "$root/$recipient/cur"
    done
}

write_message() {
    local path="$1"

    printf '%s\n' \
        'From: Sender <agent.sender@h>' \
        'To: agent.a@h, agent.a@h' \
        'Cc: agent.b@h, agent.a@h' \
        'bCc: agent.c@h' \
        'BCC: agent.c@h' \
        'Delivered-To: stale.one@h' \
        'delivered-to: stale.two@h' \
        'Subject: [INFO] local delivery test' \
        'Date: Wed, 29 Jul 2026 04:00:00 +0000' \
        'Message-ID: <local-delivery-test@h>' \
        'X-Work: j-1209ca37' \
        'X-Type: info' \
        '' \
        'local delivery body' >"$path"
}

new_message() {
    local root="$1"
    local recipient="$2"

    find "$root/$recipient/new" -maxdepth 1 -type f -print -quit
}

tree_state() {
    local root="$1"

    (
        cd "$root"
        find . -mindepth 1 -printf '%y %P\n' | sort
        find . -type f -print0 |
            sort -z |
            while IFS= read -r -d '' path; do
                printf 'sha256 %s %s\n' \
                    "${path#./}" "$(sha256sum "$path" | cut -d ' ' -f 1)"
            done
    )
}

sentinel_state() {
    local root="$1"

    (
        cd "$root"
        find . -type f \
            \( -name 'sentinel-new' -o -name 'sentinel-cur:2,S' \) \
            -print0 |
            sort -z |
            while IFS= read -r -d '' path; do
                printf '%s %s\n' \
                    "${path#./}" "$(sha256sum "$path" | cut -d ' ' -f 1)"
            done
    )
}

run_case() {
    local name="$1"
    shift
    tests=$((tests + 1))

    if ("$@"); then
        printf 'ok %d - %s\n' "$tests" "$name"
    else
        printf 'not ok %d - %s\n' "$tests" "$name"
        failures=$((failures + 1))
    fi
}

test_exact_fanout_and_identity() {
    require_deliver

    local root="$test_root/fanout"
    local message="$root/message"
    local recipient file
    local -a files=()
    local -a inodes=()

    mkdir -p "$root"
    make_maildirs "$root/mail"
    write_message "$message"
    SNO_REACH_ROOT="$root/mail" "$deliver" <"$message" ||
        fail "delivery exited non-zero"

    mapfile -t files < <(
        find "$root/mail" -path '*/new/*' -type f -print | sort
    )
    assert_eq 3 "${#files[@]}" "total delivered copies"

    for recipient in agent.a@h agent.b@h agent.c@h; do
        file="$(new_message "$root/mail" "$recipient")"
        [[ -n "$file" ]] || fail "missing copy for $recipient"
        assert_eq 1 \
            "$(find "$root/mail/$recipient/new" -maxdepth 1 -type f | wc -l)" \
            "copy count for $recipient"
        assert_eq '<local-delivery-test@h>' \
            "$(mhdr -h message-id "$file")" \
            "Message-ID for $recipient"
        inodes+=("$(stat -c '%i' "$file")")
    done

    assert_eq 3 \
        "$(printf '%s\n' "${inodes[@]}" | sort -u | wc -l)" \
        "distinct recipient inodes"
}

test_private_headers_and_body() {
    require_deliver

    local root="$test_root/headers"
    local message="$root/message"
    local recipient file

    mkdir -p "$root"
    make_maildirs "$root/mail"
    write_message "$message"
    SNO_REACH_ROOT="$root/mail" "$deliver" <"$message" ||
        fail "delivery exited non-zero"

    for recipient in agent.a@h agent.b@h agent.c@h; do
        file="$(new_message "$root/mail" "$recipient")"
        assert_eq 0 \
            "$(grep -Eic '^bcc:' "$file" || true)" \
            "Bcc header count for $recipient"
        assert_eq 1 \
            "$(grep -Eic '^delivered-to:' "$file" || true)" \
            "Delivered-To header count for $recipient"
        assert_eq "$recipient" \
            "$(mhdr -h delivered-to "$file")" \
            "Delivered-To value for $recipient"
        assert_eq '<local-delivery-test@h>' \
            "$(mhdr -h message-id "$file")" \
            "Message-ID for $recipient"
        assert_eq 'local delivery body' \
            "$(sed '1,/^$/d' "$file")" \
            "body for $recipient"
    done
}

test_independent_reply_state() {
    require_deliver

    local root="$test_root/state"
    local message="$root/message"
    local a_new a_cur b_new c_new b_name c_name b_hash c_hash

    mkdir -p "$root"
    make_maildirs "$root/mail"
    write_message "$message"
    SNO_REACH_ROOT="$root/mail" "$deliver" <"$message" ||
        fail "delivery exited non-zero"

    a_new="$(new_message "$root/mail" agent.a@h)"
    b_new="$(new_message "$root/mail" agent.b@h)"
    c_new="$(new_message "$root/mail" agent.c@h)"
    b_name="$(basename "$b_new")"
    c_name="$(basename "$c_new")"
    b_hash="$(sha256sum "$b_new" | cut -d ' ' -f 1)"
    c_hash="$(sha256sum "$c_new" | cut -d ' ' -f 1)"

    a_cur="$root/mail/agent.a@h/cur/$(basename "$a_new"):2,"
    mv -- "$a_new" "$a_cur"
    mflag -R "$a_cur" >/dev/null || fail "mflag failed"

    [[ -f "${a_cur}R" ]] || fail "To copy is not marked replied"
    assert_eq "$b_name" \
        "$(basename "$(new_message "$root/mail" agent.b@h)")" \
        "Cc copy filename"
    assert_eq "$c_name" \
        "$(basename "$(new_message "$root/mail" agent.c@h)")" \
        "Bcc copy filename"
    assert_eq "$b_hash" \
        "$(sha256sum "$root/mail/agent.b@h/new/$b_name" | cut -d ' ' -f 1)" \
        "Cc copy hash"
    assert_eq "$c_hash" \
        "$(sha256sum "$root/mail/agent.c@h/new/$c_name" | cut -d ' ' -f 1)" \
        "Bcc copy hash"
    assert_eq 0 \
        "$(find "$root/mail/agent.b@h" "$root/mail/agent.c@h" \
            -type f -name '*:2,*R*' | wc -l)" \
        "reply flags outside the To mailbox"
}

test_to_action_and_cc_information() {
    require_deliver

    local root="$test_root/action"
    local message="$root/message"
    local actionable informational

    mkdir -p "$root"
    make_maildirs "$root/mail"
    write_message "$message"
    SNO_REACH_ROOT="$root/mail" "$deliver" <"$message" ||
        fail "delivery exited non-zero"

    # mpick expands MBOX_ADDR from its own expression language.
    # shellcheck disable=SC2016
    actionable="$(
        mlist "$root/mail/agent.a@h" |
            MBOX_ADDR=agent.a@h mpick -t \
                'to.addr == $MBOX_ADDR && !replied' |
            wc -l
    )"
    # shellcheck disable=SC2016
    informational="$(
        mlist "$root/mail/agent.b@h" |
            MBOX_ADDR=agent.b@h mpick -t \
                'to.addr == $MBOX_ADDR && !replied' |
            wc -l
    )"

    assert_eq 1 "$actionable" "To action query"
    assert_eq 0 "$informational" "Cc action query"
    [[ -n "$(new_message "$root/mail" agent.a@h)" ]] ||
        fail "To copy is unreadable"
    [[ -n "$(new_message "$root/mail" agent.b@h)" ]] ||
        fail "Cc copy is unreadable"
}

test_delivery_only_authority_and_failures() {
    require_deliver

    local root="$test_root/authority"
    local message="$root/message"
    local recipient before after
    local failure_root="$test_root/hardlink-failure"
    local invalid_root="$test_root/invalid-address"
    local invalid_message="$invalid_root/message"
    local unexpected

    mkdir -p "$root"
    make_maildirs "$root/mail"
    write_message "$message"
    for recipient in agent.a@h agent.b@h agent.c@h; do
        printf 'new sentinel for %s\n' "$recipient" \
            >"$root/mail/$recipient/new/sentinel-new"
        printf 'cur sentinel for %s\n' "$recipient" \
            >"$root/mail/$recipient/cur/sentinel-cur:2,S"
    done

    before="$(tree_state "$root/mail")"
    if SNO_REACH_ROOT="$root/mail" "$deliver" \
        --mark-replied "$root/mail/agent.b@h/cur/sentinel-cur:2,S" \
        <"$message" >/dev/null 2>&1; then
        fail "state-targeting arguments were accepted"
    fi
    after="$(tree_state "$root/mail")"
    assert_eq "$before" "$after" "argument rejection mutation"

    before="$(sentinel_state "$root/mail")"
    SNO_REACH_ROOT="$root/mail" "$deliver" <"$message" ||
        fail "normal delivery exited non-zero"
    after="$(sentinel_state "$root/mail")"
    assert_eq "$before" "$after" "pre-existing Maildir state"

    mkdir -p "$failure_root"
    make_maildirs "$failure_root/mail"
    write_message "$failure_root/message"
    if [[ "$(uname -s)" == Linux ]]; then
        if strace -f -e trace=linkat -e inject=linkat:error=EIO:when=1 -o "$failure_root/link.trace" \
            env SNO_REACH_ROOT="$failure_root/mail" "$deliver" \
            <"$failure_root/message" >"$failure_root/out" 2>"$failure_root/err"; then
            fail "delivery succeeded after actual hard-link syscall failure"
        fi
        grep -Eq 'linkat\(.*= -1 EIO .*INJECTED' "$failure_root/link.trace" || fail 'hard-link failure boundary was not reached'
    else
        chmod 500 "$failure_root/mail/"*/new
        if SNO_REACH_ROOT="$failure_root/mail" "$deliver" \
            <"$failure_root/message" >"$failure_root/out" 2>"$failure_root/err"; then
            fail 'delivery succeeded with non-writable publication directories'
        fi
        grep -E 'ln: .*new/.*Permission denied' "$failure_root/err" || fail 'actual hard-link permission refusal was not reached'
        assert_eq '' "$(find "$failure_root/mail" -path '*/new/*' -type f -print)" 'no card published after hard-link refusal'
        chmod 700 "$failure_root/mail/"*/new
    fi
    unexpected="$(
        find "$failure_root/mail" -type f ! -path '*/new/*' -print
    )"
    assert_eq '' "$unexpected" "fallback files after hard-link failure"

    mkdir -p "$invalid_root"
    make_maildirs "$invalid_root/mail"
    printf 'sentinel\n' >"$invalid_root/mail/agent.a@h/new/keep"
    printf '%s\n' \
        'From: Sender <agent.sender@h>' \
        'To: agent.a@h' \
        'Cc: bad/seat@h' \
        'Message-ID: <invalid-address@h>' \
        '' \
        'invalid address body' >"$invalid_message"
    before="$(tree_state "$invalid_root/mail")"
    if SNO_REACH_ROOT="$invalid_root/mail" "$deliver" \
        <"$invalid_message" >/dev/null 2>&1; then
        fail "parsed invalid address was accepted"
    fi
    after="$(tree_state "$invalid_root/mail")"
    assert_eq "$before" "$after" "invalid-address mutation"
}

printf 'TAP version 13\n'
run_case 'exact fan-out and stable Message-ID' test_exact_fanout_and_identity
run_case 'Bcc privacy, Delivered-To, and body preservation' \
    test_private_headers_and_body
run_case 'independent per-recipient reply state' test_independent_reply_state
run_case 'To action and Cc information behavior' \
    test_to_action_and_cc_information
run_case 'delivery-only authority and loud failure' \
    test_delivery_only_authority_and_failures
printf '1..%d\n' "$tests"

((failures == 0)) || exit 1
