#!/usr/bin/env bash
# Hold both real directory moves at the same boundary, then release them together.
set -Eeuo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$HERE/../../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/utility-install-race.XXXXXX")"
trap 'rm -rf -- "$WORK"' EXIT
mkdir -p "$WORK/source/apps" "$WORK/tools"
cp "$ROOT/LICENSE" "$WORK/source/LICENSE"
cp "$HERE/install-race-mv" "$WORK/tools/mv"
chmod +x "$WORK/tools/mv"
for app in heartbeat report-time subscription-quota-check; do
  cp -a "$ROOT/apps/$app" "$WORK/source/apps/$app"
  rm -rf -- "$WORK/source/apps/$app/dist"
done
git -C "$WORK/source" init -q
git -C "$WORK/source" add .
git -C "$WORK/source" -c user.name=Test -c user.email=test@example.invalid commit -qm fixture
UTILITY_REAL_MV="$(command -v mv)"
export UTILITY_REAL_MV
for app in heartbeat report-time subscription-quota-check; do
  make -C "$WORK/source/apps/$app" package "CONTRACT=$HERE/fixtures/requirements-contract.json"
  export UTILITY_MOVE_BARRIER="$WORK/$app-barrier"
  mkdir "$UTILITY_MOVE_BARRIER"
  env PATH="$WORK/tools:$PATH" make -C "$WORK/source/apps/$app" install "HOME=$WORK/install-home" >"$WORK/first.log" 2>&1 &
  first=$!
  env PATH="$WORK/tools:$PATH" make -C "$WORK/source/apps/$app" install "HOME=$WORK/install-home" >"$WORK/second.log" 2>&1 &
  second=$!
  rc1=0; rc2=0
  wait "$first" || rc1=$?
  wait "$second" || rc2=$?
  cat "$WORK/first.log" "$WORK/second.log"
  [[ "$rc1" == 0 && "$rc2" == 0 ]] || { printf 'FAIL simultaneous installs: %s %s\n' "$rc1" "$rc2" >&2; exit 1; }
  [[ "$(find "$UTILITY_MOVE_BARRIER" -type f | wc -l)" == 2 ]]
  version="$(<"$ROOT/apps/$app/VERSION")"
  mkdir -p "$WORK/expected/$app"
  tar xzf "$WORK/source/apps/$app/dist/$app-$version.tar.gz" -C "$WORK/expected/$app"
  diff -r "$WORK/expected/$app" "$WORK/install-home/.local/lib/sno-$app/releases/$version"
  "$WORK/install-home/.local/bin/$app" --help >/dev/null
  printf 'PASS %s simultaneous same-version install creates exactly one intact release\n' "$app"
done
