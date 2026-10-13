#!/usr/bin/env bash
# Prints every released program whose source changed since the last release tag while its VERSION did not, one name per line.
# A program archive is named after its VERSION, so a changed program with the old number ships the old build.
# Usage: scripts/program-versions.sh [base-tag]   (default: the newest v*.*.* tag that does not contain HEAD; needs full history and tags)
set -Eeuo pipefail
cd "$(git rev-parse --show-toplevel)"
programs=(reach heartbeat report-time subscription-quota-check)
# The draft Release this run builds already has its tag on HEAD, so only tags that do not contain HEAD can be the previous release.
base=${1:-$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname --no-contains HEAD | head -n 1)}
if [[ -z $base ]]; then printf '%s\n' "${programs[@]}"; exit 0; fi
for program in "${programs[@]}"; do
  if git diff --quiet "$base"..HEAD -- "apps/$program" apps/requirements-contract.json \
    ":(exclude)apps/$program/VERSION" ":(exclude)apps/$program/dist" ":(exclude,glob)apps/$program/**/*.md"; then continue; fi
  if git diff --quiet "$base"..HEAD -- "apps/$program/VERSION"; then echo "$program"; fi
done
