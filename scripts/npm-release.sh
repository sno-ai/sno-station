#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf '%s\n' 'Usage: npm-release.sh prepare|publish|finalize SOURCE_SHA CANDIDATE_DIR RUN_ID' >&2
  exit 2
}

[[ $# == 4 ]] || usage
operation=$1
source_sha=$2
candidate_dir=$3
run_id=$4
[[ $operation == prepare || $operation == publish || $operation == finalize ]] || usage
[[ $source_sha =~ ^[0-9a-f]{40}$ && $run_id =~ ^[0-9]+$ ]] || usage
for tool in jq npm openssl git; do command -v "$tool" >/dev/null || { printf 'Missing %s\n' "$tool" >&2; exit 2; }; done
[[ $(git rev-parse HEAD) == "$source_sha" ]] || { printf 'Checked-out source differs from %s\n' "$source_sha" >&2; exit 2; }
mkdir -p -- "$candidate_dir"
candidate_dir=$(cd "$candidate_dir" && pwd -P)
manifest="$candidate_dir/manifest.json"

package_dirs=(
  packages/utils packages/common-core packages/embedder packages/observability
  packages/sqlite-crypto packages/chunking packages/content-sanitizer packages/memory
  apps/mem-codex apps/mem-claude apps/mem-cursor apps/mem-claw
)

package_row() {
  jq -r --argjson index "$1" '.packages[$index] | [.name, .version, .tag, .file, .integrity] | @tsv' "$manifest"
}

verify_manifest() {
  jq -e --arg sha "$source_sha" --arg run "$run_id" '
    .source_sha == $sha and .run_id == $run and
    (.packages | length) >= 1 and
    all(.packages[]; (.name | startswith("@snoai/")) and
      (.version | type == "string") and (.tag == "latest" or .tag == "next") and
      (.file | endswith(".tgz")) and (.integrity | startswith("sha512-")))
  ' "$manifest" >/dev/null || { printf 'Candidate table does not match this source and run\n' >&2; exit 2; }
}

verify_tarballs() {
  local count row name version tag file integrity actual index
  count=$(jq -r '.packages | length' "$manifest")
  for ((index = 0; index < count; index++)); do
    row=$(package_row "$index")
    IFS=$'\t' read -r name version tag file integrity <<< "$row"
    [[ -f "$candidate_dir/tarballs/$file" ]] || { printf 'Missing candidate file for %s@%s\n' "$name" "$version" >&2; exit 2; }
    actual="sha512-$(openssl dgst -sha512 -binary "$candidate_dir/tarballs/$file" | openssl base64 -A)"
    [[ $actual == "$integrity" ]] || { printf 'Candidate bytes changed for %s@%s\n' "$name" "$version" >&2; exit 2; }
  done
}

registry_integrity() {
  local result
  if result=$(npm view "$1@$2" dist.integrity --json 2> "$candidate_dir/npm-view.err"); then
    jq -er '.' <<< "$result"
  elif grep -q 'E404' "$candidate_dir/npm-view.err"; then
    return 4
  else
    printf 'Cannot read npm registry for %s@%s; publication stopped\n' "$1" "$2" >&2
    return 2
  fi
}

verify_registry() {
  local count row name version tag file integrity actual index
  count=$(jq -r '.packages | length' "$manifest")
  for ((index = 0; index < count; index++)); do
    row=$(package_row "$index")
    IFS=$'\t' read -r name version tag file integrity <<< "$row"
    actual=$(registry_integrity "$name" "$version") || { printf 'Registry does not contain %s@%s with approved bytes\n' "$name" "$version" >&2; return 1; }
    [[ $actual == "$integrity" ]] || { printf 'Registry bytes differ for %s@%s\n' "$name" "$version" >&2; return 1; }
  done
}

release_tag() {
  local version
  version=$(sed -n 's/^version: "\([^"]*\)"/\1/p' VERSION.yaml)
  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf 'VERSION.yaml has no release version\n' >&2; exit 2; }
  printf 'v%s\n' "$version"
}

case $operation in
  prepare)
    mkdir -p -- "$candidate_dir/tarballs" "$candidate_dir/pack" "$candidate_dir/records"
    rows=()
    for package_dir in "${package_dirs[@]}"; do
      name=$(jq -er '.name' "$package_dir/package.json")
      version=$(jq -er '.version' "$package_dir/package.json")
      slug=${name##*/}
      tag=latest
      [[ $version == *-* ]] && tag=next
      if registry_integrity "$name" "$version" > /dev/null; then
        # Not part of this release. Its tarball differs from the published one anyway: the diagnostic catalog hashes
        # every source file in the workspace, so any change anywhere changes the bytes of every package.
        printf '%s@%s is already on npm; not part of this release\n' "$name" "$version" >&2
        continue
      else
        result=$?
        [[ $result == 4 ]] || exit "$result"
      fi
      printf 'Packing %s@%s\n' "$name" "$version" >&2
      output=$(cd "$package_dir" && npm pack --silent --pack-destination "$candidate_dir/tarballs")
      file=${output##*$'\n'}
      [[ $file == *.tgz && -f "$candidate_dir/tarballs/$file" ]] || { printf 'Pack did not produce a tarball for %s\n' "$name" >&2; exit 1; }
      npm publish --dry-run --json --access public --tag "$tag" "$candidate_dir/tarballs/$file" > "$candidate_dir/pack/$slug.json"
      integrity=$(jq -er --arg name "$name" --arg version "$version" 'select(.name == $name and .version == $version) | .integrity' "$candidate_dir/pack/$slug.json")
      jq -n --arg name "$name" --arg version "$version" --arg tag "$tag" --arg file "$file" --arg integrity "$integrity" \
        '{name:$name,version:$version,tag:$tag,file:$file,integrity:$integrity}' > "$candidate_dir/records/$slug.json"
      rows+=("$candidate_dir/records/$slug.json")
    done
    jq -s --arg sha "$source_sha" --arg run "$run_id" \
      '{source_sha:$sha,run_id:$run,packages:.}' "${rows[@]}" > "$manifest"
    verify_manifest
    verify_tarballs
    printf 'Candidate prepared from %s in run %s\n' "$source_sha" "$run_id"
    ;;
  publish)
    verify_manifest
    verify_tarballs
    main_sha=$(git ls-remote origin refs/heads/main | cut -f1)
    [[ $main_sha =~ ^[0-9a-f]{40}$ ]] || { printf 'Cannot read public main\n' >&2; exit 2; }
    count=$(jq -r '.packages | length' "$manifest")
    already_published=0
    for ((index = 0; index < count; index++)); do
      row=$(package_row "$index")
      IFS=$'\t' read -r name version tag file integrity <<< "$row"
      if actual=$(registry_integrity "$name" "$version"); then
        [[ $actual == "$integrity" ]] || { printf 'Existing npm version has different bytes: %s@%s\n' "$name" "$version" >&2; exit 2; }
        ((already_published += 1))
      else
        result=$?
        [[ $result == 4 ]] || exit "$result"
      fi
    done
    [[ $main_sha == "$source_sha" || $already_published -gt 0 ]] || { printf 'Public main advanced before publication; prepare a new candidate\n' >&2; exit 2; }
    for ((index = 0; index < count; index++)); do
      row=$(package_row "$index")
      IFS=$'\t' read -r name version tag file integrity <<< "$row"
      if actual=$(registry_integrity "$name" "$version"); then
        [[ $actual == "$integrity" ]] || { printf 'Existing npm version has different bytes: %s@%s\n' "$name" "$version" >&2; exit 2; }
        printf 'Already published: %s@%s\n' "$name" "$version" >&2
        continue
      else
        result=$?
        [[ $result == 4 ]] || exit "$result"
      fi
      printf 'Publishing %s@%s (%s/%s)\n' "$name" "$version" "$((index + 1))" "$count" >&2
      npm publish "$candidate_dir/tarballs/$file" --access public --tag "$tag" --provenance
    done
    verify_registry
    tag=$(release_tag)
    if ! gh release view "$tag" >/dev/null 2>&1; then
      {
        printf 'Sno Station %s\n\nPublished npm packages from %s:\n\n' "$tag" "$source_sha"
        for ((index = 0; index < count; index++)); do
          row=$(package_row "$index")
          IFS=$'\t' read -r name version package_tag file integrity <<< "$row"
          printf -- '- %s@%s (%s)\n' "$name" "$version" "$package_tag"
        done
      } > "$candidate_dir/release-notes.md"
      gh release create "$tag" --draft --target "$source_sha" --title "Sno Station $tag" --notes-file "$candidate_dir/release-notes.md"
    fi
    printf 'All package versions verified; GitHub Release is a draft\n'
    ;;
  finalize)
    verify_manifest
    verify_registry
    tag=$(release_tag)
    [[ $(git ls-remote origin refs/heads/main | cut -f1) == "$source_sha" ]] || { printf 'Public main changed before release finalization\n' >&2; exit 2; }
    [[ $(gh release view "$tag" --json isDraft --jq '.isDraft') == true ]] || { printf 'Expected draft GitHub Release %s\n' "$tag" >&2; exit 2; }
    # `sno setup` downloads these from the Release; v1.0.1 shipped without them and every fresh setup failed five rows.
    # This release's own page must carry them: the older copies are removed below, once this page is public.
    attached=$(gh release view "$tag" --json assets --jq '.assets[].name')
    reach_version=$(<apps/reach/VERSION)
    expected=(heartbeat-"$(<apps/heartbeat/VERSION)".tar.gz report-time-"$(<apps/report-time/VERSION)".tar.gz
      subscription-quota-check-"$(<apps/subscription-quota-check/VERSION)".tar.gz)
    for platform in linux-x86_64 linux-aarch64 macos-x86_64 macos-aarch64; do expected+=("reach-$reach_version-$platform.tar.gz"); done
    for name in "${expected[@]}"; do
      grep -qxF "$name" <<< "$attached" || { printf 'No release carries %s (checked before publishing %s); run the release archives workflow for this tag first\n' "$name" "$tag" >&2; exit 2; }
    done
    gh release edit "$tag" --draft=false
    printf 'GitHub Release %s published after external installation proof\n' "$tag"
    # A program version lives in exactly one published release ("ambiguous release asset" otherwise): drop the older copies.
    for name in "${expected[@]}"; do
      gh api "repos/$GITHUB_REPOSITORY/releases?per_page=100" --jq ".[] | select(.draft == false and .tag_name != \"$tag\") | .tag_name as \$t | .assets[] | select(.name == \"$name\") | \"\(\$t) \(.id)\"" | while read -r older asset_id; do
        gh api -X DELETE "repos/$GITHUB_REPOSITORY/releases/assets/$asset_id" && printf 'Removed %s from %s\n' "$name" "$older"
      done
    done
    ;;
esac
