#!/usr/bin/env bash
# Static guard per tasks.md §29.3: SDK is Node-only (Decision 9 / design.md).
# Forbids Bun-only runtime APIs in src/ (and in test fixtures).
set -euo pipefail

cd "$(dirname "$0")/.."

# Match identifiers that are Bun-only. Allow `import.meta.url` (web standard); forbid `import.meta.dir` (Bun-only).
PATTERN='\bBun\.(serve|file|write|spawn|readableStreamToText|deepEquals|sleep|gc|version)\b|import\.meta\.dir([^[:alnum:]_]|$)'

found=0
if grep -rE "$PATTERN" src/ 2>/dev/null; then
	found=1
fi
if grep -rE "$PATTERN" ../../tests/packages/sno-observe/ 2>/dev/null; then
	found=1
fi
if [ "$found" -ne 0 ]; then
	echo "FAIL: Bun-only API detected. SDK is Node 22+ only." >&2
	exit 1
fi
echo "OK: no Bun-only runtime APIs in src/ or tests/"
