#!/usr/bin/env bash
# The workflow's required test job precedes this accepted-byte gate.
set -Eeuo pipefail
[[ $# == 2 ]] || { printf 'usage: verify-utility-release.sh ACCEPTED_RECORD CONTRACT\n' >&2; exit 2; }
record="$(realpath -e -- "$1")"
contract_file="$(realpath -e -- "$2")"
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
source_commit="$(git -C "$root" rev-parse HEAD)"
contract_repo="$(git -C "$(dirname -- "$contract_file")" rev-parse --show-toplevel)"
contract_commit="$(git -C "$contract_repo" rev-parse HEAD)"
contract_relative="${contract_file#"$contract_repo/"}"
[[ "$contract_relative" != "$contract_file" ]] || exit 2
git -C "$contract_repo" ls-files --error-unmatch -- "$contract_relative" >/dev/null
git -C "$contract_repo" diff --quiet HEAD -- "$contract_relative" || {
  printf 'release: contract differs from pinned commit\n' >&2; exit 2;
}
declare -A expected=()
rows=0
while IFS=$'\t' read -r archive digest source_ref contract_ref extra || [[ -n "$archive" ]]; do
  [[ -n "$archive" && -z "$extra" && "$digest" =~ ^[a-f0-9]{64}$ &&
     "$source_ref" == "$source_commit" && "$contract_ref" == "$contract_commit" ]] || {
    printf 'release: invalid accepted record or commit mismatch: %s\n' "$archive" >&2; exit 2;
  }
  [[ -z "${expected[$archive]+present}" ]] || { printf 'release: duplicate accepted archive\n' >&2; exit 2; }
  expected["$archive"]="$digest"
  rows=$((rows + 1))
done < "$record"
[[ "$rows" == 3 ]] || { printf 'release: expected three accepted archives\n' >&2; exit 2; }
for program in heartbeat report-time subscription-quota-check; do
  version="$(<"$root/apps/$program/VERSION")"
  archive="$program-$version.tar.gz"
  [[ -n "${expected[$archive]:-}" ]] || { printf 'release: missing accepted archive: %s\n' "$archive" >&2; exit 2; }
  make -C "$root/apps/$program" package CONTRACT="$contract_file"
  actual="$(sha256sum "$root/apps/$program/dist/$archive" | cut -d ' ' -f1)"
  [[ "$actual" == "${expected[$archive]}" ]] || {
    printf 'release: accepted digest mismatch: %s expected=%s actual=%s\n' "$archive" "${expected[$archive]}" "$actual" >&2
    exit 1
  }
  (cd "$root/apps/$program/dist" && sha256sum -c "$archive.sha256")
  printf 'verified %s %s source=%s contract=%s\n' "$archive" "$actual" "$source_commit" "$contract_commit"
done
