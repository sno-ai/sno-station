#!/usr/bin/env bash
# Many agents, no lock. These cases assert the property that replaces one: a label is not an
# address — (owner, label) is. Two agents may hold the same label at once and neither can reach
# the other's; one agent may not hold it twice; and a claim left by a dead process is litter
# that clears itself rather than blocking the next arm.
#
# The registry is redirected into TMPDIR and both agents are simulated with HEARTBEAT_OWNER, so
# this never touches the real state directory and never sees the running session's own
# heartbeats.

set -Eeuo pipefail

export LC_ALL=C

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HEARTBEAT:-$HERE/../../../apps/heartbeat/bin/heartbeat}"

[[ -x "$SCRIPT" ]] ||
  { printf 'selftest: not executable: %s\n' "$SCRIPT" >&2; exit 2; }

work="$(mktemp -d "${TMPDIR:-/tmp}/heartbeat-registry.XXXXXX")"
export HEARTBEAT_STATE="$work/state"
failures=0

cleanup() {
  local dir pid
  for dir in "$HEARTBEAT_STATE"/run/*/*/; do
    [[ -r $dir/info ]] || continue
    pid="$(sed -n 's/^pid=//p' "$dir/info" 2>/dev/null || true)"
    if [[ -n $pid ]]; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  rm -rf -- "$work"
}
trap cleanup EXIT

pass() { printf 'ok    %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }

# as <owner> <args...> — run the command as one simulated agent.
as() {
  local who="$1"; shift
  env HEARTBEAT_OWNER="$who" "$SCRIPT" "$@"
}

# Every heartbeat this suite arms carries a two-minute wall clock. The EXIT trap below clears
# them on a normal end, but a suite that is killed outright runs no trap — and an orphaned
# heartbeat holds whatever descriptors it inherited, which is how a killed self-test blocked
# the next deploy. The wall clock needs nobody to remember anything.
arm() {
  local who="$1" label="$2"
  env HEARTBEAT_OWNER="$who" "$SCRIPT" --interval 2s --label "$label" --max-hours 0.033 \
    --log "$work/$who-$label.log" -- true >/dev/null 2>&1 &
  printf '%s' "$!"
}

claim_of() {
  local owner="$1" label="$2"

  printf '%s/run/%s/%s' "$HEARTBEAT_STATE" \
    "$(printf '%s' "$owner" | sha256sum | awk '{print $1}')" \
    "$(printf '%s' "$label" | sha256sum | awk '{print $1}')"
}

# --- two agents, one label ------------------------------------------------------------------
pid_a="$(arm agent-A card-B)"
pid_b="$(arm agent-B card-B)"
sleep 2

if [[ -r "$(claim_of agent-A card-B)/info" && -r "$(claim_of agent-B card-B)/info" ]]; then
  pass "two agents hold the same label at once"
else
  fail "two agents could not both hold card-B"
fi

# --- an agent cannot stop the other's --------------------------------------------------------
# This is the failure the owner named: one agent stopping another's card-B.
if as agent-C --stop card-B >/dev/null 2>&1; then
  fail "a third agent stopped a label it does not own"
else
  pass "a label you do not own cannot be stopped"
fi
if kill -0 "$pid_a" 2>/dev/null && kill -0 "$pid_b" 2>/dev/null; then
  pass "both heartbeats survived the outsider's stop"
else
  fail "an outsider's stop killed a running heartbeat"
fi

# --- stopping your own reaches exactly one ---------------------------------------------------
if as agent-A --stop card-B >/dev/null 2>&1; then
  pass "an agent stops its own"
else
  fail "an agent could not stop its own"
fi
wait "$pid_a" 2>/dev/null || true
if [[ ! -e "$(claim_of agent-A card-B)" ]]; then
  pass "a stopped heartbeat leaves no claim behind"
else
  fail "a stopped heartbeat left its claim"
fi
if kill -0 "$pid_b" 2>/dev/null; then
  pass "the other agent's heartbeat is untouched"
else
  fail "stopping one killed the other"
fi

# --- one agent may not hold the same label twice ---------------------------------------------
if env HEARTBEAT_OWNER=agent-B "$SCRIPT" --interval 2s --label card-B \
     --log "$work/dup.log" --max-ticks 1 -- true >/dev/null 2>&1; then
  fail "the same agent armed card-B twice"
else
  rc=$?
  if ((rc == 4)); then
    pass "a second arm under the same label is refused with exit 4"
  else
    fail "a duplicate arm exited $rc, not 4"
  fi
fi

as agent-B --stop card-B >/dev/null 2>&1 || true
wait "$pid_b" 2>/dev/null || true

# --- registry paths cannot collapse distinct identities -------------------------------------
pid_colon="$(arm 'agent:x' collision)"
pid_question="$(arm 'agent?x' collision)"
sleep 2
if kill -0 "$pid_colon" 2>/dev/null && kill -0 "$pid_question" 2>/dev/null; then
  pass "distinct owner identities cannot collide in the registry"
else
  fail "distinct owner identities collided in the registry"
fi
as 'agent?x' --stop collision >/dev/null 2>&1 || true
wait "$pid_question" 2>/dev/null || true
if kill -0 "$pid_colon" 2>/dev/null; then
  pass "stopping one encoded owner cannot signal another"
else
  fail "stopping one encoded owner signalled another"
fi
as 'agent:x' --stop collision >/dev/null 2>&1 || true
wait "$pid_colon" 2>/dev/null || true

# --- a claim left by a dead process clears itself ---------------------------------------------
stale="$(claim_of agent-D card-B)"
mkdir -p -- "$stale"
printf 'owner=agent-D\nlabel=card-B\npid=999999\nlog=%s\n' "$work/stale.log" >"$stale/info"
if env HEARTBEAT_OWNER=agent-D "$SCRIPT" --interval 1s --label card-B \
     --log "$work/stale.log" --max-ticks 1 -- true >/dev/null 2>&1; then
  pass "a stale claim does not block the next arm"
else
  fail "a stale claim blocked the next arm"
fi

# --- stopping something you never started -----------------------------------------------------
set +e
as agent-E --stop nothing-here >/dev/null 2>&1
rc=$?
set -e
if ((rc == 3)); then
  pass "stopping a label you never started exits 3"
else
  fail "stopping an unknown label exited $rc, not 3"
fi

# --- the wall clock stops a forgotten heartbeat -----------------------------------------------
# 0.0005 h is 1.8s: the same deadline the 24-hour default uses, proven in seconds.
env HEARTBEAT_OWNER=agent-F timeout 30 "$SCRIPT" --interval 1s --label forgotten \
  --log "$work/forgotten.log" --max-hours 0.0005 -- true >/dev/null 2>&1
if grep -q 'STOPPED: reached --max-hours' "$work/forgotten.log"; then
  pass "a forgotten heartbeat stops itself at the wall clock"
else
  fail "the wall clock did not stop the heartbeat"
fi

# --- a claim under construction is never reaped by another agent -------------------------------
# The claim is renamed into place complete, so this window should not exist at all. It is tested
# anyway: an armer whose registry entry is deleted underneath it dies before its first tick, and
# that is the silent death the whole unit exists to prevent. Another owner lists repeatedly while
# several agents arm at once; every heartbeat must survive with its claim intact.
race_pids=()
for i in 1 2 3 4 5; do
  race_pids+=("$(arm "racer-$i" "race")")
done
for _ in 1 2 3 4 5 6 7 8 9 10; do
  as watcher --list >/dev/null 2>&1 || true
done
sleep 2
race_ok=1
for i in 1 2 3 4 5; do
  [[ -r "$(claim_of "racer-$i" race)/info" ]] || race_ok=0
done
for pid in "${race_pids[@]}"; do
  kill -0 "$pid" 2>/dev/null || race_ok=0
done
if ((race_ok)); then
  pass "concurrent arms survive another agent listing"
else
  fail "a listing agent destroyed a claim being armed"
fi
for i in 1 2 3 4 5; do
  as "racer-$i" --stop race >/dev/null 2>&1 || true
done

# A directory with no info is litter, but it is given a grace minute rather than deleted on
# sight — nothing here removes a directory it cannot explain.
fresh="$(claim_of agent-I fresh)"
mkdir -p -- "$fresh"
as agent-J --list >/dev/null 2>&1 || true
if [[ -d $fresh ]]; then
  pass "a directory with no info survives its grace minute"
else
  fail "an unexplained directory was deleted on sight"
fi
rm -rf -- "$fresh"

# --- a heartbeat holds nothing it inherited ----------------------------------------------------
# A heartbeat outlives its starter, so any descriptor it carries over becomes someone else's
# outage hours later. Measured: a deploy's lock, inherited through its self-test, was still held
# by an orphaned heartbeat and blocked the next deploy for 120 seconds.
if [[ -d /proc/self/fd ]]; then
  exec 9>"$work/inherited.lock"
  pid_k="$(arm agent-K inherit)"
  sleep 2
  held=0
  observed=0
  unreadable=0
  if kill -0 "$pid_k" 2>/dev/null && [[ -r "/proc/$pid_k/fd" && -x "/proc/$pid_k/fd" ]]; then
    for entry in "/proc/$pid_k/fd"/*; do
      if target="$(readlink -- "$entry" 2>/dev/null)"; then
        observed=$((observed + 1))
        [[ $target == *inherited.lock ]] && held=1
      else
        unreadable=1
      fi
    done
  fi
  if ! kill -0 "$pid_k" 2>/dev/null || ((observed == 0 || unreadable)); then
    fail "cannot inspect the live heartbeat's descriptors"
  elif ((held)); then
    fail "a heartbeat kept a descriptor it inherited"
  else
    pass "a heartbeat holds nothing it inherited"
  fi
  exec 9>&-
  as agent-K --stop inherit >/dev/null 2>&1 || true
  wait "$pid_k" 2>/dev/null || true
else
  printf '# no /proc; inherited-descriptor check skipped\n'
fi

# --- --list shows both sides and marks your own ------------------------------------------------
pid_g="$(arm agent-G visible)"
sleep 2
listing="$(as agent-G --list)"
if grep -q 'visible' <<<"$listing" && grep -q '^you ' <<<"$listing"; then
  pass "--list shows your own and marks it"
else
  fail "--list did not mark your own heartbeat"
fi
outsider="$(as agent-H --list)"
if grep -q 'visible' <<<"$outsider" && ! grep -q '^you ' <<<"$outsider"; then
  pass "another agent's heartbeat is visible but not marked yours"
else
  fail "--list mismarked another agent's heartbeat"
fi
as agent-G --stop visible >/dev/null 2>&1 || true
wait "$pid_g" 2>/dev/null || true

if ((failures)); then
  printf '\n%s registry check(s) failed\n' "$failures"
  exit 1
fi
printf '\nall registry checks passed\n'
