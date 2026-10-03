#!/usr/bin/env bash
set -Eeuo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
case "${1:-}" in
''|local)
  exec python3 "$HERE/local-suite.py"
  ;;
archive)
  shift
  exec bash "$HERE/archive.t" "$@"
  ;;
startup)
  shift
  installed="${1:?installed candidate command required}"
  proof="${2:?new proof directory required}"
  mkdir -- "$proof"
  status=0
  REACH_UNDER_TEST="$installed" REACH_KEEP_TEST_ROOT=1 \
    bash "$HERE/notification-once.t" >"$proof/notification-once.log" 2>&1 || status=$?
  cat "$proof/notification-once.log"
  exit "$status"
  ;;
public)
  for mode in surface init lint inbox wait reply; do
    printf 'START public %s\n' "$mode"
    timeout 120 bash "$HERE/public-contract.t" "$mode"
  done
  ;;
lint) bash "$HERE/progress-reporting-lint.t" ;;
transport) bash "$HERE/transport.t" ;;
*)
  printf 'Choose local, public, lint, transport, archive <asset> <new-evidence-dir>, or startup <installed-command> <new-evidence-dir>. External/live acceptance is separate.\n' >&2
  exit 2
  ;;
esac
