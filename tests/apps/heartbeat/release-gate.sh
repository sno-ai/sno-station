#!/usr/bin/env bash
# Exercise the actual release-byte verifier in disposable committed repositories.
set -Eeuo pipefail
export LC_ALL=C
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$HERE/../../.." && pwd)"
CONTRACT_REPO="${1:?usage: release-gate.sh CONTRACT_REPO CONTRACT_COMMIT}"
CONTRACT_COMMIT="${2:?contract commit required}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/utility-gate.XXXXXX")"
trap 'rm -rf -- "$WORK"' EXIT
mkdir -p "$WORK/source/apps" "$WORK/source/tests/apps" "$WORK/source/.github/workflows" "$WORK/contract/scripts"
cp "$ROOT/LICENSE" "$WORK/source/LICENSE"
cp "$ROOT/.github/workflows/release-packages.yml" "$WORK/source/.github/workflows/"
for app in heartbeat report-time subscription-quota-check; do
  cp -a "$ROOT/apps/$app" "$WORK/source/apps/$app"
  rm -rf -- "$WORK/source/apps/$app/dist"
  cp -a "$ROOT/tests/apps/$app" "$WORK/source/tests/apps/$app"
done
git -C "$CONTRACT_REPO" show "$CONTRACT_COMMIT:scripts/requirements-contract.json" >"$WORK/contract/scripts/requirements-contract.json"
for repo in source contract; do
  git -C "$WORK/$repo" init -q
  git -C "$WORK/$repo" add .
  git -C "$WORK/$repo" -c user.name=Test -c user.email=test@example.invalid commit -qm 'release gate fixture'
done
source_commit="$(git -C "$WORK/source" rev-parse HEAD)"
contract_commit="$(git -C "$WORK/contract" rev-parse HEAD)"
contract="$WORK/contract/scripts/requirements-contract.json"
verifier="$WORK/source/apps/heartbeat/verify-utility-release.sh"
record="$WORK/accepted.txt"
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
record_build() {
  local input="$1" app archive digest
  : >"$record"
  for app in heartbeat report-time subscription-quota-check; do
    make -C "$WORK/source/apps/$app" package "CONTRACT=$input"
    archive="$app-$(<"$ROOT/apps/$app/VERSION").tar.gz"
    digest="$(sha256sum "$WORK/source/apps/$app/dist/$archive" | cut -d ' ' -f1)"
    printf '%s\t%s\t%s\t%s\n' "$archive" "$digest" "$source_commit" "$contract_commit" >>"$record"
  done
}
reject_digest() {
  if bash "$verifier" "$record" "$contract" >"$WORK/rejected.log" 2>&1; then
    fail 'release verifier accepted mismatching bytes'
  fi
  grep -F "accepted digest mismatch: heartbeat-$(<"$ROOT/apps/heartbeat/VERSION").tar.gz" "$WORK/rejected.log" || fail 'refusal was not the digest gate'
  ! grep -q '^verified ' "$WORK/rejected.log" || fail 'a mismatching archive was verified'
}

record_build "$contract"
bash "$verifier" "$record" "$contract" | tee "$WORK/valid.log"
[[ "$(grep -c '^verified ' "$WORK/valid.log")" == 3 ]] || fail 'valid record did not verify three archives'
printf 'PASS real helper accepts three matching archives with pinned committed contract\n'

awk 'BEGIN {FS=OFS="\t"} NR==1 {$2=(substr($2,1,1)=="0"?"1":"0") substr($2,2)} {print}' "$record" >"$WORK/altered.txt"
mv "$WORK/altered.txt" "$record"
reject_digest
printf 'PASS changing one accepted digest digit stops release verification\n'

# The current checked-in fixture equals the real file. Use a valid compact fixture
# to test byte drift explicitly; provenance alone cannot change identical digests.
jq -c . "$HERE/fixtures/requirements-contract.json" >"$WORK/compact-fixture.json"
! cmp -s "$WORK/compact-fixture.json" "$contract" || fail 'fixture mutation did not change contract bytes'
record_build "$WORK/compact-fixture.json"
reject_digest
printf 'PASS fixture-byte acceptance cannot authorize different real-contract bytes\n'

python3 "$HERE/workflow-gate.py" "$WORK/source"
record_build "$contract"
python3 "$HERE/workflow-resume.py" "$WORK/source"
