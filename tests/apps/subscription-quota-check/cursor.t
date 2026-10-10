#!/usr/bin/env bash
# cursor.t — `--vendor cursor [--seat]` against Cursor's real usage response.
#
# Only the network and the macOS login stores are replaced (stubs/cursor: curl, security,
# sqlite3, uname). Seat lookup, login choice, pool choice, verdict and exit code run for real.
# The usage body is the response the endpoint returned on 2026-10-08 (auto 60%, named 0%).
#
# Usage: bash cursor.t     Exit: 0 all passed · 1 an assertion failed · 2 the suite could not run.
set -Eeuo pipefail
export LC_ALL=C

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROBE="${PROBE:-$HERE/../../../apps/subscription-quota-check/bin/subscription-quota-check}"
[[ -x "$PROBE" ]] || { printf 'cursor.t: cannot execute %s\n' "$PROBE" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/sqc-cursor.XXXXXX")"
trap 'rm -rf -- "$WORK" 2>/dev/null || true' EXIT
NOW="$(date -u +%s)"
CYCLE_END=$((NOW + 7200))
passed=0 failed=0

ok() { passed=$((passed + 1)); printf 'ok %d - %s\n' "$((passed + failed))" "$1"; }
bad() { failed=$((failed + 1)); printf 'not ok %d - %s\n    %s\n' "$((passed + failed))" "$1" "${2:-}"; }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "want [$3] got [$2]"; fi; }

# usage <auto> <named> — the real 2026-10-08 body with chosen percentages and a fixed cycle end.
usage() {
	sed -e "s/CYCLE_END_MS/${CYCLE_END}000/" \
		-e "s/\"autoPercentUsed\":60/\"autoPercentUsed\":$1/" \
		-e "s/\"apiPercentUsed\":0/\"apiPercentUsed\":$2/" "$HERE/fixtures/cursor-usage.json" >"$WORK/usage.json"
}

# run <name> [probe args] — own HOME, Reach root and profile under $WORK/<name>. Sets RC, OUT, H.
run() {
	local name="$1"; shift
	H="$WORK/$name"
	mkdir -p "$H/home" "$H/reach" "$H/profile/cursor/conversations"
	RC=0
	OUT="$(env PATH="$HERE/stubs/cursor:$PATH" HOME="$H/home" TMPDIR="$H" \
		SNO_REACH_ROOT="$H/reach" SNO_PROFILE_DIR="$H/profile" \
		STUB_CURSOR_BODY="$WORK/usage.json" STUB_CURSOR_LOG="$H/curl.log" \
		"$PROBE" --vendor cursor --json "$@" 2>"$H/err")" || RC=$?
}
prepare() { # <name>: the sandbox folders before files are placed in them
	H="$WORK/$1"
	mkdir -p "$H/home" "$H/reach" "$H/profile/cursor/conversations"
}
linux_login() { mkdir -p "$1/home/.config/cursor"; printf '{"accessToken":"linux-secret-token"}\n' >"$1/home/.config/cursor/auth.json"; }
ide_store() { mkdir -p "$1/home/Library/Application Support/Cursor/User/globalStorage"; : >"$1/home/Library/Application Support/Cursor/User/globalStorage/state.vscdb"; }
seat() { # <sandbox> <address> <channel> [conversation id]
	mkdir -p "$1/reach/$2"
	jq -n --arg a "$2" --arg c "$3" --arg id "${4:-%1}" \
		'{address:$a,channel:$c,handle:("h:" + $id),identity:{kind:"k",value:$id},claimed_at:1,refreshed_at:1,by:{pid:1,host:"h"},harness:"cursor"}' \
		>"$1/reach/$2/reachable.json"
}
record() { # <sandbox> <conversation id> <surface> <model> <reach_addr or null>
	jq -n --arg id "$2" --arg s "$3" --arg m "$4" --argjson r "$5" \
		'{conversation_id:$id,surface:$s,project:"/p",workspace_roots:["/p"],model:$m,model_at:"2026-10-10T01:02:03.000Z",
		  transcript_path:null,reach_addr:$r,first_seen:"2026-10-10T01:00:00.000Z",last_event:"2026-10-10T01:02:03.000Z",ended_at:null}' \
		>"$1/profile/cursor/conversations/$2.json"
}
jqv() { jq -r "$1" <<<"$OUT"; }

printf 'TAP version 13\n'

# No seat on Linux: the CLI login file, Cursor's default model, the auto pool.
usage 60 0
prepare plain; linux_login "$H"
run plain
check 'no seat: exit 0' "$RC" 0
check 'no seat: Linux CLI login file' "$(jqv '.vendors[0].login')" cli-file
check 'no seat: default model reads the auto pool' "$(jqv '.vendors[0] | [.model,.model_vendor,.pool,.tightest_window.used_pct] | join(" ")')" 'default cursor auto 60'
check 'no seat: both pools reported' "$(jqv '.vendors[0].pools | [.auto.used_percent,.named.used_percent,.auto.verdict,.named.verdict] | join(" ")')" '60 0 go go'
check 'no seat: reset is the cycle end' "$(jqv '.vendors[0].tightest_window.resets_at_epoch')" "$CYCLE_END"
check 'no seat: overall verdict go' "$(jqv '.verdict')" go
if grep -q 'secret-token' <<<"$OUT$(cat "$H/err")" || grep '^ARGV' "$H/curl.log" | grep -q secret-token; then
	bad 'the token never reaches stdout, stderr or curl argv'
else ok 'the token never reaches stdout, stderr or curl argv'; fi
check 'the token is sent from a header file' "$(grep -c '^HEADERFILE Authorization: Bearer linux-secret-token$' "$H/curl.log")" 1

# Auto pool full (the 2026-10-09 reading): blocked until the cycle end.
usage 100 0
prepare full; linux_login "$H"
run full
check 'auto 100%: exit 1' "$RC" 1
check 'auto 100%: blocked, wait' "$(jqv '.vendors[0] | [.state,.verdict] | join(" ")')" 'blocked wait'
check 'auto 100%: overall verdict wait' "$(jqv '.verdict')" wait
check 'auto 100%: blocking names the pool and its reset' "$(jqv '.vendors[0].blocking | [.limit_id,.used_pct,.resets_at_epoch] | join(" ")')" "auto 100 $CYCLE_END"

# IDE seat on macOS: the IDE login store, the recorded model's pool and vendor.
usage 60 0
prepare ide; ide_store "$H"
seat "$H" executor.ide@h cursor-ide 11111111-ide
record "$H" 11111111-ide ide cursor-grok-4.6-medium null
STUB_DARWIN=1 run ide --seat executor.ide@h
check 'IDE seat: exit 0' "$RC" 0
check 'IDE seat: IDE login store, auto pool, xai' "$(jqv '.vendors[0] | [.login,.model,.pool,.model_vendor,.seat] | join(" ")')" 'ide-store cursor-grok-4.6-medium auto xai executor.ide@h'

# CLI seat on macOS: the keychain login; a named model reads the named pool.
usage 60 85
prepare cli; seat "$H" executor.cli@h tmux
record "$H" older cli default '"executor.cli@h"'
record "$H" zz-other cli gpt-5 '"executor.other@h"'
jq '.last_event = "2026-10-10T03:00:00.000Z"' "$H/profile/cursor/conversations/zz-other.json" >"$H/tmp.json"
mv "$H/tmp.json" "$H/profile/cursor/conversations/zz-other.json"
jq '.model = "claude-4.5-sonnet" | .last_event = "2026-10-10T02:00:00.000Z"' "$H/profile/cursor/conversations/older.json" \
	>"$H/profile/cursor/conversations/newer.json"
STUB_DARWIN=1 run cli --seat executor.cli@h
check 'CLI seat: keychain login, newest record of the seat, named pool' \
	"$(jqv '.vendors[0] | [.login,.model,.pool,.model_vendor,.tightest_window.used_pct,.verdict] | join(" ")')" \
	'cli-keychain claude-4.5-sonnet named anthropic 85 short_only'
check 'CLI seat: short_only exits 0' "$RC" 0
check 'CLI seat: no tool error on macOS' "$(<"$H/err")" ''

# Keychain locked over SSH: unreadable, never a number.
prepare locked; seat "$H" executor.cli@h tmux
record "$H" c1 cli default '"executor.cli@h"'
STUB_DARWIN=1 STUB_KEYCHAIN=locked run locked --seat executor.cli@h
check 'keychain locked: exit 3' "$RC" 3
check 'keychain locked: unreadable with the contract reason' "$(jqv '.vendors[0] | [.state,.verdict,.reason] | join(" | ")')" \
	'unreadable | unknown | Cursor CLI login unreadable (keychain locked)'
check 'keychain locked: overall verdict unknown, not go' "$(jqv '.verdict')" unknown
check 'keychain locked: no endpoint call' "$([[ -e "$H/curl.log" ]] && printf called || printf none)" none

# A seat with no conversation record has no known model.
prepare norecord; linux_login "$H"; seat "$H" executor.none@h tmux
run norecord --seat executor.none@h
check 'seat without record: exit 3, model unknown' "$RC $(jqv '.vendors[0].reason')" \
	'3 seat model unknown: no Cursor conversation record for seat executor.none@h'

# A refused login is a login to renew.
prepare refused; linux_login "$H"
STUB_CURSOR_HTTP=401 run refused
check 'HTTP 401: needs_auth, exit 4' "$RC $(jqv '.vendors[0].state')" '4 needs_auth'

# --seat belongs to the Cursor read only.
RC=0; "$PROBE" --vendor codex --seat executor.x@h >/dev/null 2>&1 || RC=$?
check '--seat without --vendor cursor is refused' "$RC" 2

# Shared picker: only the external quota endpoint and agent CLIs are substitutes.
prepare picker; linux_login "$H"
mkdir -p "$H/bin" "$H/config/sno"
printf '#!/usr/bin/env bash\nexit 0\n' >"$H/bin/cursor-agent"
chmod +x "$H/bin/cursor-agent"
printf '[models]\nhandoff_order="cursor"\n' >"$H/config/sno/models.toml"
sed 's/RESET_LATER/1792000000/g' "$HERE/fixtures/codex-go.json" >"$H/codex.json"
seat "$H" executor.cursor@h tmux
record "$H" picked cli cursor-grok-4.6-medium '"executor.cursor@h"'
pick() {
	RC=0
	OUT="$(env PATH="$H/bin:$HERE/stubs/cursor:$HERE/stubs:/usr/bin:/bin" HOME="$H/home" TMPDIR="$H" \
		XDG_CONFIG_HOME="$H/config" SNO_REACH_ROOT="$H/reach" SNO_PROFILE_DIR="$H/profile" \
		STUB_CURSOR_BODY="$WORK/usage.json" STUB_CURSOR_LOG="$H/curl.log" STUB_CODEX_PAYLOAD="$H/codex.json" \
		"$PROBE" "$@" 2>"$H/err")" || RC=$?
}
usage 60 100
pick --pick handoff --from codex
check 'picker: recorded Cursor model remains usable when the other pool is full' \
	"$RC $(jqv '.chosen | [.agent,.model,.provider,.vendor,.verdict,.in_place] | join(" ")')" \
	'0 cursor cursor-grok-4.6-medium xai xai go false'
pick --pick review --from codex
check 'picker: Cursor is a review candidate in the same order' \
	"$(jqv '.chosen | [.agent,.model,.vendor,.in_place] | join(" ")')" 'cursor cursor-grok-4.6-medium xai false'
pick --agent cursor --seat executor.cursor@h
check 'agent: Cursor seat reports its current model and pool' \
	"$RC $(jqv '[.model,.model_vendor,.vendor.pool,.vendor.verdict] | join(" ")')" '0 cursor-grok-4.6-medium xai auto go'
pick --agent cursor --model claude-4.5-sonnet
check 'agent: explicit Cursor model uses its named pool' \
	"$RC $(jqv '[.model,.model_vendor,.vendor.pool,.vendor.verdict] | join(" ")')" '1 claude-4.5-sonnet anthropic named wait'
record "$H" picked cli gpt-5 '"executor.cursor@h"'
usage 60 0
pick --pick handoff --from codex
check 'picker: Cursor serving GPT is skipped as the same vendor' "$(jqv '[.chosen,.skipped[0].reason] | @json')" '[null,"same-vendor"]'
record "$H" picked cli cursor-grok-4.6-medium '"executor.cursor@h"'
usage 100 0
pick --pick handoff --from codex
check 'picker: full Cursor model pool is skipped' "$(jqv '[.chosen,.skipped[0].reason] | @json')" '[null,"no-quota"]'
usage 60 0
printf '{}\n' >"$H/home/.config/cursor/auth.json"
pick --pick review --from codex
check 'picker: unreadable CLI login is unavailable with its cause' \
	"$(jqv '[.chosen,.skipped[0].reason,.skipped[0].detail] | @json')" \
	'[null,"unavailable","Cursor CLI login unreadable: no accessToken in ~/.config/cursor/auth.json"]'
STUB_DARWIN=1 STUB_KEYCHAIN=locked pick --pick review --from codex
check 'picker: locked macOS CLI keychain is unavailable with its cause' \
	"$(jqv '[.chosen,.skipped[0].reason,.skipped[0].detail] | @json')" \
	'[null,"unavailable","Cursor CLI login unreadable (keychain locked)"]'
linux_login "$H"
rm -- "$H/profile/cursor/conversations/picked.json" "$H/reach/executor.cursor@h/reachable.json"
pick --pick handoff --from codex --model gpt-5
check 'picker: a sender model cannot stand in for a missing Cursor model' \
	"$(jqv '[.chosen,.skipped[0].reason] | @json')" '[null,"unavailable"]'
record "$H" picked cli cursor-grok-4.6-medium '"executor.cursor@h"'
seat "$H" executor.cursor@h tmux
printf '[models]\nhandoff_order="codex"\n' >"$H/config/sno/models.toml"
pick --pick handoff --from cursor --seat executor.cursor@h
check 'picker: a Cursor sender uses its recorded vendor and selects another vendor' \
	"$RC $(jqv '[.from.model,.from.vendor,.chosen.agent,.chosen.vendor] | join(" ")')" \
	'0 cursor-grok-4.6-medium xai codex openai'
printf '[models]\nhandoff_order="cursor"\n' >"$H/config/sno/models.toml"
rm -- "$H/bin/cursor-agent"
pick --pick handoff --from codex
check 'picker: missing Cursor CLI is unavailable with its cause' \
	"$(jqv '[.chosen,.skipped[0].reason,.skipped[0].detail] | @json')" \
	'[null,"unavailable","cursor-agent command not found on PATH"]'

printf '1..%d\n' "$((passed + failed))"
((failed == 0)) || exit 1
