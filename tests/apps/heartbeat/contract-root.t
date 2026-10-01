#!/usr/bin/env bash
# A contract is one JSON object, not a stream of individually valid objects.
set -Eeuo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$HERE/../../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/contract-root.XXXXXX")"
trap 'rm -rf -- "$WORK"' EXIT
mkdir -p "$WORK/apps"
cp "$ROOT/LICENSE" "$WORK/LICENSE"
for app in heartbeat report-time subscription-quota-check; do
  cp -a "$ROOT/apps/$app" "$WORK/apps/$app"
  rm -rf -- "$WORK/apps/$app/dist"
done
git -C "$WORK" init -q
git -C "$WORK" add .
git -C "$WORK" -c user.name=Test -c user.email=test@example.invalid commit -qm fixture
{
  printf '{}\n'
  jq -c . "$HERE/fixtures/requirements-contract.json"
} >"$WORK/concatenated.json"
for app in heartbeat report-time subscription-quota-check; do
  if make -C "$WORK/apps/$app" package "CONTRACT=$WORK/concatenated.json" >"$WORK/result.log" 2>&1; then
    cat "$WORK/result.log"
    printf 'FAIL %s accepted concatenated JSON objects\n' "$app" >&2
    exit 1
  fi
  cat "$WORK/result.log"
  [[ ! -d "$WORK/apps/$app/dist" ]] ||
    [[ -z "$(find "$WORK/apps/$app/dist" -type f -print -quit)" ]]
  printf 'PASS %s rejects concatenated contract objects without artifacts\n' "$app"
done
