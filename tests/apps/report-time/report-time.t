#!/usr/bin/env bash
set -Eeuo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${REPORT_TIME:-$HERE/../../../apps/report-time/bin/report-time}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/report-time.XXXXXX")"
pid=''
cleanup() {
  if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  rm -rf -- "$WORK"
}
trap cleanup EXIT

actual="$(env -u REPORT_TIME_USER_TZ TZ=Asia/Tokyo "$SCRIPT" @1704067200)"
expected='2024-01-01 09:00 JST (2024-01-01 00:00 UTC)'
[[ "$actual" == "$expected" ]] || { printf 'FAIL Tokyo epoch: %s\n' "$actual" >&2; exit 1; }

actual="$(TZ=Asia/Tokyo REPORT_TIME_USER_TZ=America/Los_Angeles "$SCRIPT" @1704067200)"
expected='2023-12-31 16:00 PST (2024-01-01 00:00 UTC)'
[[ "$actual" == "$expected" ]] || { printf 'FAIL zone override: %s\n' "$actual" >&2; exit 1; }

REPORT_TIME_REAL_DATE="$(command -v date)"
export REPORT_TIME_REAL_DATE
mkdir "$WORK/tools"
cat >"$WORK/tools/date" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == '+%s' ]]; then printf '1704067200\n'; else exec "$REPORT_TIME_REAL_DATE" "$@"; fi
EOF
chmod +x "$WORK/tools/date"
actual="$(env -u REPORT_TIME_USER_TZ PATH="$WORK/tools:$PATH" TZ=Asia/Tokyo "$SCRIPT" --in 3600)"
expected='2024-01-01 10:00 JST (2024-01-01 01:00 UTC)'
[[ "$actual" == "$expected" ]] || { printf 'FAIL interval: %s\n' "$actual" >&2; exit 1; }

sleep 10 &
pid=$!
if "$SCRIPT" --pid "$pid" >"$WORK/out" 2>"$WORK/err"; then
  printf 'FAIL non-timeout process accepted\n' >&2; exit 1
fi
[[ ! -s "$WORK/out" ]] || { printf 'FAIL refusal wrote stdout\n' >&2; exit 1; }
grep -F 'not a timeout wrapper' "$WORK/err" >/dev/null || { cat "$WORK/err" >&2; exit 1; }
printf 'ok report-time fixed epoch, zone override, interval, and non-timeout refusal\n'
