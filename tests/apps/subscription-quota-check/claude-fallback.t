#!/usr/bin/env bash
set -Eeuo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROBE="${PROBE:-$HERE/../../../apps/subscription-quota-check/bin/subscription-quota-check}"
WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
REAL_DATE="$(command -v date)"
mkdir -p "$WORK/bin" "$WORK/home" "$WORK/config/sno"
cat >"$WORK/bin/date" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$*" == '-u +%s' ]]; then printf '1791504000\n'; else exec "$REAL_DATE" "$@"; fi
SH
chmod +x "$WORK/bin/date"
export REAL_DATE HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/config" PATH="$WORK/bin:$HERE/stubs:$PATH"
export STUB_CLAUDE_PAYLOAD="$WORK/claude.json" STUB_CODEX_PAYLOAD="$WORK/codex.json"
sed 's/RESET_LATER/1792000000/g' "$HERE/fixtures/codex-go.json" >"$STUB_CODEX_PAYLOAD"
printf '[models]\nhandoff_order="claude-code"\n' >"$XDG_CONFIG_HOME/sno/models.toml"
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
for limits in empty inactive; do
  for window in five_hour seven_day; do
    jq --arg window "$window" --arg limits "$limits" '
      .rate_limits.five_hour.resets_at="2026-10-09T01:00:00Z"
      | .rate_limits.seven_day.resets_at="2026-10-13T00:00:00Z"
      | .rate_limits[$window].utilization=100
      | .rate_limits.limits |= (if $limits=="empty" then [] else map(.is_active=false) end)
    ' "$HERE/fixtures/claude-go.json" >"$STUB_CLAUDE_PAYLOAD"
    run --vendor claude --json
    if [[ "$window" == five_hour ]]; then
      check "$limits limits, full five-hour report" "[$RC,.ok,.verdict,.exit_code,.vendors[0].state,.vendors[0].verdict,.vendors[0].blocking]" \
        '[1,false,"wait",1,"blocked","wait",{"limit_id":"session","used_pct":100,"resets_at":"2026-10-09T01:00:00Z","seconds_to_reset":3600}]'
    else
      check "$limits limits, full weekly report" "[$RC,.ok,.verdict,.exit_code,.vendors[0].state,.vendors[0].verdict,.vendors[0].blocking]" \
        '[1,false,"wait",1,"blocked","wait",{"limit_id":"weekly_all","used_pct":100,"resets_at":"2026-10-13T00:00:00Z","seconds_to_reset":345600}]'
    fi
    run --agent claude-code
    check "$limits limits, full $window agent read" "[$RC,.ok,.vendor.state,.vendor.verdict]" '[1,false,"blocked","wait"]'
    run --pick handoff --from codex --json
    check "$limits limits, full $window cannot receive handoff" "[$RC,.chosen,.candidates,.skipped[0].agent,.skipped[0].reason]" \
      '[0,null,[],"claude-code","no-quota"]'
  done
done
jq '.rate_limits.limits=[] | .rate_limits.five_hour.utilization=99
  | .rate_limits.five_hour.resets_at="2026-10-09T01:00:00Z"
  | .rate_limits.seven_day.resets_at="2026-10-13T00:00:00Z"' \
  "$HERE/fixtures/claude-go.json" >"$STUB_CLAUDE_PAYLOAD"
run --vendor claude --json
check 'Non-full fallback remains usable' "[$RC,.ok,.verdict,.vendors[0].state,.vendors[0].blocking]" '[0,true,"short_only","ok",null]'
run --pick handoff --from codex --json
check 'Non-full fallback remains a handoff candidate' "[$RC,.chosen.agent,.chosen.verdict,.skipped]" '[0,"claude-code","short_only",[]]'
printf '1..%s\nClaude fallback selftest: %s passed, %s failed\n' "$((passed+failed))" "$passed" "$failed"
((failed==0))
