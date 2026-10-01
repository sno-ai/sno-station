#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
fixture="$repo_root/tests/apps/mem-claw/fixtures/rem-retired-vocabulary.negative.json"
retired="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).masterSwitch)' "$fixture")"
runner="$repo_root/evals/memora/evals/agent_eval/run_memora_mem_claw.sh"
if grep -q -- "$retired" "$runner"; then
	echo "retired master-switch alias remains in production runner: $retired" >&2
	exit 1
fi
if ! grep -q -- "SNO_EDGE_REM" "$runner"; then
	echo "current master switch is absent from production runner: SNO_EDGE_REM" >&2
	exit 1
fi
echo "retired master switch is refused by absence; current switch is wired"
