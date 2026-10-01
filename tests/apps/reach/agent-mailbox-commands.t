#!/usr/bin/env bash
set -Eeuo pipefail
export HOST="$(hostname)"

# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"
repo_root="$APP"
mbox="$REACH"
lint="$APP/lib/reach-lint"
deliver="$APP/lib/reach-deliver"
export PATH="$APP/vendor/bin:$PATH"
export HOME="$TEST_HOME"
test_root="$WORK/cases"
mkdir -p "$test_root"
terminate_test_root_processes() {
    local root="$1"
    local pid cmdline pgid target current_pgid
    local -a targets=()
    local _

    current_pgid="$(ps -o pgid= -p "$$" | tr -d ' ')"
    while read -r pid; do
        [[ "$pid" != "$$" && "$pid" != "$PPID" ]] || continue
        cmdline="$(test_process_command "$pid" 2>/dev/null || true)"
        [[ "$cmdline" == *"$root/"* ]] || continue
        target="$pid"
        pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
        if [[ "$pgid" == "$pid" && "$pgid" != "$current_pgid" ]]; then target="-$pgid"; fi
        targets+=("$target")
        kill -TERM -- "$target" 2>/dev/null || true
    done < <(test_process_ids)

    for _ in {1..30}; do
        local alive=0
        for target in "${targets[@]}"; do
            if kill -0 -- "$target" 2>/dev/null; then
                alive=1
            fi
        done
        if ((alive == 0)); then
            return 0
        fi
        sleep 0.1
    done

    for target in "${targets[@]}"; do
        kill -KILL -- "$target" 2>/dev/null || true
    done
    sleep 0.1
    for target in "${targets[@]}"; do
        kill -0 -- "$target" 2>/dev/null && return 1
    done
    return 0
}

cleanup_test_root() {
    terminate_test_root_processes "$WORK" || true
    tmux -L "$SERVER" kill-server 2>/dev/null || true
    if [[ "${REACH_KEEP_TEST_ROOT:-0}" == 1 || "${failures:-0}" != 0 ]]; then
        printf 'test evidence: %s\n' "$WORK"
    else
        rm -rf -- "$WORK"
    fi
}
trap cleanup_test_root EXIT

tests=0
failures=0
LAST_STATUS=0


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

assert_ne() {
    local unexpected="$1"
    local actual="$2"
    local label="$3"

    [[ "$actual" != "$unexpected" ]] ||
        fail "$label: unexpectedly got [$actual]"
}

assert_nonzero() {
    local status="$1"
    local label="$2"

    ((status != 0)) || fail "$label: expected non-zero status"
}

assert_contains() {
    local haystack="$1"
    local needle="$2"
    local label="$3"

    [[ "$haystack" == *"$needle"* ]] ||
        fail "$label: missing [$needle]"
}

assert_not_contains() {
    local haystack="$1"
    local needle="$2"
    local label="$3"

    [[ "$haystack" != *"$needle"* ]] ||
        fail "$label: unexpectedly contained [$needle]"
}

assert_file() {
    local path="$1"
    local label="$2"

    [[ -f "$path" ]] || fail "$label: missing file [$path]"
}

assert_no_r_flag() {
    local path="$1"
    local label="$2"

    [[ "$(basename "$path")" != *':2,'*R* ]] ||
        fail "$label: unexpected Maildir R flag on [$path]"
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

require_phase2_command() {
    local path="$1"

    [[ -x "$path" ]] ||
        fail "missing Phase 2 public command: $path"
}

require_real_dependency() {
    local tool="$1"

    command -v "$tool" >/dev/null 2>&1 ||
        fail "required pinned dependency is unavailable: $tool"
}

make_maildirs() {
    STATE="$1"
    shift
    local address
    for address in "$@"; do
        initialize "$address" "${init_display_name:-fixture}" >/dev/null
        register "$address" >/dev/null
    done
    export TMUX="$TEST_TMUX" TMUX_PANE="$TEST_PANE"
}

write_authority_card() {
    local root="$1" address="$2"
    SNO_REACH_ROOT="$root" "$mbox" init --as "$address" --name "${init_display_name:-fixture}" >/dev/null
}

write_message() {
    local path="$1"
    local from_name="$2"
    local from_address="$3"
    local to_value="$4"
    local cc_value="$5"
    local bcc_value="$6"
    local subject="$7"
    local date_value="$8"
    local message_id="$9"
    local journey="${10}"
    local type="${11}"
    local body="${12}"
    shift 12
    local header

    {
        printf 'From: %s <%s>\n' "$from_name" "$from_address"
        [[ -z "$to_value" ]] || printf 'To: %s\n' "$to_value"
        [[ -z "$cc_value" ]] || printf 'Cc: %s\n' "$cc_value"
        [[ -z "$bcc_value" ]] || printf 'Bcc: %s\n' "$bcc_value"
        printf 'Subject: %s\n' "$subject"
        printf 'Date: %s\n' "$date_value"
        printf 'Message-ID: %s\n' "$message_id"
        printf 'X-Work: %s\n' "$journey"
        printf 'X-Type: %s\n' "$type"
        for header in "$@"; do
            printf '%s\n' "$header"
        done
        printf '\n%s\n' "$body"
    } >"$path"
}

accept_reply_work() {
    local mail="$1" source="$2" holder sender id accepted=''
    holder="$(mhdr -h delivered-to "$source")"
    sender="$(maddr -a -h from: "$source")"
    id="$(mhdr -h message-id "$source")"
    printf 'Accepted.\n' >"$test_root/acceptance-body"
    run_command_with_input "$test_root/acceptance-body" "$test_root/accept.out" "$test_root/accept.err" \
        env SNO_REACH_ROOT="$mail" "$mbox" reply --as "$holder" --card "$source" --state accepted
    assert_eq 0 "$LAST_STATUS" 'reply fixture acceptance delivery'
    while IFS= read -r -d '' candidate; do
        if [[ "$(mhdr -h x-state "$candidate")" == accepted && "$(mhdr -h in-reply-to "$candidate")" == "$id" ]]; then
            accepted="$candidate"; break
        fi
    done < <(find "$mail/$sender/new" -type f -print0)
    [[ -n "$accepted" ]] || fail 'acceptance fixture report missing'
    run_command "$test_root/accept-read.out" "$test_root/accept-read.err" \
        env SNO_REACH_ROOT="$mail" "$mbox" dismiss --as "$sender" --card "$accepted" --reason 'Acceptance read.'
    assert_eq 0 "$LAST_STATUS" 'reply fixture acceptance read'
}

tree_state() {
    local root="$1"

    (
        cd "$root"
        find . -mindepth 1 -printf '%y %P\n' | sort
        find . -type l -printf 'link %P -> %l\n' | sort
        find . -type f -print0 |
            sort -z |
            while IFS= read -r -d '' path; do
                printf 'sha256 %s %s\n' \
                    "${path#./}" "$(sha256sum "$path" | cut -d ' ' -f 1)"
            done
    )
}

maildir_message_state() {
    local root="$1"

    (
        cd "$root"
        find . -type f \( -path '*/new/*' -o -path '*/cur/*' -o \
            -path '*/outbox/*' \) -printf 'f %P\n' | sort
        find . -type f \( -path '*/new/*' -o -path '*/cur/*' -o \
            -path '*/outbox/*' \) -print0 | sort -z |
            while IFS= read -r -d '' path; do
                printf 'sha256 %s %s\n' "${path#./}" \
                    "$(sha256sum "$path" | cut -d ' ' -f 1)"
            done
    )
}

new_message() {
    local root="$1"
    local address="$2"

    find "$root/$address/new" -maxdepth 1 -type f -print -quit
}

message_by_id() {
    local root="$1"
    local address="$2"
    local message_id="$3"
    local path

    while IFS= read -r path; do
        if [[ "$(mhdr -h message-id "$path")" == "$message_id" ]]; then
            printf '%s\n' "$path"
            return 0
        fi
    done < <(find "$root/$address/new" "$root/$address/cur" \
        -maxdepth 1 -type f -print | sort)
    return 1
}

line_count() {
    local path="$1"

    if [[ ! -s "$path" ]]; then
        printf '0\n'
        return
    fi
    wc -l <"$path" | tr -d ' '
}

exact_line_count() {
    local path="$1"
    local expected_line="$2"

    grep -Fxc -- "$expected_line" "$path" 2>/dev/null || true
}

inbox_path_count() {
    cut -f1 "$1" | grep -Fxc -- "$2" || true
}

held_answer_parent() {
    local root="$1" id="$2" asker="$3" answerer="$4" work="$5" cc="${6:-}"
    write_message "$root/$answerer/new/${id#<}" Asker "$asker" "$answerer" "$cc" '' \
        '[QUESTION] Original answer request' 'Wed, 29 Jul 2026 05:00:00 +0000' \
        "$id" "$work" question 'Please provide the requested answer.' "Delivered-To: $answerer"
}

run_command() {
    local stdout_path="$1"
    local stderr_path="$2"
    shift 2

    set +e
    "$@" >"$stdout_path" 2>"$stderr_path"
    LAST_STATUS=$?
    set -e
}

run_command_with_input() {
    local input_path="$1"
    local stdout_path="$2"
    local stderr_path="$3"
    shift 3

    set +e
    "$@" <"$input_path" >"$stdout_path" 2>"$stderr_path"
    LAST_STATUS=$?
    set -e
}

wait_for_any_output() {
    local pid="$3"
    # Reach wait is quiet until it selects a path. Preserve the live-wait race
    # check without requiring the retired wrapper's progress output.
    sleep 0.2
    kill -0 "$pid" 2>/dev/null || fail 'wait exited before fixture delivery'
}

wait_for_file() {
    local path="$1"
    local attempts="${2:-100}"
    local attempt

    for ((attempt = 0; attempt < attempts; attempt += 1)); do
        [[ -s "$path" ]] && return 0
        if ((attempt > 0 && attempt % 100 == 0)); then
            printf '    waiting for %s: %ss elapsed\n' \
                "$(basename "$path")" "$((attempt / 10))" >&2
        fi
        sleep 0.1
    done
    fail "timed out waiting for file: $path"
}

close_section7_terminal() {
    local root="$1"
    local handle="$2"
    local close_output
    local close_status

    set +e
    close_output="$(orca terminal close --terminal "$handle" --tab --json 2>&1)"
    close_status=$?
    set -e
    if ((close_status != 0)) && [[ "$close_output" != *tab_not_found* ]]; then
        printf '    Section 7 cleanup warning: terminal close failed: %s\n' \
            "$handle" >&2
    fi
    terminate_test_root_processes "$root" ||
        fail "could not stop Section 7 actor processes under: $root"
    rm -f -- "$root/terminal-handle"
}

wait_for_exit_within() {
    local pid="$1"
    local label="$2"
    local _

    for _ in {1..30}; do
        kill -0 "$pid" 2>/dev/null || return 0
        sleep 0.1
    done
    kill "$pid" 2>/dev/null || true
    if wait "$pid"; then
        :
    fi
    fail "$label did not exit within three seconds"
}

insert_header() {
    local source="$1"
    local destination="$2"
    local header="$3"

    awk -v header="$header" '
        !inserted && $0 == "" { print header; inserted = 1 }
        { print }
    ' "$source" >"$destination"
}

remove_header() {
    local source="$1"
    local destination="$2"
    local name="$3"

    awk -v name="$name" '
        BEGIN { prefix = tolower(name) ":" }
        index(tolower($0), prefix) == 1 { next }
        { print }
    ' "$source" >"$destination"
}

remove_recipient_headers() {
    local source="$1"
    local destination="$2"

    awk '
        /^(To|Cc|Bcc):/ { next }
        { print }
    ' "$source" >"$destination"
}

replace_header() {
    local source="$1"
    local destination="$2"
    local name="$3"
    local value="$4"

    awk -v name="$name" -v value="$value" '
        BEGIN { prefix = tolower(name) ":" }
        index(tolower($0), prefix) == 1 {
            print name ":" (value == "" ? "" : " " value)
            next
        }
        { print }
    ' "$source" >"$destination"
}

duplicate_header() {
    local source="$1"
    local destination="$2"
    local name="$3"

    awk -v name="$name" '
        BEGIN { prefix = tolower(name) ":" }
        {
            print
            if (!duplicated && index(tolower($0), prefix) == 1) {
                print
                duplicated = 1
            }
        }
    ' "$source" >"$destination"
}

fold_header() {
    local source="$1"
    local destination="$2"
    local name="$3"

    awk -v name="$name" '
        BEGIN { prefix = tolower(name) ":" }
        index(tolower($0), prefix) == 1 {
            sub(/^[^:]*:[[:space:]]*/, "")
            print name ":"
            print " " $0
            next
        }
        { print }
    ' "$source" >"$destination"
}

add_header_continuation() {
    local source="$1"
    local destination="$2"
    local name="$3"
    local continuation="$4"

    awk -v name="$name" -v continuation="$continuation" '
        BEGIN { prefix = tolower(name) ":" }
        {
            print
            if (!added && index(tolower($0), prefix) == 1) {
                print " " continuation
                added = 1
            }
        }
    ' "$source" >"$destination"
}

remove_separator() {
    local source="$1"
    local destination="$2"

    awk '
        !removed && $0 == "" { removed = 1; next }
        { print }
    ' "$source" >"$destination"
}

assert_invalid_message() {
    local root="$1"
    local message="$2"
    local label="$3"
    local output_dir="$4"
    local before after

    before="$(tree_state "$root")"
    run_command "$output_dir/lint.out" "$output_dir/lint.err" \
        "$lint" "$message"
    assert_nonzero "$LAST_STATUS" "$label lint"

    run_command_with_input "$message" "$output_dir/send.out" \
        "$output_dir/send.err" env SNO_REACH_ROOT="$root" \
        "$mbox" send --no-ring --as agent.sender@"${HOST}"
    assert_nonzero "$LAST_STATUS" "$label send"
    after="$(tree_state "$root")"
    assert_eq "$before" "$after" "$label zero placement"
}

test_real_dependencies_and_delivery_headers() {
    local root="$test_root/preflight"
    local message="$root/message.eml"
    local address delivered

    for tool in maddr mhdr mlist mpick mscan msort mthread; do
        require_real_dependency "$tool"
    done
    [[ -x "$deliver" ]] ||
        fail "read-only Phase 1 delivery command is unavailable"

    mkdir -p "$root"
    make_maildirs "$root/mail" agent.a@"${HOST}" agent.b@"${HOST}" agent.third@"${HOST}"
    write_message "$message" Sender agent.sender@"${HOST}" \
        agent.a@"${HOST}" agent.b@"${HOST}" agent.third@"${HOST}" \
        '[QUESTION] Phase 2 delivery-header prerequisite' \
        'Wed, 29 Jul 2026 05:20:00 +0000' \
        '<phase2-delivery-header@'"${HOST}"'>' j-phase2 question \
        'delivery header prerequisite' \
        'Delivered-To: stale.recipient@'"${HOST}"''

    SNO_REACH_ROOT="$root/mail" "$deliver" <"$message" ||
        fail "real Phase 1 delivery failed during preflight"

    for address in agent.a@${HOST} agent.b@${HOST} agent.third@${HOST}; do
        assert_eq 1 \
            "$(find "$root/mail/$address/new" -maxdepth 1 -type f | wc -l)" \
            "$address copy count"
        delivered="$(new_message "$root/mail" "$address")"
        assert_eq 1 \
            "$(grep -Eic '^Delivered-To:' "$delivered" || true)" \
            "$address Delivered-To count"
        assert_eq "$address" "$(mhdr -h delivered-to "$delivered")" \
            "$address Delivered-To value"
        assert_eq 0 "$(grep -Eic '^Bcc:' "$delivered" || true)" \
            "$address Bcc privacy"
    done
}


test_lint_rejects_ambiguous_contract_values() {
    require_phase2_command "$lint"

    local root="$test_root/lint-review-regression"
    local canonical="$root/canonical.eml"
    local multiple_from="$root/multiple-from.eml"
    local multiple_message_ids="$root/multiple-message-ids.eml"
    local unknown_agent_header="$root/unknown-agent-header.eml"
    local tag_suffix="$root/tag-suffix.eml"
    local questionable_tag="$root/questionable-tag.eml"
    local folded_subject="$root/folded-subject.eml"
    local canonical_hash from_status message_id_status unknown_header_status
    local tag_suffix_status questionable_tag_status folded_subject_status
    local regression_failures=0

    mkdir -p "$root"
    write_message "$canonical" Sender agent.sender@"${HOST}" agent.a@"${HOST}" '' '' \
        '[QUESTION] Phase 2 lint review control' \
        'Wed, 29 Jul 2026 06:40:00 +0000' \
        '<phase2-lint-review-control@'"${HOST}"'>' j-phase2-lint-review question \
        'Canonical lint review control body.'
    canonical_hash="$(sha256sum "$canonical" | cut -d ' ' -f 1)"
    run_command "$root/canonical.out" "$root/canonical.err" \
        "$lint" "$canonical"
    assert_eq 0 "$LAST_STATUS" "lint review canonical control"

    replace_header "$canonical" "$multiple_from" From \
        'Sender <agent.sender@'"${HOST}"'>, Other <agent.a@'"${HOST}"'>'
    assert_eq 1 "$(grep -c '^From:' "$multiple_from")" \
        "multiple-address From field count"
    assert_eq 2 \
        "$(maddr -a -h from: "$multiple_from" | wc -l)" \
        "multiple-address From parsed address count"
    run_command "$root/multiple-from.out" "$root/multiple-from.err" \
        "$lint" "$multiple_from"
    from_status="$LAST_STATUS"

    replace_header "$canonical" "$multiple_message_ids" Message-ID \
        $'<phase2-lint-review-one@'"${HOST}"$'>\t<phase2-lint-review-two@'"${HOST}"$'>'
    assert_eq 1 "$(grep -c '^Message-ID:' "$multiple_message_ids")" \
        "tab-separated Message-ID field count"
    assert_eq \
        $'Message-ID: <phase2-lint-review-one@'"${HOST}"$'>\t<phase2-lint-review-two@'"${HOST}"$'>' \
        "$(grep '^Message-ID:' "$multiple_message_ids")" \
        "literal horizontal-tab Message-ID fixture"
    run_command "$root/multiple-message-ids.out" \
        "$root/multiple-message-ids.err" "$lint" "$multiple_message_ids"
    message_id_status="$LAST_STATUS"

    insert_header "$canonical" "$unknown_agent_header" \
        'X-Unrecognized-Agent: unexpected'
    assert_eq 1 \
        "$(grep -c '^X-Unrecognized-Agent:' "$unknown_agent_header")" \
        "unknown agent X-header field count"
    run_command "$root/unknown-agent-header.out" \
        "$root/unknown-agent-header.err" "$lint" "$unknown_agent_header"
    unknown_header_status="$LAST_STATUS"

    replace_header "$canonical" "$tag_suffix" Subject \
        '[QUESTION]ABLE Phase 2 inexact tag suffix'
    assert_eq '[QUESTION]ABLE Phase 2 inexact tag suffix' \
        "$(mhdr -h subject "$tag_suffix")" \
        "inexact subject tag suffix fixture"
    run_command "$root/tag-suffix.out" "$root/tag-suffix.err" \
        "$lint" "$tag_suffix"
    tag_suffix_status="$LAST_STATUS"

    replace_header "$canonical" "$questionable_tag" Subject \
        '[QUESTIONABLE] Phase 2 green rejection control'
    run_command "$root/questionable-tag.out" "$root/questionable-tag.err" \
        "$lint" "$questionable_tag"
    questionable_tag_status="$LAST_STATUS"

    add_header_continuation "$canonical" "$folded_subject" Subject \
        'continued subject text'
    assert_eq 1 "$(grep -c '^Subject:' "$folded_subject")" \
        "folded Subject field count"
    assert_eq 1 "$(grep -c '^ continued subject text$' "$folded_subject")" \
        "folded Subject continuation count"
    run_command "$root/folded-subject.out" "$root/folded-subject.err" \
        "$lint" "$folded_subject"
    folded_subject_status="$LAST_STATUS"

    if ((from_status == 0)); then
        printf '%s\n' \
            '    false acceptance: one From field contains two addresses' >&2
        regression_failures=$((regression_failures + 1))
    elif ((from_status != 65)); then
        printf '    wrong rejection status for multiple-address From: %s\n' \
            "$from_status" >&2
        regression_failures=$((regression_failures + 1))
    fi
    if ((message_id_status == 0)); then
        printf '%s\n' \
            '    false acceptance: one Message-ID field contains two tab-separated IDs' \
            >&2
        regression_failures=$((regression_failures + 1))
    elif ((message_id_status != 65)); then
        printf '    wrong rejection status for multiple Message-IDs: %s\n' \
            "$message_id_status" >&2
        regression_failures=$((regression_failures + 1))
    fi
    if ((unknown_header_status == 0)); then
        printf '%s\n' \
            '    false acceptance: unknown agent X-header' >&2
        regression_failures=$((regression_failures + 1))
    elif ((unknown_header_status != 65)); then
        printf '    wrong rejection status for unknown agent X-header: %s\n' \
            "$unknown_header_status" >&2
        regression_failures=$((regression_failures + 1))
    fi
    if ((tag_suffix_status == 0)); then
        printf '%s\n' \
            '    false acceptance: exact subject tag has a non-space suffix' \
            >&2
        regression_failures=$((regression_failures + 1))
    elif ((tag_suffix_status != 65)); then
        printf '    wrong rejection status for subject tag suffix: %s\n' \
            "$tag_suffix_status" >&2
        regression_failures=$((regression_failures + 1))
    fi
    if ((folded_subject_status == 0)); then
        printf '%s\n' \
            '    false acceptance: required Subject has a folded continuation' \
            >&2
        regression_failures=$((regression_failures + 1))
    elif ((folded_subject_status != 65)); then
        printf '    wrong rejection status for folded Subject: %s\n' \
            "$folded_subject_status" >&2
        regression_failures=$((regression_failures + 1))
    fi
    assert_eq 65 "$questionable_tag_status" \
        "literal QUESTIONABLE green rejection control"
    assert_eq "$canonical_hash" \
        "$(sha256sum "$canonical" | cut -d ' ' -f 1)" \
        "lint review canonical control bytes"
    ((regression_failures == 0))
}


test_polling_scan_errors_surface_as_io_failure() {
    require_phase2_command "$mbox"
    local scan_error='open: Permission denied'
    [[ "$(uname -s)" == Linux ]] || scan_error='opendir: Permission denied'

    local root="$test_root/polling-scan-errors"
    local message="$root/non-action-message.eml"
    local caller_maildir="$root/mail/agent.a@${HOST}"
    local caller_mode
    local expected_caller_state before after
    local control_status wait_probe_status wait_status
    local standby_probe_status standby_status
    local wait_pid standby_pid
    local wait_started_ns standby_started_ns
    local wait_elapsed_ms standby_elapsed_ms
    local regression_failures=0

    mkdir -p "$root"
    make_maildirs "$root/mail" agent.sender@"${HOST}" agent.a@"${HOST}"
    write_message "$message" Sender agent.sender@"${HOST}" \
        agent.sender@"${HOST}" agent.a@"${HOST}" '' \
        '[FYI] Phase 2 polling scan-error sentinel' \
        'Wed, 29 Jul 2026 07:10:00 +0000' \
        '<phase2-polling-scan-error-sentinel@'"${HOST}"'>' \
        j-phase2-polling-scan-error info \
        'This real Cc copy makes the no-mutation assertion non-vacuous.'

    SNO_REACH_ROOT="$root/mail" "$deliver" <"$message" ||
        fail "real Phase 1 delivery failed for polling scan-error sentinel"
    assert_file "$(new_message "$root/mail" agent.a@"${HOST}")" \
        "polling scan-error sentinel Cc copy"
    caller_mode="$(stat -c '%a' "$caller_maildir")"

    before="$(tree_state "$caller_maildir")"
    run_command "$root/control.out" "$root/control.err" \
        env SNO_REACH_ROOT="$root/mail" \
        "$mbox" wait --as agent.a@"${HOST}" \
        --from agent.sender@"${HOST}" \
        --reply-to '<phase2-polling-normal-timeout@'"${HOST}"'>' \
        --timeout 0 --every 1
    control_status="$LAST_STATUS"
    after="$(tree_state "$caller_maildir")"
    assert_eq 4 "$control_status" "normal unmatched wait timeout status"
    assert_eq "$before" "$after" \
        "normal unmatched wait timeout mutation"
    expected_caller_state="$after"

    (
        set +e
        env SNO_REACH_ROOT="$root/mail" BASH_ENV="$TEST_DIR/fixtures/poll-ready-env.sh" REACH_POLL_READY="$root/wait.ready" \
            "$mbox" wait --as agent.a@"${HOST}" \
            --from agent.sender@"${HOST}" \
            --reply-to '<phase2-polling-scan-error-root@'"${HOST}"'>' \
            --timeout 2 --every 1 \
            >"$root/wait.out" 2>"$root/wait.err"
        printf '%s\n' "$?" >"$root/wait.status"
    ) &
    wait_pid=$!
    wait_for_file "$root/wait.ready"
    kill -0 "$wait_pid" || fail 'threaded wait exited before the scan-error probe'
    wait_started_ns="$(date +%s%N)"
    before="$(tree_state "$caller_maildir")"
    chmod 000 "$caller_maildir"
    run_command "$root/wait-probe.out" "$root/wait-probe.err" \
        mlist "$caller_maildir"
    wait_probe_status="$LAST_STATUS"
    wait_for_exit_within "$wait_pid" \
        "wait after caller Maildir permission loss"
    if wait "$wait_pid"; then
        :
    fi
    wait_elapsed_ms=$((($(date +%s%N) - wait_started_ns) / 1000000))
    assert_file "$root/wait.status" "wait scan-error status capture"
    wait_status="$(<"$root/wait.status")"
    chmod "$caller_mode" "$caller_maildir"
    after="$(tree_state "$caller_maildir")"
    assert_eq "$before" "$after" "wait scan-error Maildir mutation"
    assert_contains "$(cat "$root/wait-probe.err")" \
        "$scan_error" \
        "wait real filesystem scan failure"
    assert_contains "$(cat "$root/wait.err")" \
        "$scan_error" \
        "wait polling command observed filesystem scan failure"

    (
        set +e
        env SNO_REACH_ROOT="$root/mail" BASH_ENV="$TEST_DIR/fixtures/poll-ready-env.sh" REACH_POLL_READY="$root/standby.ready" \
            "$mbox" wait --as agent.a@"${HOST}" \
            --timeout 2 --every 1 \
            >"$root/standby.out" 2>"$root/standby.err"
        printf '%s\n' "$?" >"$root/standby.status"
    ) &
    standby_pid=$!
    wait_for_file "$root/standby.ready"
    kill -0 "$standby_pid" || fail 'unfiltered wait exited before the scan-error probe'
    standby_started_ns="$(date +%s%N)"
    before="$(tree_state "$caller_maildir")"
    chmod 000 "$caller_maildir"
    run_command "$root/standby-probe.out" "$root/standby-probe.err" \
        mlist "$caller_maildir"
    standby_probe_status="$LAST_STATUS"
    wait_for_exit_within "$standby_pid" \
        "standby after caller Maildir permission loss"
    if wait "$standby_pid"; then
        :
    fi
    standby_elapsed_ms=$((($(date +%s%N) - standby_started_ns) / 1000000))
    assert_file "$root/standby.status" "standby scan-error status capture"
    standby_status="$(<"$root/standby.status")"
    chmod "$caller_mode" "$caller_maildir"
    after="$(tree_state "$caller_maildir")"
    assert_eq "$before" "$after" "standby scan-error Maildir mutation"
    assert_contains "$(cat "$root/standby-probe.err")" \
        "$scan_error" \
        "standby real filesystem scan failure"
    assert_contains "$(cat "$root/standby.err")" \
        "$scan_error" \
        "standby polling command observed filesystem scan failure"

    if ((wait_status != 74)); then
        printf '    wait scan failure: mlist=%s, expected 74, got %s after %sms\n' \
            "$wait_probe_status" "$wait_status" "$wait_elapsed_ms" >&2
        regression_failures=$((regression_failures + 1))
    elif ((wait_elapsed_ms >= 1800)); then
        printf '    wait scan failure: status 74 was delayed for %sms\n' \
            "$wait_elapsed_ms" >&2
        regression_failures=$((regression_failures + 1))
    fi
    if ((standby_status != 74)); then
        printf '    standby scan failure: mlist=%s, expected 74, got %s after %sms\n' \
            "$standby_probe_status" "$standby_status" \
            "$standby_elapsed_ms" >&2
        regression_failures=$((regression_failures + 1))
    elif ((standby_elapsed_ms >= 1800)); then
        printf '    standby scan failure: status 74 was delayed for %sms\n' \
            "$standby_elapsed_ms" >&2
        regression_failures=$((regression_failures + 1))
    fi
    assert_eq "$(printf '%s\n' "$expected_caller_state" | \
        sed -n '/^f new\//p;/^f cur\//p;/^f outbox\//p;/^sha256 new\//p;/^sha256 cur\//p;/^sha256 outbox\//p')" \
        "$(maildir_message_state "$caller_maildir")" \
        "polling scan-error caller Maildir restoration"
    assert_eq "$caller_mode" "$(stat -c '%a' "$caller_maildir")" \
        "polling scan-error caller Maildir mode restoration"
    ((regression_failures == 0))
}


test_wait_surfaces_unreadable_listed_answer() {
    require_phase2_command "$mbox"

    local root="$test_root/unreadable-listed-answer"
    local answer="$root/answer.eml"
    local answer_path
    local expected_maildir_state expected_maildir_modes expected_message_mode
    local mlist_status mhdr_status wait_status
    local wait_started_ns wait_elapsed_ms
    local wait_error
    local after
    local regression_failures=0

    mkdir -p "$root"
    make_maildirs "$root/mail" agent.a@"${HOST}"
    write_message "$answer" Responder agent.responder@"${HOST}" agent.a@"${HOST}" '' '' \
        'Re: [ANSWER] Phase 2 unreadable listed answer' \
        'Wed, 29 Jul 2026 07:35:00 +0000' \
        '<phase2-unreadable-listed-answer@'"${HOST}"'>' \
        j-phase2-unreadable-listed-answer answer \
        'This caller-owned answer must not become an ordinary timeout.' \
        'In-Reply-To: <phase2-unreadable-listed-root@'"${HOST}"'>' \
        'References: <phase2-unreadable-listed-root@'"${HOST}"'>'

    SNO_REACH_ROOT="$root/mail" "$deliver" <"$answer" ||
        fail "real Phase 1 delivery failed for unreadable answer"
    answer_path="$(message_by_id "$root/mail" agent.a@"${HOST}" \
        '<phase2-unreadable-listed-answer@'"${HOST}"'>')" ||
        fail "caller-owned unreadable answer was not delivered"
    assert_eq agent.a@"${HOST}" "$(mhdr -h delivered-to "$answer_path")" \
        "unreadable answer Delivered-To control"
    expected_maildir_state="$(tree_state "$root/mail")"
    expected_maildir_modes="$(
        find "$root/mail" -printf '%m %P\n' | sort
    )"
    expected_message_mode="$(stat -c '%a' "$answer_path")"

    chmod 000 "$answer_path"
    if [[ -r "$answer_path" ]]; then
        chmod "$expected_message_mode" "$answer_path"
        fail "unreadable answer remained readable after permission loss"
    fi

    run_command "$root/mlist.out" "$root/mlist.err" \
        mlist "$root/mail/agent.a@${HOST}"
    mlist_status="$LAST_STATUS"
    run_command "$root/mhdr.out" "$root/mhdr.err" \
        mhdr -h delivered-to "$answer_path"
    mhdr_status="$LAST_STATUS"

    wait_started_ns="$(date +%s%N)"
    run_command "$root/wait.out" "$root/wait.err" \
        env SNO_REACH_ROOT="$root/mail" \
        "$mbox" wait --as agent.a@"${HOST}" \
        --from agent.responder@"${HOST}" \
        --reply-to '<phase2-unreadable-listed-root@'"${HOST}"'>' \
        --timeout 0 --every 1
    wait_status="$LAST_STATUS"
    wait_elapsed_ms=$((($(date +%s%N) - wait_started_ns) / 1000000))
    wait_error="$(cat "$root/wait.err")"

    chmod "$expected_message_mode" "$answer_path"
    after="$(tree_state "$root/mail")"

    assert_eq 0 "$mlist_status" "unreadable answer mlist status"
    assert_eq 1 "$(exact_line_count "$root/mlist.out" "$answer_path")" \
        "unreadable answer exact mlist path"
    assert_eq 0 "$(line_count "$root/mlist.err")" \
        "unreadable answer mlist diagnostics"
    assert_nonzero "$mhdr_status" "unreadable answer direct mhdr status"
    assert_eq "$expected_maildir_state" "$after" \
        "unreadable answer Maildir tree and bytes"
    assert_eq "$expected_maildir_modes" \
        "$(find "$root/mail" -printf '%m %P\n' | sort)" \
        "unreadable answer Maildir modes"
    assert_eq "$expected_message_mode" "$(stat -c '%a' "$answer_path")" \
        "unreadable answer mode restoration"
    assert_eq 0 "$(line_count "$root/wait.out")" \
        "unreadable answer wait output"

    if ((wait_status != 74)); then
        printf '    unreadable listed answer: mlist=%s mhdr=%s expected wait=74, got %s after %sms\n' \
            "$mlist_status" "$mhdr_status" "$wait_status" \
            "$wait_elapsed_ms" >&2
        regression_failures=$((regression_failures + 1))
    elif ((wait_elapsed_ms >= 1000)); then
        printf '    unreadable listed answer: status 74 was delayed for %sms\n' \
            "$wait_elapsed_ms" >&2
        regression_failures=$((regression_failures + 1))
    fi
    if [[ "$wait_error" != *"$answer_path"* || "$wait_error" != *read* ]]; then
        printf '%s\n' \
            '    unreadable listed answer: wait did not expose the unreadable message path' \
            >&2
        regression_failures=$((regression_failures + 1))
    fi
    ((regression_failures == 0))
}


test_reply_preserves_preexisting_cur_destination() {
    local init_display_name=pesto
    require_phase2_command "$mbox"

    local root="$test_root/reply-cur-collision"
    local source_message="$root/source.eml"
    local reply_body="$root/reply-body.txt"
    local new_source source_basename source_hash
    local collision collision_hash collision_mode
    local moved_source reply_file='' candidate
    local from_header body thread_output

    mkdir -p "$root"
    make_maildirs "$root/mail" agent.questioner@"${HOST}" agent.a@"${HOST}"
    write_message "$source_message" Questioner agent.questioner@"${HOST}" \
        agent.a@"${HOST}" '' '' \
        '[QUESTION] Phase 2 reply cur collision' \
        'Wed, 29 Jul 2026 08:10:00 +0000' \
        '<phase2-reply-cur-collision-root@'"${HOST}"'>' \
        j-phase2-reply-cur-collision question \
        'original collision source body' \
        'In-Reply-To: <phase2-reply-cur-collision-ancestor@'"${HOST}"'>' \
        'References: <phase2-reply-cur-collision-ancestor@'"${HOST}"'>' \
        'X-Name: questioner'
    run_command_with_input "$source_message" "$root/send-source.out" \
        "$root/send-source.err" env SNO_REACH_ROOT="$root/mail" \
        "$mbox" send --no-ring --as agent.questioner@"${HOST}"
    assert_eq 0 "$LAST_STATUS" "collision source send status"

    new_source="$(message_by_id "$root/mail" agent.a@"${HOST}" \
        '<phase2-reply-cur-collision-root@'"${HOST}"'>')" ||
        fail "collision source was not delivered"
    accept_reply_work "$root/mail" "$new_source"
    source_basename="$(basename "$new_source")"
    source_hash="$(sha256sum "$new_source" | cut -d ' ' -f 1)"
    collision="$root/mail/agent.a@${HOST}/cur/$source_basename:2,"
    printf '%s\n' \
        'pre-existing cur collision sentinel' \
        'these bytes must never become the reply source' >"$collision"
    collision_hash="$(sha256sum "$collision" | cut -d ' ' -f 1)"
    collision_mode="$(stat -c '%a' "$collision")"
    printf 'collision-safe caller response\n' >"$reply_body"

    run_command_with_input "$reply_body" "$root/reply.out" "$root/reply.err" \
        env SNO_REACH_ROOT="$root/mail" "$mbox" reply --as agent.a@"${HOST}" \
        --card "$new_source"
    assert_eq 0 "$LAST_STATUS" "cur-collision reply status"

    assert_file "$collision" "pre-existing cur collision path"
    assert_eq "$collision_hash" \
        "$(sha256sum "$collision" | cut -d ' ' -f 1)" \
        "pre-existing cur collision bytes"
    assert_eq "$collision_mode" "$(stat -c '%a' "$collision")" \
        "pre-existing cur collision mode"
    [[ ! -e "$new_source" ]] ||
        fail "cur-collision reply left source in new"

    moved_source="$(message_by_id "$root/mail" agent.a@"${HOST}" \
        '<phase2-reply-cur-collision-root@'"${HOST}"'>')" ||
        fail "cur-collision source did not reach caller cur"
    assert_ne "$collision" "$moved_source" \
        "cur-collision distinct source path"
    assert_eq "$root/mail/agent.a@${HOST}/cur" "$(dirname "$moved_source")" \
        "cur-collision source parent"
    [[ "$(basename "$moved_source")" == *':2,'*R* ]] ||
        fail "cur-collision source lacks R flag: $moved_source"
    assert_eq "$source_hash" \
        "$(sha256sum "$moved_source" | cut -d ' ' -f 1)" \
        "cur-collision moved source bytes"
    assert_eq 1 \
        "$(find "$root/mail/agent.a@${HOST}/cur" -maxdepth 1 -type f \
            -name '*:2,*R*' | wc -l)" \
        "only distinct collision source gained R"
    assert_eq 0 \
        "$(find "$root/mail/agent.questioner@${HOST}" -type f \
            -name '*:2,*R*' | wc -l)" \
        "cur-collision flags outside caller mailbox"

    while IFS= read -r candidate; do
        if [[ "$(mhdr -h x-type "$candidate")" == answer ]] &&
           [[ "$(mhdr -h in-reply-to "$candidate")" == '<phase2-reply-cur-collision-root@'"${HOST}"'>' ]]; then
            reply_file="$candidate"
            break
        fi
    done < <(find "$root/mail/agent.questioner@${HOST}/new" \
        -maxdepth 1 -type f -print | sort)
    assert_file "$reply_file" "cur-collision delivered reply"

    from_header="$(mhdr -h from "$reply_file")"
    printf '%s\n' "$from_header" |
        grep -Eiq '^pesto <agent\.a@'"${HOST}"'>$' ||
        fail "cur-collision reply From is wrong: $from_header"
    assert_eq 'Re: [ANSWER] Phase 2 reply cur collision' \
        "$(mhdr -h subject "$reply_file")" \
        "cur-collision reply subject"
    assert_eq j-phase2-reply-cur-collision \
        "$(mhdr -h x-work "$reply_file")" \
        "cur-collision reply X-Work"
    assert_eq answer "$(mhdr -h x-type "$reply_file")" \
        "cur-collision reply X-Type"
    assert_eq pesto "$(mhdr -h x-name "$reply_file")" \
        "cur-collision reply X-Name"
    assert_eq agent.questioner@"${HOST}" "$(mhdr -h delivered-to "$reply_file")" \
        "cur-collision reply Delivered-To"
    assert_eq '<phase2-reply-cur-collision-root@'"${HOST}"'>' \
        "$(mhdr -h in-reply-to "$reply_file")" \
        "cur-collision reply direct parent"
    assert_eq \
        '<phase2-reply-cur-collision-ancestor@'"${HOST}"'> <phase2-reply-cur-collision-root@'"${HOST}"'>' \
        "$(mhdr -h references "$reply_file")" \
        "cur-collision reply full References"
    assert_ne '<phase2-reply-cur-collision-root@'"${HOST}"'>' \
        "$(mhdr -h message-id "$reply_file")" \
        "cur-collision new reply Message-ID"

    body="$(sed '1,/^$/d' "$reply_file")"
    assert_contains "$body" '> original collision source body' \
        "cur-collision quoted source"
    assert_contains "$body" 'collision-safe caller response' \
        "cur-collision reply body"

    thread_output="$(
        printf '%s\n' "$moved_source" "$reply_file" | mthread
    )" || fail "cur-collision mthread failed"
    assert_eq 2 "$(printf '%s\n' "$thread_output" | wc -l)" \
        "cur-collision mthread row count"
    assert_eq "$moved_source" \
        "$(printf '%s\n' "$thread_output" | sed -n '1s/^ *//p')" \
        "cur-collision mthread root"
    printf '%s\n' "$thread_output" |
        sed -n '2p' |
        grep -Eq "^ +$(printf '%s' "$reply_file" |
            sed 's/[][\\.^$*+?(){}|/]/\\&/g')$" ||
        fail "cur-collision mthread did not indent reply"
}


test_third_party_cannot_dismiss() {
    require_phase2_command "$mbox"

    local root="$test_root/third-party-dismiss"
    local source_message="$root/source.eml"
    local source before after dismiss_status

    mkdir -p "$root"
    make_maildirs "$root/mail" agent.sender@"${HOST}" agent.recipient@"${HOST}" agent.third@"${HOST}"
    write_message "$source_message" Sender agent.sender@"${HOST}" \
        agent.recipient@"${HOST}" '' '' \
        '[QUESTION] Third-party dismissal refusal' \
        'Fri, 31 Jul 2026 02:22:00 +0000' \
        '<third-party-dismiss-red@'"${HOST}"'>' j-third-party-dismiss question \
        'Only the named recipient may dismiss this card.'
    run_command_with_input "$source_message" "$root/send.out" "$root/send.err" \
        env SNO_REACH_ROOT="$root/mail" "$mbox" send --no-ring --as agent.sender@"${HOST}"
    assert_eq 0 "$LAST_STATUS" "third-party dismissal source send status"
    source="$(message_by_id "$root/mail" agent.recipient@"${HOST}" \
        '<third-party-dismiss-red@'"${HOST}"'>')" ||
        fail "third-party dismissal source was not delivered"

    before="$(maildir_message_state "$root/mail")"
    run_command "$root/dismiss.out" "$root/dismiss.err" \
        env SNO_REACH_ROOT="$root/mail" "$mbox" dismiss \
        --as agent.third@"${HOST}" --card "$source" \
        --reason 'not mine to dismiss'
    dismiss_status="$LAST_STATUS"
    after="$(maildir_message_state "$root/mail")"

    assert_nonzero "$dismiss_status" "third-party dismissal refusal status"
    assert_contains "$(<"$root/dismiss.err")" 'caller-owned Maildir' \
        "third-party dismissal authorization diagnostic"
    assert_eq "$before" "$after" "third-party dismissal mutation"
}


test_cc_only_caller_cannot_reply() {
    require_phase2_command "$mbox"

    local root="$test_root/cc-only-reply-authorization"
    local source_message="$root/source.eml"
    local reply_body="$root/reply-body.txt"
    local source source_name source_mode source_hash
    local before after before_files after_files new_deliveries
    local reply_status
    local source_preserved=no
    local source_name_unchanged=no
    local source_mode_unchanged=no
    local source_hash_unchanged=no
    local source_flags_unchanged=no
    local tree_unchanged=no
    local regression_failures=0

    mkdir -p "$root"
    make_maildirs "$root/mail" agent.questioner@"${HOST}" agent.a@"${HOST}" agent.b@"${HOST}"
    write_message "$source_message" Questioner agent.questioner@"${HOST}" \
        agent.b@"${HOST}" agent.a@"${HOST}" '' \
        '[QUESTION] Phase 2 Cc-only reply authorization' \
        'Wed, 29 Jul 2026 08:55:00 +0000' \
        '<phase2-cc-only-reply-source@'"${HOST}"'>' \
        j-phase2-cc-only-reply question \
        'The informed-only recipient must not answer this source.' \
        'X-Name: questioner'
    run_command_with_input "$source_message" "$root/send-source.out" \
        "$root/send-source.err" env SNO_REACH_ROOT="$root/mail" \
        "$mbox" send --no-ring --as agent.questioner@"${HOST}"
    assert_eq 0 "$LAST_STATUS" "Cc-only source send status"

    source="$(message_by_id "$root/mail" agent.a@"${HOST}" \
        '<phase2-cc-only-reply-source@'"${HOST}"'>')" ||
        fail "Cc-only caller source was not delivered"
    assert_eq agent.b@"${HOST}" "$(maddr -a -h to: "$source")" \
        "Cc-only source To prerequisite"
    assert_eq agent.a@"${HOST}" "$(maddr -a -h cc: "$source")" \
        "Cc-only source Cc prerequisite"
    assert_eq agent.a@"${HOST}" "$(mhdr -h delivered-to "$source")" \
        "Cc-only source Delivered-To prerequisite"
    source_name="$(basename "$source")"
    source_mode="$(stat -c '%a' "$source")"
    source_hash="$(sha256sum "$source" | cut -d ' ' -f 1)"
    assert_no_r_flag "$source" "Cc-only source initial flags"
    printf 'Cc-only authorization refusal body\n' >"$reply_body"

    before="$(tree_state "$root/mail")"
    before_files="$(find "$root/mail" -type f | wc -l)"
    run_command_with_input "$reply_body" "$root/reply.out" "$root/reply.err" \
        env SNO_REACH_ROOT="$root/mail" "$mbox" reply --as agent.a@"${HOST}" \
        --card "$source"
    reply_status="$LAST_STATUS"
    after="$(tree_state "$root/mail")"
    after_files="$(find "$root/mail" -type f | wc -l)"
    new_deliveries=$((after_files - before_files))

    if ((reply_status == 0)); then
        regression_failures=$((regression_failures + 1))
    fi
    if [[ "$before" == "$after" ]]; then
        tree_unchanged=yes
    else
        regression_failures=$((regression_failures + 1))
    fi
    if ((new_deliveries != 0)); then
        regression_failures=$((regression_failures + 1))
    fi
    if [[ -f "$source" ]]; then
        source_preserved=yes
        [[ "$(basename "$source")" == "$source_name" ]] &&
            source_name_unchanged=yes
        [[ "$(stat -c '%a' "$source")" == "$source_mode" ]] &&
            source_mode_unchanged=yes
        [[ "$(sha256sum "$source" | cut -d ' ' -f 1)" == "$source_hash" ]] &&
            source_hash_unchanged=yes
        if [[ "$(basename "$source")" != *':2,'* ]]; then
            source_flags_unchanged=yes
        fi
    fi
    if [[ "$source_preserved" != yes ||
          "$source_name_unchanged" != yes ||
          "$source_mode_unchanged" != yes ||
          "$source_hash_unchanged" != yes ||
          "$source_flags_unchanged" != yes ]]; then
        regression_failures=$((regression_failures + 1))
    fi

    if ((regression_failures != 0)); then
        printf '    Cc-only reply authorization: status=%s source-preserved=%s name=%s mode=%s hash=%s flags=%s tree-unchanged=%s new-deliveries=%s\n' \
            "$reply_status" "$source_preserved" "$source_name_unchanged" \
            "$source_mode_unchanged" "$source_hash_unchanged" \
            "$source_flags_unchanged" "$tree_unchanged" \
            "$new_deliveries" >&2
    fi
    ((regression_failures == 0))
}


test_bcc_caller_replies_from_delivered_copy() {
    require_phase2_command "$mbox"

    local root="$test_root/bcc-reply-authorization"
    local source_message="$root/source.eml"
    local reply_body="$root/reply-body.txt"
    local source answer

    mkdir -p "$root"
    make_maildirs "$root/mail" agent.questioner@"${HOST}" agent.visible@"${HOST}" agent.bcc@"${HOST}"
    write_message "$source_message" Questioner agent.questioner@"${HOST}" \
        agent.visible@"${HOST}" '' agent.bcc@"${HOST}" \
        '[QUESTION] Bcc reply authorization' \
        'Sun, 02 Aug 2026 07:44:00 +0000' \
        '<bcc-reply-source@'"${HOST}"'>' j-bcc-reply question \
        'The hidden recipient must be able to answer its delivered copy.' \
        'X-Name: questioner'
    run_command_with_input "$source_message" "$root/send.out" "$root/send.err" \
        env SNO_REACH_ROOT="$root/mail" "$mbox" send --no-ring --as agent.questioner@"${HOST}"
    assert_eq 0 "$LAST_STATUS" "Bcc source send status"
    source="$(message_by_id "$root/mail" agent.bcc@"${HOST}" '<bcc-reply-source@'"${HOST}"'>')" ||
        fail "Bcc source was not delivered"
    assert_eq agent.bcc@"${HOST}" "$(mhdr -h delivered-to "$source")" \
        "Bcc source Delivered-To authority"
    assert_eq 0 "$(grep -Eic '^Bcc:' "$source" || true)" \
        "Bcc source privacy"
    if [[ "${SNO_REACH_BCC_STRIP_DELIVERED_TO:-0}" == 1 ]]; then
        sed '/^Delivered-To:/d' "$source" >"$root/stripped"
        mv -- "$root/stripped" "$source"
    fi
    printf 'Bcc recipient answer\n' >"$reply_body"
    run_command_with_input "$reply_body" "$root/reply.out" "$root/reply.err" \
        env SNO_REACH_REPLY_RECEIPT=1 SNO_REACH_ROOT="$root/mail" \
        "$mbox" reply --as agent.bcc@"${HOST}" \
        --card "$source"
    if [[ "${SNO_REACH_BCC_STRIP_DELIVERED_TO:-0}" == 1 ]]; then
        assert_nonzero "$LAST_STATUS" "stripped Delivered-To reply status"
        assert_contains "$(<"$root/reply.err")" \
            'could not read reply source recipient:' \
            "stripped Delivered-To authority failure"
        assert_file "$source" "stripped Delivered-To source remains unreplied"
        printf 'plant_observable=stripped-delivered-to-refused\n'
        return
    fi
    assert_eq 0 "$LAST_STATUS" "Bcc reply status"
    answer="$(message_by_id "$root/mail" agent.questioner@"${HOST}" \
        "$(<"$root/reply.out")")" || fail "Bcc answer was not delivered"
    assert_eq answer "$(mhdr -h x-type "$answer")" "Bcc answer type"
    assert_eq '<bcc-reply-source@'"${HOST}"'>' "$(mhdr -h in-reply-to "$answer")" \
        "Bcc answer thread"
}


test_direct_answer_send_satisfies_wait() {
    require_phase2_command "$mbox"

    local root="$test_root/direct-answer-send-authorization"
    local answer="$root/direct-answer.eml"
    local wait_out="$root/wait.out"
    local wait_err="$root/wait.err"
    local wait_status_file="$root/wait.status"
    local wait_pid wait_status send_status wait_paths delivered

    mkdir -p "$root"
    make_maildirs "$root/mail" agent.sender@"${HOST}" agent.a@"${HOST}"
    held_answer_parent "$root/mail" '<phase2-forged-answer-root@'"${HOST}"'>' \
        agent.a@"${HOST}" agent.sender@"${HOST}" j-phase2-forged-direct-answer
    write_message "$answer" Sender agent.sender@"${HOST}" agent.a@"${HOST}" '' '' \
        'Re: [ANSWER] Phase 2 direct answer' \
        'Wed, 29 Jul 2026 08:56:00 +0000' \
        '<phase2-forged-direct-answer@'"${HOST}"'>' \
        j-phase2-forged-direct-answer answer \
        'A direct answer must satisfy the recipient thread wait.' \
        'In-Reply-To: <phase2-forged-answer-root@'"${HOST}"'>' \
        'References: <phase2-forged-answer-root@'"${HOST}"'>' \
        'X-Name: sender'
    run_command "$root/lint.out" "$root/lint.err" "$lint" "$answer"
    assert_eq 0 "$LAST_STATUS" "direct answer lint status"
    assert_eq agent.sender@"${HOST}" "$(maddr -a -h from: "$answer")" \
        "direct answer author prerequisite"

    (
        set +e
        SNO_REACH_ROOT="$root/mail" "$mbox" wait --as agent.a@"${HOST}" \
            --from agent.sender@"${HOST}" \
            --reply-to '<phase2-forged-answer-root@'"${HOST}"'>' \
            --timeout 2 --every 1 \
            >"$wait_out" 2>"$wait_err"
        printf '%s\n' "$?" >"$wait_status_file"
    ) &
    wait_pid=$!
    wait_for_any_output "$wait_out" "$wait_err" "$wait_pid"
    kill -0 "$wait_pid" 2>/dev/null ||
        fail "direct-answer wait exited before direct send"

    run_command_with_input "$answer" "$root/send.out" "$root/send.err" \
        env SNO_REACH_ROOT="$root/mail" \
        "$mbox" send --no-ring --as agent.sender@"${HOST}"
    send_status="$LAST_STATUS"
    wait_for_exit_within "$wait_pid" "direct-answer wait after direct send"
    if wait "$wait_pid"; then
        :
    fi
    assert_file "$wait_status_file" "direct-answer wait status record"
    wait_status="$(<"$wait_status_file")"
    wait_paths="$(line_count "$wait_out")"
    assert_eq 0 "$send_status" "direct-answer send status"
    assert_eq 0 "$wait_status" "direct-answer wait status"
    assert_eq 1 "$wait_paths" "direct-answer wait path count"
    delivered="$(<"$wait_out")"
    assert_file "$delivered" "direct-answer delivered path"
    assert_eq '<phase2-forged-direct-answer@'"${HOST}"'>' \
        "$(mhdr -h message-id "$delivered")" \
        "direct-answer delivered Message-ID"
    assert_eq '<phase2-forged-answer-root@'"${HOST}"'>' \
        "$(mhdr -h in-reply-to "$delivered")" \
        "direct-answer delivered thread root"
}


test_uninvolved_answer_cannot_close_action() {
    require_phase2_command "$mbox"

    local root="$test_root/uninvolved"
    local question="$root/question.eml"
    local answer="$root/answer.eml"
    local original answer_copy original_hash original_name
    local before_output="$root/peek-before.out"
    local after_output="$root/peek-after.out"

    mkdir -p "$root"
    make_maildirs "$root/mail" cts.uninvolved@"${HOST}" agent.a@"${HOST}" agent.third@"${HOST}"
    write_message "$question" CTS cts.uninvolved@"${HOST}" agent.a@"${HOST}" '' '' \
        '[QUESTION] Phase 2 uninvolved-answer regression' \
        'Wed, 29 Jul 2026 05:30:00 +0000' \
        '<phase2-uninvolved-root@'"${HOST}"'>' j-phase2-uninvolved question \
        'The open action must remain visible.'

    run_command_with_input "$question" "$root/send-question.out" \
        "$root/send-question.err" env SNO_REACH_ROOT="$root/mail" \
        "$mbox" send --no-ring --as cts.uninvolved@"${HOST}"
    assert_eq 0 "$LAST_STATUS" "question send status"

    original="$(message_by_id "$root/mail" agent.a@"${HOST}" \
        '<phase2-uninvolved-root@'"${HOST}"'>')" ||
        fail "caller-owned original was not delivered"
    original_hash="$(sha256sum "$original" | cut -d ' ' -f 1)"
    original_name="$(basename "$original")"

    run_command "$before_output" "$root/peek-before.err" \
        env SNO_REACH_ROOT="$root/mail" "$mbox" inbox --as agent.a@"${HOST}"
    assert_eq 0 "$LAST_STATUS" "peek before answer status"
    assert_eq 1 "$(inbox_path_count "$before_output" "$original")" \
        "original action before answer"

    write_message "$answer" Third agent.third@"${HOST}" '' agent.a@"${HOST}" '' \
        'Re: [ANSWER] Phase 2 uninvolved-answer regression' \
        'Wed, 29 Jul 2026 05:31:00 +0000' \
        '<phase2-uninvolved-answer@'"${HOST}"'>' j-phase2-uninvolved answer \
        'This author is not the question recipient.' \
        'In-Reply-To: <phase2-uninvolved-root@'"${HOST}"'>' \
        'References: <phase2-uninvolved-root@'"${HOST}"'>'

    run_command "$root/lint-answer.out" "$root/lint-answer.err" \
        "$lint" "$answer"
    assert_eq 0 "$LAST_STATUS" "uninvolved answer lint status"
    run_command_with_input "$answer" "$root/deliver-answer.out" \
        "$root/deliver-answer.err" env SNO_REACH_ROOT="$root/mail" \
        "$deliver"
    assert_eq 0 "$LAST_STATUS" "uninvolved answer delivery status"

    answer_copy="$(message_by_id "$root/mail" agent.a@"${HOST}" \
        '<phase2-uninvolved-answer@'"${HOST}"'>')" ||
        fail "Cc answer was not delivered"
    run_command "$after_output" "$root/peek-after.err" \
        env SNO_REACH_ROOT="$root/mail" "$mbox" inbox --as agent.a@"${HOST}"
    assert_eq 0 "$LAST_STATUS" "peek after answer status"
    assert_eq 1 "$(inbox_path_count "$after_output" "$original")" \
        "original action after answer"
    assert_eq 0 "$(inbox_path_count "$after_output" "$answer_copy")" \
        "Cc answer action count"
    assert_file "$root/mail/agent.a@${HOST}/new/$original_name" \
        "unchanged original location"
    assert_eq "$original_hash" \
        "$(sha256sum "$original" | cut -d ' ' -f 1)" \
        "original bytes after uninvolved answer"
    assert_no_r_flag "$original" "original reply state"
}


test_wait_isolated_by_recipient_thread_and_type() {
    # A matched answer is recorded as seen (seen.jsonl), so the no-change comparisons leave that record out.
    require_phase2_command "$mbox"

    local root="$test_root/wait"
    local other_recipient="$root/other-recipient.eml"
    local other_thread="$root/other-thread.eml"
    local wrong_sender="$root/wrong-sender.eml"
    local same_thread_status="$root/same-thread-status.eml"
    local matching="$root/matching.eml"
    local wait_out="$root/wait.out"
    local wait_err="$root/wait.err"
    local wait_status_file="$root/wait.status"
    local live_wait_out="$root/live-wait.out"
    local live_wait_err="$root/live-wait.err"
    local live_wait_status_file="$root/live-wait.status"
    local wait_pid live_wait_pid status matching_copy before after
    local live_wait_paths

    mkdir -p "$root"
    make_maildirs "$root/mail" agent.sender@"${HOST}" agent.expected@"${HOST}" agent.a@"${HOST}" \
        agent.b@"${HOST}" agent.third@"${HOST}" agent.questioner@"${HOST}"

    write_message "$other_recipient" Expected agent.expected@"${HOST}" agent.b@"${HOST}" '' '' \
        'Re: [ANSWER] Phase 2 other recipient' \
        'Wed, 29 Jul 2026 05:40:00 +0000' \
        '<phase2-wait-other-recipient@'"${HOST}"'>' j-phase2-wait answer \
        'Answer delivered only to another recipient.' \
        'In-Reply-To: <phase2-wait-root@'"${HOST}"'>' \
        'References: <phase2-wait-root@'"${HOST}"'>'
    write_message "$other_thread" Expected agent.expected@"${HOST}" agent.a@"${HOST}" '' '' \
        'Re: [ANSWER] Phase 2 other thread' \
        'Wed, 29 Jul 2026 05:41:00 +0000' \
        '<phase2-wait-other-thread@'"${HOST}"'>' j-phase2-wait answer \
        'Answer for a different thread.' \
        'In-Reply-To: <phase2-different-root@'"${HOST}"'>' \
        'References: <phase2-different-root@'"${HOST}"'>'
    write_message "$same_thread_status" Expected agent.expected@"${HOST}" \
        agent.a@"${HOST}" '' '' '[STATUS] Phase 2 same-thread status' \
        'Wed, 29 Jul 2026 05:42:00 +0000' \
        '<phase2-wait-status@'"${HOST}"'>' j-phase2-wait status \
        'A status card is not an answer.' \
        'In-Reply-To: <phase2-wait-root@'"${HOST}"'>' \
        'References: <phase2-wait-root@'"${HOST}"'>'
    write_message "$wrong_sender" Wrong agent.sender@"${HOST}" agent.a@"${HOST}" '' '' \
        'Re: [ANSWER] Phase 2 wrong sender' \
        'Wed, 29 Jul 2026 05:42:30 +0000' \
        '<phase2-wait-wrong-sender@'"${HOST}"'>' j-phase2-wait answer \
        'A matching thread from the wrong sender cannot satisfy wait.' \
        'In-Reply-To: <phase2-wait-root@'"${HOST}"'>' \
        'References: <phase2-wait-root@'"${HOST}"'>'

    (
        set +e
        SNO_REACH_ROOT="$root/mail" "$mbox" wait --as agent.a@"${HOST}" \
            --from agent.expected@"${HOST}" \
            --reply-to '<phase2-wait-root@'"${HOST}"'>' \
            --timeout 2 --every 1 \
            >"$wait_out" 2>"$wait_err"
        printf '%s\n' "$?" >"$wait_status_file"
    ) &
    wait_pid=$!
    wait_for_any_output "$wait_out" "$wait_err" "$wait_pid"

    run_command "$root/lint-other-recipient.out" \
        "$root/lint-other-recipient.err" "$lint" "$other_recipient"
    assert_eq 0 "$LAST_STATUS" "other-recipient answer lint status"
    run_command_with_input "$other_recipient" \
        "$root/deliver-other-recipient.out" \
        "$root/deliver-other-recipient.err" \
        env SNO_REACH_ROOT="$root/mail" "$deliver"
    assert_eq 0 "$LAST_STATUS" "other-recipient answer delivery status"
    run_command "$root/lint-other-thread.out" \
        "$root/lint-other-thread.err" "$lint" "$other_thread"
    assert_eq 0 "$LAST_STATUS" "other-thread answer lint status"
    run_command_with_input "$other_thread" \
        "$root/deliver-other-thread.out" "$root/deliver-other-thread.err" \
        env SNO_REACH_ROOT="$root/mail" "$deliver"
    assert_eq 0 "$LAST_STATUS" "other-thread answer delivery status"
    run_command_with_input "$same_thread_status" "$root/send-status.out" \
        "$root/send-status.err" env SNO_REACH_ROOT="$root/mail" \
        "$mbox" send --no-ring --as agent.expected@"${HOST}"
    assert_eq 0 "$LAST_STATUS" "same-thread status send status"
    run_command_with_input "$wrong_sender" "$root/send-wrong-sender.out" \
        "$root/send-wrong-sender.err" env SNO_REACH_ROOT="$root/mail" \
        "$deliver"
    assert_eq 0 "$LAST_STATUS" "wrong-sender same-thread answer send status"

    before="$(tree_state "$root/mail")"
    if wait "$wait_pid"; then
        :
    fi
    assert_file "$wait_status_file" "bounded wait status record"
    status="$(<"$wait_status_file")"
    assert_eq 4 "$status" "isolated wait timeout status"
    assert_not_contains "$(<"$wait_out")" "$root/mail/" \
        "isolated wait matched-path output"
    after="$(tree_state "$root/mail")"
    assert_eq "$before" "$after" "first wait flag and filename state"

    (
        set +e
        SNO_REACH_ROOT="$root/mail" "$mbox" wait --as agent.a@"${HOST}" \
            --from agent.expected@"${HOST}" \
            --reply-to '<phase2-wait-root@'"${HOST}"'>' \
            --timeout 5 --every 1 \
            >"$live_wait_out" 2>"$live_wait_err"
        printf '%s\n' "$?" >"$live_wait_status_file"
    ) &
    live_wait_pid=$!
    wait_for_any_output "$live_wait_out" "$live_wait_err" "$live_wait_pid"
    kill -0 "$live_wait_pid" 2>/dev/null ||
        fail "matching wait exited before descendant answer delivery"

    write_message "$matching" Expected agent.expected@"${HOST}" agent.a@"${HOST}" '' '' \
        'Re: [ANSWER] Phase 2 matching descendant answer' \
        'Wed, 29 Jul 2026 05:43:00 +0000' \
        '<phase2-wait-matching@'"${HOST}"'>' j-phase2-wait answer \
        'This descendant answer is delivered while wait is polling.' \
        'In-Reply-To: <phase2-wait-direct-parent@'"${HOST}"'>' \
        'References: <phase2-wait-root@'"${HOST}"'> <phase2-wait-direct-parent@'"${HOST}"'>'
    assert_ne '<phase2-wait-root@'"${HOST}"'>' \
        "$(mhdr -h in-reply-to "$matching")" \
        "matching descendant direct parent"
    assert_contains "$(mhdr -h references "$matching")" \
        '<phase2-wait-root@'"${HOST}"'>' "matching descendant root reference"
    run_command "$root/lint-matching.out" "$root/lint-matching.err" \
        "$lint" "$matching"
    assert_eq 0 "$LAST_STATUS" "matching answer lint status"
    run_command_with_input "$matching" "$root/deliver-matching.out" \
        "$root/deliver-matching.err" env SNO_REACH_ROOT="$root/mail" \
        "$deliver"
    assert_eq 0 "$LAST_STATUS" "matching answer delivery status"
    matching_copy="$(message_by_id "$root/mail" agent.a@"${HOST}" \
        '<phase2-wait-matching@'"${HOST}"'>')" ||
        fail "matching answer was not delivered to caller"
    before="$(tree_state "$root/mail" | grep -v -e '/seen\.jsonl' -e '/\.seen\.lock')"
    wait_for_exit_within "$live_wait_pid" \
        "already-polling matching wait"
    if wait "$live_wait_pid"; then
        :
    fi
    assert_file "$live_wait_status_file" \
        "already-polling matching wait status record"
    status="$(<"$live_wait_status_file")"
    assert_eq 0 "$status" "already-polling matching wait status"
    assert_eq 1 "$(exact_line_count "$live_wait_out" "$matching_copy")" \
        "already-polling matching wait path"
    live_wait_paths="$(
        while IFS= read -r path; do
            [[ -f "$path" ]] && printf '%s\n' "$path"
        done <"$live_wait_out"
    )"
    assert_eq "$matching_copy" "$live_wait_paths" \
        "already-polling wait exact caller-owned path"
    after="$(tree_state "$root/mail" | grep -v -e '/seen\.jsonl' -e '/\.seen\.lock')"
    assert_eq "$before" "$after" \
        "already-polling matching wait flag and filename state"

    run_command "$root/wait-default.out" "$root/wait-default.err" \
        timeout 5 env SNO_REACH_ROOT="$root/mail" "$mbox" wait \
        --as agent.a@"${HOST}" --from agent.expected@"${HOST}" \
        --reply-to '<phase2-wait-root@'"${HOST}"'>' --timeout 5
    assert_eq 0 "$LAST_STATUS" "default wait immediate status"
    assert_eq 1 \
        "$(exact_line_count "$root/wait-default.out" "$matching_copy")" \
        "default wait matching path"

    run_command "$root/wait-zero.out" "$root/wait-zero.err" \
        env SNO_REACH_ROOT="$root/mail" "$mbox" wait --as agent.a@"${HOST}" \
        --from agent.expected@"${HOST}" \
        --reply-to '<phase2-wait-root@'"${HOST}"'>' \
        --timeout 0 --every 1
    assert_eq 0 "$LAST_STATUS" "zero-timeout initial scan status"
    assert_eq 1 \
        "$(exact_line_count "$root/wait-zero.out" "$matching_copy")" \
        "zero-timeout initial scan path"
    after="$(tree_state "$root/mail" | grep -v -e '/seen\.jsonl' -e '/\.seen\.lock')"
    assert_eq "$before" "$after" "successful wait flag and filename state"
}


test_reply_quotes_threads_and_records_only_success() {
    local init_display_name=pesto
    require_phase2_command "$mbox"

    local root="$test_root/reply-success"
    local source_message="$root/source.eml"
    local source new_source moved_source reply_file source_hash
    local reply_body="$root/reply-body.txt"
    local thread_output from_header body
    local failed_root="$test_root/reply-failure"
    local failed_message="$failed_root/source.eml"
    local failed_source failed_moved failed_hash failed_entry
    local failed_queued_message failed_recipients failed_body failed_from
    local before after
    local -a failed_entries=()

    mkdir -p "$root"
    make_maildirs "$root/mail" agent.questioner@"${HOST}" agent.a@"${HOST}"
    write_message "$source_message" Questioner agent.questioner@"${HOST}" \
        agent.a@"${HOST}" '' '' \
        '[QUESTION] Phase 2 chained reply' \
        'Wed, 29 Jul 2026 06:00:00 +0000' \
        '<phase2-reply-root@'"${HOST}"'>' j-phase2-reply question \
        'original quoted body' \
        'In-Reply-To: <phase2-reply-ancestor@'"${HOST}"'>' \
        'References: <phase2-reply-ancestor@'"${HOST}"'>'
    run_command_with_input "$source_message" "$root/send-source.out" \
        "$root/send-source.err" env SNO_REACH_ROOT="$root/mail" \
        "$mbox" send --no-ring --as agent.questioner@"${HOST}"
    assert_eq 0 "$LAST_STATUS" "reply source send status"
    new_source="$(message_by_id "$root/mail" agent.a@"${HOST}" \
        '<phase2-reply-root@'"${HOST}"'>')" ||
        fail "reply source was not delivered"
    accept_reply_work "$root/mail" "$new_source"
    source_hash="$(sha256sum "$new_source" | cut -d ' ' -f 1)"
    printf 'caller response body\n' >"$reply_body"

    run_command_with_input "$reply_body" "$root/reply.out" "$root/reply.err" \
        env SNO_REACH_ROOT="$root/mail" "$mbox" reply --as agent.a@"${HOST}" \
        --card "$new_source"
    assert_eq 0 "$LAST_STATUS" "successful reply status"
    [[ ! -e "$new_source" ]] ||
        fail "successful reply left source in new"
    moved_source="$(
        find "$root/mail/agent.a@${HOST}/cur" -maxdepth 1 -type f -print -quit
    )"
    assert_file "$moved_source" "moved reply source"
    [[ "$(basename "$moved_source")" == *':2,'*R* ]] ||
        fail "successful reply source lacks cur/:2,R state"
    assert_eq "$source_hash" \
        "$(sha256sum "$moved_source" | cut -d ' ' -f 1)" \
        "moved source bytes"
    assert_eq 0 \
        "$(find "$root/mail/agent.questioner@${HOST}" -type f \
            -name '*:2,*R*' | wc -l)" \
        "reply flags outside caller mailbox"

    reply_file="$(find "$root/mail/agent.questioner@${HOST}/new" \
        -maxdepth 1 -type f -print -quit)"
    assert_file "$reply_file" "delivered reply"
    from_header="$(mhdr -h from "$reply_file")"
    printf '%s\n' "$from_header" |
        grep -Eiq '^pesto <agent\.a@'"${HOST}"'>$' ||
        fail "reply From does not identify pesto at agent.a@${HOST}: $from_header"
    assert_eq 'Re: [ANSWER] Phase 2 chained reply' \
        "$(mhdr -h subject "$reply_file")" "reply subject"
    assert_eq answer "$(mhdr -h x-type "$reply_file")" "reply X-Type"
    assert_eq '<phase2-reply-root@'"${HOST}"'>' \
        "$(mhdr -h in-reply-to "$reply_file")" "reply direct parent"
    assert_eq \
        '<phase2-reply-ancestor@'"${HOST}"'> <phase2-reply-root@'"${HOST}"'>' \
        "$(mhdr -h references "$reply_file")" "reply full References"
    assert_ne '<phase2-reply-root@'"${HOST}"'>' \
        "$(mhdr -h message-id "$reply_file")" "new reply Message-ID"
    assert_ne '' "$(mhdr -h message-id "$reply_file")" \
        "present reply Message-ID"
    body="$(sed '1,/^$/d' "$reply_file")"
    assert_contains "$body" '> original quoted body' "quoted original body"
    assert_contains "$body" 'caller response body' "caller response body"

    thread_output="$(
        printf '%s\n' "$moved_source" "$reply_file" | mthread
    )" || fail "mthread failed on delivered reply"
    assert_eq 2 "$(printf '%s\n' "$thread_output" | wc -l)" \
        "mthread row count"
    assert_eq "$moved_source" \
        "$(printf '%s\n' "$thread_output" | sed -n '1s/^ *//p')" \
        "mthread root"
    printf '%s\n' "$thread_output" |
        sed -n '2p' |
        grep -Eq "^ +$(printf '%s' "$reply_file" |
            sed 's/[][\\.^$*+?(){}|/]/\\&/g')$" ||
        fail "mthread did not indent reply beneath original"

    mkdir -p "$failed_root"
    make_maildirs "$failed_root/mail" agent.questioner@"${HOST}" agent.a@"${HOST}"
    write_message "$failed_message" Questioner agent.questioner@"${HOST}" \
        agent.a@"${HOST}" '' '' \
        '[QUESTION] Phase 2 failed reply delivery' \
        'Wed, 29 Jul 2026 06:10:00 +0000' \
        '<phase2-reply-failure@'"${HOST}"'>' j-phase2-reply question \
        'delivery failure source body'
    run_command_with_input "$failed_message" "$failed_root/send-source.out" \
        "$failed_root/send-source.err" env SNO_REACH_ROOT="$failed_root/mail" \
        "$mbox" send --no-ring --as agent.questioner@"${HOST}"
    assert_eq 0 "$LAST_STATUS" "failed-delivery source send status"
    failed_source="$(message_by_id "$failed_root/mail" agent.a@"${HOST}" \
        '<phase2-reply-failure@'"${HOST}"'>')" ||
        fail "failed-delivery source was not delivered"
    accept_reply_work "$failed_root/mail" "$failed_source"
    failed_hash="$(sha256sum "$failed_source" | cut -d ' ' -f 1)"
    local failed_release="$failed_root/release"
    mkdir -p "$failed_release"
    cp -a "$APP/bin" "$APP/lib" "$APP/vendor" "$APP/VERSION" "$failed_release/"
    mv "$failed_release/lib/reach-deliver" "$failed_release/lib/reach-deliver.real"
    cp "$TEST_DIR/fixtures/fail-local-delivery.sh" "$failed_release/lib/reach-deliver"
    chmod +x "$failed_release/lib/reach-deliver"

    run_command_with_input "$reply_body" "$failed_root/reply.out" \
        "$failed_root/reply.err" env SNO_REACH_SKIP_OUTBOX_RETRY=1 \
        REACH_TEST_FAIL_NEW="$failed_root/mail/agent.questioner@${HOST}/new" \
        SNO_REACH_ROOT="$failed_root/mail" \
        "$failed_release/bin/sno-reach" reply --as agent.a@"${HOST}" \
        --card "$failed_source"
    assert_nonzero "$LAST_STATUS" "unavailable-recipient reply"
    [[ ! -e "$failed_source" ]] ||
        fail "failed reply left source in new"
    failed_moved="$(
        find "$failed_root/mail/agent.a@${HOST}/cur" \
            -maxdepth 1 -type f -print -quit
    )"
    assert_file "$failed_moved" "failed reply moved source"
    assert_eq "$failed_hash" \
        "$(sha256sum "$failed_moved" | cut -d ' ' -f 1)" \
        "failed reply source bytes"
    mapfile -t failed_entries < <(
        find "$failed_root/mail/agent.a@${HOST}/outbox" \
            -mindepth 1 -maxdepth 1 -type d -print | sort
    )
    ((${#failed_entries[@]} == 1)) ||
        fail "failed reply did not retain exactly one queued outbox entry"
    failed_entry="${failed_entries[0]}"
    assert_eq $'message\nrecipients' \
        "$(find "$failed_entry" -mindepth 1 -maxdepth 1 \
            -type f -printf '%f\n' | sort)" \
        "failed reply complete queued entry"
    failed_queued_message="$failed_entry/message"
    failed_recipients="$failed_entry/recipients"
    [[ -f "$failed_queued_message" && ! -L "$failed_queued_message" &&
       -f "$failed_recipients" && ! -L "$failed_recipients" ]] ||
        fail "failed reply queue contains an unsafe or incomplete file"
    assert_eq agent.questioner@"${HOST}" "$(<"$failed_recipients")" \
        "failed reply exact queued recipient"
    assert_eq "$(<"$failed_recipients")" \
        "$(maddr -a -h to:cc:bcc: "$failed_queued_message")" \
        "failed reply queued message recipient"
    run_command "$failed_root/queued-lint.out" \
        "$failed_root/queued-lint.err" "$lint" "$failed_queued_message"
    assert_eq 0 "$LAST_STATUS" "failed reply queued message lint"
    failed_from="$(mhdr -h from "$failed_queued_message")"
    printf '%s\n' "$failed_from" |
        grep -Eiq '^pesto <agent\.a@'"${HOST}"'>$' ||
        fail "failed reply queued From is wrong: $failed_from"
    assert_eq 'Re: [ANSWER] Phase 2 failed reply delivery' \
        "$(mhdr -h subject "$failed_queued_message")" \
        "failed reply queued subject"
    assert_eq answer "$(mhdr -h x-type "$failed_queued_message")" \
        "failed reply queued X-Type"
    assert_eq pesto "$(mhdr -h x-name "$failed_queued_message")" \
        "failed reply queued X-Name"
    assert_eq j-phase2-reply \
        "$(mhdr -h x-work "$failed_queued_message")" \
        "failed reply queued journey"
    assert_eq '<phase2-reply-failure@'"${HOST}"'>' \
        "$(mhdr -h in-reply-to "$failed_queued_message")" \
        "failed reply queued direct parent"
    assert_eq '<phase2-reply-failure@'"${HOST}"'>' \
        "$(mhdr -h references "$failed_queued_message")" \
        "failed reply queued References"
    assert_ne '' "$(mhdr -h message-id "$failed_queued_message")" \
        "failed reply queued Message-ID"
    assert_ne '<phase2-reply-failure@'"${HOST}"'>' \
        "$(mhdr -h message-id "$failed_queued_message")" \
        "failed reply queued new Message-ID"
    failed_body="$(sed '1,/^$/d' "$failed_queued_message")"
    assert_contains "$failed_body" '> delivery failure source body' \
        "failed reply queued quoted body"
    assert_contains "$failed_body" 'caller response body' \
        "failed reply queued response body"
    assert_eq 4 \
        "$(find "$failed_root/mail" -type f \( -path '*/new/*' -o \
            -path '*/cur/*' -o -path '*/outbox/*' \) | wc -l)" \
        "accepted report, failed reply message and outbox file count"
    [[ "$(basename "$failed_moved")" == *':2,'*R* ]] ||
        fail "failed reply source lacks cur/:2,R after durable queue staging"

    before="$(tree_state "$failed_root/mail")"
    run_command_with_input "$reply_body" "$failed_root/reply-again.out" \
        "$failed_root/reply-again.err" env \
        SNO_REACH_ROOT="$failed_root/mail" "$mbox" reply \
        --as agent.a@"${HOST}" --card "$failed_moved"
    assert_nonzero "$LAST_STATUS" "second reply to queued source"
    assert_contains "$(<"$failed_root/reply-again.err")" 'replied' \
        "second reply refusal diagnostic"
    after="$(tree_state "$failed_root/mail")"
    assert_eq "$before" "$after" "second reply refusal mutation"
    assert_eq 1 \
        "$(find "$failed_root/mail/agent.a@${HOST}/outbox" \
            -mindepth 1 -maxdepth 1 -type d | wc -l)" \
        "second reply queued entry count"
}


test_strict_lint_and_zero_placement() {
    require_phase2_command "$lint"
    require_phase2_command "$mbox"

    local root="$test_root/lint"
    local canonical="$root/canonical.eml"
    local variants="$root/variants"
    local output_dir="$root/output"
    local canonical_hash variant name value
    local -a singleton_headers=(
        From Subject Date Message-ID X-Work X-Type
    )
    local -a invalid_address_headers=(
        'From|Sender <bad/seat@'"${HOST}"'>'
        'Sender|Relay <bad/seat@'"${HOST}"'>'
        'Reply-To|Questioner <bad/seat@'"${HOST}"'>'
        'To|bad/seat@'"${HOST}"''
        'Cc|bad/seat@'"${HOST}"''
        'Bcc|bad/seat@'"${HOST}"''
        'Delivered-To|bad/seat@'"${HOST}"''
    )

    mkdir -p "$variants" "$output_dir"
    make_maildirs "$root/mail" agent.sender@"${HOST}" agent.a@"${HOST}"
    write_message "$canonical" Sender agent.sender@"${HOST}" agent.a@"${HOST}" '' '' \
        '[QUESTION] Phase 2 canonical lint message' \
        'Wed, 29 Jul 2026 06:20:00 +0000' \
        '<phase2-lint-canonical@'"${HOST}"'>' j-phase2-lint question \
        'Canonical lint body.' \
        'X-Name: sender'
    canonical_hash="$(sha256sum "$canonical" | cut -d ' ' -f 1)"

    run_command "$output_dir/valid-file.out" "$output_dir/valid-file.err" \
        "$lint" "$canonical"
    assert_eq 0 "$LAST_STATUS" "canonical file lint"
    run_command_with_input "$canonical" "$output_dir/valid-stdin.out" \
        "$output_dir/valid-stdin.err" "$lint"
    assert_eq 0 "$LAST_STATUS" "canonical stdin lint"
    assert_eq "$canonical_hash" \
        "$(sha256sum "$canonical" | cut -d ' ' -f 1)" \
        "canonical hash after valid lint"

    for name in "${singleton_headers[@]}"; do
        variant="$variants/missing-${name,,}.eml"
        remove_header "$canonical" "$variant" "$name"
        mkdir -p "$output_dir/missing-${name,,}"
        assert_invalid_message "$root/mail" "$variant" \
            "missing $name" "$output_dir/missing-${name,,}"
    done
    variant="$variants/missing-recipients.eml"
    remove_recipient_headers "$canonical" "$variant"
    mkdir -p "$output_dir/missing-recipients"
    assert_invalid_message "$root/mail" "$variant" \
        "missing all recipient headers" "$output_dir/missing-recipients"

    for name in "${singleton_headers[@]}"; do
        variant="$variants/empty-${name,,}.eml"
        replace_header "$canonical" "$variant" "$name" ''
        mkdir -p "$output_dir/empty-${name,,}"
        assert_invalid_message "$root/mail" "$variant" \
            "empty $name" "$output_dir/empty-${name,,}"

        variant="$variants/duplicate-${name,,}.eml"
        duplicate_header "$canonical" "$variant" "$name"
        mkdir -p "$output_dir/duplicate-${name,,}"
        assert_invalid_message "$root/mail" "$variant" \
            "duplicate $name" "$output_dir/duplicate-${name,,}"

        variant="$variants/folded-${name,,}.eml"
        fold_header "$canonical" "$variant" "$name"
        mkdir -p "$output_dir/folded-${name,,}"
        assert_invalid_message "$root/mail" "$variant" \
            "folded $name" "$output_dir/folded-${name,,}"
    done

    variant="$variants/missing-separator.eml"
    remove_separator "$canonical" "$variant"
    mkdir -p "$output_dir/missing-separator"
    assert_invalid_message "$root/mail" "$variant" \
        "missing header body separator" "$output_dir/missing-separator"

    for value in "${invalid_address_headers[@]}"; do
        name="${value%%|*}"
        variant="$variants/invalid-address-${name,,}.eml"
        if [[ "$name" == From || "$name" == To ]]; then
            replace_header "$canonical" "$variant" "$name" "${value#*|}"
        else
            insert_header "$canonical" "$variant" "$name: ${value#*|}"
        fi
        mkdir -p "$output_dir/invalid-address-${name,,}"
        assert_invalid_message "$root/mail" "$variant" \
            "invalid $name address" \
            "$output_dir/invalid-address-${name,,}"
    done

    variant="$variants/bare-from.eml"
    replace_header "$canonical" "$variant" From 'agent.sender@'"${HOST}"''
    mkdir -p "$output_dir/bare-from"
    assert_invalid_message "$root/mail" "$variant" \
        "From without display name" "$output_dir/bare-from"

    variant="$variants/malformed-address-list.eml"
    replace_header "$canonical" "$variant" To \
        'agent.a@'"${HOST}"', not-an-address'
    mkdir -p "$output_dir/malformed-address-list"
    assert_invalid_message "$root/mail" "$variant" \
        "malformed address-list item" "$output_dir/malformed-address-list"

    variant="$variants/type-tag-mismatch.eml"
    replace_header "$canonical" "$variant" X-Type answer
    replace_header "$variant" "$variant.tmp" Subject \
        'Re: [QUESTION] Phase 2 mismatched answer'
    mv -- "$variant.tmp" "$variant"
    insert_header "$variant" "$variant.tmp" \
        'In-Reply-To: <phase2-lint-parent@'"${HOST}"'>'
    mv -- "$variant.tmp" "$variant"
    insert_header "$variant" "$variant.tmp" \
        'References: <phase2-lint-parent@'"${HOST}"'>'
    mv -- "$variant.tmp" "$variant"
    mkdir -p "$output_dir/type-tag-mismatch"
    assert_invalid_message "$root/mail" "$variant" \
        "type and subject tag mismatch" "$output_dir/type-tag-mismatch"

    variant="$variants/unknown-type.eml"
    replace_header "$canonical" "$variant" X-Type request
    mkdir -p "$output_dir/unknown-type"
    assert_invalid_message "$root/mail" "$variant" \
        "unknown X-Type" "$output_dir/unknown-type"

    write_message "$variants/valid-answer.eml" Sender agent.sender@"${HOST}" \
        agent.a@"${HOST}" '' '' 'Re: [ANSWER] Phase 2 valid answer' \
        'Wed, 29 Jul 2026 06:21:00 +0000' \
        '<phase2-lint-answer@'"${HOST}"'>' j-phase2-lint answer \
        'Valid answer body.' \
        'In-Reply-To: <phase2-lint-parent@'"${HOST}"'>' \
        'References: <phase2-lint-ancestor@'"${HOST}"'> <phase2-lint-parent@'"${HOST}"'>'
    run_command "$output_dir/valid-answer.out" \
        "$output_dir/valid-answer.err" "$lint" \
        "$variants/valid-answer.eml"
    assert_eq 0 "$LAST_STATUS" "complete reply-chain lint"

    remove_header "$variants/valid-answer.eml" \
        "$variants/answer-missing-parent.eml" In-Reply-To
    mkdir -p "$output_dir/answer-missing-parent"
    assert_invalid_message "$root/mail" \
        "$variants/answer-missing-parent.eml" \
        "answer missing In-Reply-To" "$output_dir/answer-missing-parent"

    remove_header "$variants/valid-answer.eml" \
        "$variants/answer-missing-references.eml" References
    mkdir -p "$output_dir/answer-missing-references"
    assert_invalid_message "$root/mail" \
        "$variants/answer-missing-references.eml" \
        "answer missing References" "$output_dir/answer-missing-references"

    replace_header "$variants/valid-answer.eml" \
        "$variants/answer-parent-absent.eml" References \
        '<phase2-lint-ancestor@'"${HOST}"'>'
    mkdir -p "$output_dir/answer-parent-absent"
    assert_invalid_message "$root/mail" \
        "$variants/answer-parent-absent.eml" \
        "direct parent absent from References" \
        "$output_dir/answer-parent-absent"

    replace_header "$canonical" "$variants/invalid-date.eml" Date \
        'not-a-date'
    mkdir -p "$output_dir/invalid-date"
    assert_invalid_message "$root/mail" "$variants/invalid-date.eml" \
        "invalid Date" "$output_dir/invalid-date"

    replace_header "$canonical" "$variants/invalid-message-id.eml" \
        Message-ID 'not-an-angle-message-id'
    mkdir -p "$output_dir/invalid-message-id"
    assert_invalid_message "$root/mail" "$variants/invalid-message-id.eml" \
        "invalid Message-ID" "$output_dir/invalid-message-id"

    replace_header "$variants/valid-answer.eml" \
        "$variants/invalid-in-reply-to.eml" In-Reply-To \
        'not-an-angle-message-id'
    mkdir -p "$output_dir/invalid-in-reply-to"
    assert_invalid_message "$root/mail" \
        "$variants/invalid-in-reply-to.eml" \
        "invalid In-Reply-To" "$output_dir/invalid-in-reply-to"

    replace_header "$variants/valid-answer.eml" \
        "$variants/invalid-references.eml" References \
        '<phase2-lint-parent@'"${HOST}"'> not-an-angle-message-id'
    mkdir -p "$output_dir/invalid-references"
    assert_invalid_message "$root/mail" "$variants/invalid-references.eml" \
        "invalid References token" "$output_dir/invalid-references"

    for value in 'X-Name-Required: pesto' 'X-Needs-Action: yes'; do
        name="${value%%:*}"
        variant="$variants/rejected-${name,,}.eml"
        insert_header "$canonical" "$variant" "$value"
        mkdir -p "$output_dir/rejected-${name,,}"
        assert_invalid_message "$root/mail" "$variant" \
            "deleted extension $name" "$output_dir/rejected-${name,,}"
    done

    variant="$variants/repeated-tags.eml"
    insert_header "$canonical" "$variant" 'X-Tag: release readiness'
    insert_header "$variant" "$variant.tmp" \
        'X-Tag: requires owner decision'
    mv -- "$variant.tmp" "$variant"
    run_command "$output_dir/repeated-tags.out" \
        "$output_dir/repeated-tags.err" "$lint" "$variant"
    assert_eq 0 "$LAST_STATUS" "repeated nonempty X-Tag lint"

    insert_header "$canonical" "$variants/empty-tag.eml" 'X-Tag:'
    mkdir -p "$output_dir/empty-tag"
    assert_invalid_message "$root/mail" "$variants/empty-tag.eml" \
        "empty X-Tag" "$output_dir/empty-tag"

    insert_header "$canonical" "$variants/nonprintable-tag.eml" \
        $'X-Tag: printable\tviolation'
    mkdir -p "$output_dir/nonprintable-tag"
    assert_invalid_message "$root/mail" "$variants/nonprintable-tag.eml" \
        "non-printable X-Tag" "$output_dir/nonprintable-tag"

    for value in no auto-generated auto-replied; do
        variant="$variants/auto-submitted-$value.eml"
        insert_header "$canonical" "$variant" "Auto-Submitted: $value"
        run_command "$output_dir/auto-submitted-$value.out" \
            "$output_dir/auto-submitted-$value.err" "$lint" "$variant"
        assert_eq 0 "$LAST_STATUS" \
            "canonical Auto-Submitted $value lint"
    done
    insert_header "$canonical" "$variants/invalid-auto-submitted.eml" \
        'Auto-Submitted: automatic'
    mkdir -p "$output_dir/invalid-auto-submitted"
    assert_invalid_message "$root/mail" \
        "$variants/invalid-auto-submitted.eml" \
        "invalid Auto-Submitted" "$output_dir/invalid-auto-submitted"

    replace_header "$canonical" "$variants/empty-callsign.eml" \
        X-Name ''
    mkdir -p "$output_dir/empty-callsign"
    assert_invalid_message "$root/mail" "$variants/empty-callsign.eml" \
        "empty X-Name" "$output_dir/empty-callsign"
    replace_header "$canonical" "$variants/spaced-callsign.eml" \
        X-Name 'two tokens'
    mkdir -p "$output_dir/spaced-callsign"
    assert_invalid_message "$root/mail" "$variants/spaced-callsign.eml" \
        "non-bare X-Name" "$output_dir/spaced-callsign"

    replace_header "$canonical" "$variants/spaced-journey.eml" \
        X-Work 'two tokens'
    mkdir -p "$output_dir/spaced-journey"
    assert_invalid_message "$root/mail" "$variants/spaced-journey.eml" \
        "non-token X-Work" "$output_dir/spaced-journey"

    assert_eq "$canonical_hash" \
        "$(sha256sum "$canonical" | cut -d ' ' -f 1)" \
        "canonical hash after lint matrix"
}


test_private_bcc_dismissal() {
    require_phase2_command "$mbox"

    local root="$test_root/private-bcc-dismissal"
    local message="$root/private.eml" sender=sender.private-bcc@${HOST}
    local to_address=worker.private-to@${HOST} bcc_address=worker.private-bcc@${HOST}
    local source dismissed

    mkdir -p "$root"
    make_maildirs "$root/mail" "$sender" "$to_address" "$bcc_address"
    write_message "$message" Sender "$sender" "$to_address" '' "$bcc_address" \
        '[FYI] Private informed copy' 'Sun, 02 Aug 2026 11:55:00 +0000' \
        '<private-bcc-dismissal@'"${HOST}"'>' j-private-bcc info \
        'This private informed copy must have a non-reply exit.'
    run_command_with_input "$message" "$root/deliver.out" "$root/deliver.err" \
        env SNO_REACH_ROOT="$root/mail" "$deliver"
    assert_eq 0 "$LAST_STATUS" 'private Bcc source delivery status'
    source="$(message_by_id "$root/mail" "$bcc_address" \
        '<private-bcc-dismissal@'"${HOST}"'>')" || fail 'private Bcc copy was not delivered'
    assert_eq "$bcc_address" "$(mhdr -h delivered-to "$source")" \
        'private Bcc copy caller-owned Delivered-To'
    assert_eq 0 "$(grep -Eic '^Bcc:' "$source" || true)" \
        'private Bcc header remains stripped'
    run_command "$root/dismiss.out" "$root/dismiss.err" \
        env SNO_REACH_ROOT="$root/mail" "$mbox" dismiss --as "$bcc_address" \
        --card "$source" --reason 'private notice acknowledged'
    if [[ "${AGENT_MAILBOX_EXPECT_BCC_DISMISS_REFUSAL:-0}" == 1 ]]; then
        assert_nonzero "$LAST_STATUS" 'planted private Bcc dismissal refusal'
        assert_contains "$(<"$root/dismiss.err")" 'To/Cc addresses do not include' \
            'planted private Bcc dismissal public-header gate'
        printf 'plant_observable=private-bcc-dismissal-refused-without-public-membership\n'
        return
    fi
    assert_eq 0 "$LAST_STATUS" 'private Bcc dismissal status'
    dismissed="$(<"$root/dismiss.out")"
    assert_file "$dismissed" 'dismissed private Bcc copy'
    [[ "$(basename "$dismissed")" == *':2,'*T* ]] ||
        fail 'dismissed private Bcc copy lacks T flag'
    assert_file "$root/mail/$bcc_address/dismissals.jsonl" \
        'private Bcc dismissal audit'
}


test_sender_declared_no_reply_stops_at_delivery() {
    require_phase2_command "$mbox"

    local root="$test_root/send-gate-no-reply"
    local mail_root="$root/mail"
    local sender=agent.sender@${HOST}
    local recipient=agent.recipient@${HOST}
    local info="$root/info.eml"
    local decision="$root/decision.eml"
    local question="$root/question.eml"
    local delivered
    local wake_state

    mkdir -p "$root"
    make_maildirs "$mail_root" "$sender" "$recipient"
    write_message "$info" Sender "$sender" '' "$recipient" '' \
        '[FYI] Delivery-stopped notice' \
        'Wed, 05 Aug 2026 00:00:00 +0000' \
        '<send-gate-no-reply-info@'"${HOST}"'>' j-send-gates info \
        'No answer is owed.' 'X-No-Reply: true'

    run_command_with_input "$info" "$root/info.out" "$root/info.err" \
        env SNO_REACH_ROOT="$mail_root" "$mbox" send --no-ring --as "$sender"
    assert_eq 0 "$LAST_STATUS" "no-reply info send status"
    delivered="$(message_by_id "$mail_root" "$recipient" \
        '<send-gate-no-reply-info@'"${HOST}"'>')" ||
        fail "no-reply info was not delivered"
    [[ "$delivered" == */cur/*':2,'*R* ]] ||
        fail "no-reply delivery lacks the stop flag: $delivered"
    assert_eq 0 "$(find "$mail_root/$recipient/new" -maxdepth 1 \
        -type f | wc -l)" "no-reply delivery new queue count"
    run_command "$root/informed.out" "$root/informed.err" \
        env SNO_REACH_ROOT="$mail_root" "$mbox" inbox --cc --as "$recipient"
    assert_eq 0 "$LAST_STATUS" "no-reply informed status"
    assert_contains "$(<"$root/informed.out")" "$delivered" \
        "no-reply Cc copy remains readable"
    cat >"$root/wake-standin" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
while (($# > 0)); do
    case "$1" in
        --outcome) printf 'outcome=%s\n' "$2"; exit 0 ;;
        *) shift ;;
    esac
done
exit 64
EOF
    chmod 0755 "$root/wake-standin"
    run_command "$root/wake.out" "$root/wake.err" env \
        SNO_REACH_WAKE_STANDIN="$root/wake-standin" \
        SNO_REACH_WAKE_OUTCOME=rang SNO_REACH_WAKE_NO_DETACH=1 \
        "$repo_root/lib/reach-wake" start --root "$mail_root" \
        --sender "$sender" --recipient "$recipient" \
        --message-id '<send-gate-no-reply-info@'"${HOST}"'>' \
        --work j-send-gates --mechanism ''
    assert_eq 0 "$LAST_STATUS" "no-reply wake confirmation status"
    wake_state="$(find "$mail_root/$recipient/wake-attempts" \
        -maxdepth 1 -type f -name '*.json' -print -quit)"
    assert_file "$wake_state" "no-reply wake state"
    assert_eq confirmed "$(jq -r .state "$wake_state")" \
        "no-reply wake terminal state"
    assert_eq 0 "$(jq -r .attempt "$wake_state")" \
        "no-reply wake retry count"

    rm -r -- "$mail_root/$recipient/wake-attempts"
    write_message "$decision" Sender "$sender" "$recipient" '' '' \
        '[DECISION] Delivery-stopped action' \
        'Wed, 05 Aug 2026 00:00:01 +0000' \
        '<send-gate-no-reply-decision@'"${HOST}"'>' j-send-gates decision \
        'No answer is owed.' 'X-No-Reply: true'
    run_command_with_input "$decision" "$root/decision.out" \
        "$root/decision.err" env SNO_REACH_ROOT="$mail_root" \
        "$mbox" \
        send --as "$sender"
    assert_eq 0 "$LAST_STATUS" "public no-reply send status"
    delivered="$(message_by_id "$mail_root" "$recipient" \
        '<send-gate-no-reply-decision@'"${HOST}"'>')" ||
        fail "public no-reply decision was not delivered"
    [[ "$delivered" == */cur/*':2,'*R* ]] ||
        fail "public no-reply delivery lacks the stop flag: $delivered"
    [[ ! -e "$mail_root/$recipient/wake-attempts" ]] ||
        fail "public no-reply send entered the wake state machine"

    write_message "$question" Sender "$sender" "$recipient" '' '' \
        '[QUESTION] Invalid no-reply question' \
        'Wed, 05 Aug 2026 00:00:01 +0000' \
        '<send-gate-no-reply-question@'"${HOST}"'>' j-send-gates question \
        'This question requires an answer.' 'X-No-Reply: true'
    run_command_with_input "$question" "$root/question.out" \
        "$root/question.err" env SNO_REACH_ROOT="$mail_root" \
        "$mbox" send --no-ring --as "$sender"
    assert_eq 65 "$LAST_STATUS" "no-reply question refusal status"
    assert_contains "$(<"$root/question.err")" \
        'X-No-Reply is invalid for X-Type: question' \
        "no-reply question refusal reason"
    assert_contains "$(<"$root/question.err")" 'corrected command:' \
        "no-reply question corrected command"
    if message_by_id "$mail_root" "$recipient" \
        '<send-gate-no-reply-question@'"${HOST}"'>' >/dev/null; then
        fail "refused no-reply question was delivered"
    fi
}


test_send_enforces_informational_recipient_fields() {
    require_phase2_command "$mbox"

    local root="$test_root/send-gate-fields"
    local mail_root="$root/mail"
    local sender=agent.sender@${HOST}
    local recipient=agent.recipient@${HOST}
    local observer=agent.observer@${HOST}
    local message="$root/message.eml"
    local message_id

    mkdir -p "$root"
    make_maildirs "$mail_root" "$sender" "$recipient" "$observer"

    message_id='<send-gate-info-to@'"${HOST}"'>'
    write_message "$message" Sender "$sender" "$recipient" '' '' \
        '[FYI] Invalid informational To' \
        'Wed, 05 Aug 2026 00:01:00 +0000' "$message_id" \
        j-send-gates info 'This belongs on Cc.'
    run_command_with_input "$message" "$root/info-to.out" \
        "$root/info-to.err" env SNO_REACH_ROOT="$mail_root" \
        "$mbox" send --no-ring --as "$sender"
    assert_eq 65 "$LAST_STATUS" "info To refusal status"
    assert_contains "$(<"$root/info-to.err")" \
        'X-Type: info must not address a To recipient' \
        "info To refusal reason"
    assert_contains "$(<"$root/info-to.err")" \
        'move every To recipient to Cc' "info To corrected command"
    if message_by_id "$mail_root" "$recipient" "$message_id" >/dev/null; then
        fail "refused info To card was delivered"
    fi

    message_id='<send-gate-info-cc@'"${HOST}"'>'
    write_message "$message" Sender "$sender" '' "$recipient" '' \
        '[FYI] Valid informational Cc' \
        'Wed, 05 Aug 2026 00:01:01 +0000' "$message_id" \
        j-send-gates info 'This is correctly informational.'
    run_command_with_input "$message" "$root/info-cc.out" \
        "$root/info-cc.err" env SNO_REACH_ROOT="$mail_root" \
        "$mbox" send --no-ring --as "$sender"
    assert_eq 0 "$LAST_STATUS" "info Cc send status"
    message_by_id "$mail_root" "$recipient" "$message_id" >/dev/null ||
        fail "info Cc card was not delivered"
    run_command "$root/info-cc-peek.out" "$root/info-cc-peek.err" \
        env SNO_REACH_ROOT="$mail_root" "$mbox" inbox --as "$recipient"
    assert_eq 0 "$LAST_STATUS" "info Cc peek status"
    assert_eq '' "$(<"$root/info-cc-peek.out")" \
        "info Cc remains outside action queue"
    run_command "$root/info-cc-read.out" "$root/info-cc-read.err" \
        env SNO_REACH_ROOT="$mail_root" "$mbox" inbox --as "$recipient" --cc
    assert_eq 0 "$LAST_STATUS" 'informed copy explicit read status'
    assert_eq 1 "$(line_count "$root/info-cc-read.out")" 'informed copy explicit read count'

    message_id='<send-gate-answer-cc@'"${HOST}"'>'
    write_message "$message" Sender "$sender" '' "$recipient" '' \
        '[ANSWER] Invalid Cc-only answer' \
        'Wed, 05 Aug 2026 00:01:02 +0000' "$message_id" \
        j-send-gates answer 'The asker must be on To.' \
        'In-Reply-To: <send-gate-answer-parent@'"${HOST}"'>' \
        'References: <send-gate-answer-parent@'"${HOST}"'>'
    run_command_with_input "$message" "$root/answer-cc.out" \
        "$root/answer-cc.err" env SNO_REACH_ROOT="$mail_root" \
        "$mbox" send --no-ring --as "$sender"
    assert_eq 65 "$LAST_STATUS" "Cc-only answer refusal status"
    assert_contains "$(<"$root/answer-cc.err")" \
        'X-Type: answer requires a To recipient' \
        "Cc-only answer refusal reason"
    assert_contains "$(<"$root/answer-cc.err")" \
        'move the answering recipient from Cc to To' \
        "Cc-only answer corrected command"
    if message_by_id "$mail_root" "$recipient" "$message_id" >/dev/null; then
        fail "refused Cc-only answer was delivered"
    fi

    message_id='<send-gate-answer-to@'"${HOST}"'>'
    held_answer_parent "$mail_root" '<send-gate-answer-parent@'"${HOST}"'>' "$recipient" "$sender" j-send-gates
    write_message "$message" Sender "$sender" "$recipient" '' '' \
        '[ANSWER] Valid actionable answer' \
        'Wed, 05 Aug 2026 00:01:03 +0000' "$message_id" \
        j-send-gates answer 'The answer reaches the asker action queue.' \
        'In-Reply-To: <send-gate-answer-parent@'"${HOST}"'>' \
        'References: <send-gate-answer-parent@'"${HOST}"'>'
    run_command_with_input "$message" "$root/answer-to.out" \
        "$root/answer-to.err" env SNO_REACH_ROOT="$mail_root" \
        "$mbox" send --no-ring --as "$sender"
    assert_eq 0 "$LAST_STATUS" "answer To send status"
    run_command "$root/answer-wait.out" "$root/answer-wait.err" \
        env SNO_REACH_ROOT="$mail_root" "$mbox" wait --as "$recipient" \
        --from "$sender" \
        --reply-to '<send-gate-answer-parent@'"${HOST}"'>' \
        --timeout 0 --every 1
    assert_eq 0 "$LAST_STATUS" "answer To wait status"
    assert_eq "$message_id" \
        "$(mhdr -h message-id "$(<"$root/answer-wait.out")")" \
        "answer To wait exact card"

    message_id='<send-gate-answer-to-cc@'"${HOST}"'>'
    held_answer_parent "$mail_root" '<send-gate-answer-parent-two@'"${HOST}"'>' "$recipient" "$sender" j-send-gates "$observer"
    write_message "$message" Sender "$sender" "$recipient" "$observer" '' \
        '[ANSWER] Actionable answer with informed observer' \
        'Wed, 05 Aug 2026 00:01:04 +0000' "$message_id" \
        j-send-gates answer 'To acts and Cc observes.' \
        'In-Reply-To: <send-gate-answer-parent-two@'"${HOST}"'>' \
        'References: <send-gate-answer-parent-two@'"${HOST}"'>'
    run_command_with_input "$message" "$root/answer-to-cc.out" \
        "$root/answer-to-cc.err" env SNO_REACH_ROOT="$mail_root" \
        "$mbox" send --no-ring --as "$sender"
    assert_eq 0 "$LAST_STATUS" "answer To plus Cc send status"
    run_command "$root/observer-informed.out" "$root/observer-informed.err" \
        env SNO_REACH_ROOT="$mail_root" "$mbox" inbox --cc --as "$observer"
    assert_eq 0 "$LAST_STATUS" "answer observer informed status"
    local observer_path
    observer_path="$(<"$root/observer-informed.out")"
    observer_path="${observer_path#*$'\t'}"
    assert_eq "$message_id" "$(mhdr -h message-id "$observer_path")" \
        "answer observer informed copy"

    local type subject_tag
    for type in question decision; do
        if [[ "$type" == question ]]; then
            subject_tag=QUESTION
        else
            subject_tag=DECISION
        fi
        message_id="<send-gate-${type}-to-control@${HOST}>"
        write_message "$message" Sender "$sender" "$recipient" '' '' \
            "[$subject_tag] Valid actionable To" \
            'Wed, 05 Aug 2026 00:01:02 +0000' "$message_id" \
            j-send-gates "$type" 'This remains actionable.'
        run_command_with_input "$message" "$root/$type-control.out" \
            "$root/$type-control.err" env SNO_REACH_ROOT="$mail_root" \
            "$mbox" send --no-ring --as "$sender"
        assert_eq 0 "$LAST_STATUS" "$type To control send status"
        message_by_id "$mail_root" "$recipient" "$message_id" \
            >/dev/null || fail "$type To control card was not delivered"
    done
}


test_send_rate_limits_non_questions_per_pair() {
    require_phase2_command "$mbox"

    local root="$test_root/send-gate-rate"
    local mail_root="$root/mail"
    local sender=agent.sender@${HOST}
    local recipient=agent.recipient@${HOST}
    local other_sender=agent.other-sender@${HOST}
    local other_recipient=agent.other-recipient@${HOST}
    local message="$root/message.eml"
    local attempt message_id before_refusal after_refusal old_marker

    mkdir -p "$root"
    make_maildirs "$mail_root" "$sender" "$recipient" \
        "$other_sender" "$other_recipient"
    for attempt in 1 2 3; do
        message_id="<send-gate-rate-$attempt@${HOST}>"
        write_message "$message" Sender "$sender" '' "$recipient" '' \
            '[FYI] Rate-limited notice' \
            "Wed, 05 Aug 2026 00:02:0$attempt +0000" "$message_id" \
            j-send-gates info "Notice $attempt."
        run_command_with_input "$message" "$root/rate-$attempt.out" \
            "$root/rate-$attempt.err" env SNO_REACH_ROOT="$mail_root" \
            SNO_REACH_RATE_LIMIT_MAX=2 \
            SNO_REACH_RATE_LIMIT_WINDOW_SECONDS=600 \
            "$mbox" send --no-ring --as "$sender"
        if ((attempt <= 2)); then
            assert_eq 0 "$LAST_STATUS" "rate-limited control $attempt status"
            if ((attempt == 1)); then
                old_marker="$mail_root/$sender/send-rate-limit/$recipient/1.EXPIRED"
                printf '%s\n' '<expired-rate-marker@'"${HOST}"'>' >"$old_marker"
            else
                [[ ! -e "$old_marker" ]] ||
                    fail "expired rate-limit marker was not removed"
                before_refusal="$(tree_state "$mail_root")"
            fi
        else
            assert_eq 65 "$LAST_STATUS" "rate-limit refusal status"
            assert_contains "$(<"$root/rate-$attempt.err")" \
                'count=2 limit=2 window=600s' "rate-limit refusal details"
            assert_contains "$(<"$root/rate-$attempt.err")" \
                'corrected command:' "rate-limit corrected command"
            if message_by_id "$mail_root" "$recipient" "$message_id" \
                >/dev/null; then
                fail "rate-limited card was delivered"
            fi
            after_refusal="$(tree_state "$mail_root")"
            assert_eq "$before_refusal" "$after_refusal" \
                "rate-limit refusal leaves the complete mailbox tree unchanged"
        fi
    done

    message_id='<send-gate-rate-other-recipient@'"${HOST}"'>'
    write_message "$message" Sender "$sender" '' "$other_recipient" '' \
        '[FYI] Independent recipient pair' \
        'Wed, 05 Aug 2026 00:02:04 +0000' "$message_id" \
        j-send-gates info 'Different recipient pair.'
    run_command_with_input "$message" "$root/other-recipient.out" \
        "$root/other-recipient.err" env SNO_REACH_ROOT="$mail_root" \
        SNO_REACH_RATE_LIMIT_MAX=2 SNO_REACH_RATE_LIMIT_WINDOW_SECONDS=600 \
        "$mbox" send --no-ring --as "$sender"
    assert_eq 0 "$LAST_STATUS" "different recipient pair remains available"

    message_id='<send-gate-rate-other-sender@'"${HOST}"'>'
    write_message "$message" Other "$other_sender" '' "$recipient" '' \
        '[FYI] Independent sender pair' \
        'Wed, 05 Aug 2026 00:02:05 +0000' "$message_id" \
        j-send-gates info 'Different sender pair.'
    run_command_with_input "$message" "$root/other-sender.out" \
        "$root/other-sender.err" env SNO_REACH_ROOT="$mail_root" \
        SNO_REACH_RATE_LIMIT_MAX=2 SNO_REACH_RATE_LIMIT_WINDOW_SECONDS=600 \
        "$mbox" send --no-ring --as "$other_sender"
    assert_eq 0 "$LAST_STATUS" "different sender pair remains available"

    message_id='<send-gate-rate-question@'"${HOST}"'>'
    write_message "$message" Sender "$sender" "$recipient" '' '' \
        '[QUESTION] Question bypasses the rate limit' \
        'Wed, 05 Aug 2026 00:02:04 +0000' "$message_id" \
        j-send-gates question 'An answer is required.'
    run_command_with_input "$message" "$root/question.out" \
        "$root/question.err" env SNO_REACH_ROOT="$mail_root" \
        SNO_REACH_RATE_LIMIT_MAX=2 \
        SNO_REACH_RATE_LIMIT_WINDOW_SECONDS=600 \
        "$mbox" send --no-ring --as "$sender"
    assert_eq 0 "$LAST_STATUS" "rate-limit question bypass status"
    message_by_id "$mail_root" "$recipient" "$message_id" >/dev/null ||
        fail "question was blocked by the rate limit"
}

printf 'TAP version 13\n'
case "${1:-}" in
    cleanup-proof) run_case cleanup-proof bash "$TEST_DIR/cleanup.t" --seed "$WORK/state" agent "${REACH_CLEANUP_PROOF:?}" ;;
    test_real_dependencies_and_delivery_headers) run_case 'test_real_dependencies_and_delivery_headers' test_real_dependencies_and_delivery_headers ;;
    test_lint_rejects_ambiguous_contract_values) run_case 'test_lint_rejects_ambiguous_contract_values' test_lint_rejects_ambiguous_contract_values ;;
    test_polling_scan_errors_surface_as_io_failure) run_case 'test_polling_scan_errors_surface_as_io_failure' test_polling_scan_errors_surface_as_io_failure ;;
    test_wait_surfaces_unreadable_listed_answer) run_case 'test_wait_surfaces_unreadable_listed_answer' test_wait_surfaces_unreadable_listed_answer ;;
    test_reply_preserves_preexisting_cur_destination) run_case 'test_reply_preserves_preexisting_cur_destination' test_reply_preserves_preexisting_cur_destination ;;
    test_third_party_cannot_dismiss) run_case 'test_third_party_cannot_dismiss' test_third_party_cannot_dismiss ;;
    test_cc_only_caller_cannot_reply) run_case 'test_cc_only_caller_cannot_reply' test_cc_only_caller_cannot_reply ;;
    test_bcc_caller_replies_from_delivered_copy) run_case 'test_bcc_caller_replies_from_delivered_copy' test_bcc_caller_replies_from_delivered_copy ;;
    test_direct_answer_send_satisfies_wait) run_case 'test_direct_answer_send_satisfies_wait' test_direct_answer_send_satisfies_wait ;;
    test_uninvolved_answer_cannot_close_action) run_case 'test_uninvolved_answer_cannot_close_action' test_uninvolved_answer_cannot_close_action ;;
    test_wait_isolated_by_recipient_thread_and_type) run_case 'test_wait_isolated_by_recipient_thread_and_type' test_wait_isolated_by_recipient_thread_and_type ;;
    test_reply_quotes_threads_and_records_only_success) run_case 'test_reply_quotes_threads_and_records_only_success' test_reply_quotes_threads_and_records_only_success ;;
    test_strict_lint_and_zero_placement) run_case 'test_strict_lint_and_zero_placement' test_strict_lint_and_zero_placement ;;
    test_private_bcc_dismissal) run_case 'test_private_bcc_dismissal' test_private_bcc_dismissal ;;
    test_sender_declared_no_reply_stops_at_delivery) run_case 'test_sender_declared_no_reply_stops_at_delivery' test_sender_declared_no_reply_stops_at_delivery ;;
    test_send_enforces_informational_recipient_fields) run_case 'test_send_enforces_informational_recipient_fields' test_send_enforces_informational_recipient_fields ;;
    test_send_rate_limits_non_questions_per_pair) run_case 'test_send_rate_limits_non_questions_per_pair' test_send_rate_limits_non_questions_per_pair ;;
    *) printf 'choose an explicit migrated test function; see test-inventory.md\n' >&2; exit 2 ;;
esac
printf '1..%d\n' "$tests"
((failures == 0)) || exit 1
