#!/usr/bin/env bash
# Prints every released program whose source changed since the last release tag while its VERSION did not, one name per line.
# A program archive is named after its VERSION, so a changed program with the old number ships the old build.
# Usage: scripts/program-versions.sh [base-tag]   (default: the newest v*.*.* tag; needs full history and tags)
set -Eeuo pipefail
cd "$(git rev-parse --show-toplevel)"
programs=(reach heartbeat report-time subscription-quota-check)
base=${1:-$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null || true)}
if [[ -z $base ]]; then printf '%s\n' "${programs[@]}"; exit 0; fi
for program in "${programs[@]}"; do
  git diff --quiet "$base"..HEAD -- "apps/$program" apps/requirements-contract.json \
    ":(exclude)apps/$program/VERSION" ":(exclude)apps/$program/dist" ":(exclude,glob)apps/$program/**/*.md" && continue
  git diff --quiet "$base"..HEAD -- "apps/$program/VERSION" && echo "$program"
done
