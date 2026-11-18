#!/usr/bin/env bash
# probe.t — every claim this unit makes, checked against the real probe.
#
# The two vendor CLIs are replaced by stubs on PATH; nothing else is. Every line of the
# probe's own parsing, verdict rule, freshness gate and exit-code arithmetic runs for real,
# so an assertion here fails when the product is wrong and not when a stub is wrong.
#
# No network. No model call. Safe to run inside a deployed copy at deploy time.
#
# Usage: bash probe.t     (override the target with PROBE=/path/to/subscription-quota-check)
# Exit:  0 all passed · 1 an assertion failed · 2 the suite could not run.
set -Eeuo pipefail

export LC_ALL=C

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROBE="${PROBE:-$HERE/../../../apps/subscription-quota-check/bin/subscription-quota-check}"
STUBS="$HERE/stubs"
FIXTURES="$HERE/fixtures"

[[ -x "$PROBE" ]] ||
	{ printf 'probe.t: cannot execute the probe under test: %s\n' "$PROBE" >&2; exit 2; }
[[ -x "$STUBS/codex" && -x "$STUBS/claude" ]] ||
	{ printf 'probe.t: stubs are missing or not executable in %s\n' "$STUBS" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/sqc-selftest.XXXXXX")"
trap 'rm -rf -- "$WORK" 2>/dev/null || true' EXIT

NOW="$(date -u +%s)"
passed=0
failed=0
failures=()

ok()   { passed=$((passed + 1)); printf 'ok %d - %s\n' "$((passed + failed))" "$1"; }
bad()  { failed=$((failed + 1)); failures+=("$1"); printf 'not ok %d - %s\n' "$((passed + failed))" "$1"
         [[ $# -lt 2 ]] || printf '    %s\n' "$2"; }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "want [$3] got [$2]"; fi; }

# render <fixture> — fixture timestamps are placeholders so they never go stale. The blocked
# codex bucket keeps the shape that matters: a SEVEN-DAY window 2222 s from resetting.
render() {
	local src="$FIXTURES/$1" dst="$WORK/$1"
	sed -e "s/RESET_BLOCKED/$((NOW + 2222))/g" \
		-e "s/RESET_LATER/$((NOW + 604800))/g" \
		-e "s/FIVE_RESET/$(date -u -d "@$((NOW + 3600))" +%Y-%m-%dT%H:%M:%S.000000+00:00)/g" \
		-e "s/WEEK_RESET/$(date -u -d "@$((NOW + 345600))" +%Y-%m-%dT%H:%M:%S.000000+00:00)/g" \
		-- "$src" >"$dst"
	printf '%s' "$dst"
}

# run <name> — one probe run in its own sandbox: own HOME, own TMPDIR, stubs first on PATH.
# Everything after the name is passed to the probe. Sets RC, OUT.
run() {
	local name="$1"; shift
	local home="$WORK/$name"
	mkdir -p "$home"
	printf '{"cachedUsageUtilization":{"fetchedAtMs":%s}}\n' \
		"$(( (NOW - ${CACHE_AGE_SEC:-10}) * 1000 ))" >"$home/.claude.json"
	RC=0
	OUT="$(env PATH="${PROBE_TEST_PATH:-$STUBS:$PATH}" HOME="$home" TMPDIR="$home" \
		STUB_CODEX_PAYLOAD="${STUB_CODEX_PAYLOAD:-}" \
		STUB_CODEX_MODE="${STUB_CODEX_MODE:-answer}" \
		STUB_CODEX_LOGGED_IN="${STUB_CODEX_LOGGED_IN:-1}" \
		STUB_CLAUDE_PAYLOAD="${STUB_CLAUDE_PAYLOAD:-}" \
		STUB_CLAUDE_MODE="${STUB_CLAUDE_MODE:-answer}" \
		STUB_CLAUDE_STALE="${STUB_CLAUDE_STALE:-0}" \
		"$PROBE" "$@" 2>"$WORK/$name.err")" || RC=$?
	LAST_HOME="$home"
}

jqv() { printf '%s' "$OUT" | jq -r "$1"; }

printf 'TAP version 13\n'
printf '# probe under test: %s\n' "$PROBE"

# The substitute must not invent a response when the real request never arrived.
for request in '' '{"type":"control_request","request_id":"q","request":{"subtype":"wrong_method"}}'; do
	if printf '%s\n' "$request" | STUB_CLAUDE_PAYLOAD="$FIXTURES/claude-go.json" \
		"$STUBS/claude" --input-format stream-json >"$WORK/rejected-request.out" 2>"$WORK/rejected-request.err"; then
		bad "the Claude substitute rejects an absent or wrong usage request"
	else
		ok "the Claude substitute rejects an absent or wrong usage request"
	fi
	check "a rejected usage request returns no vendor payload" "$(wc -c <"$WORK/rejected-request.out")" 0
done

# ---------------------------------------------------------------- arguments --

unset OPENAI_BASE_URL
run help --help; check "--help exits 0" "$RC" 0
if printf '%s' "$OUT" | grep -q 'short_only'; then
	ok "--help documents the verdict values"
else
	bad "--help documents the verdict values"
fi
if [[ "$OUT" == *'OPENAI_BASE_URL is not set'* && "$OUT" != *"using the harness's own endpoint"* ]]; then
	ok "--help explains the quota when OPENAI_BASE_URL is unset"
else
	bad "--help explains the quota when OPENAI_BASE_URL is unset"
fi

run badvendor --vendor nope --json; check "an unknown vendor is rejected" "$RC" 2
run badflag --frobnicate --json;    check "an unknown flag is rejected" "$RC" 2
run novalue --vendor;               check "--vendor with no value is rejected" "$RC" 2

STUB_CODEX_PAYLOAD="$(render codex-go.json)" run eqform --vendor=codex --json
check "the --vendor=value form is accepted" "$RC" 0
check "the --vendor=value form reads the vendor it named" "$(jqv '.vendors | length')" 1

# --quiet exists so a caller can put this in a hook without the progress note landing in a
# log it does not own. The retry note is the only thing it suppresses, so provoke it.
STUB_CODEX_MODE=silent run quiet --quiet --vendor codex --json
check "--quiet leaves stderr empty" "$(wc -c <"$WORK/quiet.err" | tr -d ' ')" 0
STUB_CODEX_MODE=silent run loud --vendor codex --json
if [[ -s "$WORK/loud.err" ]]; then
	ok "without --quiet the retry is reported on stderr"
else
	bad "without --quiet the retry is reported on stderr" "stderr was empty"
fi

# ------------------------------------------------------- the credit-spender --

# account/rateLimitResetCredit/consume sits beside the read method and spends a finite,
# purchasable asset. It must never appear in this file by any spelling.
if grep -qiE 'resetCredit|rate-limit-reset-credits/consume|/consume' -- "$PROBE"; then
	bad "the credit-spending method appears nowhere in the probe" \
		"found a reference to a consume method"
else
	ok "the credit-spending method appears nowhere in the probe"
fi

# ----------------------------------------------------------- missing binary --

mkdir -p "$WORK/empty"
for tool in bash jq timeout date mkfifo mktemp rm uname; do
	ln -s "$(command -v "$tool")" "$WORK/empty/$tool"
done
PROBE_TEST_PATH="$WORK/empty" run nocodex --vendor codex --json
check "a missing vendor binary exits 3, not 1" "$RC" 3
check "a missing vendor binary reads unknown, never blocked" "$(jqv '.vendors[0].verdict')" unknown

# ------------------------------------------------------------ codex blocked --

STUB_CODEX_PAYLOAD="$(render codex-blocked.json)" run cxblocked --vendor codex --json
check "a blocked codex exits 1" "$RC" 1
check "a blocked codex says wait" "$(jqv '.vendors[0].verdict')" wait
check "the blocking bucket is named" "$(jqv '.vendors[0].blocking.limit_id')" codex

# THE trap. The window is seven days long and the reset is 37 minutes away. A probe that
# derives the wait from the window length would answer 604800 and sleep for a week.
check "the window length is reported as metadata" \
	"$(jqv '.vendors[0].tightest_window.window_minutes')" 10080
secs="$(jqv '.vendors[0].blocking.seconds_to_reset')"
if ((secs > 2100 && secs < 2300)); then
	ok "the wait comes from resetsAt, not from the window length"
else
	bad "the wait comes from resetsAt, not from the window length" "got ${secs}s, want ~2222s"
fi

STUB_CODEX_PAYLOAD="$(render codex-workspace-blocked.json)" \
	run cxworkspace --vendor codex --json
check "a workspace limit exits blocked" "$RC" 1
check "a workspace limit requires owner action" \
	"$(jqv '.vendors[0].verdict')" owner_action
check "a workspace limit never supplies a reset wait" \
	"$(jqv '.vendors[0].blocking.seconds_to_reset')" null
check "a workspace limit names the required action" \
	"$(jqv '.vendors[0].blocking.required_action')" contact_workspace_owner

# ------------------------------------------------------- codex headroom rule --

STUB_CODEX_PAYLOAD="$(render codex-go.json)" run cxgo --vendor codex --json
check "a roomy codex exits 0" "$RC" 0
check "a roomy codex says go" "$(jqv '.vendors[0].verdict')" go

STUB_CODEX_PAYLOAD="$(render codex-short.json)" run cxshort --vendor codex --json
check "thin headroom still exits 0" "$RC" 0
check "thin headroom says short_only" "$(jqv '.vendors[0].verdict')" short_only
check "the verdict names the window it came from" \
	"$(jqv '.vendors[0].tightest_window.limit_id')" codex_bengalfox

# -------------------------------------------------------------- codex auth ---

STUB_CODEX_MODE=silent STUB_CODEX_LOGGED_IN=0 run cxauth --vendor codex --json
check "being logged out exits 4, never 1" "$RC" 4
check "being logged out is never reported as out of quota" \
	"$(jqv '.vendors[0].verdict')" needs_auth

# --------------------------------------------------------------- claude ------

STUB_CLAUDE_PAYLOAD="$(render claude-go.json)" run clgo --vendor claude --json
check "a roomy claude exits 0" "$RC" 0
check "a roomy claude says go" "$(jqv '.vendors[0].verdict')" go
check "the binding window is active even when an inactive window has higher usage" \
	"$(jqv '.vendors[0].tightest_window.limit_id')" weekly_all

STUB_CLAUDE_PAYLOAD="$(render claude-short.json)" run clshort --vendor claude --json
check "claude thin headroom says short_only" "$(jqv '.vendors[0].verdict')" short_only

STUB_CLAUDE_PAYLOAD="$(render claude-blocked.json)" run clblocked --vendor claude --json
check "a blocked claude exits 1" "$RC" 1
check "a blocked claude says wait" "$(jqv '.vendors[0].verdict')" wait

# --------------------------------------------------------------- freshness ---

for mode in text-failure text-timeout text-empty; do
	STUB_CLAUDE_PAYLOAD="$(render claude-go.json)" STUB_CLAUDE_MODE="$mode" \
		run "$mode" --vendor claude --json
	check "$mode exits unknown" "$RC" 3
	check "$mode reports unknown" "$(jqv '.verdict')" unknown
	check "$mode cannot establish freshness" "$(jqv '.vendors[0].freshness')" unknown
	check "$mode publishes no quota percentage" "$(jqv '.vendors[0] | has("five_hour")')" false
done

STUB_CLAUDE_PAYLOAD="$(render claude-go.json)" STUB_CLAUDE_STALE=1 \
	run clstale --vendor claude --json
check "last-known data is not answered from" "$RC" 3
check "last-known data reads unknown" "$(jqv '.vendors[0].verdict')" unknown
check "no percentage is published from data that may be old" \
	"$(jqv '.vendors[0] | has("five_hour")')" false

CACHE_AGE_SEC=7200 STUB_CLAUDE_PAYLOAD="$(render claude-go.json)" \
	run clold --vendor claude --json
check "a cache past its own validity horizon reads unknown" "$RC" 3

# ------------------------------------------------------- not a plan session --

STUB_CLAUDE_PAYLOAD="$(render claude-not-applicable.json)" run clna --vendor claude --json
check "an API-key session exits 0" "$RC" 0
check "an API-key session is not reported as 0% used" "$(jqv '.vendors[0].verdict')" n/a
if printf '%s' "$OUT" | grep -q 'secret-canary'; then
	bad "nothing identifying from the payload reaches the output" "the canary was printed"
else
	ok "nothing identifying from the payload reaches the output"
fi

# --------------------------------------------------- one vendor, one verdict --

STUB_CODEX_MODE=silent STUB_CODEX_LOGGED_IN=0 \
	STUB_CLAUDE_PAYLOAD="$(render claude-go.json)" run isolate --vendor claude --json
check "asking for one vendor does not inherit the other's failure" "$RC" 0

STUB_CODEX_PAYLOAD="$(render codex-blocked.json)" \
	STUB_CLAUDE_PAYLOAD="$(render claude-go.json)" run both --json
check "the worst vendor sets the exit code" "$RC" 1
check "the worst vendor sets the overall verdict" "$(jqv '.verdict')" wait
check "the healthy vendor keeps its own verdict" \
	"$(jqv '.vendors | map(select(.vendor == "claude"))[0].verdict')" go

# ---------------------------------------------------------------- envelope ---

for field in ok operation captured_at host verdict exit_code vendors; do
	if printf '%s' "$OUT" | jq -e "has(\"$field\")" >/dev/null; then
		ok "the envelope carries $field"
	else
		bad "the envelope carries $field"
	fi
done
check "the envelope names this operation" "$(jqv '.operation')" subscription-quota-check
check "the envelope carries the threshold it judged by" \
	"$(jqv '.short_only_below_remaining_pct')" 20
check "each vendor reading carries the CLI build it came from" \
	"$(jqv '.vendors[0] | has("cli_version")')" true

# ------------------------------------------------------------- no leftovers --

leftover="$(find "$LAST_HOME" -maxdepth 1 -name 'quota-check.*' -o -maxdepth 1 -name 'sqc.*' \
	2>/dev/null | wc -l)"
check "the probe leaves no scratch directory behind" "$leftover" 0

# ------------------------------------------------------------------- speed ---

# The regression this guards: app-server keeps stdin open, so a probe that waits for the
# server to end instead of closing its own write end burns the whole 25 s timeout on every
# call, success included. Measured before the fix: 26 s. The stub reproduces that hold.
start="$(date -u +%s)"
STUB_CODEX_PAYLOAD="$(render codex-go.json)" run cxspeed --vendor codex --json
elapsed=$(( $(date -u +%s) - start ))
if ((RC == 0 && elapsed < 10)); then
	ok "a successful codex probe returns without waiting out its timeout (${elapsed}s)"
else
	bad "a successful codex probe returns without waiting out its timeout" \
		"exit $RC after ${elapsed}s"
fi

# ----------------------------------------------------------------- summary ---

printf '1..%d\n' "$((passed + failed))"
if ((failed == 0)); then
	printf 'subscription-quota-check selftest: ALL PASS (%d assertions)\n' "$passed"
	exit 0
fi
printf 'subscription-quota-check selftest: %d of %d FAILED (%s)\n' \
	"$failed" "$((passed + failed))" "${failures[*]}"
exit 1
