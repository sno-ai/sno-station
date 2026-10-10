#!/usr/bin/env bash
# Run the preserved behavioural suites against this repository's application.
set -Eeuo pipefail
export LC_ALL=C
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd -- "$HERE/../../../apps/subscription-quota-check" && pwd)"
export PROBE="$APP/bin/subscription-quota-check"

printf 'TAP version 13\n'
if ! bash "$HERE/probe.t"; then
  printf 'FAIL probe.t\n' >&2
  exit 1
fi
if ! bash "$HERE/agents.t"; then
  printf 'FAIL agents.t\n' >&2
  exit 1
fi
printf '1..2\nsubscription-quota-check selftest: ALL PASS (2 stage(s))\n'
