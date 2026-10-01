#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$repo_root/apps/mem-claw"
npx vitest run --config vitest.config.ts \
	../../tests/packages/memory/unit/rem-operation-switches-contract.test.ts \
	-t "rem-master-switch-absent-defaults-off-contract"
