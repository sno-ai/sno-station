#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd -- "$HERE/../../../apps/report-time" && pwd)"
export REPORT_TIME="${REPORT_TIME:-$APP/bin/report-time}"

printf 'TAP version 13\n'
bash "$HERE/report-time.t"
printf '1..1\nreport-time selftest: ALL PASS (1 stage(s))\n'
