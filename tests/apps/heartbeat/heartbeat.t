#!/usr/bin/env bash
# The heartbeat's contract is that a broken hook cannot stop the tick, so every case here
# breaks the hook a different way and asserts the ticks still land. The flood case is not
# hypothetical: capturing a hook's output before truncating it takes the heartbeat down
# with SIGSEGV on its first tick, which is exactly the failure the script exists to prevent.
#
# The script under test is resolved RELATIVE TO THIS FILE, so the identical suite runs in the
# source repo and inside each deployed skill copy. HEARTBEAT=<path> points it elsewhere —
# that is how the installed public command is proven rather than assumed.
#
# Everything scratch goes under TMPDIR. This runs INSIDE the deployed skill directory, where
# a stray file would read as deploy drift forever after.

set -Eeuo pipefail

export LC_ALL=C

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HEARTBEAT:-$HERE/../../../apps/heartbeat/bin/heartbeat}"

[[ -x "$SCRIPT" ]] ||
  { printf 'selftest: not executable: %s\n' "$SCRIPT" >&2; exit 2; }

if help="$("$SCRIPT" --help)" &&
   grep -Fxq -- "  --due-set     add or update a timed task in a progress record's \"## Due\" section" <<<"$help" &&
   grep -Fxq -- '  --due-cancel  remove a timed task by action, or remove the entire "## Due"' <<<"$help" &&
   grep -Fxq -- '  --due         list timed tasks; --problems shows only tasks with recorded problems' <<<"$help" &&
   grep -Fxq -- '  --due-tick    launch agents for tasks that are due, then return without waiting' <<<"$help"; then
  printf 'ok    --help explains the timed-task flags\n'
else
  printf 'FAIL  --help is missing timed-task flag explanations\n' >&2
  exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/heartbeat-selftest.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT

# The registry goes in the scratch directory under a name of its own, so this suite never
# collides with — or reaps — a heartbeat the running session actually depends on.
export HEARTBEAT_STATE="$work/state"
export HEARTBEAT_OWNER="selftest-$$"
failures=0

printf '# heartbeat under test: %s\n' "$SCRIPT"

check() {
  local name="$1" want="$2" log="$3"
  local got
  got="$(grep -c 'tick=' -- "$log" || true)"
  if ((got >= want)); then
    printf 'ok    %s (%s lines)\n' "$name" "$got"
  else
    printf 'FAIL  %s: wanted >=%s tick lines, got %s\n' "$name" "$want" "$got"
    failures=$((failures + 1))
  fi
}

run() {
  local log="$1"; shift
  # A hook that kills the heartbeat shows up here as a nonzero exit, so it is not masked.
  if ! "$SCRIPT" --interval 1s --label t --log "$log" --max-ticks 3 -- "$@"; then
    printf 'FAIL  heartbeat itself exited nonzero for: %s\n' "$*"
    failures=$((failures + 1))
  fi
}

run "$work/exits-nonzero.log" false
check "hook exits nonzero" 4 "$work/exits-nonzero.log"
if grep -q 'hook FAILED status=1' "$work/exits-nonzero.log"; then
  printf 'ok    nonzero hook status recorded\n'
else
  printf 'FAIL  nonzero hook status reported as success\n'
  failures=$((failures + 1))
fi

run "$work/missing.log" /nonexistent/program
check "hook does not exist" 4 "$work/missing.log"
if grep -q 'hook FAILED status=127' "$work/missing.log"; then
  printf 'ok    missing hook status recorded\n'
else
  printf 'FAIL  missing hook status reported as success\n'
  failures=$((failures + 1))
fi

run "$work/floods.log" yes flooding
check "hook floods stdout" 4 "$work/floods.log"
longest="$(awk '{print length}' "$work/floods.log" | sort -n | tail -1)"
if ((longest < 2000)); then
  printf 'ok    flooded line truncated (%s chars)\n' "$longest"
else
  printf 'FAIL  flooded line not truncated: %s chars\n' "$longest"
  failures=$((failures + 1))
fi

# A hung hook must cost one hook-timeout, not the whole run.
timeout 120 "$SCRIPT" --interval 1s --label t --log "$work/hangs.log" --max-ticks 1 -- sleep 999
check "hook hangs" 2 "$work/hangs.log"
if grep -q 'TIMED OUT' "$work/hangs.log"; then
  printf 'ok    hang reported as a timeout\n'
else
  printf 'FAIL  hang not reported\n'
  failures=$((failures + 1))
fi

# A hook that spawns a background child inheriting stdout and exits must not freeze the
# heartbeat: the child holds the output pipe open long past the hook's own timeout, and an
# unbounded reader then waits forever — every later tick and check dead, process still
# "running". The run must finish on its own, well inside the outer guard here.
if timeout 60 "$SCRIPT" --interval 1s --label t --log "$work/orphan.log" --max-ticks 1 \
     -- bash -c 'sleep 300 & echo hi'; then
  printf 'ok    a hook child holding stdout does not freeze the heartbeat\n'
else
  printf 'FAIL  a hook child holding stdout froze or failed the heartbeat\n'
  failures=$((failures + 1))
fi

# The armed message must hand over a reader that retires itself: tail --pid bound to this
# heartbeat, so a finished watch never leaves a tail running forever.
"$SCRIPT" --interval 1s --label t --log "$work/armline.log" --max-ticks 1 -- true >"$work/armed.out" &
armed_pid=$!
wait "$armed_pid"
if grep -Fq "tail --pid=$armed_pid -F -n0" "$work/armed.out"; then
  printf 'ok    the armed message prints a self-retiring reader\n'
else
  printf 'FAIL  the armed message does not print a self-retiring reader\n'
  failures=$((failures + 1))
fi

# SIGTERM must leave a final line rather than vanishing mid-watch.
"$SCRIPT" --interval 3s --label t --log "$work/signal.log" -- true &
pid=$!
sleep 4
kill -TERM "$pid"
wait "$pid"
if grep -q 'STOPPED: signalled' "$work/signal.log"; then
  printf 'ok    SIGTERM writes a final line\n'
else
  printf 'FAIL  SIGTERM left no final line\n'
  failures=$((failures + 1))
fi

# --until-file is how a heartbeat ends when the job it watches produces its output — and it
# must NOT end when the job merely opens that file. A results file created as an empty shell at
# startup and filled in at the end retired a real heartbeat on tick 1; both halves are asserted
# here in one run.
"$SCRIPT" --interval 1s --label t --log "$work/until.log" --until-file "$work/done" -- true &
pid=$!
sleep 2
: >"$work/done"                       # the empty shell a job creates when it opens its output
sleep 3
if kill -0 "$pid" 2>/dev/null; then
  printf 'ok    an empty --until-file does not end the watch\n'
else
  printf 'FAIL  an empty --until-file ended the watch\n'
  failures=$((failures + 1))
fi
printf 'result\n' >"$work/done"       # the job finishes and writes its output
wait "$pid"
if grep -q 'FINISHED: .*done has content' "$work/until.log"; then
  printf 'ok    --until-file ends the watch\n'
else
  printf 'FAIL  --until-file did not end the watch\n'
  failures=$((failures + 1))
fi

# --until-file is checked DURING the wait, not only after a hook. At a twenty-minute interval
# the difference between the two is twenty minutes of a finished job going unreported.
"$SCRIPT" --interval 30s --label t --log "$work/until-mid.log" --until-file "$work/mid" -- true &
pid=$!
sleep 3
printf 'result\n' >"$work/mid"
start="$SECONDS"
wait "$pid"
elapsed=$((SECONDS - start))
if ((elapsed <= 10)) && grep -q 'FINISHED: .*mid has content' "$work/until-mid.log"; then
  printf 'ok    --until-file noticed mid-interval (%ss after it appeared)\n' "$elapsed"
else
  printf 'FAIL  --until-file not noticed mid-interval (%ss)\n' "$elapsed"
  failures=$((failures + 1))
fi

# Retained baseline assertion: this repeats the earlier status=1 log check and is
# not counted as independent coverage.
if grep -q 'hook FAILED status=1' "$work/exits-nonzero.log"; then
  printf 'ok    a failing hook is named in the line\n'
else
  printf 'FAIL  a failing hook was not named\n'
  failures=$((failures + 1))
fi

# A bare invocation prints usage and succeeds; the deployer validates the published command
# that way, and no-arguments carries no intent to watch anything.
if "$SCRIPT" >/dev/null 2>&1; then
  printf 'ok    a bare invocation succeeds\n'
else
  printf 'FAIL  a bare invocation did not succeed\n'
  failures=$((failures + 1))
fi

# Bad arguments must be refused loudly rather than watched silently.
if "$SCRIPT" --interval 0 --label t --log "$work/bad.log" -- true 2>/dev/null; then
  printf 'FAIL  accepted --interval 0\n'
  failures=$((failures + 1))
else
  printf 'ok    rejects --interval 0\n'
fi
if "$SCRIPT" --interval 1s --label t --log "$work/bad.log" 2>/dev/null; then
  printf 'FAIL  accepted a missing hook command\n'
  failures=$((failures + 1))
else
  printf 'ok    rejects a missing hook command\n'
fi

# An --until-file that is already there would end the watch on its first check. Refusing at arm
# time is the only place that can be said before a heartbeat dies at birth for it.
: >"$work/already-there"
if "$SCRIPT" --interval 1s --label t --log "$work/bad.log" \
     --until-file "$work/already-there" -- true 2>/dev/null; then
  printf 'FAIL  armed on an --until-file that already exists\n'
  failures=$((failures + 1))
else
  rc=$?
  if ((rc == 2)); then
    printf 'ok    rejects an --until-file that already exists\n'
  else
    printf 'FAIL  an existing --until-file exited %s, not 2\n' "$rc"
    failures=$((failures + 1))
  fi
fi

# --- the wait shape ---------------------------------------------------------------------------
# "wake me when X is done" is the commonest job an agent has and the one it most often replaces
# with three lines of its own, which then hang forever on a typo and tell nobody. It must
# therefore cost exactly two decisions — what to wait for, what to call it — and no more: no
# interval, no log path, no hook command.
( sleep 3; printf 'result\n' >"$work/wait-done" ) &
out="$("$SCRIPT" --label waiter --interval 1s --until-file "$work/wait-done")"
owner_key="$(printf '%s' "$HEARTBEAT_OWNER" | sha256sum | awk '{print $1}')"
label_key="$(printf '%s' waiter | sha256sum | awk '{print $1}')"
waiter_log="$HEARTBEAT_STATE/log/$owner_key/$label_key.log"
if grep -q 'FINISHED \[waiter\]' <<<"$out"; then
  printf 'ok    a wait needs no hook, and says FINISHED on stdout\n'
else
  printf 'FAIL  a wait did not report FINISHED on stdout: %s\n' "$out"
  failures=$((failures + 1))
fi
if [[ -s "$waiter_log" ]]; then
  printf 'ok    a wait with no --log still leaves a log\n'
else
  printf 'FAIL  a wait with no --log left no log\n'
  failures=$((failures + 1))
fi
if grep -q 'tick=1 waiting' "$waiter_log"; then
  printf 'ok    a tick with no hook still lands\n'
else
  printf 'FAIL  a tick with no hook wrote nothing\n'
  failures=$((failures + 1))
fi

# GIVING UP MUST NOT READ AS FINISHING. An agent woken by this line acts on it; if the two
# endings look alike it reports a run that never finished.
out="$("$SCRIPT" --label gaveup --interval 1s --log "$work/gaveup.log" \
        --until-file "$work/never-appears" --max-hours 0.0009)"
if grep -q 'NOT FINISHED \[gaveup\]' <<<"$out"; then
  printf 'ok    a wait that timed out says NOT FINISHED\n'
else
  printf 'FAIL  a timed-out wait did not say NOT FINISHED: %s\n' "$out"
  failures=$((failures + 1))
fi

# The cadence has an answer already, so an agent never has to invent one.
"$SCRIPT" --label defaults --log "$work/defaults.log" --max-ticks 1 -- true >/dev/null
if grep -q 'interval=600s' "$work/defaults.log"; then
  printf 'ok    --interval defaults rather than being required\n'
else
  printf 'FAIL  --interval did not default\n'
  failures=$((failures + 1))
fi

# The cadence is the caller's to choose, from seconds to hours, and it is read the way people
# type it: a bare number is MINUTES, a unit overrides (30s, 10m, 2h). Each accepted spelling
# must also CONVERT correctly — the started line logs the interval in seconds, so a wrong
# conversion is visible right there.
i=0
for spec in '1s:1' '90s:90' '5:300' '5m:300' '10min:600' '2h:7200' '120:7200'; do
  arg="${spec%%:*}"; want="${spec##*:}"
  i=$((i + 1))
  if "$SCRIPT" --label "cadence-$i" --interval "$arg" --log "$work/cadence-$i.log" \
       --max-ticks 1 -- true >/dev/null 2>&1 &&
     grep -q "interval=${want}s" "$work/cadence-$i.log"; then
    printf 'ok    --interval %s accepted as %ss\n' "$arg" "$want"
  else
    printf 'FAIL  --interval %s not accepted as %ss\n' "$arg" "$want"
    failures=$((failures + 1))
  fi
done

# A bare number above 120 is a seconds habit, and reading it as minutes would arm a silently
# wrong cadence — hours apart instead of minutes. Refused, with the fix in the message.
if "$SCRIPT" --interval 600 --label t --log "$work/bad.log" -- true 2>/dev/null; then
  printf 'FAIL  accepted bare --interval 600\n'
  failures=$((failures + 1))
else
  rc=$?
  if ((rc == 2)); then
    printf 'ok    rejects bare --interval 600 (minutes ambiguity)\n'
  else
    printf 'FAIL  bare --interval 600 exited %s, not 2\n' "$rc"
    failures=$((failures + 1))
  fi
fi

# --flag=value is the other convention half the tools here use; it must split, not refuse.
if "$SCRIPT" --interval=1s --label=eqform --log="$work/eqform.log" --max-ticks=1 -- true >/dev/null 2>&1 &&
   grep -q '\[eqform\] tick=1' "$work/eqform.log"; then
  printf 'ok    --flag=value forms are accepted\n'
else
  printf 'FAIL  --flag=value forms were refused\n'
  failures=$((failures + 1))
fi

# Absurd durations are refused before arithmetic can wrap them into something plausible.
for bad in 99999999999999999999 9999999999h 20000m; do
  if "$SCRIPT" --interval "$bad" --label t --log "$work/bad.log" -- true 2>/dev/null; then
    printf 'FAIL  accepted --interval %s\n' "$bad"
    failures=$((failures + 1))
  else
    printf 'ok    rejects --interval %s\n' "$bad"
  fi
done

# The alias spellings agents actually reach for are the same flags, not near-misses.
if "$SCRIPT" --name alias-t --every 1s --log "$work/alias.log" --max-ticks 1 -- true >/dev/null 2>&1 &&
   grep -q '\[alias-t\] tick=1' "$work/alias.log"; then
  printf 'ok    --every and --name are accepted as --interval and --label\n'
else
  printf 'FAIL  --every / --name were not accepted\n'
  failures=$((failures + 1))
fi
# Refusal alone cannot prove the routing — an unknown flag also exits 2 — so the message
# must be the until-file refusal, not the unknown-argument one.
: >"$work/alias-until-exists"
if "$SCRIPT" --label t --until "$work/alias-until-exists" 2>"$work/alias-until.err"; then
  printf 'FAIL  --until did not route to --until-file\n'
  failures=$((failures + 1))
elif grep -q 'already exists' "$work/alias-until.err"; then
  printf 'ok    --until is accepted as --until-file\n'
else
  printf 'FAIL  --until was refused as unknown rather than routed\n'
  failures=$((failures + 1))
fi

# A heartbeat with no hook and nothing to wait for was told about no job at all.
if "$SCRIPT" --label nothing --log "$work/bad.log" 2>/dev/null; then
  printf 'FAIL  armed with neither a hook nor an --until-file\n'
  failures=$((failures + 1))
else
  printf 'ok    rejects having nothing to do\n'
fi

if ((failures)); then
  printf '\n%s check(s) failed\n' "$failures"
  exit 1
fi
printf '\nall heartbeat checks passed\n'
