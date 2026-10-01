#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$repo_root/apps/mem-claw"
npx vitest run --config vitest.config.ts \
	../../tests/packages/memory/integration/rem-operation-switches-production-entry.test.ts \
	-t "rem-operation-identifiers-production-entry"
