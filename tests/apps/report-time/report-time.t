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
if [[ -r /proc/uptime ]]; then expected_refusal='not a timeout wrapper'; else expected_refusal='needs Linux /proc'; fi
grep -F "$expected_refusal" "$WORK/err" >/dev/null || { cat "$WORK/err" >&2; exit 1; }
for option in -x --version --wall; do
  args=("$option")
  if [[ "$option" == --wall ]]; then args+=(3600); fi
  status=0
  "$SCRIPT" "${args[@]}" >"$WORK/out" 2>"$WORK/err" || status=$?
  [[ "$status" == 2 ]] || { printf 'FAIL unknown option %s: exit %s, expected 2\n' "$option" "$status" >&2; exit 1; }
  [[ ! -s "$WORK/out" ]] || { printf 'FAIL unknown option %s wrote stdout\n' "$option" >&2; exit 1; }
  printf "report-time: unknown option '%s' (see --help)\n" "$option" >"$WORK/expected-err"
  cmp -s "$WORK/expected-err" "$WORK/err" || { printf 'FAIL unknown option %s stderr:\n' "$option" >&2; cat "$WORK/err" >&2; exit 1; }
done
status=0
"$SCRIPT" --in 60 junk extra >"$WORK/out" 2>"$WORK/err" || status=$?
[[ "$status" -eq 2 ]] || { printf 'FAIL --in extra arguments: expected exit 2, got %s\n' "$status" >&2; exit 1; }
[[ ! -s "$WORK/out" ]] || { printf 'FAIL --in extra arguments wrote stdout\n' >&2; exit 1; }
printf "%s\n" "report-time: --in takes exactly one value, got '60 junk extra'" | cmp -s - "$WORK/err" \
  || { printf 'FAIL --in extra arguments stderr:\n' >&2; cat "$WORK/err" >&2; exit 1; }
printf 'ok report-time fixed epoch, zone override, interval, non-timeout refusal, unknown options, and --in extra-arguments refusal\n'
