#!/usr/bin/env bash
# Oracle: agent-progress-reporting PRD REQ-1..5 and REQ-26.
# The unchanged test must reject the old linter's missing lifecycle validation.
set -Eeuo pipefail
export HOST="$(hostname)"
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../apps/reach" && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/progress-reporting-lint.XXXXXXXX")"
trap 'rm -r -- "$test_root"' EXIT
tests=0 failures=0

check() {
    local name="$1" expected="$2" type="$3" tag="$4" extra="$5"
    shift 5
    local rc=0 token
    tests=$((tests + 1))
    {
        printf 'From: Worker <agent.worker@'"${HOST}"'>\nTo: Supervisor <tpm.repo@'"${HOST}"'>\n'
        printf 'Subject: [%s] lifecycle\n' "$tag"
        printf 'Date: Thu, 10 Sep 2026 00:00:00 +0000\n'
        printf 'Message-ID: <report@'"${HOST}"'>\nX-Work: progress-lint\nX-Type: %s\n' "$type"
        printf '%s\n\nReport body.\n' "$extra"
    } >"$test_root/card"
    "$repo_root/bin/sno-reach" lint "$test_root/card" >"$test_root/out" 2>"$test_root/err" || rc=$?
    if [[ "$rc" != "$expected" ]]; then
        printf 'not ok %s - %s (exit %s, expected %s)\n' "$tests" "$name" "$rc" "$expected"
        cat "$test_root/err" >&2
        failures=$((failures + 1))
        return
    fi
    for token in "$@"; do
        if ! grep -Fiq -- "$token" "$test_root/err"; then
            printf 'not ok %s - %s (missing diagnostic token %s)\n' "$tests" "$name" "$token"
            failures=$((failures + 1))
            return
        fi
    done
    printf 'ok %s - %s\n' "$tests" "$name"
}

thread=$'In-Reply-To: <work@'"${HOST}"$'>\nReferences: <work@'"${HOST}"$'>'
check 'QCG-1 accepted report' 0 status STATUS "$thread"$'\nX-State: accepted'
check 'QCG-1 unknown state names value' 65 status STATUS "$thread"$'\nX-State: started' started
check 'QCG-1 duplicate state' 65 status STATUS "$thread"$'\nX-State: accepted\nx-state: accepted' X-State
check 'QCG-2 state requires a parent' 65 status STATUS 'X-State: running' In-Reply-To
check 'QCG-3 cancel with a parent' 0 cancel CANCEL "$thread"
check 'QCG-3 cancel requires a parent' 65 cancel CANCEL '' In-Reply-To
check 'QCG-4 valid supersession and expiry' 0 decision DECISION $'Supersedes: <old@'"${HOST}"$'>\nExpiry-Date: Thu, 10 Sep 2026 01:00:00 +0000'
check 'QCG-4 supersession is one id' 65 decision DECISION 'Supersedes: <one@'"${HOST}"'> <two@'"${HOST}"'>' Supersedes
check 'QCG-4 supersession requires brackets' 65 decision DECISION 'Supersedes: old@'"${HOST}"'' Supersedes
check 'QCG-4 supersession is singleton' 65 decision DECISION $'Supersedes: <one@'"${HOST}"$'>\nSupersedes: <two@'"${HOST}"$'>' Supersedes
check 'QCG-4 expiry requires a date' 65 decision DECISION 'Expiry-Date: tomorrowish' Expiry-Date
check 'QCG-4 expiry is singleton' 65 decision DECISION $'Expiry-Date: Thu, 10 Sep 2026 01:00:00 +0000\nExpiry-Date: Thu, 10 Sep 2026 02:00:00 +0000' Expiry-Date
check 'QCG-5 blocked report must be a question' 65 status STATUS "$thread"$'\nX-State: requires-action' X-Type
check 'QCG-5 acceptance must be a status' 65 question QUESTION "$thread"$'\nX-State: accepted' X-Type
check 'QCG-5 running must be a status' 65 question QUESTION "$thread"$'\nX-State: running' X-Type
check 'QCG-5 question can block work' 0 question QUESTION "$thread"$'\nX-State: requires-action'
check 'QCG-29 cancel cannot replace work' 65 cancel CANCEL "$thread"$'\nSupersedes: <work@'"${HOST}"$'>' X-Type Supersedes
check 'REQ-26 state cannot replace work' 65 status STATUS "$thread"$'\nX-State: accepted\nSupersedes: <work@'"${HOST}"$'>' X-State Supersedes
for state in running completed failed cancelled refused; do
    check "REQ-1 valid state $state" 0 status STATUS "$thread"$'\nX-State: '"$state"
done
printf '1..%s\n' "$tests"
((failures == 0))
