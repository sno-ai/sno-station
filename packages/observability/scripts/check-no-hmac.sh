#!/usr/bin/env bash
# Static guard per design.md Decision 0 + tasks.md §11.2 / §24.1.
# The SDK SHALL NOT contain HMAC primitives; Vercel handles HMAC downstream.
# CI runs this; non-zero exit fails the build.
set -euo pipefail

cd "$(dirname "$0")/.."

PATTERN='createHmac|Hmac|X-Sno-Signature|HELICONE_INTERNAL_INGEST_HMAC'
if grep -rE "$PATTERN" src/ 2>/dev/null; then
	echo "FAIL: HMAC primitive detected in packages/sno-observe/src/" >&2
	echo "       (Decision 0: SDK does NOT sign HMAC; Vercel does.)" >&2
	exit 1
fi
echo "OK: no HMAC primitives in packages/sno-observe/src/"
