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
if ! bash "$HERE/claude-result.t"; then
  printf 'FAIL claude-result.t\n' >&2
  exit 1
fi
if ! bash "$HERE/claude-fallback.t"; then
  printf 'FAIL claude-fallback.t\n' >&2
  exit 1
fi
if ! bash "$HERE/codex-blocking.t"; then
  printf 'FAIL codex-blocking.t\n' >&2
  exit 1
fi
printf '1..5\nsubscription-quota-check selftest: ALL PASS (5 stage(s))\n'
