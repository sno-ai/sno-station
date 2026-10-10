#!/usr/bin/env bash
set -Eeuo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROBE="${PROBE:-$HERE/../../../apps/subscription-quota-check/bin/subscription-quota-check}"
WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
export HOME="$WORK/home" HERMES_HOME="$WORK/hermes" XDG_CONFIG_HOME="$WORK/config"
export SNO_REACH_STATE_ROOT="$WORK/reach" STUB_FIXTURES="$HERE/fixtures"
export STUB_COMMAND_LOG="$WORK/commands" PATH="$HERE/stubs:$PATH"
mkdir -p "$HOME" "$HERMES_HOME/logs" "$XDG_CONFIG_HOME/sno" "$SNO_REACH_STATE_ROOT/test-hermes" "$SNO_REACH_STATE_ROOT/test-claw"
cp "$STUB_FIXTURES/hermes-agent-log-requests.txt" "$HERMES_HOME/logs/agent.log.1"
printf '{"session_id":"20261009_071006_873a0a","cwd":"/tmp/reach-test","spawned_at":1791529806}\n' >"$SNO_REACH_STATE_ROOT/test-hermes/transcript.json"
printf '{"session_key":"reach-test-claw"}\n' >"$SNO_REACH_STATE_ROOT/test-claw/transcript.json"
export STUB_HERMES_EXPORT="$WORK/export.jsonl"
printf '{"id":"20261009_071006_873a0a","started_at":1791529806,"messages":[{"role":"user","content":"Reach seat test-hermes"}]}\n' >"$STUB_HERMES_EXPORT"
printf '{"cachedUsageUtilization":{"fetchedAtMs":%s}}\n' "$(( $(date +%s) * 1000 ))" >"$HOME/.claude.json"
export STUB_CODEX_PAYLOAD="$STUB_FIXTURES/codex-go.json" STUB_CLAUDE_PAYLOAD="$WORK/claude.json"
sed -e 's/FIVE_RESET/2026-10-15T00:00:00.000000+00:00/g' -e 's/WEEK_RESET/2026-10-20T00:00:00.000000+00:00/g' "$STUB_FIXTURES/claude-go.json" >"$STUB_CLAUDE_PAYLOAD"
sed -e 's/RESET_LATER/1792000000/g' "$STUB_FIXTURES/codex-go.json" >"$WORK/codex.json"
export STUB_CODEX_PAYLOAD="$WORK/codex.json"
passed=0 failed=0 OUT='' RC=0
run() { RC=0; OUT="$("$PROBE" "$@" 2>"$WORK/error")" || RC=$?; }
check() {
  local actual
  actual="$(jq -c "$2" <<<"$OUT" 2>/dev/null)" || actual='invalid JSON'
  if [[ "$actual" == "$3" ]]; then
    passed=$((passed+1)); printf 'ok %s - %s\n' "$((passed+failed))" "$1"
  else
    failed=$((failed+1)); printf 'not ok %s - %s: expected %s, got %s (exit %s)\n' "$((passed+failed))" "$1" "$3" "$actual" "$RC"
  fi
}
printf 'TAP version 13\n'
run --agent hermes --seat test-hermes
check 'Hermes seat and rotated log' '[.ok,.operation,.agent,.model,.provider,.model_vendor,.vendor.verdict,.vendor.tightest_window.used_pct]' '[true,"agent-read","hermes","gpt-5.6-terra","openai-codex","openai","go",8]'
check 'Hermes reset from recorded window' '.vendor.tightest_window.resets_at' '"2026-10-15T04:05:18+00:00"'
printf '2026-10-09 07:20:00,000 INFO [20261009_071006_873a0a] agent.conversation_loop: API call #9: model=claude-sonnet-5 provider=anthropic in=1\n2026-10-09 07:21:00,000 WARNING [20261009_071006_873a0a] agent.conversation_loop: API call failed provider=openai-codex model=gpt-5.6-terra\n' >"$HERMES_HOME/logs/agent.log"
run --agent hermes --seat test-hermes
check 'Latest successful request beats session row and failed request' '[.model,.provider,.vendor.tightest_window.used_pct,.vendor.verdict]' '["claude-sonnet-5","anthropic",92,"short_only"]'
export STUB_HERMES_ANTHROPIC="$WORK/anthropic.json"
jq '.windows[1].used_percent=79' "$STUB_FIXTURES/hermes-usage-anthropic.json" >"$STUB_HERMES_ANTHROPIC"
run --agent hermes --seat test-hermes
check 'Anthropic requested 79 percent case' '[.vendor.tightest_window.used_pct,.vendor.verdict]' '[79,"go"]'
jq '.windows[1].used_percent=79.6' "$STUB_FIXTURES/hermes-usage-anthropic.json" >"$STUB_HERMES_ANTHROPIC"
run --agent hermes --seat test-hermes
check 'Round fractional percent, judge unrounded headroom' '[.vendor.tightest_window.used_pct,.vendor.verdict]' '[80,"go"]'
jq '.windows[1].used_percent=80' "$STUB_FIXTURES/hermes-usage-anthropic.json" >"$STUB_HERMES_ANTHROPIC"
run --agent hermes --seat test-hermes
check 'Twenty percent remaining is short only' '.vendor.verdict' '"short_only"'
jq '.windows[1].used_percent=100' "$STUB_FIXTURES/hermes-usage-anthropic.json" >"$STUB_HERMES_ANTHROPIC"
run --agent hermes --seat test-hermes
check 'Full window is blocked' '[.ok,.vendor.state,.vendor.verdict]' '[false,"blocked","wait"]'
[[ "$RC" == 1 ]] || failed=$((failed+1))
unset STUB_HERMES_ANTHROPIC
run --agent hermes --model local-reason/qwen3.8-27b-reason
check 'Local usage is not an error' '[.ok,.provider,.model_vendor,.vendor.state,.vendor.verdict,.vendor.tightest_window]' '[true,"local-reason","local:local-reason","ok","unread",null]'
check 'Local usage exits successfully without a failed-command diagnostic' "[$RC,$([[ -s "$WORK/error" ]] && printf true || printf false)]" '[0,false]'
STUB_HERMES_LOCAL_STDERR=1 run --agent hermes --model local-reason/qwen3.8-27b-reason
check 'No-account message on stderr is also unread' '[.ok,.vendor.verdict]' '[true,"unread"]'
printf 'Hermes usage endpoint failed\n' >"$WORK/local-error.txt"
STUB_HERMES_LOCAL_ERROR="$WORK/local-error.txt" run --agent hermes --model local-reason/qwen3.8-27b-reason
check 'Other local usage failure stays unknown' "[$RC,.ok,.vendor.verdict,.vendor.state]" '[3,false,"unknown","unreadable"]'
for agent in hermes openclaw; do
  run --agent "$agent"
  check 'Missing seat never guesses newest session' '[.ok,.reason]' '[false,"current-model-unknown"]'
  [[ "$RC" == 3 ]] || failed=$((failed+1))
done
run --agent cursor
check 'Cursor is deferred' '[.ok,.reason]' '[false,"cursor-not-integrated"]'
RC=0
OUT="$(python3 - "$PROBE" <<'PY'
import os, pty, subprocess, sys
master, slave = pty.openpty()
result = subprocess.run([sys.argv[1], '--agent', 'cursor'], stdout=slave, stderr=subprocess.PIPE, timeout=10, env={**os.environ, 'NO_COLOR': '1'})
os.close(slave)
try:
    print(os.read(master, 4096).decode().strip())
except OSError:
    pass
os.close(master)
sys.exit(result.returncode)
PY
)" || RC=$?
check 'Agent read stays JSON on a terminal' '[.ok,.reason]' '[false,"cursor-not-integrated"]'
run --agent codex --model gpt-5.6-terra
check 'Codex reuses quota probe' '[.model,.provider,.model_vendor,.vendor.verdict]' '["gpt-5.6-terra","openai","openai","go"]'
run --agent claude-code
check 'Claude fixed vendor with no model' '[.model,.provider,.model_vendor,.vendor.verdict]' '[null,"anthropic","anthropic","go"]'
run --agent openclaw --seat test-claw
check 'OpenClaw seat uses exact key' '[.model,.provider,.model_vendor,.vendor.tightest_window.used_pct]' '["gpt-5.6-terra","openai","openai",31]'
export STUB_OPENCLAW_USAGE="$WORK/claw.json"
jq '.usage.providers[0].windows[0].usedPercent=25' "$STUB_FIXTURES/openclaw-status-usage.json" >"$STUB_OPENCLAW_USAGE"
run --agent openclaw --seat test-claw
check 'OpenClaw requested 25 percent case' '[.vendor.verdict,.vendor.tightest_window.used_pct]' '["go",25]'
run --agent openclaw --model anthropic/claude-sonnet-5
check 'OpenClaw no matching provider is unread' '[.model_vendor,.vendor.verdict,.ok]' '["anthropic","unread",true]'
unset STUB_OPENCLAW_USAGE
for pair in 'openai/gpt-5.6-terra openai' 'openai-codex/gpt-5.6-terra openai' 'codex/gpt-5.6-terra openai' 'chatgpt/gpt-5.6-terra openai' 'claude/claude-sonnet-5 anthropic' 'anthropic/claude-sonnet-5 anthropic' 'openrouter/anthropic/claude-sonnet-5 anthropic' 'google/gemini-3 google' 'custom/qwen local:custom' 'local-reason/qwen local:local-reason' 'cursor-claude-sonnet-5 anthropic' 'gpt-5.6-terra openai' 'o3 openai' 'special-codex openai' 'cursor-gemini-3 google' 'cursor-grok-4.5 xai' 'composer-2 cursor' 'default cursor' 'auto cursor' 'other/unknown other'; do
  read -r model vendor <<<"$pair"
  run --agent hermes --model "$model"
  check "Vendor normalization $model" '.model_vendor' "\"$vendor\""
done
rm "$HERMES_HOME/logs/agent.log"
run --pick handoff --from hermes --seat test-hermes --json
check 'Default agent order' '.order' '["claude-code","codex","cursor","hermes","openclaw"]'
check 'In-place candidates come before other agents' '.candidates[:3] | map([.agent,.model,.provider,.vendor,.in_place,.verdict])' '[["hermes","qwen3.8-27b-reason","local-reason","local:local-reason",true,"unread"],["hermes","claude-sonnet-5","anthropic","anthropic",true,"short_only"],["claude-code",null,"anthropic","anthropic",false,"go"]]'
check 'Unread quota can win' '[.chosen.model,.chosen.verdict]' '["qwen3.8-27b-reason","unread"]'
check 'Unread local model is not skipped' '[.skipped[] | select(.provider=="local-reason")]' '[]'
check 'Same vendor Codex skipped' '[.skipped[] | select(.agent=="codex") | .reason]' '["same-vendor"]'
check 'Cursor skipped explicitly' '[.skipped[] | select(.agent=="cursor") | .reason]' '["cursor-not-integrated"]'
STUB_HERMES_LOCAL_STDERR=1 run --pick handoff --from hermes --seat test-hermes --json
check 'No-account message on stderr remains a handoff candidate' '[.chosen.model,.chosen.verdict]' '["qwen3.8-27b-reason","unread"]'
STUB_HERMES_LOCAL_ERROR="$WORK/local-error.txt" run --pick handoff --from hermes --seat test-hermes --json
check 'Other local usage failure skips the model as unavailable' '[.chosen.provider,[.skipped[] | select(.provider=="local-reason") | .reason]]' '["anthropic",["unavailable"]]'
run --pick review --from hermes --seat test-hermes --json
check 'Review begins at agent order, no in-place group' '[.chosen.agent,all(.candidates[]; .in_place==false)]' '["claude-code",true]'
check 'Review includes sender other vendors' '[.candidates[] | select(.agent=="hermes") | .model]' '["qwen3.8-27b-reason","claude-sonnet-5"]'
printf '[elsewhere]\nhandoff_order="codex"\n[models]\nhandoff_order = '\''openclaw,unknown,hermes,cursor,claude-code,codex'\'' # order\n' >"$XDG_CONFIG_HOME/sno/models.toml"
run --pick handoff --from claude-code --json
check 'Quoted configured order ignores unknown agents' '.order' '["openclaw","hermes","cursor","claude-code","codex"]'
check 'Order chooses OpenClaw first' '.chosen.agent' '"openclaw"'
[[ "$(cat "$WORK/error")" == *unknown* ]] || failed=$((failed+1))
printf '[models]\nhandoff_order="claude-code,codex,cursor"\n' >"$XDG_CONFIG_HOME/sno/models.toml"
export STUB_CLAUDE_MODE=silent
run --pick handoff --from codex --json
check 'No winner stays successful' '[.ok,.chosen,.candidates]' '[true,null,[]]'
check 'Unreadable CLI skips unavailable' '[.skipped[] | select(.agent=="claude-code") | .reason]' '["unavailable"]'
[[ "$(cat "$WORK/error")" == *claude* ]] || failed=$((failed+1))
unset STUB_CLAUDE_MODE
printf '[models]\nhandoff_order="hermes,codex"\n' >"$XDG_CONFIG_HOME/sno/models.toml"
export STUB_HERMES_FAIL=1
run --pick handoff --from claude-code --json
check 'Failed probe walk continues' '.chosen.agent' '"codex"'
check 'Failed model list is unavailable' '.skipped[0].reason' '"unavailable"'
[[ "$(cat "$WORK/error")" == *'hermes fallback list'*'Hermes login expired'* ]] || failed=$((failed+1))
unset STUB_HERMES_FAIL
# A blocked sender can still ask for another vendor.
sed -e 's/RESET_BLOCKED/1792000000/g' -e 's/RESET_LATER/1792000000/g' "$STUB_FIXTURES/codex-blocked.json" >"$WORK/blocked-codex.json"
STUB_CODEX_PAYLOAD="$WORK/blocked-codex.json" run --pick handoff --from codex --json
check 'Blocked sender still selects another vendor' '[.ok,.from.verdict,.chosen.agent]' '[true,"wait","hermes"]'
printf '[models]\nhandoff_order="claude-code"\n' >"$XDG_CONFIG_HOME/sno/models.toml"
sed -e 's/FIVE_RESET/2026-10-15T00:00:00.000000+00:00/g' -e 's/WEEK_RESET/2026-10-20T00:00:00.000000+00:00/g' "$STUB_FIXTURES/claude-blocked.json" >"$WORK/blocked-claude.json"
STUB_CLAUDE_PAYLOAD="$WORK/blocked-claude.json" run --pick handoff --from codex --json
check 'Quota wait skips no-quota' '[.chosen,.skipped[0].reason]' '[null,"no-quota"]'
printf '[models]\nhandoff_order="hermes"\n' >"$XDG_CONFIG_HOME/sno/models.toml"
STUB_HERMES_REFUSAL=1 run --pick handoff --from codex --json
check 'Named-model refusal skips no-quota' '[.chosen,[.skipped[] | select(.vendor!="openai") | .reason]]' '[null,["no-quota","no-quota"]]'
printf '[models]\nhandoff_order="openclaw"\n' >"$XDG_CONFIG_HOME/sno/models.toml"
STUB_SINGLE_USAGE=1 run --pick review --from claude-code --json
check 'All OpenClaw models share one successful quota read' '.candidates | length' '7'
check 'OpenClaw own ordering is default then available catalogue' '[.candidates[:3][] | .model]' '["gpt-5.6-terra","gpt-6-astra","gpt-5.6-sol"]'
check 'Available catalogue models all have usable quota' '[all(.candidates[]; .verdict=="go"),.skipped]' '[true,[]]'
export STUB_OPENCLAW_FALLBACKS="$WORK/fallbacks.json"
printf '{"fallbacks":["anthropic/claude-sonnet-5","local-reason/qwen3.8-27b-reason"]}\n' >"$STUB_OPENCLAW_FALLBACKS"
rm "$STUB_COMMAND_LOG.openclaw"
STUB_SINGLE_USAGE=1 run --pick handoff --from openclaw --seat test-claw --json
check 'Sender quota reused across other OpenClaw providers' '.candidates | map([.model,.vendor,.in_place,.verdict])' '[["claude-sonnet-5","anthropic",true,"unread"],["qwen3.8-27b-reason","local:local-reason",true,"unread"]]'
unset STUB_OPENCLAW_FALLBACKS
printf '[models]\nhandoff_order="hermes"\n' >"$XDG_CONFIG_HOME/sno/models.toml"
printf '{"runtime":"hermes","session_id":"20261009_071006_873a0a","cwd":"/tmp/reach-test","spawned_at":1791529806}\n' >"$SNO_REACH_STATE_ROOT/test-hermes/transcript.json"
printf '2026-10-09 07:20:00,000 INFO [20261009_071006_873a0a] agent.conversation_loop: API call #9: model=claude-sonnet-5 provider=anthropic in=1\n' >"$HERMES_HOME/logs/agent.log"
run --pick handoff --from codex --json
check 'Another agent offers its recorded current model before fallbacks' '[.chosen.agent,.chosen.model,.chosen.provider,.chosen.in_place]' '["hermes","claude-sonnet-5","anthropic",false]'
rm "$HERMES_HOME/logs/agent.log"
export STUB_HERMES_ANTHROPIC="$WORK/malformed.json"
jq '.windows[1].used_percent="broken"' "$STUB_FIXTURES/hermes-usage-anthropic.json" >"$STUB_HERMES_ANTHROPIC"
run --agent hermes --model claude-sonnet-5
check 'Malformed usage is unknown, never available' '[.ok,.vendor.verdict,.vendor.state]' '[false,"unknown","unreadable"]'
run --pick handoff --from codex --json
check 'Malformed usage skips only affected provider' '[.chosen.model,[.skipped[] | select(.provider=="anthropic") | .reason]]' '["qwen3.8-27b-reason",["unavailable"]]'
[[ "$(cat "$WORK/error")" == *'hermes'*'usage'*'percent'* ]] || failed=$((failed+1))
unset STUB_HERMES_ANTHROPIC
# Before any request, the seat row in the real SQLite database supplies the model.
printf '{"session_id":"20261009_080000_aaaaaa"}\n' >"$SNO_REACH_STATE_ROOT/test-hermes/transcript.json"
python3 - "$HERMES_HOME/state.db" <<'PY'
import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
    db.execute('CREATE TABLE sessions (id TEXT, model TEXT, billing_provider TEXT)')
    db.execute('INSERT INTO sessions VALUES (?, ?, ?)', ('20261009_080000_aaaaaa','claude-sonnet-5','anthropic'))
PY
run --agent hermes --seat test-hermes
check 'No-request seat uses database model/provider' '[.model,.provider,.vendor.tightest_window.used_pct]' '["claude-sonnet-5","anthropic",92]'
# Resolve the unrecorded session by address and spawn time, not by recency alone.
printf '{"cwd":"/tmp/reach-test","spawned_at":1791529806}\n' >"$SNO_REACH_STATE_ROOT/test-hermes/transcript.json"
run --agent hermes --seat test-hermes
check 'Unresolved seat found through session export' '[.model,.provider]' '["gpt-5.6-terra","openai-codex"]'
printf '{"id":"20261009_071006_873a0a","started_at":1791529806,"messages":[{"role":"user","content":"different seat"}]}\n' >"$STUB_HERMES_EXPORT"
run --agent hermes --seat test-hermes
check 'Unrelated session cannot supply model' '[.ok,.reason]' '[false,"current-model-unknown"]'
printf '1..%s\nagent quota selftest: %s passed, %s failed\n' "$((passed+failed))" "$passed" "$failed"
((failed==0))
