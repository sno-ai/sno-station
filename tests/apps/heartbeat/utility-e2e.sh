#!/usr/bin/env bash
# Real installed-command journey. Installation is deliberately outside this runner.
set -Eeuo pipefail
export LC_ALL=C
MODE="${1:?usage: utility-e2e.sh preflight|journey EVIDENCE_DIRECTORY}"
EVIDENCE="${2:?evidence directory required}"
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
mkdir -p "$EVIDENCE"
EVIDENCE="$(cd "$EVIDENCE" && pwd)"
export PATH="$HOME/.local/bin:$PATH"
APPS=(heartbeat report-time subscription-quota-check)

identity() {
  printf 'host=%s\n' "$(hostname)"
  for app in "${APPS[@]}"; do
    local command_path resolved expected version
    version="$(<"$ROOT/apps/$app/VERSION")"
    command_path="$(command -v "$app")" || return 1
    resolved="$(readlink -f "$command_path")" || return 1
    expected="$HOME/.local/lib/sno-$app/releases/$version/bin/$app"
    [[ "$command_path" == "$HOME/.local/bin/$app" && "$resolved" == "$expected" && -x "$resolved" ]] || return 1
    [[ "$(<"${expected%/bin/*}/VERSION")" == "$version" ]] || return 1
    printf 'command=%s resolved=%s version=%s\n' "$command_path" "$resolved" "$(<"${expected%/bin/*}/VERSION")"
    sha256sum "$resolved" || return 1
  done
  for vendor in codex claude; do
    command -v "$vendor" || return 1
    timeout 10 "$vendor" --version || return 1
  done
}

if [[ "$MODE" == preflight ]]; then
  failures=0
  report="$EVIDENCE/utility-e2e-preflight-$(TZ=America/Los_Angeles date +%F).md"
  : >"$report"
  check() {
    local name="$1"; shift
    local rc=0
    {
      printf '\n## %s\n\nCommand:' "$name"
      printf ' %q' "$@"
      printf '\n\n```text\n'
    } >>"$report"
    "$@" >>"$report" 2>&1 || rc=$?
    printf '\n```\n\nExit: %s\n' "$rc" >>"$report"
    if ((rc)); then failures=$((failures + 1)); fi
  }
  # shellcheck disable=SC2016
  check host bash -c 'test "$(hostname)" = gpt1 && hostname'
  check installed-identity identity
  check codex-login timeout 20 codex login status
  check claude-login timeout 20 claude auth status
  # shellcheck disable=SC2016
  check subscription-environment bash -c 'test -z "${OPENAI_API_KEY:-}" && test -z "${ANTHROPIC_API_KEY:-}"'
  check writable-link-directory test -w "$HOME/.local/lib/sno-heartbeat"
  printf '\nFailed checks: %s\n' "$failures" >>"$report"
  cat "$report"
  ((failures == 0)) || exit 1
  identity >"$EVIDENCE/identity.txt"
  sha256sum "$report" "$EVIDENCE/identity.txt" >"$EVIDENCE/preflight.sha256"
  printf 'PASS preflight; identity frozen in %s\n' "$EVIDENCE"
  exit 0
fi

[[ "$MODE" == journey ]] || { printf 'unknown mode: %s\n' "$MODE" >&2; exit 2; }
[[ "${UTILITY_E2E_ALLOW_LINK_MUTATION:-}" == 1 ]] || {
  printf 'journey needs UTILITY_E2E_ALLOW_LINK_MUTATION=1 for the declared current-link defect\n' >&2
  exit 2
}
sha256sum -c "$EVIDENCE/preflight.sha256"
cmp "$EVIDENCE/identity.txt" <(identity)
WORK="$(mktemp -d "${TMPDIR:-/tmp}/utility-e2e.XXXXXX")"
export HEARTBEAT_STATE="$WORK/state" HEARTBEAT_OWNER="utility-e2e-$$"
label="utility-e2e-$$"
current="$HOME/.local/lib/sno-heartbeat/current"
original="$(readlink "$current")"
pid=''
mutated=0
cleanup() {
  if ((mutated)); then ln -sfnT -- "$original" "$current"; fi
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    heartbeat --stop "$label" >/dev/null 2>&1 || kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf -- "$WORK"
}
trap cleanup EXIT

arm_stop() {
  local name="$1"
  heartbeat --interval 1m --label "$label" --max-hours 0.03 -- true >"$EVIDENCE/$name.log" 2>&1 &
  pid=$!
  local started="$SECONDS"
  while ! grep -r -q 'tick=1' "$HEARTBEAT_STATE/log" 2>/dev/null; do
    kill -0 "$pid" 2>/dev/null || { cat "$EVIDENCE/$name.log"; return 1; }
    ((SECONDS - started < 90)) || return 1
    sleep 1
  done
  grep -F 'Monitor({command:' "$EVIDENCE/$name.log"
  timeout 20 heartbeat --stop "$label" | tee "$EVIDENCE/$name-stop.log"
  grep -F 'heartbeat: stopped' "$EVIDENCE/$name-stop.log"
  wait "$pid"
  pid=''
  grep -F 'STOPPED' "$EVIDENCE/$name.log"
  cp -a "$HEARTBEAT_STATE/log" "$EVIDENCE/$name-ticks"
  # The next arm must produce its own tick, not read the first arm's log.
  rm -rf -- "$HEARTBEAT_STATE/log"
}

arm_stop initial
mkdir "$WORK/empty"
printf 'Planting declared defect in %s; restoring immediately after refused calls.\n' "$current"
ln -sfnT -- "$WORK/empty" "$current"
mutated=1
hash -p "$HOME/.local/bin/heartbeat" heartbeat
[[ "$(command -v heartbeat)" == "$HOME/.local/bin/heartbeat" ]]
if heartbeat --list >"$EVIDENCE/planted-list.log" 2>&1; then
  printf 'FAIL broken current link still ran heartbeat\n' >&2; exit 1
fi
if heartbeat --interval 1m --label "$label" -- true >"$EVIDENCE/planted-arm.log" 2>&1; then
  printf 'FAIL broken current link still armed heartbeat\n' >&2; exit 1
fi
cat "$EVIDENCE/planted-list.log" "$EVIDENCE/planted-arm.log"
ln -sfnT -- "$original" "$current"
mutated=0
heartbeat --list
arm_stop restored
rc=0
timeout 90 subscription-quota-check --vendor codex --human >"$EVIDENCE/quota.log" 2>"$EVIDENCE/quota.stderr" || rc=$?
cat "$EVIDENCE/quota.log" "$EVIDENCE/quota.stderr"
case "$rc" in 0|1|3|4) ;; *) printf 'FAIL quota command exit %s\n' "$rc" >&2; exit 1 ;; esac
[[ "$(wc -l <"$EVIDENCE/quota.log")" -eq 1 ]]
grep -i codex "$EVIDENCE/quota.log"
cmp "$EVIDENCE/identity.txt" <(identity)
printf 'PASS host=%s installed core programs: two arm/stop runs, two refused broken-link calls, one vendor response (exit %s; usage is not guaranteed for unreadable/auth outcomes)\n' "$(hostname)" "$rc"
