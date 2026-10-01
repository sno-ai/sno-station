#!/usr/bin/env bash
set -Eeuo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
case "${1:-}" in
''|local)
  bash "$HERE/cleanup.t"
  exec python3 "$HERE/local-suite.py"
  ;;
archive)
  shift
  exec bash "$HERE/archive.t" "$@"
  ;;
startup)
  shift
  exec bash "$HERE/startup.t" "$@"
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
