#!/usr/bin/env bash
set -Eeuo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROBE="${PROBE:-$HERE/../../../apps/subscription-quota-check/bin/subscription-quota-check}"
WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
export HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/config" PATH="$HERE/stubs:$PATH"
export STUB_CLAUDE_PAYLOAD="$WORK/claude.json" STUB_CODEX_PAYLOAD="$WORK/codex.json"
mkdir -p "$HOME" "$XDG_CONFIG_HOME/sno"
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
export STUB_CLAUDE_MODE=missing-result
for args in '--vendor claude --json' '--json'; do
  read -r -a flags <<<"$args"
  run "${flags[@]}"
  check "Missing result: $args" "[$RC,.ok,.verdict,(.vendors[] | select(.vendor==\"claude\") | [.state,.verdict,.reason])]" \
    '[3,false,"unknown",["unreadable","unknown","get_usage control request returned no result"]]'
done
run --agent claude-code
check 'Missing result in agent read' "[$RC,.ok,.vendor.state,.vendor.verdict]" '[3,false,"unreadable","unknown"]'
run --pick handoff --from codex --json
check 'Missing result cannot supply a handoff candidate' "[$RC,.chosen,.candidates,.skipped[0].agent,.skipped[0].reason]" \
  '[0,null,[],"claude-code","unavailable"]'
for mode in answer silent; do
  export STUB_CLAUDE_MODE="$mode"
  printf 'null\n' >"$STUB_CLAUDE_PAYLOAD"
  run --vendor claude --json
  check "$mode with no result" "[$RC,.vendors[0].state,.vendors[0].verdict,.vendors[0].reason]" \
    '[3,"unreadable","unknown","get_usage control request returned no result"]'
done
export STUB_CLAUDE_MODE=answer
for payload in '{}' '{"rate_limits_available":null}' '{"rate_limits_available":"false"}' \
  '{"rate_limits_available":"true"}' '{"rate_limits_available":0}' \
  '{"rate_limits_available":[]}' '{"rate_limits_available":{}}'; do
  printf '%s\n' "$payload" >"$STUB_CLAUDE_PAYLOAD"
  run --vendor claude --json
  check "Absent or non-boolean availability: $payload" "[$RC,.vendors[0].state,.vendors[0].verdict,.vendors[0].reason]" \
    '[3,"unreadable","unknown","rate_limits_available is absent or not a boolean"]'
done
printf '{"rate_limits_available":false}\n' >"$STUB_CLAUDE_PAYLOAD"
run --vendor claude --json
check 'Explicit false still means no subscription limit' "[$RC,.ok,.vendors[0].state,.vendors[0].verdict]" \
  '[0,true,"not_applicable","n/a"]'
sed -e 's/FIVE_RESET/2026-10-15T00:00:00.000000+00:00/g' \
  -e 's/WEEK_RESET/2026-10-20T00:00:00.000000+00:00/g' "$HERE/fixtures/claude-go.json" >"$STUB_CLAUDE_PAYLOAD"
run --vendor claude --json
check 'Explicit true still reads subscription usage' "[$RC,.ok,.vendors[0].state,.vendors[0].verdict]" '[0,true,"ok","go"]'
printf '1..%s\nClaude result selftest: %s passed, %s failed\n' "$((passed+failed))" "$passed" "$failed"
((failed==0))
