#!/usr/bin/env bash
set -Eeuo pipefail
export HOST="$(hostname)"

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$TEST_DIR/fixtures/process-observe.sh"
repo_root="$(cd -- "$TEST_DIR/../../../apps/reach" && pwd)"

if [[ "${1:-}" == --outbox-observer-actor ]]; then
    root="${2:?mailbox root is required}"
    address="${3:?actor address is required}"
    expected="${4:?expected count is required}"
    output="${5:?output path is required}"
    ready="${6:?ready path is required}"
    mbox="${REACHABILITY_WAKE_MBOX:-$repo_root/bin/sno-reach}"
    deadline=$((SECONDS + 30))
    trap 'SNO_REACH_SKIP_WAKE_ADOPTION=1 SNO_REACH_ROOT="$root" "$mbox" unregister --as "$address" >/dev/null 2>&1 || true' EXIT
    SNO_REACH_SKIP_WAKE_ADOPTION=1 SNO_REACH_ROOT="$root" \
        "$repo_root/lib/reach-reachability" register --root "$root" --as "$address" --channel fixture \
        --handle "actor-$$" --pid "$$" --host "${HOST}" >/dev/null
    printf '%s\n' "$$" >"$ready"
    : >"$output"
    while [[ ! -e "$root/observers-start" ]]; do
        ((SECONDS < deadline)) || exit 1
        sleep 0.05
    done
    deadline=$((SECONDS + 30))
    while ((SECONDS < deadline)); do
        mapfile -t actions < <(SNO_REACH_SKIP_WAKE_ADOPTION=1 \
            SNO_REACH_ROOT="$root" "$mbox" inbox --as "$address" | cut -f1)
        for path in "${actions[@]}"; do
            [[ -f "$path" ]] || continue
            [[ "$(mhdr -h x-type "$path")" == status ]] || continue
            message_id="$(mhdr -h message-id "$path")"
            grep -Fqx -- "$message_id" "$output" 2>/dev/null && continue
            printf '%s\n' "$message_id" >>"$output"
            SNO_REACH_SKIP_WAKE_ADOPTION=1 SNO_REACH_ROOT="$root" \
                "$mbox" dismiss --as "$address" \
                --card "$path" --reason 'handled outbox escalation' >/dev/null
        done
        [[ "$(wc -l <"$output")" -ge "$expected" ]] && exit 0
        sleep 0.05
    done
    exit 1
fi


mbox="${REACHABILITY_WAKE_MBOX:-$repo_root/bin/sno-reach}"
wake="${REACHABILITY_WAKE_COMMAND:-$repo_root/lib/reach-wake}"
wrapper="$repo_root/bin/sno-reach"
standin="$TEST_DIR/fixtures/wake-standin.sh"
export PATH="$repo_root/vendor/bin:$PATH"

test_root="$(mktemp -d "${TMPDIR:-/tmp}/reachability-wake.XXXXXXXXXX")"
observer_server="reach-wake-observers-$$"
observer_started=0

cleanup_race_processes() {
    local root="$1"
    local signal pid pgid current_pgid process_arg belongs remaining target
    local -a process_args=() matched_pids=() targets=()

    current_pgid="$(ps -o pgid= -p "$$" | tr -d ' ')"
        while read -r pid; do
            [[ "$pid" != "$$" && "$pid" != "$PPID" ]] || continue
            process_args=()
            mapfile -t process_args < <(test_process_arguments "$pid" 2>/dev/null)
            belongs=0
            for process_arg in "${process_args[@]}"; do
                [[ "$process_arg" == "$root/"* ]] || continue
                belongs=1
                break
            done
            ((belongs == 1)) || continue
            matched_pids+=("$pid")
            pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
            if [[ "$pgid" == "$pid" && "$pgid" != "$current_pgid" ]]; then
                targets+=("-$pgid")
            else
                targets+=("$pid")
            fi
        done < <(test_process_ids)
    for signal in TERM KILL; do
        for target in "${targets[@]}"; do
            kill -"$signal" -- "$target" 2>/dev/null || true
        done
        for pid in "${matched_pids[@]}"; do
            wait "$pid" 2>/dev/null || true
        done
        for _ in {1..40}; do
            remaining=0
            for target in "${targets[@]}"; do
                ! kill -0 -- "$target" 2>/dev/null || remaining=$((remaining + 1))
            done
            ((remaining == 0)) && break
            sleep 0.05
        done
        ((remaining == 0)) && return 0
    done
    printf 'not ok - race fixture left %s matching child process(es)\n' \
        "$remaining" >&2
    return 1
}

cleanup_test_root() {
    local exit_status=$?

    set +e
    trap - EXIT
    if [[ -n "${wake_log_holder_release:-}" ]]; then
        : >"$wake_log_holder_release"
    fi
    if [[ -n "${wake_log_holder_pid:-}" ]]; then
        kill -TERM "$wake_log_holder_pid" 2>/dev/null || true
        wait "$wake_log_holder_pid" 2>/dev/null || true
    fi
    if [[ -n "${wake_retry_child_pid:-}" ]]; then
        kill -TERM "$wake_retry_child_pid" 2>/dev/null || true
        wait "$wake_retry_child_pid" 2>/dev/null || true
    fi
    if [[ -n "${wake_descriptor_barrier_pid:-}" ]]; then
        kill -TERM "$wake_descriptor_barrier_pid" 2>/dev/null || true
        wait "$wake_descriptor_barrier_pid" 2>/dev/null || true
    fi
    cleanup_race_processes "$test_root" || exit_status=1
    if ((observer_started)); then tmux -L "$observer_server" kill-server 2>/dev/null || true; fi
    if ((exit_status)) || [[ "${REACH_KEEP_TEST_ROOT:-0}" == 1 ]]; then
        printf 'test evidence: %s\n' "$test_root"
    else
        rm -r -- "$test_root" || exit_status=1
    fi
    exit "$exit_status"
}

trap cleanup_test_root EXIT

fail() {
    printf 'not ok - %s\n' "$*" >&2
    exit 1
}

assert_eq() {
    local expected="$1"
    local actual="$2"
    local label="$3"

    [[ "$actual" == "$expected" ]] ||
        fail "$label: expected '$expected', got '$actual'"
}

assert_contains() {
    local value="$1"
    local expected="$2"
    local label="$3"

    [[ "$value" == *"$expected"* ]] ||
        fail "$label: missing '$expected'"
}

wait_for_file() {
    local path="$1"
    local deadline=$((SECONDS + 10))

    while ((SECONDS < deadline)); do
        [[ -s "$path" ]] && return 0
        sleep 0.05
    done
    fail "timed out waiting for $path"
}

# A supervisor discovers silent reports by reading the wake-attempt records under
# the mailbox root. This used to go through `cts-roster.sh --pending-wake`, a CTS
# tool that no longer offers that flag; the property being checked was always
# this repository's, so it is read from this repository's own artifacts.
pending_wake_attempt_count() {
    local root="$1"

    # Anything that has not reached a confirmed effect, or been ruled not
    # applicable, is still a silent report somebody has to see -- pending,
    # escalated and supervisor-unresolved alike.
    find "$root" -path '*/wake-attempts/*.json' -type f -print0 2>/dev/null |
        xargs -0 --no-run-if-empty jq -r \
            'select(.state != "confirmed" and .state != "not-applicable") | .attempt_id' |
        sort -u | wc -l
}

init_address() {
    local root="$1" address="$2" supervisor="${3:-$2}" name="${4:-fixture}"
    SNO_REACH_ROOT="$root" "$mbox" init --as "$address" --name "$name" >/dev/null
    # Internal wake-state fixtures vary an already canonical initialized identity.
    # Public first-run tests separately require self-supervision and no team registry.
    if [[ "$supervisor" != "$address" ]]; then
        jq --arg supervisor "$supervisor" '.supervisor=$supervisor' "$root/$address/seat.json" >"$root/$address/seat.next"
        mv "$root/$address/seat.next" "$root/$address/seat.json"
    fi
}

write_message() {
    local path="$1"
    local sender="$2"
    local recipient="$3"
    local message_id="$4"
    local type="${5:-question}"
    local auto_submitted="${6:-}"

    {
        printf 'From: Sender <%s>\n' "$sender"
        printf 'To: Recipient <%s>\n' "$recipient"
        printf 'Subject: [%s] Reachability wake fixture\n' "${type^^}"
        printf 'Date: Fri, 01 Aug 2026 00:00:00 +0000\n'
        printf 'Message-ID: %s\n' "$message_id"
        printf 'X-Work: j-reachability-wake\n'
        printf 'X-Type: %s\n' "$type"
        [[ -z "$auto_submitted" ]] ||
            printf 'Auto-Submitted: %s\n' "$auto_submitted"
        printf '\nReachability wake fixture for %s.\n' "$message_id"
    } >"$path"
}

register_address() {
    local root="$1" address="$2" now="$3" handle="${4:-fixture-handle}"
    SNO_REACH_NOW="$now" "$repo_root/lib/reach-reachability" register --root "$root" \
        --as "$address" --channel fixture --handle "$handle" --pid "$$" --host fixture-host
}

register_observer() {
    local root="$1" address="$2" pane command
    [[ ! -f "$root/$address/reachable.json" ]] || return 0
    if ((observer_started == 0)); then
        tmux -L "$observer_server" -f /dev/null new-session -d -s observers 'sleep 120'
        observer_started=1
        TMUX="$(tmux -L "$observer_server" display-message -p '#{socket_path},#{pid},0')"
        export TMUX
    fi
    # This suite steps orphan states synchronously under their lock. Observer
    # reads must not adopt the same artificial orphan before acknowledging it.
    printf -v command 'env SNO_REACH_SKIP_WAKE_ADOPTION=1 timeout 120 bash %q' "$TEST_DIR/fixtures/tmux-ack-actor.sh"
    pane="$(tmux -L "$observer_server" new-window -d -P -F '#{pane_id}' -t observers "$command")"
    local deadline=$((SECONDS + 5))
    until tmux -L "$observer_server" capture-pane -p -t "$pane" | grep -q 'READY integration ACK actor'; do
        ((SECONDS < deadline)) || fail 'observer ACK actor did not start'
        sleep 0.05
    done
    SNO_REACH_ROOT="$root" SNO_REACH_NOW=0 TMUX_PANE="$pane" \
        "$mbox" register --as "$address" --channel tmux --handle "$pane" >/dev/null
}

case_lifecycle() {
    local root="$test_root/lifecycle"
    local address=worker.lifecycle@${HOST}
    local other=worker.other@${HOST}
    local before_other address_before_invalid status_line index pid rc
    local -a writers=()

    init_address "$root" "$address"
    init_address "$root" "$other"
    register_address "$root" "$other" 1000 other-handle >/dev/null
    before_other="$(sha256sum "$root/$other/reachable.json")"

    register_address "$root" "$address" 1000 first-handle >/dev/null
    jq -e --arg address "$address" '
        .address == $address and .channel == "fixture" and
        .handle == "first-handle" and .claimed_at == 1000 and
        .identity == {kind:"fixture", value:"first-handle"} and
        .refreshed_at == 1000 and .by.pid > 0 and
        .by.host == "fixture-host"
    ' "$root/$address/reachable.json" >/dev/null ||
        fail "register publishes the canonical reachability record"

    register_address "$root" "$address" 1900 refreshed-handle >/dev/null
    jq -e '
        .claimed_at == 1000 and .refreshed_at == 1900 and
        .handle == "refreshed-handle" and
        .identity == {kind:"fixture", value:"refreshed-handle"}
    ' "$root/$address/reachable.json" >/dev/null ||
        fail "register refresh preserves the claim time"

    status_line="$(SNO_REACH_NOW=2800 "$repo_root/lib/reach-reachability" \
        status --root "$root" --as "$address")"
    assert_contains "$status_line" $'present\t1900\t900\t' \
        "exact 900-second reachability boundary"
    status_line="$(SNO_REACH_NOW=2801 "$repo_root/lib/reach-reachability" \
        status --root "$root" --as "$address")"
    assert_contains "$status_line" $'stale\t1900\t901\t' \
        "exact 901-second reachability boundary"

    for index in $(seq 1 10); do
        register_address "$root" "$address" "$((1900 + index))" \
            "race-$index" >/dev/null &
        writers+=("$!")
    done
    for pid in "${writers[@]}"; do
        wait "$pid" || fail "concurrent registration writer $pid failed"
    done
    jq -e --arg address "$address" \
        '.address == $address and .claimed_at == 1000 and
         .refreshed_at >= 1901 and .refreshed_at <= 1910 and
         (.handle | startswith("race-"))' \
        "$root/$address/reachable.json" >/dev/null ||
        fail "ten concurrent registrations publish one complete record"

    address_before_invalid="$(sha256sum "$root/$address/reachable.json")"
    set +e
    SNO_REACH_ROOT="$root" SNO_REACH_NOW=2000 \
        "$repo_root/lib/reach-reachability" register --root "$root" --as "$address" --channel fixture \
        --handle 'invalid handle' --pid "$$" --host fixture-host \
        >"$root/invalid.out" 2>"$root/invalid.err"
    rc=$?
    set -e
    assert_eq 64 "$rc" "invalid routable token refusal"
    assert_eq "$address_before_invalid" "$(sha256sum "$root/$address/reachable.json")" \
        "invalid registration leaves the prior record intact"

    SNO_REACH_ROOT="$root" "$mbox" unregister --as "$address" >/dev/null
    [[ ! -e "$root/$address/reachable.json" ]] ||
        fail "unregister removes exactly one reachability record"
    assert_eq "$before_other" "$(sha256sum "$root/$other/reachable.json")" \
        "unregister preserves the unrelated seat"

    printf 'ok - reachability lifecycle and isolated unregister\n'
}

case_wake_log_lock_held_unregister_bounds_out() {
    local root="$test_root/wake-log-lock-held-unregister-bounds-out"
    local address=worker.lock-held@${HOST} other=worker.lock-other@${HOST}
    local state temporary fail_sleep lock_ready command_pid command_child_pid=''
    local before after other_before other_after start_ms end_ms elapsed_ms rc child_pid
    local expected_error refused_child_pid released_before other_released_before temporary_count

    init_address "$root" "$address"
    init_address "$root" "$other"
    register_address "$root" "$address" 1000 locked-handle >/dev/null
    register_address "$root" "$other" 1000 other-handle >/dev/null
    before="$(sha256sum "$root/$address/reachable.json" | cut -d ' ' -f1)"
    other_before="$(sha256sum "$root/$other/reachable.json" | cut -d ' ' -f1)"

    set +e
    SNO_REACH_NOW=0 SNO_REACH_WAKE_NO_DETACH=1 \
        SNO_REACH_WAKE_STANDIN="$standin" SNO_REACH_WAKE_OUTCOME=busy \
        "$wake" start --root "$root" --sender "$other" \
        --recipient "$address" --message-id '<wake-log-lock-held@'"${HOST}"'>' \
        --work j-reachability-wake --mechanism "$standin" \
        >"$root/start.out" 2>"$root/start.err"
    rc=$?
    set -e
    assert_eq 0 "$rc" 'lock-contention fixture reached wake status'
    state="$(find "$root/$address/wake-attempts" -type f -name '*.json' -print -quit)"
    [[ -f "$state" ]] || fail 'lock-contention fixture has no pending wake state'
    assert_eq pending "$(jq -r '.state' "$state")" \
        'lock-contention fixture leaves an unconfirmed pending wake'
    temporary="$state.tmp"
    jq '.child_pid=99999999' "$state" >"$temporary"
    mv -- "$temporary" "$state"

    fail_sleep="$root/fail-sleep"
    cat >"$fail_sleep" <<'FAIL_SLEEP'
#!/usr/bin/env bash
printf '%s\n' "$$" >"${SNO_REACH_FIXTURE_SLEEP_PID:?}"
exit 1
FAIL_SLEEP
    chmod 700 "$fail_sleep"

    wake_log_holder_release="$root/lock-holder.release"
    lock_ready="$root/lock-holder.ready"
    (
        exec 7>"$root/$address/.wake-log.lock"
        flock 7
        printf 'pid=%s\n' "$BASHPID" >"$lock_ready"
        while [[ ! -e "$wake_log_holder_release" ]]; do sleep 0.05; done
    ) &
    wake_log_holder_pid=$!
    wait_for_file "$lock_ready"
    kill -0 "$wake_log_holder_pid" || fail 'wake-log lock holder is not alive'

    start_ms="$(date -u +%s%3N)"
    timeout --signal=TERM --kill-after=1 2 \
        env SNO_REACH_ROOT="$root" SNO_REACH_NOW=1 \
            SNO_REACH_SLEEP_COMMAND="$fail_sleep" \
            SNO_REACH_FIXTURE_SLEEP_PID="$root/retry-child.pid" \
            "$mbox" inbox --as "$address" \
            >"$root/held.out" 2>"$root/held.err" &
    command_pid=$!
    for _ in {1..100}; do
        command_child_pid="$(ps -axo pid=,ppid= | awk -v parent="$command_pid" '$2 == parent && !found {print $1; found=1}')"
        [[ -z "$command_child_pid" ]] || break
        sleep 0.01
    done
    if wait "$command_pid"; then rc=0; else rc=$?; fi
    end_ms="$(date -u +%s%3N)"
    elapsed_ms=$((end_ms - start_ms))
    after="$(sha256sum "$root/$address/reachable.json" | cut -d ' ' -f1)"
    other_after="$(sha256sum "$root/$other/reachable.json" | cut -d ' ' -f1)"

    if ((rc == 124 || rc == 137)); then
        fail "public unregister exceeded its two-second outer bound (status=$rc elapsed_ms=$elapsed_ms)"
    fi
    assert_eq 75 "$rc" 'held wake-log lock returns temporary failure'
    expected_error="$(printf '%s\n%s' \
        "reach-wake: wake log lock timed out after 1s: $root/$address/.wake-log.lock" \
        'reach: could not adopt orphaned wake attempts')"
    assert_eq "$expected_error" "$(<"$root/held.err")" \
        'held wake-log lock has the complete named diagnostic'
    ((elapsed_ms < 2000)) || fail "public unregister exceeded product bound: ${elapsed_ms}ms"
    assert_eq "$before" "$after" 'refused unregister preserves its reachability record'
    assert_eq "$other_before" "$other_after" 'refused unregister preserves unrelated reachability'
    refused_child_pid="$(jq -r '.child_pid' "$state")"
    [[ "$refused_child_pid" =~ ^[1-9][0-9]*$ ]] ||
        fail "refused unregister recorded invalid child pid: $refused_child_pid"
    ! kill -0 "$refused_child_pid" 2>/dev/null ||
        fail "refused unregister left its adoption process alive: $refused_child_pid"
    temporary_count="$(find "$root/$address/wake-attempts" -maxdepth 1 \
        -type f -name '.wake-state.*' -print | wc -l)"
    assert_eq 0 "$temporary_count" 'refused unregister leaves no temporary wake state'

    : >"$wake_log_holder_release"
    wait "$wake_log_holder_pid"
    wake_log_holder_pid=''
    released_before="$(sha256sum "$root/$address/reachable.json" | cut -d ' ' -f1)"
    other_released_before="$(sha256sum "$root/$other/reachable.json" | cut -d ' ' -f1)"
    assert_eq "$before" "$released_before" \
        'lock release alone does not remove the refused reachability record'
    assert_eq "$other_before" "$other_released_before" \
        'lock release alone does not change unrelated reachability'

    env SNO_REACH_ROOT="$root" SNO_REACH_NOW=1 \
        SNO_REACH_SLEEP_COMMAND="$fail_sleep" SNO_REACH_FIXTURE_SLEEP_PID="$root/retry-child.pid" \
        "$mbox" inbox --as "$address" >"$root/released-inbox.out" 2>"$root/released-inbox.err"
    if env SNO_REACH_ROOT="$root" SNO_REACH_NOW=1 \
            SNO_REACH_SLEEP_COMMAND="$fail_sleep" \
            SNO_REACH_FIXTURE_SLEEP_PID="$root/retry-child.pid" \
            "$mbox" unregister --as "$address" \
            >"$root/released.out" 2>"$root/released.err"; then
        rc=0
    else
        rc=$?
    fi
    assert_eq 0 "$rc" 'unregister succeeds after wake-log lock release'
    [[ ! -e "$root/$address/reachable.json" ]] ||
        fail 'successful unregister left its reachability record'
    assert_eq "$other_before" \
        "$(sha256sum "$root/$other/reachable.json" | cut -d ' ' -f1)" \
        'successful unregister preserves the unrelated seat'

    child_pid="$(jq -r '.child_pid' "$state")"
    wake_retry_child_pid="$child_pid"
    for _ in {1..100}; do
        kill -0 "$child_pid" 2>/dev/null || break
        sleep 0.01
    done
    ! kill -0 "$child_pid" 2>/dev/null ||
        fail "adopted retry child remains alive: $child_pid"
    wake_retry_child_pid=''

    printf 'lock_holder_pid=%s command_pid=%s command_child_pid=%s refused_status=75 elapsed_ms=%s\n' \
        "$(cut -d= -f2 "$lock_ready")" "$command_pid" "$command_child_pid" "$elapsed_ms"
    printf 'refusal_diagnostic=wake-log-lock-timeout-after-1s\n'
    printf 'reachable_before=%s reachable_refused=%s unrelated_before=%s unrelated_after=%s\n' \
        "$before" "$after" "$other_before" \
        "$(sha256sum "$root/$other/reachable.json" | cut -d ' ' -f1)"
    printf 'refused_child_pid=%s refused_child_absent=yes temporary_artifacts=%s\n' \
        "$refused_child_pid" "$temporary_count"
    printf 'lock_released_reachable=%s lock_released_unrelated=%s\n' \
        "$released_before" "$other_released_before"
    printf 'released_status=0 reachable_removed=yes retry_child_pid=%s retry_child_absent=yes\n' \
        "$child_pid"
    printf 'fixture_root=%s cleanup=scheduled\n' "$root"
    printf 'ok - public unregister bounds out on a held wake-log lock and succeeds after release\n'
}

case_wake_child_descriptor_closure() {
    local root="$test_root/wake-child-descriptor-closure"
    local sender=worker.descriptor-sender@${HOST} recipient=worker.descriptor-recipient@${HOST}
    local gate_sleep gate barrier barrier_ready state child_pid barrier_pid rc inherited_status

    init_address "$root" "$sender"
    init_address "$root" "$recipient"
    register_address "$root" "$sender" 1000 sender-handle >/dev/null
    register_address "$root" "$recipient" 1000 recipient-handle >/dev/null

    gate="$root/retry-gate"
    barrier_ready="$root/barrier.ready"
    barrier="$root/child-barrier"
    cat >"$barrier" <<'CHILD_BARRIER'
#!/usr/bin/env bash
printf '%s\n' "$$" >"${SNO_REACH_DESCRIPTOR_BARRIER_READY:?}"
while [[ ! -e "${SNO_REACH_DESCRIPTOR_GATE:?}" ]]; do sleep 0.05; done
CHILD_BARRIER
    chmod 700 "$barrier"
    gate_sleep="$root/gate-sleep"
    cat >"$gate_sleep" <<'GATE_SLEEP'
#!/usr/bin/env bash
while [[ ! -e "${SNO_REACH_DESCRIPTOR_GATE:?}" ]]; do sleep 0.05; done
exit 1
GATE_SLEEP
    chmod 700 "$gate_sleep"

    if SNO_REACH_NOW=0 SNO_REACH_WAKE_NO_DETACH=1 \
            SNO_REACH_WAKE_STANDIN="$standin" SNO_REACH_WAKE_OUTCOME=busy \
            "$wake" start --root "$root" --sender "$sender" \
            --recipient "$recipient" --message-id '<wake-child-descriptor@'"${HOST}"'>' \
            --work j-reachability-wake --mechanism "$standin" \
            >"$root/start.out" 2>"$root/start.err"; then
        rc=0
    else
        rc=$?
    fi
    assert_eq 0 "$rc" 'descriptor fixture reached wake status'
    state="$(find "$root/$recipient/wake-attempts" -type f -name '*.json' -print -quit)"
    [[ -f "$state" ]] || fail 'descriptor fixture has no pending wake state'
    assert_eq pending "$(jq -r '.state' "$state")" \
        'descriptor fixture leaves an unconfirmed pending wake'
    jq '.child_pid=99999999' "$state" >"$state.tmp"
    mv -- "$state.tmp" "$state"

    SNO_REACH_NOW=1 SNO_REACH_SLEEP_COMMAND="$gate_sleep" \
        SNO_REACH_DESCRIPTOR_GATE="$gate" \
        SNO_REACH_DESCRIPTOR_BARRIER_READY="$barrier_ready" \
        SNO_REACH_WAKE_CHILD_BARRIER="$barrier" \
        "$wake" adopt --root "$root"
    child_pid="$(jq -r '.child_pid' "$state")"
    wake_retry_child_pid="$child_pid"
    kill -0 "$child_pid" || fail 'descriptor fixture retry child is not alive'
    wait_for_file "$barrier_ready"
    barrier_pid="$(<"$barrier_ready")"
    wake_descriptor_barrier_pid="$barrier_pid"
    kill -0 "$barrier_pid" || fail 'descriptor fixture child barrier is not alive'
    inherited_status=0
    if [[ -d /proc ]]; then
        if [[ -e "/proc/$barrier_pid/fd/8" || -e "/proc/$barrier_pid/fd/9" ]]; then inherited_status=1; fi
    else
        /usr/sbin/lsof -p "$barrier_pid" -F f >"$root/barrier-fds" || fail 'cannot inspect live barrier descriptors'
        grep -q '^f' "$root/barrier-fds" || fail 'empty barrier descriptor observation'
        if grep -Eq '^f(8|9)$' "$root/barrier-fds"; then inherited_status=1; fi
    fi

    : >"$gate"
    for _ in {1..100}; do
        kill -0 "$child_pid" 2>/dev/null || break
        sleep 0.01
    done
    ! kill -0 "$child_pid" 2>/dev/null ||
        fail "descriptor fixture retry child remains alive: $child_pid"
    wake_retry_child_pid=''
    wake_descriptor_barrier_pid=''

    if [[ "${REACHABILITY_WAKE_EXPECT_INHERITED_DESCRIPTOR:-0}" == 1 ]]; then
        ((inherited_status != 0)) ||
            fail 'planted detached child did not retain its inherited descriptor'
        printf 'plant_observable=detached-wake-child-retained-parent-lock-descriptor\n'
        return
    fi
    assert_eq 0 "$inherited_status" 'detached wake child closes inherited lock descriptors'
    printf 'descriptor_child_pid=%s barrier_pid=%s descriptor_child_absent=yes inherited_lock_fds=none\n' \
        "$child_pid" "$barrier_pid"
    printf 'ok - detached wake child closes inherited parent descriptors\n'
}

case_publication_crash() {
    local root="$test_root/publication-crash"
    local address=worker.publication@${HOST}
    local barrier="$root/barrier.sh"
    local before writer_pid barrier_pid writer_rc

    init_address "$root" "$address"
    register_address "$root" "$address" 1000 old-handle >/dev/null
    before="$(sha256sum "$root/$address/reachable.json")"
    cat >"$barrier" <<'BARRIER'
#!/usr/bin/env bash
printf '%s\n' "$$" >"${BARRIER_PID:?BARRIER_PID is required}"
printf 'ready\n' >"${BARRIER_READY:?BARRIER_READY is required}"
while :; do sleep 1; done
BARRIER
    chmod 0755 "$barrier"

    BARRIER_PID="$root/barrier.pid" BARRIER_READY="$root/barrier.ready" \
        SNO_REACH_SKIP_WAKE_ADOPTION=1 SNO_REACH_ROOT="$root" SNO_REACH_NOW=2000 \
        SNO_REACH_TEST_PUBLICATION_BARRIER="$barrier" \
        "$repo_root/lib/reach-reachability" register --root "$root" --as "$address" --channel fixture \
        --handle new-handle --pid "$$" --host fixture-host \
        >"$root/writer.out" 2>"$root/writer.err" &
    writer_pid=$!
    wait_for_file "$root/barrier.pid"
    wait_for_file "$root/barrier.ready"
    barrier_pid="$(<"$root/barrier.pid")"
    kill "$writer_pid" "$barrier_pid"
    set +e
    wait "$writer_pid"
    writer_rc=$?
    set -e
    [[ "$writer_rc" -ne 0 ]] || fail "interrupted reachability writer succeeded"
    assert_eq "$before" "$(sha256sum "$root/$address/reachable.json")" \
        "interrupted publication preserves the complete old record"
    jq -e '.handle == "old-handle" and .refreshed_at == 1000' \
        "$root/$address/reachable.json" >/dev/null ||
        fail "reader observed a partial reachability target"

    printf 'ok - deterministic pre-rename kill preserves the old complete record\n'
}

case_confirmation() {
    local root="$test_root/confirmation"
    local sender=sender.confirmation@${HOST}
    local recipient=worker.confirmation@${HOST}
    local message="$root/message.eml"
    local mechanism="$root/mechanism.sh"
    local state rc

    init_address "$root" "$sender"
    init_address "$root" "$recipient"
    register_address "$root" "$sender" 1000 sender-handle >/dev/null
    register_address "$root" "$recipient" 1000 recipient-handle >/dev/null
    write_message "$message" "$sender" "$recipient" '<confirm-target@'"${HOST}"'>'
    SNO_REACH_SKIP_WAKE_ADOPTION=1 SNO_REACH_ROOT="$root" SNO_REACH_NOW=1000 \
        "$mbox" send --no-ring --as "$sender" <"$message" >/dev/null
    cat >"$mechanism" <<'MECHANISM'
#!/usr/bin/env bash
printf 'outcome=%s\n' "${WAKE_TEST_OUTCOME:?WAKE_TEST_OUTCOME is required}"
MECHANISM
    chmod 0755 "$mechanism"

    set +e
    WAKE_TEST_OUTCOME=rang-unverified SNO_REACH_NOW=1000 \
        SNO_REACH_WAKE_NO_DETACH=1 \
        "$wake" start --root "$root" --sender "$sender" \
        --recipient "$recipient" --message-id '<confirm-target@'"${HOST}"'>' \
        --work j-reachability-wake --mechanism "$mechanism" \
        >"$root/start.out" 2>"$root/start.err"
    rc=$?
    set -e
    assert_eq 0 "$rc" "rang-unverified reached the recipient"
    state="$(find "$root/$recipient/wake-attempts" -name '*.json' -type f)"
    assert_eq pending "$(jq -r '.state' "$state")" \
        "rang-unverified initial state"

    register_address "$root" "$recipient" 1100 refreshed-handle >/dev/null
    printf '%s\n' \
        '{"version":1,"message_id":"<other-message@'"${HOST}"'>","caller":"worker.confirmation@'"${HOST}"'","path":"other","seen_at":1100,"pid":1}' \
        >"$root/$recipient/seen.jsonl"
    set +e
    WAKE_TEST_OUTCOME=rang-unverified SNO_REACH_NOW=1120 \
        "$wake" step --state "$state"
    rc=$?
    set -e
    assert_eq 4 "$rc" "unrelated refresh and message do not confirm"
    assert_eq pending "$(jq -r '.state' "$state")" \
        "unrelated activity leaves the target pending"

    printf '%s\n' \
        '{"version":1,"message_id":"<confirm-target@'"${HOST}"'>","caller":"worker.confirmation@'"${HOST}"'","path":"target","seen_at":1121,"pid":1}' \
        >>"$root/$recipient/seen.jsonl"
    WAKE_TEST_OUTCOME=rang-unverified SNO_REACH_NOW=1240 \
        "$wake" step --state "$state" >/dev/null
    assert_eq confirmed "$(jq -r '.state' "$state")" \
        "message-naming recipient effect confirms the wake"

    printf 'ok - only the target Message-ID effect confirms a pending wake\n'
}

case_retry_bound() {
    local root="$test_root/retry-bound"
    local sender=sender.retry@${HOST}
    local recipient=worker.retry@${HOST}
    local supervisor=supervisor.retry@${HOST}
    local message="$root/original.eml"
    local state rc step path

    init_address "$root" "$sender" "$supervisor"
    init_address "$root" "$recipient" "$supervisor"
    init_address "$root" "$supervisor" "$supervisor"
    register_address "$root" "$sender" 0 sender-handle >/dev/null
    register_address "$root" "$recipient" 0 recipient-handle >/dev/null
    register_address "$root" "$supervisor" 0 supervisor-handle >/dev/null
    write_message "$message" "$sender" "$recipient" '<retry-bound@'"${HOST}"'>'
    SNO_REACH_SKIP_WAKE_ADOPTION=1 SNO_REACH_ROOT="$root" SNO_REACH_NOW=0 \
        "$mbox" send --no-ring --as "$sender" <"$message" >/dev/null
    set +e
    SNO_REACH_NOW=0 SNO_REACH_WAKE_NO_DETACH=1 \
        SNO_REACH_WAKE_STANDIN="$standin" SNO_REACH_WAKE_OUTCOME=busy \
        "$wake" start --root "$root" --sender "$sender" \
        --recipient "$recipient" --message-id '<retry-bound@'"${HOST}"'>' \
        --work j-reachability-wake --mechanism /missing \
        >"$root/start.out" 2>"$root/start.err"
    rc=$?
    set -e
    assert_eq 0 "$rc" "detached retry initial reached result"
    state="$(find "$root/$recipient/wake-attempts" -name '*.json' -type f)"

    for step in $(seq 1 30); do
        set +e
        SNO_REACH_NOW="$((step * 120))" "$wake" step --state "$state" \
            >"$root/step-$step.out" 2>"$root/step-$step.err"
        rc=$?
        set -e
        assert_eq 4 "$rc" "retry step $step remains pending"
    done
    assert_eq 30 "$(jq -r '.attempt' "$state")" \
        "one-hour retry attempt count"
    assert_eq pending "$(jq -r '.state' "$state")" \
        "one-hour working turn does not exhaust"
    assert_eq 0 "$(find "$root/$sender/new" -type f | wc -l)" \
        "one-hour working turn sends no false escalation"

    for step in $(seq 31 45); do
        set +e
        SNO_REACH_NOW="$((step * 120))" "$wake" step --state "$state" \
            >"$root/step-$step.out" 2>"$root/step-$step.err"
        rc=$?
        set -e
        if ((step < 45)); then
            assert_eq 4 "$rc" "retry step $step remains pending"
        else
            [[ "$rc" == 0 ]] || cat "$root/step-$step.err" >&2
            assert_eq 0 "$rc" "exact 90-minute bound escalates"
        fi
    done
    assert_eq escalated "$(jq -r '.state' "$state")" \
        "retry bound terminal state"
    assert_eq 45 "$(jq -r '.attempt' "$state")" \
        "elapsed bound includes the forty-fifth detached retry"
    assert_eq 1 "$(find "$root/$sender/new" -type f | wc -l)" \
        "sender receives one escalation"
    assert_eq 1 "$(find "$root/$supervisor/new" -type f | wc -l)" \
        "recipient supervisor receives one escalation"
    path="$(find "$root/$supervisor/new" -type f -print -quit)"
    assert_eq status "$(mhdr -h x-type "$path")" \
        "escalation message type"
    assert_eq auto-generated "$(mhdr -h auto-submitted "$path")" \
        "escalation loop prevention"
    assert_contains "$(<"$path")" 'Original-Message-ID: <retry-bound@'"${HOST}"'>' \
        "escalation original message"
    assert_contains "$(<"$path")" 'Recipient: worker.retry@'"${HOST}"'' \
        "escalation recipient"
    assert_contains "$(<"$path")" 'Elapsed-Bound-Seconds: 5400' \
        "escalation elapsed bound"
    # Wake mode proves delivery. It does not prove whether the recipient read
    # or started the work before the message-specific effect was recorded.
    assert_contains "$(mhdr -h subject "$path")" \
        'delivery is confirmed, pickup is not' \
        "escalation subject states the card landed"
    assert_contains "$(<"$path")" \
        'This wake did not observe the message-specific confirmation effect, so it cannot tell whether the recipient read or started the work.' \
        "escalation disposition keeps pickup state unknown"
    [[ "$(<"$path")" != *'is unread'* ]] ||
        fail 'escalation disposition inferred unread state from wake mode'

    printf 'ok - injectable clock proves one-hour safety and exact 90-minute escalation\n'
}

case_supervisor_resolution() {
    local base="$test_root/supervisor-resolution"
    local variant root sender recipient message state rc

    for variant in absent malformed; do
        root="$base/$variant"
        sender="sender.$variant@${HOST}"
        recipient="worker.$variant@${HOST}"
        init_address "$root" "$sender"
        init_address "$root" "$recipient"
        register_address "$root" "$sender" 0 sender-handle >/dev/null
        register_address "$root" "$recipient" 0 recipient-handle >/dev/null
        message="$root/original.eml"
        write_message "$message" "$sender" "$recipient" \
            "<supervisor-$variant@${HOST}>"
        SNO_REACH_ROOT="$root" SNO_REACH_NOW=0 \
            SNO_REACH_SKIP_WAKE_ADOPTION=1 "$mbox" send --no-ring --as "$sender" \
            <"$message" >/dev/null
        if [[ "$variant" == absent ]]; then
            mv "$root/$recipient/seat.json" "$root/$recipient/seat.json.absent"
        else
            printf '%s\n' '{"supervisor":42}' >"$root/$recipient/seat.json"
        fi
        set +e
        SNO_REACH_NOW=0 SNO_REACH_WAKE_NO_DETACH=1 \
            SNO_REACH_WAKE_ATTEMPTS=1 SNO_REACH_WAKE_STANDIN="$standin" \
            SNO_REACH_WAKE_OUTCOME=busy "$wake" start --root "$root" \
            --sender "$sender" --recipient "$recipient" \
            --message-id "<supervisor-$variant@${HOST}>" \
            --work j-reachability-wake --mechanism /missing \
            >"$root/start.out" 2>"$root/start.err"
        rc=$?
        set -e
        assert_eq 0 "$rc" "$variant supervisor initial reached result"
        state="$(find "$root/$recipient/wake-attempts" \
            -name '*.json' -type f)"
        set +e
        SNO_REACH_NOW=5400 "$wake" step --state "$state" >/dev/null
        rc=$?
        set -e
        assert_eq 1 "$rc" "$variant supervisor unresolved status"
        assert_eq supervisor-unresolved "$(jq -r '.state' "$state")" \
            "$variant supervisor is explicit and loud"
        assert_eq 0 "$(find "$root/$sender/new" -type f | wc -l)" \
            "$variant supervisor sends no fallback copy"
        assert_eq 1 "$(pending_wake_attempt_count "$root")" \
            "$variant supervisor remains independently discoverable"
    done
    printf 'ok - absent and malformed supervisor cards stay loud with zero fallback copies\n'
}


case_closed_outcomes() {
    local root="$test_root/outcomes"
    local sender=sender.outcomes@${HOST}
    local recipient=worker.outcomes@${HOST}
    local outcome rc message copy_count state unresolvable_state
    local empty_terminal="$TEST_DIR/fixtures/orca-empty-terminal.sh"

    [[ -x "$wake" ]] || fail "repository wake state machine is executable"
    init_address "$root" "$sender"
    init_address "$root" "$recipient"
    register_address "$root" "$sender" 1000 sender-handle >/dev/null
    register_address "$root" "$recipient" 1000 recipient-handle >/dev/null

    for outcome in stale no-channel failed surprise-v1; do
        message="$root/$outcome.eml"
        write_message "$message" "$sender" "$recipient" \
            "<wake-$outcome@${HOST}>"
        set +e
        SNO_REACH_ROOT="$root" SNO_REACH_NOW=1000 \
            SNO_REACH_SKIP_WAKE_ADOPTION=1 \
            SNO_REACH_WAKE_STANDIN="$standin" \
            SNO_REACH_WAKE_OUTCOME="$outcome" \
            SNO_REACH_WAKE_NO_DETACH=1 \
            env -u ORCA_TAB_ID "$wrapper" send --as "$sender" <"$message" \
            >"$root/$outcome.out" 2>"$root/$outcome.err"
        rc=$?
        set -e
        assert_eq 5 "$rc" "$outcome delivered-but-not-woken status"
        copy_count="$(find "$root/$recipient/new" -type f -print | wc -l)"
        [[ "$copy_count" -ge 1 ]] || fail "$outcome lost the delivered copy"
        state="$(jq -r '.state' "$root/$recipient/wake-attempts/"*.json | tail -n1)"
        assert_eq pending "$state" "$outcome durable pending state"
        assert_contains "$(<"$root/$outcome.err")" 'Do not resend' \
            "$outcome public partial-success diagnostic"
    done

    assert_eq 4 "$(wc -l <"$root/$recipient/wake.log")" \
        "closed outcome attempt count"

    SNO_REACH_NOW=1000 SNO_REACH_SKIP_WAKE_ADOPTION=1 \
        SNO_REACH_ROOT="$root" "$repo_root/lib/reach-reachability" register --root "$root" --as "$recipient" \
        --channel orca --handle missing-terminal --pid "$$" \
        --host test-host >/dev/null
    message="$root/unresolvable.eml"
    write_message "$message" "$sender" "$recipient" \
        '<wake-registered-unresolvable@'"${HOST}"'>'
    set +e
    ORCA_CLI_COMMAND="$empty_terminal" SNO_REACH_ROOT="$root" \
        MAILBOX_DOORBELL_LOG="$root/reach-ring.jsonl" \
        SNO_REACH_NOW=1000 SNO_REACH_SKIP_WAKE_ADOPTION=1 \
        SNO_REACH_WAKE_NO_DETACH=1 env -u ORCA_TAB_ID \
        "$wrapper" send --as "$sender" \
        <"$message" >"$root/unresolvable.out" 2>"$root/unresolvable.err"
    rc=$?
    set -e
    assert_eq 5 "$rc" "registered-but-unresolvable wake status"
    unresolvable_state="$(jq -r --arg id "<wake-registered-unresolvable@${HOST}>" \
        'select(.message_id == $id) |
         [.last_outcome,.reachability_state] | @tsv' \
        "$root/$recipient/wake-attempts/"*.json)"
    assert_eq $'unknown\tregistered-but-unresolvable' "$unresolvable_state" \
        "registered handle resolution differs from unknown wake outcome"
    assert_contains "$(<"$root/unresolvable.err")" \
        'registered-but-unresolvable' \
        "registered-but-unresolvable sender diagnostic"
    assert_contains "$(<"$root/unresolvable.err")" \
        'has not reached a live channel' \
        "registered-but-unresolvable sender sees the loud partial failure"
    jq -s -e --arg recipient "$recipient" '
        length >= 1 and
        all(.[]; .to == $recipient and .outcome == "unresolved" and
            (.detail | contains("no unique live window")))
    ' "$root/reach-ring.jsonl" >/dev/null ||
        fail "unresolved ring measurement: expected failure rows, observed '$(jq -sc . "$root/reach-ring.jsonl" 2>/dev/null || printf unreadable)'"
    assert_eq 5 "$(wc -l <"$root/$recipient/wake.log")" \
        "closed and unresolvable outcome attempt count"
    printf 'ok - closed and unresolvable wake outcomes fail loud without duplicate delivery\n'
}

# A wake that reached a live channel is not a failure and must not be reported
# as one. rang and rang-unverified put the keystroke into the recipient's
# window; busy is a recipient proven awake mid-turn, which
# None of the three is confirmed at send time -- the effect at the destination
# only becomes observable once the recipient acts -- so the attempt must stay
# pending while the sender is told the wake reached its target.
# Three outcomes, not two. A wake that never started has no retry worker and no
# escalation behind it, so reporting it with the same status as a pending retry
# tells the sender a worker is watching a card that nothing is watching. Seats
# that are never rung by design must say so rather than exit silently, because
# after the reached/not-reached split a silent success is indistinguishable from
# a ring that landed.
case_wake_start_failure_is_not_a_pending_retry() {
    local root="$test_root/unstarted"
    local sender=sender.unstarted@${HOST} recipient=worker.unstarted@${HOST}
    local installed="$root/release" wrapper_copy message rc stderr_text reply_source
    init_address "$root" "$sender"
    init_address "$root" "$recipient"
    register_address "$root" "$sender" 1000 sender-handle >/dev/null
    register_address "$root" "$recipient" 1000 recipient-handle >/dev/null
    mkdir -p "$installed"
    cp -a "$repo_root/bin" "$repo_root/lib" "$repo_root/vendor" "$repo_root/guide" "$repo_root/VERSION" "$installed/"
    wrapper_copy="$installed/bin/sno-reach"
    mv "$installed/lib/reach-wake" "$installed/lib/reach-wake.removed"
    message="$root/unstarted.eml"
    write_message "$message" "$sender" "$recipient" '<wake-unstarted@'"${HOST}"'>'
    set +e
    SNO_REACH_ROOT="$root" SNO_REACH_NOW=1000 SNO_REACH_SKIP_WAKE_ADOPTION=1 \
        "$wrapper_copy" send --as "$sender" <"$message" >"$root/unstarted.out" 2>"$root/unstarted.err"
    rc=$?
    set -e
    stderr_text="$(<"$root/unstarted.err")"
    assert_eq 6 "$rc" 'a stored card whose wake never started has its own status'
    assert_contains "$stderr_text" 'wake could not start' 'sender sees missing wake program'
    assert_contains "$stderr_text" 'Do not resend' 'stored card is never resent'
    [[ "$stderr_text" != *'a retry is running'* ]] || fail 'missing wake claimed running retry'
    assert_eq 1 "$(find "$root/$recipient/new" -type f | wc -l)" 'card delivered without wake'
    assert_eq 0 "$(find "$root/$recipient" -path '*/wake-attempts/*.json' -type f | wc -l)" 'missing wake created no attempt'
    reply_source="$(find "$root/$recipient/new" -type f -print -quit)"
    # Accepted report is an explicit progress fixture. The acceptance command
    # itself has independent public tests; this case removes the wake program.
    write_message "$root/$sender/cur/accepted:2,T" "$recipient" "$sender" '<unstarted-accepted@'"${HOST}"'>' status
    sed -i "/^X-Type:/a X-State: accepted\nIn-Reply-To: <wake-unstarted@${HOST}>\nReferences: <wake-unstarted@${HOST}>\nDelivered-To: $sender" "$root/$sender/cur/accepted:2,T"
    set +e
    printf 'Answered.\n' | SNO_REACH_ROOT="$root" SNO_REACH_NOW=1000 SNO_REACH_SKIP_WAKE_ADOPTION=1 \
        "$wrapper_copy" reply --as "$recipient" --card "$reply_source" >"$root/reply.out" 2>"$root/reply.err"
    rc=$?
    set -e
    assert_eq 6 "$rc" 'stored reply with no wake has its own status'
    assert_contains "$(<"$root/reply.err")" 'delivery succeeded' 'reply delivered despite missing wake'
    assert_contains "$(<"$root/reply.err")" 'wake could not start' 'replier sees missing wake program'
    [[ "$(<"$root/reply.err")" != *'a retry is running'* ]] || fail 'reply claimed running retry'
    assert_eq 1 "$(find "$root/$sender/new" -type f | wc -l)" 'reply delivered exactly once'
    printf 'ok - missing wake helper preserves send/reply delivery and refuses false retry claims\n'
}

# An external doorbell on the sender's own send path with no deadline is a hang
# with no signal: the sender blocks forever and the bounded retry that would
# have escalated never gets to run. A timeout must become one ordinary failed
# attempt instead.
case_doorbell_deadline() {
    local root="$test_root/doorbell-deadline"
    local sender=sender.deadline@${HOST}
    local recipient=worker.deadline@${HOST}
    local hanging="$root/hanging-doorbell.sh"
    local message rc state started finished

    init_address "$root" "$sender"
    init_address "$root" "$recipient"
    register_address "$root" "$sender" 1000 sender-handle >/dev/null
    register_address "$root" "$recipient" 1000 recipient-handle >/dev/null
    cat >"$hanging" <<'HANG'
#!/usr/bin/env bash
# A doorbell that never answers, which is what a lock with no timeout looks
# like from the caller's side.
sleep 600
HANG
    chmod 0755 "$hanging"
    message="$root/deadline.eml"
    write_message "$message" "$sender" "$recipient" '<wake-deadline@'"${HOST}"'>'
    SNO_REACH_ROOT="$root" SNO_REACH_NOW=1000 SNO_REACH_SKIP_WAKE_ADOPTION=1 \
        "$mbox" send --no-ring --as "$sender" <"$message" >/dev/null

    started="$SECONDS"
    set +e
    SNO_REACH_ROOT="$root" SNO_REACH_NOW=1000 \
        SNO_REACH_WAKE_MECHANISM_TIMEOUT_SECONDS=2 \
        SNO_REACH_WAKE_NO_DETACH=1 \
        "$wake" start --root "$root" --sender "$sender" \
        --recipient "$recipient" --message-id '<wake-deadline@'"${HOST}"'>' \
        --work j-reachability-wake --mechanism "$hanging" \
        >"$root/deadline.out" 2>"$root/deadline.err"
    rc=$?
    set -e
    finished=$((SECONDS - started))
    ((finished < 60)) ||
        fail "a hanging doorbell was not bounded: returned after ${finished}s"
    assert_eq 5 "$rc" 'a hanging doorbell becomes a pending wake, not a hang'
    state="$(find "$root/$recipient/wake-attempts" -name '*.json' -type f)"
    assert_eq failed "$(jq -r '.last_outcome' "$state")" \
        'a doorbell timeout is recorded as one failed attempt'
    assert_eq pending "$(jq -r '.state' "$state")" \
        'a doorbell timeout leaves the bounded retry able to continue'
    printf 'ok - a doorbell that never answers is bounded into one failed attempt\n'
}

case_reached_outcomes() {
    local root="$test_root/reached"
    local sender=sender.reached@${HOST}
    local recipient=worker.reached@${HOST}
    local echoing_orca="$root/echoing-orca"
    local silent_orca="$root/silent-orca"
    local outcome rc message copy_count state stderr_text orca_command

    [[ -x "$wake" ]] || fail "repository wake state machine is executable"
    init_address "$root" "$sender"
    init_address "$root" "$recipient"
    register_address "$root" "$sender" 1000 sender-handle >/dev/null

    # The stand-in refuses rang and rang-unverified by design: only live
    # recipient evidence may produce them. Both come from the real doorbell
    # here. A terminal that echoes the wake nonce back yields rang; one that
    # reads back empty yields rang-unverified.
    cat >"$echoing_orca" <<'ORCA'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
    'terminal list')
        printf '%s\n' '{"ok":true,"result":{"terminals":[{"tabId":"tab-reached","connected":true,"handle":"term-reached"}]}}'
        ;;
    'terminal wait')
        printf '%s\n' '{"ok":true,"result":{"wait":{"satisfied":true}}}'
        ;;
    'terminal send')
        printf '%s\n' "$*" >>"$ORCA_TRACE"
        printf '%s\n' '{"ok":true,"result":{}}'
        ;;
    'terminal read')
        jq -Rs '{ok:true,result:{terminal:{tail:(split("\n"))}}}' <"$ORCA_TRACE"
        ;;
    *) printf '%s\n' '{"ok":false}' ;;
esac
ORCA
    cat >"$silent_orca" <<'ORCA'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
    'terminal list')
        printf '%s\n' '{"ok":true,"result":{"terminals":[{"tabId":"tab-reached","connected":true,"handle":"term-reached"}]}}'
        ;;
    'terminal wait')
        printf '%s\n' '{"ok":true,"result":{"wait":{"satisfied":true}}}'
        ;;
    'terminal send')
        printf '%s\n' "$*" >>"$ORCA_TRACE"
        printf '%s\n' '{"ok":true,"result":{}}'
        ;;
    'terminal read')
        printf '%s\n' '{"ok":true,"result":{"terminal":{"tail":[]}}}'
        ;;
    *) printf '%s\n' '{"ok":false}' ;;
esac
ORCA
    chmod 0755 "$echoing_orca" "$silent_orca"

    for outcome in rang rang-unverified busy; do
        message="$root/$outcome.eml"
        write_message "$message" "$sender" "$recipient" \
            "<wake-reached-$outcome@${HOST}>"
        rm -f -- "$root/$recipient/reachable.json"
        set +e
        if [[ "$outcome" == busy ]]; then
            SNO_REACH_SKIP_WAKE_ADOPTION=1 SNO_REACH_ROOT="$root" \
                SNO_REACH_NOW=1000 "$repo_root/lib/reach-reachability" register --root "$root" --as "$recipient" \
                --channel fixture --handle reached-handle --pid "$$" \
                --host fixture-host >/dev/null
            SNO_REACH_ROOT="$root" SNO_REACH_NOW=1000 \
                SNO_REACH_SKIP_WAKE_ADOPTION=1 \
                SNO_REACH_WAKE_STANDIN="$standin" \
                SNO_REACH_WAKE_OUTCOME=busy \
                SNO_REACH_WAKE_NO_DETACH=1 \
                env -u ORCA_TAB_ID "$wrapper" send --as "$sender" \
                <"$message" >"$root/$outcome.out" 2>"$root/$outcome.err"
        else
            : >"$root/$outcome.trace"
            if [[ "$outcome" == rang ]]; then
                orca_command="$echoing_orca"
            else
                orca_command="$silent_orca"
            fi
            SNO_REACH_SKIP_WAKE_ADOPTION=1 SNO_REACH_ROOT="$root" \
                SNO_REACH_NOW=1000 "$repo_root/lib/reach-reachability" register --root "$root" --as "$recipient" \
                --channel orca --handle term-reached \
                --identity-kind orca-tab --identity tab-reached \
                --pid "$$" --host fixture-host >/dev/null
            ORCA_TRACE="$root/$outcome.trace" \
                ORCA_CLI_COMMAND="$orca_command" \
                SNO_REACH_ROOT="$root" SNO_REACH_NOW=1000 \
                SNO_REACH_SKIP_WAKE_ADOPTION=1 \
                SNO_REACH_WAKE_NO_DETACH=1 \
                env -u ORCA_TAB_ID "$wrapper" send --as "$sender" \
                <"$message" >"$root/$outcome.out" 2>"$root/$outcome.err"
        fi
        rc=$?
        set -e
        stderr_text="$(<"$root/$outcome.err")"
        if ((rc != 0)); then
            sed 's/^/reached-stderr: /' "$root/$outcome.err" >&2
        fi
        assert_eq 0 "$rc" "$outcome delivered-and-reached status"
        copy_count="$(find "$root/$recipient/new" -type f -print | wc -l)"
        [[ "$copy_count" -ge 1 ]] || fail "$outcome lost the delivered copy"
        state="$(jq -r --arg id "<wake-reached-$outcome@${HOST}>" \
            'select(.message_id == $id) | [.state, .last_outcome] | @tsv' \
            "$root/$recipient/wake-attempts/"*.json)"
        assert_eq "$(printf 'pending\t%s' "$outcome")" "$state" \
            "$outcome stays pending on its own recorded outcome"
        assert_contains "$stderr_text" "wake $outcome reached" \
            "$outcome sender diagnostic names the reached channel"
        assert_contains "$stderr_text" 'Do not resend' \
            "$outcome still refuses a resend"
        [[ "$stderr_text" != *'wake failed'* ]] ||
            fail "$outcome reported a reached wake as a failure"
        [[ "$stderr_text" != *'has not reached'* ]] ||
            fail "$outcome reported a reached wake as unreached"
    done

    assert_eq 3 "$(wc -l <"$root/$recipient/wake.log")" \
        "reached outcome attempt count"
    printf 'ok - wake outcomes that reached a live channel report success and stay pending\n'
}

case_executor_wake() {
    local root="$test_root/executor-wake"
    local sender=sender.executor-wake@${HOST}
    local recipient=executor.wake@${HOST}
    local doorbell="$repo_root/lib/reach-ring"
    local fake_orca="$root/fake-orca"
    local trace="$root/orca.trace"
    local rc state

    init_address "$root" "$sender"
    init_address "$root" "$recipient" supervisor.test@"${HOST}" executor-wake
    cat >"$fake_orca" <<'ORCA'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
    'terminal list')
        printf '%s\n' '{"ok":true,"result":{"terminals":[{"tabId":"tab-executor","connected":true,"handle":"term-executor"}]}}'
        ;;
    'terminal wait')
        printf '%s\n' '{"ok":true,"result":{"wait":{"satisfied":true}}}'
        ;;
    'terminal send')
        printf '%s\n' "$*" >>"$ORCA_TRACE"
        printf '%s\n' '{"ok":true,"result":{}}'
        ;;
    'terminal read')
        printf '%s\n' '{"ok":true,"result":{"terminal":{"tail":[]}}}'
        ;;
    *) printf '%s\n' '{"ok":false}' ;;
esac
ORCA
    chmod 0755 "$fake_orca"
    SNO_REACH_SKIP_WAKE_ADOPTION=1 SNO_REACH_ROOT="$root" SNO_REACH_NOW=1000 \
        "$repo_root/lib/reach-reachability" register --root "$root" --as "$recipient" --channel orca \
        --handle stale-executor-handle --identity-kind orca-tab \
        --identity tab-executor --pid "$$" --host fixture-host >/dev/null
    set +e
    ORCA_TRACE="$trace" ORCA_CLI_COMMAND="$fake_orca" \
        SNO_REACH_ROOT="$root" SNO_REACH_NOW=1000 \
        SNO_REACH_WAKE_NO_DETACH=1 "$wake" start --root "$root" \
        --sender "$sender" --recipient "$recipient" \
        --message-id '<executor-wake@'"${HOST}"'>' \
        --work j-reachability-wake --mechanism "$doorbell" \
        >"$root/start.out" 2>"$root/start.err"
    rc=$?
    set -e
    assert_eq 0 "$rc" 'executor wake reached its terminal'
    state="$(find "$root/$recipient/wake-attempts" -name '*.json' -type f)"
    assert_eq pending "$(jq -r '.state' "$state")" \
        'executor wake awaits a mailbox effect'
    assert_eq rang-unverified "$(jq -r '.last_outcome' "$state")" \
        'executor wake is submitted but not self-confirmed'
    assert_eq 1 "$(jq -s '[.[] | select(.event == "attempt" and
        .outcome == "rang-unverified")] | length' \
        "$root/$recipient/wake.log")" \
        'executor wake has one durable pending attempt'
    assert_eq 2 "$(grep -c '^terminal send ' "$trace")" \
        'executor wake submits body and Enter to its registered terminal'
    jq -e --arg recipient "$recipient" '
        .to == $recipient and .outcome == "rang-unverified"
    ' "$root/reach-ring.jsonl" >/dev/null ||
        fail 'executor wake measurement is rang-unverified'
    printf 'ok - a registered executor is rung and remains pending until mailbox effect\n'
}

case_doorbell_measurement() {
    local root="$test_root/doorbell-measurement"
    local recipient=executor.measurement@${HOST}
    local sender=tpm.measurement@${HOST}
    local message_id='<doorbell-measurement@'"${HOST}"'>'
    local measurement="$root/reach-ring.jsonl"
    local doorbell="$repo_root/lib/reach-ring"
    local fake_orca="$root/fake-orca"

    mkdir -p "$root"
    init_address "$root" "$recipient"
    cat >"$fake_orca" <<'ORCA'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
    'terminal list') printf '%s\n' '{"ok":true,"result":{"terminals":[{"tabId":"tab-measurement","connected":true,"handle":"term-measurement"}]}}' ;;
    'terminal wait') printf '%s\n' '{"ok":true,"result":{"wait":{"satisfied":true}}}' ;;
    'terminal send') printf '%s\n' '{"ok":true,"result":{}}' ;;
    'terminal read') printf '%s\n' '{"ok":true,"result":{"terminal":{"tail":[]}}}' ;;
    *) printf '%s\n' '{"ok":false}' ;;
esac
ORCA
    chmod 0755 "$fake_orca"
    SNO_REACH_SKIP_WAKE_ADOPTION=1 SNO_REACH_ROOT="$root" \
        "$repo_root/lib/reach-reachability" register --root "$root" --as "$recipient" --channel orca \
        --handle term-measurement --identity-kind orca-tab \
        --identity tab-measurement --pid "$$" --host fixture-host >/dev/null
    ORCA_CLI_COMMAND="$fake_orca" SNO_REACH_ROOT="$root" \
        MAILBOX_DOORBELL_LOG="$measurement" \
        "$doorbell" doorbell --to "$recipient" --from "$sender" \
        --msg-id "$message_id" >"$root/doorbell.out" 2>"$root/doorbell.err"
    assert_contains "$(<"$root/doorbell.out")" 'outcome=rang-unverified' \
        'executor measurement doorbell outcome'
    assert_eq 1 "$(wc -l <"$measurement")" \
        'one valid doorbell outcome emits exactly one aggregate row'
    jq -e --arg recipient "$recipient" --arg sender "$sender" \
        --arg message_id "$message_id" --arg root "$root" '
        .to == $recipient and .from == $sender and
        .msg_id == $message_id and .mailbox == $root and
        .outcome == "rang-unverified" and
        (.ts_utc | type == "string" and length > 0)
    ' "$measurement" >/dev/null ||
        fail 'aggregate row preserves the compatible doorbell measurement fields'

    printf 'ok - every valid doorbell outcome emits one fleet aggregate row\n'
}

case_four_report_incident() {
    local root="$test_root/four-report"
    local sender=executor.unheard@${HOST}
    local recipient=tpm.unheard@${HOST}
    local supervisor=supervisor.live@${HOST}
    local message rc index sender_actor_pid supervisor_actor_pid adopter_one adopter_two
    local retry_child retry_state temporary
    local actor="$TEST_DIR/fixtures/wake-supervisor-actor.sh"

    [[ -x "$wake" ]] || fail "repository wake state machine is executable"
    init_address "$root" "$sender" "$supervisor" Fixture
    init_address "$root" "$recipient" "$supervisor"
    init_address "$root" "$supervisor" "$supervisor"
    register_address "$root" "$sender" 0 sender-handle >/dev/null
    register_address "$root" "$recipient" 0 recipient-handle >/dev/null
    register_address "$root" "$supervisor" 0 supervisor-handle >/dev/null

    for index in 1 2 3 4; do
        message="$root/report-$index.eml"
        write_message "$message" "$sender" "$recipient" \
            "<unheard-report-$index@${HOST}>" decision
        set +e
        if ((index == 1)); then
            SNO_REACH_ROOT="$root" SNO_REACH_NOW=0 \
                SNO_REACH_SKIP_WAKE_ADOPTION=1 \
                SNO_REACH_WAKE_STANDIN="$standin" \
                SNO_REACH_WAKE_OUTCOME=busy \
                env -u ORCA_TAB_ID "$wrapper" send --as "$sender" <"$message" \
                >"$root/report-$index.out" 2>"$root/report-$index.err"
        else
            SNO_REACH_ROOT="$root" SNO_REACH_NOW=0 \
                SNO_REACH_SKIP_WAKE_ADOPTION=1 \
                SNO_REACH_WAKE_STANDIN="$standin" \
                SNO_REACH_WAKE_OUTCOME=busy SNO_REACH_WAKE_NO_DETACH=1 \
                env -u ORCA_TAB_ID "$wrapper" send --as "$sender" <"$message" \
                >"$root/report-$index.out" 2>"$root/report-$index.err"
        fi
        rc=$?
        set -e
        # busy reached a live channel, so the send reports success. The card is
        # still unread, so the attempt must stay pending and still escalate.
        if ((rc != 0)); then
            sed 's/^/unheard-report-stderr: /' "$root/report-$index.err" >&2
        fi
        assert_eq 0 "$rc" "unheard report $index reached-but-unread wake status"
        assert_contains "$(<"$root/report-$index.err")" 'Do not resend' \
            "unheard report $index still refuses a resend"
        if ((index == 1)); then
            retry_state="$(jq -r \
                'select(.message_id == "<unheard-report-1@'"${HOST}"'>") | input_filename' \
                "$root/$recipient/wake-attempts/"*.json)"
            retry_child="$(jq -r '.child_pid' "$retry_state")"
            kill "$retry_child"
            for _ in {1..100}; do
                kill -0 "$retry_child" 2>/dev/null || break
                sleep 0.01
            done
            ! kill -0 "$retry_child" 2>/dev/null ||
                fail "detached retry child did not stop"
        fi
    done

    assert_eq 4 "$(find "$root/$recipient/new" -type f | wc -l)" \
        "four reports remain delivered exactly once"
    assert_eq 4 "$(find "$root/$recipient/wake-attempts" -type f \
        -name '*.json' | wc -l)" \
        "four reports each have independent durable pending evidence"
    assert_eq 4 "$(wc -l <"$root/$recipient/wake.log")" \
        "four initial wake outcomes are independently loud"

    for retry_state in "$root/$recipient/wake-attempts/"*.json; do
        temporary="$retry_state.tmp"
        jq '.attempt=.max_attempts |
            .last_at=(.started_at + .bound_seconds) |
            .last_outcome="failed"' "$retry_state" >"$temporary"
        mv -- "$temporary" "$retry_state"
    done

    assert_eq 4 "$(pending_wake_attempt_count "$root")" \
        "independent supervisor discovery sees every silent report"

    MBOX_COMMAND="$mbox" "$actor" "$root" "$sender" 4 \
        "$root/sender-handled.ids" >"$root/sender-actor.out" \
        2>"$root/sender-actor.err" &
    sender_actor_pid=$!
    MBOX_COMMAND="$mbox" "$actor" "$root" "$supervisor" 4 \
        "$root/supervisor-handled.ids" >"$root/supervisor-actor.out" \
        2>"$root/supervisor-actor.err" &
    supervisor_actor_pid=$!
    [[ "$sender_actor_pid" != "$supervisor_actor_pid" ]] ||
        fail "sender and supervisor actors share one PID"
    kill -0 "$sender_actor_pid" && kill -0 "$supervisor_actor_pid" ||
        fail "sender and supervisor actors are not simultaneously live"
    SNO_REACH_NOW=5401 "$wake" adopt --root "$root" &
    adopter_one=$!
    SNO_REACH_NOW=5401 "$wake" adopt --root "$root" &
    adopter_two=$!
    wait "$adopter_one" || fail "first orphan adopter failed"
    wait "$adopter_two" || fail "second orphan adopter failed"
    wait "$sender_actor_pid" || fail "live sender actor did not handle four escalations"
    wait "$supervisor_actor_pid" ||
        fail "live supervisor actor did not handle four escalations"
    assert_eq 4 "$(wc -l <"$root/sender-handled.ids")" \
        "live sender message-specific handled effects"
    assert_eq 4 "$(wc -l <"$root/supervisor-handled.ids")" \
        "live supervisor message-specific handled effects"
    assert_eq 4 "$(wc -l <"$root/$sender/dismissals.jsonl")" \
        "original sender receives and handles four loud escalations"
    assert_eq 4 "$(jq -r '.state' "$root/$recipient/wake-attempts/"*.json | \
        grep -c '^escalated$')" \
        "each unheard report reaches one terminal escalation"

    printf 'ok - four unheard reports become durable and independently handled alarms\n'
}

case_outbox_recovery() {
    local root="$test_root/outbox-recovery"
    local sender=agent.questioner@${HOST} worker=agent.worker@${HOST}
    local second=agent.second@${HOST}
    local supervisor=supervisor.retry@${HOST}
    local message="$root/question.eml" source entry state rc step queued_hash
    local registration_now worker_ready supervisor_ready
    local sender_actor supervisor_actor registered_pid

    init_address "$root" "$sender" "$supervisor"
    init_address "$root" "$worker" "$supervisor"
    init_address "$root" "$second" "$supervisor"
    init_address "$root" "$supervisor" "$supervisor"
    registration_now="$(date -u +%s)"
    register_address "$root" "$sender" "$registration_now" sender-handle >/dev/null
    register_address "$root" "$second" "$registration_now" second-handle >/dev/null
    if [[ "${REACHABILITY_WAKE_EXPECT_PARENT_OWNED_ACTORS:-0}" == 1 ]]; then
        register_address "$root" "$worker" "$registration_now" parent-worker >/dev/null
        register_address "$root" "$supervisor" "$registration_now" parent-supervisor >/dev/null
        assert_eq "$$" "$(jq -r '.by.pid' "$root/$worker/reachable.json")" \
            'planted worker registration belongs to parent'
        assert_eq "$$" "$(jq -r '.by.pid' "$root/$supervisor/reachable.json")" \
            'planted supervisor registration belongs to parent'
        printf 'plant_observable=parent-owned-live-actor-registrations\n'
        return
    fi
    worker_ready="$root/worker.ready"
    supervisor_ready="$root/supervisor.ready"
    REACHABILITY_WAKE_MBOX="$mbox" "$0" --outbox-observer-actor \
        "$root" "$worker" 2 "$root/worker-handled.ids" "$worker_ready" \
        >"$root/worker-actor.out" 2>"$root/worker-actor.err" &
    sender_actor=$!
    REACHABILITY_WAKE_MBOX="$mbox" "$0" --outbox-observer-actor \
        "$root" "$supervisor" 2 "$root/supervisor-handled.ids" "$supervisor_ready" \
        >"$root/supervisor-actor.out" 2>"$root/supervisor-actor.err" &
    supervisor_actor=$!
    wait_for_file "$worker_ready"
    wait_for_file "$supervisor_ready"
    registered_pid="$(jq -r '.by.pid' "$root/$worker/reachable.json")"
    assert_eq "$sender_actor" "$registered_pid" 'reply sender owns its registration'
    registered_pid="$(jq -r '.by.pid' "$root/$supervisor/reachable.json")"
    assert_eq "$supervisor_actor" "$registered_pid" 'sender supervisor owns its registration'
    kill -0 "$sender_actor" && kill -0 "$supervisor_actor" ||
        fail 'outbox actors do not hold their own seats'
    write_message "$message" "$sender" "$worker" '<outbox-recovery@'"${HOST}"'>'
    sed -i "/^Subject:/iReply-To: $sender, $second" "$message"
    SNO_REACH_SKIP_WAKE_ADOPTION=1 SNO_REACH_ROOT="$root" \
        "$mbox" send --no-ring --as "$sender" <"$message" >/dev/null
    source="$(find "$root/$worker/new" -type f -print -quit)"
    [[ -f "$source" ]] || fail 'outbox recovery source was not delivered'
    write_message "$root/$sender/cur/accepted:2,T" "$worker" "$sender" '<recovery-accepted@'"${HOST}"'>' status
    sed -i "/^X-Type:/a X-State: accepted\nIn-Reply-To: <outbox-recovery@${HOST}>\nReferences: <outbox-recovery@${HOST}>\nDelivered-To: $sender" "$root/$sender/cur/accepted:2,T"
    local failed_release="$root/failed-release"
    mkdir -p "$failed_release"
    cp -a "$repo_root/bin" "$repo_root/lib" "$repo_root/vendor" "$repo_root/guide" "$repo_root/VERSION" "$failed_release/"
    mv "$failed_release/lib/reach-deliver" "$failed_release/lib/reach-deliver.real"
    cp "$TEST_DIR/fixtures/fail-local-delivery.sh" "$failed_release/lib/reach-deliver"
    chmod +x "$failed_release/lib/reach-deliver"
    set +e
    printf 'Automatic recovery reply\n' | \
        REACH_TEST_FAIL_NEW="$root/$sender/new"$'\n'"$root/$second/new" \
        SNO_REACH_NOW=0 SNO_REACH_WAKE_NO_DETACH=1 SNO_REACH_ROOT="$root" \
        "$failed_release/bin/sno-reach" reply --as "$worker" --card "$source" \
        >"$root/reply.out" 2>"$root/reply.err"
    rc=$?
    set -e
    assert_eq 74 "$rc" 'failed reply reports queued recovery status'
    assert_contains "$(<"$root/reply.err")" 'queued copies remaining: 2' \
        'failed reply queued-copy count'
    assert_contains "$(<"$root/reply.err")" \
        "flush exactly: SNO_REACH_ROOT=$root sno reach flush --as $worker" \
        'failed reply exact flush command'
    entry="$(find "$root/$worker/outbox" -mindepth 1 -maxdepth 1 -type d -print -quit)"
    state="$(find "$root" -path '*/wake-attempts/*.json' -type f -print -quit)"
    if [[ "${REACHABILITY_WAKE_EXPECT_NO_RECOVERY:-0}" == 1 ]]; then
        [[ -d "$entry" && -z "$state" ]] ||
            fail 'disconnected outbox scheduler unexpectedly produced recovery state'
        printf 'plant_observable=queued-copy-has-no-recovery-state\n'
        return
    fi
    [[ -d "$entry" && -f "$state" ]] ||
        fail 'failed reply did not start durable outbox recovery'
    assert_eq 1 "$(find "$root" -path '*/wake-attempts/*.json' -type f | wc -l)" \
        'one multi-recipient entry starts exactly one recovery coordinator'
    assert_eq outbox "$(jq -r .mode "$state")" 'outbox recovery mode'
    assert_eq pending "$(jq -r .state "$state")" 'outbox recovery initial state'
    queued_hash="$(sha256sum "$entry/message" | cut -d ' ' -f 1)"

    : >"$root/observers-start"
    for step in $(seq 1 6); do
        set +e
        SNO_REACH_WAKE_STANDIN="$standin" SNO_REACH_WAKE_OUTCOME=busy \
        SNO_REACH_NOW="$((step * 60))" "$wake" step --state "$state" \
            >"$root/step-$step.out" 2>"$root/step-$step.err"
        rc=$?
        set -e
        if ((step < 6)); then
            assert_eq 4 "$rc" "outbox retry step $step remains pending"
        else
            assert_eq 0 "$rc" 'outbox retry reaches bounded escalation'
        fi
    done
    assert_eq escalated "$(jq -r .state "$state")" 'outbox recovery terminal state'
    assert_eq 6 "$(jq -r .attempt "$state")" \
        'outbox six-attempt bound includes the sixth retry'
    assert_eq "$queued_hash" "$(sha256sum "$entry/message" | cut -d ' ' -f 1)" \
        'undelivered reply bytes retained'
    assert_eq "$sender"$'\n'"$second" "$(<"$entry/recipients")" \
        'removed recipients remain queued'
    wait "$sender_actor" || fail 'live reply sender did not handle escalation'
    wait "$supervisor_actor" || fail 'live supervisor did not handle escalation'
    assert_eq 2 "$(wc -l <"$root/worker-handled.ids")" \
        'live reply sender observed both escalations'
    assert_eq 2 "$(wc -l <"$root/supervisor-handled.ids")" \
        'live supervisor observed both escalations'
    printf 'ok - failed reply uses six one-minute attempts, live actor-owned seats, and retained bytes\n'
}

prepare_focused_outbox() {
    local root="$1" sender="$2" message_id="$3" attempts="$4"
    shift 4
    local recipient first=1

    # Escalation reports now use the same registered-recipient public send path.
    # Register only observers; original queued destinations remain unavailable.
    register_observer "$root" "$sender"
    while IFS= read -r observer; do
        [[ -n "$observer" && "$observer" != "$sender" ]] || continue
        [[ -f "$root/$observer/seat.json" ]] || continue
        local queued=0
        for recipient in "$@"; do [[ "$observer" != "$recipient" ]] || queued=1; done
        ((queued)) || register_observer "$root" "$observer"
    done < <(find "$root" -name seat.json -type f -exec jq -r '.supervisor' {} + | sort -u)

    FOCUSED_ENTRY="$root/$sender/outbox/$(printf '%s' "$message_id" | \
        sha256sum | cut -c1-32)"
    mkdir -p -- "$FOCUSED_ENTRY"
    {
        printf 'From: Sender <%s>\n' "$sender"
        printf 'To: '
        for recipient in "$@"; do
            ((first == 1)) || printf ', '
            printf '%s' "$recipient"
            first=0
        done
        printf '\nSubject: [QUESTION] Focused outbox recovery\n'
        printf 'Date: Fri, 01 Aug 2026 00:00:00 +0000\n'
        printf 'Message-ID: %s\n' "$message_id"
        printf 'X-Work: j-reachability-wake\n'
        printf 'X-Type: question\n'
        printf '\nFocused outbox recovery fixture.\n'
    } >"$FOCUSED_ENTRY/message"
    printf '%s\n' "$@" >"$FOCUSED_ENTRY/recipients"
    if SNO_REACH_NOW=0 SNO_REACH_WAKE_NO_DETACH=1 \
            SNO_REACH_WAKE_ATTEMPTS="$attempts" \
            "$wake" start --root "$root" --sender "$sender" \
            --recipient "$1" --message-id "$message_id" \
            --work j-reachability-wake --mechanism '' \
            --outbox-entry "$FOCUSED_ENTRY" >/dev/null 2>"$root/start.err"; then
        fail 'focused outbox fixture unexpectedly completed'
    else
        assert_eq 5 "$?" 'focused outbox fixture pending status'
    fi
    local state_owner="$sender"
    [[ "${REACHABILITY_WAKE_EXPECT_RECIPIENT_OWNED_STATE:-0}" != 1 ]] ||
        state_owner="$1"
    FOCUSED_STATE="$(find "$root/$state_owner/wake-attempts" \
        -type f -name '*.json' -print -quit)"
    [[ -f "$FOCUSED_STATE" ]] || fail 'focused outbox fixture has no state'
}

case_outbox_partial_delivery() {
    local root="$test_root/outbox-partial-delivery"
    local sender=sender.partial@${HOST} first=recipient.first@${HOST}
    local second=recipient.second@${HOST} supervisor=supervisor.partial@${HOST} rc

    init_address "$root" "$sender" "$supervisor"
    init_address "$root" "$first" "$supervisor"
    init_address "$root" "$second" "$supervisor"
    init_address "$root" "$supervisor" "$supervisor"
    rmdir -- "$root/$first/new" "$root/$second/new"
    prepare_focused_outbox "$root" "$sender" '<outbox-partial@'"${HOST}"'>' 45 \
        "$first" "$second"
    mkdir -- "$root/$first/new"
    if SNO_REACH_SKIP_WAKE_ADOPTION=1 SNO_REACH_ROOT="$root" SNO_REACH_OUTBOX_ENTRY="$FOCUSED_ENTRY" \
        "$mbox" flush --as "$sender" \
            >/dev/null; then
        rc=0
    else
        rc=$?
    fi
    assert_eq 1 "$rc" 'partial flush reports one remaining recipient'
    assert_eq "$second" "$(<"$FOCUSED_ENTRY/recipients")" \
        'partial flush retains only the unavailable recipient'
    if SNO_REACH_NOW=120 "$wake" step --state "$FOCUSED_STATE" >/dev/null; then
        rc=0
    else
        rc=$?
    fi
    if [[ "${REACHABILITY_WAKE_EXPECT_PARTIAL_FALSE_SUCCESS:-0}" == 1 ]]; then
        assert_eq 0 "$rc" 'planted partial delivery falsely completes'
        assert_eq confirmed "$(jq -r .state "$FOCUSED_STATE")" \
            'planted partial delivery confirms the whole entry'
        assert_eq "$second" "$(<"$FOCUSED_ENTRY/recipients")" \
            'planted partial delivery leaves one recipient queued'
        printf 'plant_observable=partial-delivery-confirmed-with-recipient-still-queued\n'
        return
    fi
    assert_eq 4 "$rc" 'partial delivery remains pending'
    assert_eq pending "$(jq -r .state "$FOCUSED_STATE")" \
        'partial delivery does not confirm the whole entry'
    assert_eq "$second" "$(<"$FOCUSED_ENTRY/recipients")" \
        'only the unavailable recipient remains queued'
    assert_eq 1 "$(find "$root/$first/new" -type f | wc -l)" \
        'deliverable recipient receives its copy'
    printf 'ok - partial delivery keeps recovery active for the remaining recipient\n'
}

case_outbox_elapsed_only() {
    local root="$test_root/outbox-elapsed-only"
    local sender=sender.elapsed@${HOST} recipient=recipient.elapsed@${HOST}
    local supervisor=supervisor.elapsed@${HOST} rc

    init_address "$root" "$sender" "$supervisor"
    init_address "$root" "$recipient" "$supervisor"
    init_address "$root" "$supervisor" "$supervisor"
    rmdir -- "$root/$recipient/new"
    prepare_focused_outbox "$root" "$sender" '<outbox-elapsed@'"${HOST}"'>' 45 \
        "$recipient"
    if SNO_REACH_NOW=360 "$wake" step --state "$FOCUSED_STATE" >/dev/null; then
        rc=0
    else
        rc=$?
    fi
    if [[ "${REACHABILITY_WAKE_EXPECT_ELAPSED_PENDING:-0}" == 1 ]]; then
        assert_eq 4 "$rc" 'planted elapsed-only limit stays pending'
        assert_eq pending "$(jq -r .state "$FOCUSED_STATE")" \
            'planted elapsed-only limit is not terminal'
        printf 'plant_observable=elapsed-limit-alone-did-not-escalate\n'
        return
    fi
    assert_eq 0 "$rc" 'elapsed-only bound escalates'
    assert_eq escalated "$(jq -r .state "$FOCUSED_STATE")" \
        'elapsed-only bound is terminal'
    assert_eq 1 "$(jq -r .attempt "$FOCUSED_STATE")" \
        'elapsed-only boundary performs its scheduled retry before escalation'
    assert_eq 1 "$(find "$root/$sender/new" -type f | wc -l)" \
        'elapsed-only bound notifies sender'
    printf 'ok - elapsed limit alone escalates before another retry\n'
}

case_outbox_count_only() {
    local root="$test_root/outbox-count-only"
    local sender=sender.count@${HOST} recipient=recipient.count@${HOST}
    local supervisor=supervisor.count@${HOST} rc

    init_address "$root" "$sender" "$supervisor"
    init_address "$root" "$recipient" "$supervisor"
    init_address "$root" "$supervisor" "$supervisor"
    rmdir -- "$root/$recipient/new"
    prepare_focused_outbox "$root" "$sender" '<outbox-count@'"${HOST}"'>' 1 \
        "$recipient"
    if SNO_REACH_NOW=60 "$wake" step --state "$FOCUSED_STATE" >/dev/null; then
        rc=0
    else
        rc=$?
    fi
    if [[ "${REACHABILITY_WAKE_EXPECT_COUNT_PENDING:-0}" == 1 ]]; then
        assert_eq 4 "$rc" 'planted count-only limit stays pending'
        assert_eq pending "$(jq -r .state "$FOCUSED_STATE")" \
            'planted count-only limit is not terminal'
        printf 'plant_observable=count-limit-alone-did-not-escalate\n'
        return
    fi
    assert_eq 0 "$rc" 'count-only bound escalates'
    assert_eq escalated "$(jq -r .state "$FOCUSED_STATE")" \
        'count-only bound is terminal'
    assert_eq 1 "$(jq -r .attempt "$FOCUSED_STATE")" \
        'count-only bound stops at configured count'
    assert_eq 1 "$(find "$root/$sender/new" -type f | wc -l)" \
        'count-only bound notifies sender'
    printf 'ok - attempt limit alone escalates before elapsed limit\n'
}

case_outbox_mixed_supervisors() {
    local root="$test_root/outbox-mixed-supervisors"
    local sender=sender.mixed@${HOST} valid=recipient.valid@${HOST}
    local unresolved=recipient.unresolved@${HOST} supervisor=supervisor.valid@${HOST}
    local rc valid_card unresolved_card

    init_address "$root" "$sender" "$supervisor"
    init_address "$root" "$valid" "$supervisor"
    init_address "$root" "$unresolved" "$supervisor"
    init_address "$root" "$supervisor" "$supervisor"
    rm -- "$root/$unresolved/seat.json"
    rmdir -- "$root/$valid/new" "$root/$unresolved/new"
    prepare_focused_outbox "$root" "$sender" '<outbox-mixed@'"${HOST}"'>' 45 \
        "$valid" "$unresolved"
    if SNO_REACH_NOW=360 "$wake" step --state "$FOCUSED_STATE" >/dev/null; then
        rc=0
    else
        rc=$?
    fi
    if [[ "${REACHABILITY_WAKE_EXPECT_SUPERVISOR_SUPPRESSION:-0}" == 1 ]]; then
        assert_eq 1 "$rc" 'planted missing supervisor suppresses escalation'
        assert_eq supervisor-unresolved "$(jq -r .state "$FOCUSED_STATE")" \
            'planted mixed-supervisor entry is globally unresolved'
        assert_eq 0 "$(find "$root/$sender/new" -type f | wc -l)" \
            'planted sender receives no recipient status'
        assert_eq 0 "$(find "$root/$supervisor/new" -type f | wc -l)" \
            'planted valid supervisor receives no status'
        printf 'plant_observable=one-missing-supervisor-suppressed-all-status-cards\n'
        return
    fi
    assert_eq 0 "$rc" 'mixed-supervisor exhaustion escalates'
    assert_eq escalated "$(jq -r .state "$FOCUSED_STATE")" \
        'mixed-supervisor exhaustion is terminal'
    assert_eq 2 "$(find "$root/$sender/new" -type f | wc -l)" \
        'sender receives one status per unresolved recipient'
    assert_eq 2 "$(find "$root/$supervisor/new" -type f | wc -l)" \
        'sender supervisor receives one status per unresolved recipient'
    assert_eq '[]' \
        "$(jq -c .unresolved_supervisors "$FOCUSED_STATE")" \
        'removed recipient supervisor does not affect sender-owned routing'
    valid_card="$(find "$root/$sender/new" -type f -exec grep -l \
        'Recipient: recipient.valid@'"${HOST}"'' {} +)"
    unresolved_card="$(find "$root/$sender/new" -type f -exec grep -l \
        'Recipient: recipient.unresolved@'"${HOST}"'' {} +)"
    [[ -f "$valid_card" && -f "$unresolved_card" ]] ||
        fail 'sender escalation cards do not cover both recipients'
    printf 'ok - recipient supervisor absence does not suppress sender-owned escalation routing\n'
}

case_outbox_stalled_flush() {
    local root="$test_root/outbox-stalled-flush"
    local sender=sender.stalled@${HOST} recipient=recipient.stalled@${HOST}
    local supervisor=supervisor.stalled@${HOST} commands clock rc

    init_address "$root" "$sender" "$supervisor"
    init_address "$root" "$recipient" "$supervisor"
    init_address "$root" "$supervisor" "$supervisor"
    rmdir -- "$root/$recipient/new"
    prepare_focused_outbox "$root" "$sender" '<outbox-stalled@'"${HOST}"'>' 45 \
        "$recipient"
    commands="$root/release/bin"
    mkdir -p -- "$root/release"
    cp -a -- "$repo_root/bin" "$repo_root/lib" "$repo_root/vendor" "$repo_root/guide" "$repo_root/VERSION" "$root/release/"
    mv -- "$commands/sno-reach" "$commands/sno-reach.real"
    cat >"$commands/sno-reach" <<EOF
#!/usr/bin/env bash
if [[ "\${1:-}" == flush && ! -e "$root/stall-started" ]]; then
    : >"$root/stall-started"
    bash -c 'trap "" TERM; while :; do sleep 1; done' &
    printf '%s\n' "\$!" >"$root/stall-child.pid"
    trap '' TERM
    wait
fi
# This inherited timeout isolates outbox recovery; public delivery-plus-ring is
# covered separately. Real send still validates, stages and delivers the report.
if [[ "\${1:-}" == send ]]; then shift; exec "$commands/sno-reach.real" send --no-ring "\$@"; fi
exec "$commands/sno-reach.real" "\$@"
EOF
    chmod 700 "$commands/sno-reach" "$commands/../lib/reach-wake"
    clock="$root/clock"
    cat >"$clock" <<EOF
#!/usr/bin/env bash
if [[ -e "$root/clock-read" ]]; then printf '360\\n'; else : >"$root/clock-read"; printf '359\\n'; fi
EOF
    chmod 700 "$clock"
    if timeout --signal=TERM --kill-after=1 4 env SNO_REACH_NOW_COMMAND="$clock" \
            "$commands/../lib/reach-wake" step --state "$FOCUSED_STATE" >/dev/null; then
        rc=0
    else
        rc=$?
    fi
    if [[ "${REACHABILITY_WAKE_EXPECT_STALLED_FLUSH:-0}" == 1 ]]; then
        assert_eq 124 "$rc" 'planted stalled flush exceeds its deadline'
        printf 'plant_observable=stalled-flush-outlived-remaining-deadline\n'
        return
    fi
    assert_eq 0 "$rc" 'stalled flush reaches elapsed escalation'
    assert_eq escalated "$(jq -r .state "$FOCUSED_STATE")" \
        'stalled flush is terminal after deadline'
    if [[ -s "$root/stall-child.pid" ]]; then
        ! kill -0 "$(<"$root/stall-child.pid")" 2>/dev/null ||
            fail 'TERM-resistant flush child survived its absolute deadline'
    fi
    printf 'ok - stalled flush is terminated at the remaining elapsed deadline\n'
}

case_outbox_status_delivery_failure() {
    local root="$test_root/outbox-status-delivery-failure"
    local sender=sender.status-failure@${HOST} first=recipient.status-first@${HOST}
    local second=recipient.status-second@${HOST} first_supervisor=supervisor.status-first@${HOST}
    local second_supervisor=supervisor.status-second@${HOST} rc

    init_address "$root" "$sender" "$first_supervisor"
    init_address "$root" "$first" "$first_supervisor"
    init_address "$root" "$second" "$second_supervisor"
    init_address "$root" "$first_supervisor" "$first_supervisor"
    init_address "$root" "$second_supervisor" "$second_supervisor"
    register_observer "$root" "$first_supervisor"
    rmdir -- "$root/$first/new" "$root/$second/new" "$root/$first_supervisor/new"
    prepare_focused_outbox "$root" "$sender" '<outbox-status-failure@'"${HOST}"'>' 45 \
        "$first" "$second"
    if SNO_REACH_NOW=360 "$wake" step --state "$FOCUSED_STATE" >/dev/null; then
        rc=0
    else
        rc=$?
    fi
    if [[ "${REACHABILITY_WAKE_EXPECT_STATUS_SUPPRESSION:-0}" == 1 ]]; then
        assert_eq escalation-failed "$(jq -r .state "$FOCUSED_STATE")" \
            'planted first status failure stops escalation'
        assert_eq 1 "$(find "$root/$sender/new" -type f | wc -l)" \
            'planted first status failure suppresses the later sender status'
        printf 'plant_observable=first-status-failure-suppressed-later-targets\n'
        return
    fi
    assert_eq 4 "$rc" 'one failed status delivery keeps recovery pending'
    assert_eq 2 "$(find "$root/$sender/new" -type f | wc -l)" \
        'sender receives every status despite supervisor failure'
    mkdir -- "$root/$first_supervisor/new"
    if SNO_REACH_NOW=361 "$wake" step --state "$FOCUSED_STATE" >/dev/null; then
        rc=0
    else
        rc=$?
    fi
    assert_eq 0 "$rc" 'restored status target completes escalation'
    assert_eq escalated "$(jq -r .state "$FOCUSED_STATE")" \
        'queued status delivery completes recovery'
    assert_eq 2 "$(find "$root/$first_supervisor/new" -type f | wc -l)" \
        'restored sender supervisor receives every status exactly once'
    printf 'ok - one status failure neither suppresses later targets nor ends recovery\n'
}

case_outbox_escalation_restart() {
    local root="$test_root/outbox-escalation-restart"
    local sender=sender.restart@${HOST} first=recipient.restart-first@${HOST}
    local second=recipient.restart-second@${HOST} supervisor=supervisor.restart@${HOST}
    local commands rc step_pid deadline

    init_address "$root" "$sender" "$supervisor"
    init_address "$root" "$first" "$supervisor"
    init_address "$root" "$second" "$supervisor"
    init_address "$root" "$supervisor" "$supervisor"
    rmdir -- "$root/$first/new" "$root/$second/new"
    prepare_focused_outbox "$root" "$sender" '<outbox-escalation-restart@'"${HOST}"'>' 45 \
        "$first" "$second"
    commands="$root/release/bin"
    mkdir -p -- "$root/release"
    cp -a -- "$repo_root/bin" "$repo_root/lib" "$repo_root/vendor" "$repo_root/guide" "$repo_root/VERSION" "$root/release/"
    mv -- "$commands/sno-reach" "$commands/sno-reach.real"
    cat >"$commands/sno-reach" <<EOF
#!/usr/bin/env bash
set +e
"$commands/sno-reach.real" "\$@"
rc=\$?
if [[ "\${1:-}" == send && ! -e "$root/crashed" ]]; then
    : >"$root/crashed"
    sleep 10
fi
exit "\$rc"
EOF
    chmod 700 "$commands/sno-reach" "$commands/../lib/reach-wake"
    setsid env SNO_REACH_NOW=360 "$commands/../lib/reach-wake" step \
        --state "$FOCUSED_STATE" >/dev/null 2>&1 &
    step_pid=$!
    deadline=$((SECONDS + 5))
    while ((SECONDS < deadline)); do
        (( $(find "$root/$sender/new" -type f | wc -l) >= 1 )) && break
        sleep 0.05
    done
    (( $(find "$root/$sender/new" -type f | wc -l) >= 1 )) ||
        fail 'restart fixture did not deliver its first status'
    kill -KILL -- "-$step_pid" 2>/dev/null || true
    if wait "$step_pid" 2>/dev/null; then rc=0; else rc=$?; fi
    assert_eq 137 "$rc" 'restart fixture kills the escalation process group'
    SNO_REACH_NOW=361 "$commands/../lib/reach-wake" step --state "$FOCUSED_STATE" >/dev/null
    if [[ "${REACHABILITY_WAKE_EXPECT_ESCALATION_DUPLICATE:-0}" == 1 ]]; then
        (( $(find "$root/$sender/new" -type f | wc -l) > 2 )) ||
            fail 'planted restart did not duplicate a sender status'
        printf 'plant_observable=restart-duplicated-delivered-status-card\n'
        return
    fi
    assert_eq 2 "$(find "$root/$sender/new" -type f | wc -l)" \
        'restart preserves one sender status per failed recipient'
    assert_eq 2 "$(find "$root/$supervisor/new" -type f | wc -l)" \
        'restart preserves one supervisor status per failed recipient'
    assert_eq escalated "$(jq -r .state "$FOCUSED_STATE")" \
        'restart resumes unfinished escalation targets'
    printf 'ok - escalation restart resumes without duplicate status cards\n'
}

case_outbox_adopt_race() {
    local root="$test_root/outbox-adopt-race"
    local sender=agent.sender@${HOST} recipient=agent.recipient@${HOST}
    local supervisor=supervisor.adopt@${HOST}
    local entry="$root/$sender/outbox/adopt-race"
    local sleeper="$root/sleep-command" gate="$root/retry-gate"
    local impostor_command="$root/impostor-worker"
    local state temporary adopter_one adopter_two rc_one rc_two pid
    local recorded_pid recorded_command impostor_pid
    local -a retry_pids=() process_args=()

    init_address "$root" "$sender" "$supervisor"
    init_address "$root" "$recipient" "$supervisor"
    init_address "$root" "$supervisor" "$supervisor"
    mkdir -p -- "$entry"
    write_message "$entry/message" "$sender" "$recipient" \
        '<outbox-adopt-race@'"${HOST}"'>'
    printf '%s\n' "$recipient" >"$entry/recipients"
    {
        printf '#!/usr/bin/env bash\n'
        printf 'set -Eeuo pipefail\n'
        printf 'while [[ ! -e "$SNO_REACH_ADOPT_GATE" ]]; do sleep 0.05; done\n'
    } >"$sleeper"
    chmod 700 "$sleeper"
    {
        printf '#!/usr/bin/env bash\n'
        printf 'exec sleep 60\n'
    } >"$impostor_command"
    chmod 700 "$impostor_command"
    if SNO_REACH_NOW=0 SNO_REACH_WAKE_NO_DETACH=1 \
            "$wake" start --root "$root" --sender "$sender" \
            --recipient "$recipient" --message-id '<outbox-adopt-race@'"${HOST}"'>' \
            --work j-reachability-wake --mechanism '' \
            --outbox-entry "$entry" >/dev/null 2>"$root/start.err"; then
        fail 'outbox adoption fixture unexpectedly completed delivery'
    else
        assert_eq 5 "$?" 'outbox adoption fixture pending status'
    fi
    state="$(find "$root/$sender/wake-attempts" -type f -name '*.json' -print -quit)"
    [[ -f "$state" ]] || fail 'outbox adoption fixture has no state'
    "$impostor_command" &
    impostor_pid=$!
    temporary="$state.tmp"
    jq --argjson pid "$impostor_pid" \
        '.child_pid=$pid | .child_start_ticks=0' "$state" >"$temporary"
    mv -- "$temporary" "$state"

    SNO_REACH_NOW=1 SNO_REACH_SLEEP_COMMAND="$sleeper" SNO_REACH_ADOPT_GATE="$gate" \
        "$wake" adopt --root "$root" >"$root/adopt-one.out" \
        2>"$root/adopt-one.err" &
    adopter_one=$!
    SNO_REACH_NOW=1 SNO_REACH_SLEEP_COMMAND="$sleeper" SNO_REACH_ADOPT_GATE="$gate" \
        "$wake" adopt --root "$root" >"$root/adopt-two.out" \
        2>"$root/adopt-two.err" &
    adopter_two=$!
    if wait "$adopter_one"; then rc_one=0; else rc_one=$?; fi
    if wait "$adopter_two"; then rc_two=0; else rc_two=$?; fi
    kill "$impostor_pid" 2>/dev/null || true
    wait "$impostor_pid" 2>/dev/null || true
    assert_eq 0 "$rc_one" 'first concurrent adopter status'
    assert_eq 0 "$rc_two" 'second concurrent adopter status'
    recorded_pid="$(jq -r .child_pid "$state")"
    recorded_command="$(test_process_command "$recorded_pid" 2>/dev/null || true)"
    while read -r pid; do
        process_args=()
        mapfile -t process_args < <(test_process_arguments "$pid" 2>/dev/null)
        ((${#process_args[@]} == 5)) || continue
        [[ "${process_args[1]}" == "$wake" &&
           "${process_args[2]}" == run &&
           "${process_args[3]}" == --state &&
           "${process_args[4]}" == "$state" ]] || continue
        retry_pids+=("$pid")
    done < <(test_process_ids)
    if [[ "${REACHABILITY_WAKE_EXPECT_DUPLICATE_ADOPT:-0}" == 1 ]]; then
        ((${#retry_pids[@]} >= 2)) ||
            fail 'planted adoption gap did not launch duplicate coordinators'
        printf 'plant_observable=concurrent-adopters-launched-duplicate-coordinators\n'
        return
    fi
    assert_eq 1 "${#retry_pids[@]}" \
        "concurrent adopters launch one retry coordinator (recorded=$recorded_pid command=$recorded_command)"
    printf 'ok - concurrent adoption launches one retry coordinator\n'
}

case_outbox_sender_owned_state() {
    local root="$test_root/outbox-sender-owned-state"
    local sender=sender.owner@${HOST} recipient=recipient.removed@${HOST}
    local supervisor=supervisor.owner@${HOST} state rc

    init_address "$root" "$sender" "$supervisor"
    init_address "$root" "$recipient" "$supervisor"
    init_address "$root" "$supervisor" "$supervisor"
    rmdir -- "$root/$recipient/new"
    prepare_focused_outbox "$root" "$sender" '<outbox-sender-owned@'"${HOST}"'>' 6 \
        "$recipient"
    state="$FOCUSED_STATE"
    rm -r -- "$root/$recipient"
    if [[ "${REACHABILITY_WAKE_EXPECT_RECIPIENT_OWNED_STATE:-0}" == 1 ]]; then
        [[ ! -f "$state" ]] || fail 'planted recipient-owned state survived seat removal'
        printf 'plant_observable=removed-recipient-destroyed-recovery-state\n'
        return
    fi
    [[ -f "$root/$sender/wake-attempts/${state##*/}" ]] ||
        fail 'sender-owned recovery state disappeared with recipient seat'
    if SNO_REACH_NOW=60 "$wake" step --state "$state" >/dev/null; then rc=0; else rc=$?; fi
    assert_eq 0 "$rc" 'removed local seat escalates immediately'
    assert_eq escalated "$(jq -r .state "$state")" 'removed seat terminal state'
    assert_eq 1 "$(find "$root/$sender/new" -type f | wc -l)" \
        'removed seat notifies sender'
    assert_eq 1 "$(find "$root/$supervisor/new" -type f | wc -l)" \
        'removed seat notifies sender supervisor'
    printf 'ok - sender-owned recovery survives recipient removal and escalates immediately\n'
}

case_outbox_late_delivery_during_escalation() {
    local root="$test_root/outbox-late-delivery"
    local sender=sender.late@${HOST} recipient=recipient.late@${HOST}
    local supervisor=supervisor.late@${HOST} state rc

    init_address "$root" "$sender" "$supervisor"
    init_address "$root" "$recipient" "$supervisor"
    init_address "$root" "$supervisor" "$supervisor"
    register_observer "$root" "$supervisor"
    rmdir -- "$root/$recipient/new" "$root/$supervisor/new"
    prepare_focused_outbox "$root" "$sender" '<outbox-late-delivery@'"${HOST}"'>' 6 \
        "$recipient"
    state="$FOCUSED_STATE"
    if SNO_REACH_NOW=360 "$wake" step --state "$state" >/dev/null; then rc=0; else rc=$?; fi
    assert_eq 4 "$rc" 'first escalation remains pending for supervisor'
    assert_eq escalation "$(jq -r .phase "$state")" 'escalation phase is durable'
    mkdir -- "$root/$recipient/new"
    SNO_REACH_SKIP_WAKE_ADOPTION=1 SNO_REACH_ROOT="$root" SNO_REACH_OUTBOX_ENTRY="$FOCUSED_ENTRY" \
        "$mbox" flush --as "$sender" >/dev/null
    mkdir -- "$root/$supervisor/new"
    if SNO_REACH_NOW=361 "$wake" step --state "$state" >/dev/null; then rc=0; else rc=$?; fi
    if [[ "${REACHABILITY_WAKE_EXPECT_LATE_DELIVERY_CONFIRM:-0}" == 1 ]]; then
        assert_eq confirmed "$(jq -r .state "$state")" \
            'planted late delivery abandons unfinished escalation'
        assert_eq 0 "$(find "$root/$supervisor/new" -type f | wc -l)" \
            'planted late delivery leaves supervisor unnotified'
        printf 'plant_observable=late-original-delivery-abandoned-escalation\n'
        return
    fi
    assert_eq 0 "$rc" 'late original delivery does not end escalation'
    assert_eq escalated "$(jq -r .state "$state")" 'unfinished escalation completes'
    assert_eq 1 "$(find "$root/$supervisor/new" -type f | wc -l)" \
        'unfinished supervisor notification is delivered once'
    printf 'ok - escalation phase survives late original delivery\n'
}

# Sender-owned recovery removes a recipient whose seat is gone and escalates,
# which leaves the outbox entry with nothing deliverable. That is the same
# terminal condition a completed flush produces, and the completed case is
# already retired by removing the directory. The empty-on-arrival case used to
# be refused instead, which stranded it: the queued-copy count reads recipient
# lines, so it reported the orphan as zero, while flush -- the command the
# operator is told to run -- kept failing on it.
case_outbox_entry_without_recipients_is_retired() {
    local root="$test_root/outbox-empty-entry"
    local sender=sender.emptyentry@${HOST}
    local supervisor=supervisor.emptyentry@${HOST}
    local entry message rc

    init_address "$root" "$sender" "$supervisor"
    init_address "$root" "$supervisor" "$supervisor"
    register_address "$root" "$sender" 1000 sender-handle >/dev/null
    message="$root/queued.eml"
    write_message "$message" "$sender" "$sender" '<outbox-empty-entry@'"${HOST}"'>'
    SNO_REACH_ROOT="$root" SNO_REACH_NOW=1000 SNO_REACH_SKIP_WAKE_ADOPTION=1 \
        "$mbox" send --no-ring --as "$sender" <"$message" >/dev/null

    # Reproduce the state recovery leaves behind: the entry stays, its recipient
    # list does not.
    mkdir -p "$root/$sender/outbox/1787000000.M1P1Q1.${HOST}"
    entry="$root/$sender/outbox/1787000000.M1P1Q1.${HOST}"
    cp "$message" "$entry/message"
    : >"$entry/recipients"
    assert_eq 0 "$(wc -c <"$entry/recipients")" 'the staged entry has no recipients'

    set +e
    SNO_REACH_ROOT="$root" SNO_REACH_NOW=1000 SNO_REACH_SKIP_WAKE_ADOPTION=1 \
        "$mbox" flush --as "$sender" >"$root/flush.out" 2>"$root/flush.err"
    rc=$?
    set -e
    assert_eq 0 "$rc" 'flush clears an entry with no deliverable recipient'
    assert_contains "$(<"$root/flush.err")" 'retired an outbox entry with no deliverable recipient' \
        'flush says which entry it retired'
    [[ ! -e "$entry" ]] ||
        fail 'the entry with no recipients survived the flush that reported success'
    printf 'ok - an outbox entry with no deliverable recipient is retired, not stranded\n'
}

case_outbox_removed_mixed() {
    local root="$test_root/outbox-removed-mixed"
    local sender=sender.removed-mixed@${HOST} removed=recipient.removed-mixed@${HOST}
    local retryable=recipient.retryable-mixed@${HOST} supervisor=supervisor.removed-mixed@${HOST}
    local rc path

    init_address "$root" "$sender" "$supervisor"
    init_address "$root" "$removed" "$supervisor"
    init_address "$root" "$retryable" "$supervisor"
    init_address "$root" "$supervisor" "$supervisor"
    rmdir -- "$root/$removed/new" "$root/$retryable/new"
    prepare_focused_outbox "$root" "$sender" '<outbox-removed-mixed@'"${HOST}"'>' 6 \
        "$removed" "$retryable"
    rm -r -- "$root/$removed"
    mkdir -- "$root/$retryable/new"
    if SNO_REACH_NOW=60 "$wake" step --state "$FOCUSED_STATE" >/dev/null; then
        rc=0
    else
        rc=$?
    fi
    if [[ "${REACHABILITY_WAKE_EXPECT_GLOBAL_REMOVED_ABORT:-0}" == 1 ]]; then
        assert_eq escalated "$(jq -r .state "$FOCUSED_STATE")" \
            'planted removed recipient terminates the shared recovery'
        assert_eq 0 "$(find "$root/$retryable/new" -type f | wc -l)" \
            'planted shared termination abandons retryable recipient'
        printf 'plant_observable=removed-recipient-abandoned-retryable-copy\n'
        return
    fi
    assert_eq 0 "$rc" 'mixed removed and retryable recovery completes viable copy'
    assert_eq confirmed "$(jq -r .state "$FOCUSED_STATE")" \
        'retryable recipient completes after removed-recipient escalation'
    assert_eq 1 "$(find "$root/$retryable/new" -type f | wc -l)" \
        'retryable recipient receives its copy'
    assert_eq 1 "$(find "$root/$sender/new" -type f | wc -l)" \
        'sender receives removed-recipient status'
    assert_eq 1 "$(find "$root/$supervisor/new" -type f | wc -l)" \
        'sender supervisor receives removed-recipient status'
    path="$(find "$root/$sender/new" -type f -print -quit)"
    # This recipient was recorded as removed while its copy was still queued, so
    # the copy had nowhere to be placed. A seat that ended is not a transport
    # fault and must not read as one. The card must cite the record, not the
    # directory: a Maildir recreated after removal must not turn this back into
    # "delivered".
    assert_contains "$(mhdr -h subject "$path")" 'Recipient seat is gone' \
        'removed-recipient status names the ended seat'
    assert_contains "$(<"$path")" \
        'Disposition: the recipient mailbox was recorded as removed while this copy was still queued' \
        'removed-recipient status names the dropped copy'
    printf 'ok - removed recipient escalates independently while retryable copy completes\n'
}

case_final_scheduled_attempt_boundaries() {
    local root="$test_root/outbox-final-boundaries"
    local sender=sender.boundary@${HOST} recipient=recipient.boundary@${HOST}
    local wake_recipient=recipient.wake-boundary@${HOST} supervisor=supervisor.boundary@${HOST}
    local wake_state temporary rc

    init_address "$root" "$sender" "$supervisor"
    init_address "$root" "$recipient" "$supervisor"
    init_address "$root" "$wake_recipient" "$supervisor"
    init_address "$root" "$supervisor" "$supervisor"
    rmdir -- "$root/$recipient/new"
    prepare_focused_outbox "$root" "$sender" '<outbox-final-boundary@'"${HOST}"'>' 6 \
        "$recipient"
    temporary="$FOCUSED_STATE.tmp"
    jq '.attempt=5' "$FOCUSED_STATE" >"$temporary"
    mv -- "$temporary" "$FOCUSED_STATE"
    if SNO_REACH_NOW=360 "$wake" step --state "$FOCUSED_STATE" >/dev/null; then rc=0; else rc=$?; fi
    assert_eq 0 "$rc" 'outbox final boundary reaches escalation'

    SNO_REACH_NOW=0 SNO_REACH_WAKE_NO_DETACH=1 SNO_REACH_WAKE_ATTEMPTS=45 \
        SNO_REACH_WAKE_OUTCOME=failed "$wake" start --root "$root" \
        --sender "$sender" --recipient "$wake_recipient" \
        --message-id '<wake-final-boundary@'"${HOST}"'>' --work j-reachability-wake \
        --mechanism "$standin" >/dev/null 2>"$root/wake-start.err" || true
    wake_state="$(find "$root/$wake_recipient/wake-attempts" -type f -name '*.json' -print -quit)"
    [[ -f "$wake_state" ]] || fail 'wake final-boundary fixture has no state'
    temporary="$wake_state.tmp"
    jq '.attempt=44' "$wake_state" >"$temporary"
    mv -- "$temporary" "$wake_state"
    if SNO_REACH_NOW=5400 "$wake" step --state "$wake_state" >/dev/null; then rc=0; else rc=$?; fi
    assert_eq 0 "$rc" 'wake final boundary reaches escalation'
    if [[ "${REACHABILITY_WAKE_EXPECT_PREBOUND_ESCALATION:-0}" == 1 ]]; then
        assert_eq 5 "$(jq -r .attempt "$FOCUSED_STATE")" \
            'planted outbox boundary skips sixth attempt'
        assert_eq 44 "$(jq -r .attempt "$wake_state")" \
            'planted wake boundary skips forty-fifth attempt'
        printf 'plant_observable=final-scheduled-attempt-skipped-at-boundary\n'
        return
    fi
    assert_eq 6 "$(jq -r .attempt "$FOCUSED_STATE")" \
        'outbox performs sixth attempt at boundary'
    assert_eq 45 "$(jq -r .attempt "$wake_state")" \
        'wake performs forty-fifth attempt at boundary'
    printf 'ok - both retry schedules perform their final promised boundary attempt\n'
}

mode="${1:-all}"
case "$mode" in
    cleanup-proof) bash "$TEST_DIR/cleanup.t" --seed "$test_root/outbox-count-only" wake "${REACH_CLEANUP_PROOF:?}" ;;
    lifecycle) case_lifecycle ;;
    wake-log-lock-held-unregister-bounds-out)
        case_wake_log_lock_held_unregister_bounds_out
        ;;
    wake-child-descriptor-closure) case_wake_child_descriptor_closure ;;
    publication) case_publication_crash ;;
    outcomes) case_closed_outcomes ;;
    reached-outcomes) case_reached_outcomes ;;
    wake-start-failure) case_wake_start_failure_is_not_a_pending_retry ;;
    doorbell-deadline) case_doorbell_deadline ;;
    executor-wake) case_executor_wake ;;
    doorbell-measurement) case_doorbell_measurement ;;
    confirmation) case_confirmation ;;
    retry-bound) case_retry_bound ;;
    supervisor) case_supervisor_resolution ;;
    incident) case_four_report_incident ;;
    outbox-recovery) case_outbox_recovery ;;
    outbox-partial-delivery) case_outbox_partial_delivery ;;
    outbox-elapsed-only) case_outbox_elapsed_only ;;
    outbox-count-only) case_outbox_count_only ;;
    outbox-mixed-supervisors) case_outbox_mixed_supervisors ;;
    outbox-stalled-flush) case_outbox_stalled_flush ;;
    outbox-status-delivery-failure) case_outbox_status_delivery_failure ;;
    outbox-escalation-restart) case_outbox_escalation_restart ;;
    outbox-adopt-race) case_outbox_adopt_race ;;
    outbox-sender-owned-state) case_outbox_sender_owned_state ;;
    outbox-late-delivery) case_outbox_late_delivery_during_escalation ;;
    outbox-removed-mixed) case_outbox_removed_mixed ;;
    outbox-empty-entry) case_outbox_entry_without_recipients_is_retired ;;
    outbox-final-boundaries) case_final_scheduled_attempt_boundaries ;;
    all)
        case_lifecycle
        case_wake_log_lock_held_unregister_bounds_out
        case_wake_child_descriptor_closure
        case_publication_crash
        case_closed_outcomes
        case_reached_outcomes
        case_wake_start_failure_is_not_a_pending_retry
        case_doorbell_deadline
        case_executor_wake
        case_doorbell_measurement
        case_confirmation
        case_retry_bound
        case_supervisor_resolution
        case_four_report_incident
        case_outbox_recovery
        case_outbox_partial_delivery
        case_outbox_elapsed_only
        case_outbox_count_only
        case_outbox_mixed_supervisors
        case_outbox_stalled_flush
        case_outbox_status_delivery_failure
        case_outbox_escalation_restart
        case_outbox_adopt_race
        case_outbox_sender_owned_state
        case_outbox_late_delivery_during_escalation
        case_outbox_removed_mixed
        case_outbox_entry_without_recipients_is_retired
        case_final_scheduled_attempt_boundaries
        ;;
    *) fail "unknown mode: $mode" ;;
esac
