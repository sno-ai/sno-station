#!/usr/bin/env bash
set -Eeuo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROBE="${PROBE:-$HERE/../../../apps/subscription-quota-check/bin/subscription-quota-check}"
WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
REAL_DATE="$(command -v date)"
mkdir -p "$WORK/bin" "$WORK/home"
cat >"$WORK/bin/date" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$*" == '-u +%s' ]]; then printf '1791504000\n'; else exec "$REAL_DATE" "$@"; fi
SH
chmod +x "$WORK/bin/date"
export REAL_DATE HOME="$WORK/home" PATH="$WORK/bin:$HERE/stubs:$PATH"
export STUB_CODEX_PAYLOAD="$WORK/codex.json"
sed 's/RESET_BLOCKED/1791507600/g' "$HERE/fixtures/codex-blocked.json" >"$WORK/base.json"
passed=0 failed=0
run() { RC=0; OUT="$("$PROBE" "$@" 2>"$WORK/error")" || RC=$?; }
check() {
  local actual
  actual="$(jq -c "$2" <<<"$OUT")"
  if [[ "$actual" == "$3" ]]; then
    passed=$((passed+1)); printf 'ok %s - %s\n' "$((passed+failed))" "$1"
  else
    failed=$((failed+1)); printf 'not ok %s - %s: expected %s, got %s\n' "$((passed+failed))" "$1" "$3" "$actual"
  fi
}
printf 'TAP version 13\n'
for scenario in weekly short both short-later categories reached-early unknown-reset; do
  jq -c --arg scenario "$scenario" '
    .result.rateLimitsByLimitId.codex |= (
      .primary={usedPercent:25,windowDurationMins:300,resetsAt:1791507600}
      | .secondary={usedPercent:100,windowDurationMins:10080,resetsAt:1791849600}
      | if $scenario=="short" then .primary.usedPercent=100 | .secondary.usedPercent=25
        elif $scenario=="both" or $scenario=="categories" then .primary.usedPercent=100
        elif $scenario=="short-later" then .primary.usedPercent=100 | .primary.resetsAt=1791936000
        elif $scenario=="reached-early" then .primary.usedPercent=97 | .secondary.usedPercent=25
        elif $scenario=="unknown-reset" then .secondary.resetsAt=null
        else . end)
    | if $scenario=="categories" then
        .result.rateLimitsByLimitId.codex_later=(.result.rateLimitsByLimitId.codex
          | .limitId="codex_later" | .primary.resetsAt=1792195200 | .secondary.usedPercent=25)
      else . end
    | .result.rateLimits=.result.rateLimitsByLimitId.codex
  ' "$WORK/base.json" >"$STUB_CODEX_PAYLOAD"
  case "$scenario" in
    weekly|both) expected='[1,false,"blocked","wait","codex",100,1791849600,345600]' ;;
    short) expected='[1,false,"blocked","wait","codex",100,1791507600,3600]' ;;
    short-later) expected='[1,false,"blocked","wait","codex",100,1791936000,432000]' ;;
    categories) expected='[1,false,"blocked","wait","codex_later",100,1792195200,691200]' ;;
    reached-early) expected='[1,false,"blocked","wait","codex",97,1791507600,3600]' ;;
    unknown-reset) expected='[1,false,"blocked","wait","codex",100,null,null]' ;;
  esac
  run --vendor codex --json
  check "$scenario account blocking window" "[$RC,.ok,.vendors[0].state,.vendors[0].verdict,.vendors[0].blocking.limit_id,.vendors[0].blocking.used_pct,.vendors[0].blocking.resets_at_epoch,.vendors[0].blocking.seconds_to_reset]" "$expected"
  check "$scenario account wait and exit" '[.verdict,.exit_code]' '["wait",1]'
  run --agent codex
  check "$scenario agent blocking window" "[$RC,.ok,.vendor.state,.vendor.verdict,.vendor.blocking.limit_id,.vendor.blocking.used_pct,.vendor.blocking.resets_at_epoch,.vendor.blocking.seconds_to_reset]" "$expected"
done
printf '1..%s\nCodex blocking selftest: %s passed, %s failed\n' "$((passed+failed))" "$passed" "$failed"
((failed==0))
