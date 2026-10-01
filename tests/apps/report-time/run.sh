#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd -- "$HERE/../../../apps/report-time" && pwd)"
export REPORT_TIME="${REPORT_TIME:-$APP/bin/report-time}"

gate_rc=0
grep -rInI -E --exclude='*.tar.gz' '/home/|~/.codex/skills|~/.claude/skills|(^|[^[:alnum:]_])(lh|larry|gpt1|a-clean-test-vm)([^[:alnum:]_]|$)' "$APP" || gate_rc=$?
if ((gate_rc != 1)); then
  printf 'FAIL personal binding in %s\n' "$APP" >&2
  exit 1
fi

printf 'TAP version 13\n'
bash "$HERE/report-time.t"
printf '1..1\nreport-time selftest: ALL PASS (1 stage(s))\n'
