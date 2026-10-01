# Reach native acceptance

These scripts are explicitly separate from the default source-only82-group suite.
No native run has passed merely because this directory exists or calibration passes.
Use the frozen archive handed over by the executor, never source installation into
the native HOME. Physical remote SSH/ENOSPC is not admitted by the gpt1-only ruling.

1. `python3 tests/apps/reach/e2e/calibrate.py <archive>` executes no runtime. It
   checks the shared static refusal predicates, actual archive-copy fault
   seams, restoration and full typed payload identity.
2. `python3 tests/apps/reach/e2e/prepare.py <archive> <new-context.json>` creates a
   private archive-only HOME and copies only verified subscription credential JSON.
   This is setup, not Chapter0 and not a model call. Never copy that HOME into reports.
3. After the one final test review and the executor's announced readiness,
   `python3 tests/apps/reach/e2e/run.py <context.json> <new-proof-dir> --allow-live <archive-sha256>`
   runs Chapter0, the ordered normal/fault/restoration matrix, and owned cleanup.
   The first intentional public spawn writes the single clock before invocation.
   The current window is authorized by the owner's 2026-09-26 instruction to add Claude as a
   participant and confirm the five journeys: 10800 seconds in `reach-native-clock-7.json`.
   `reach-native-clock-6.json` (the first window of that instruction, spent on harness repairs)
   remains unchanged historical evidence and its hash is bound into
   the new clock. Claude sends on ACP and receives on tmux; Codex takes the other seats.
   Every later invocation uses the same clock. There are at most six allocated
   native seats (five are declared). Unregister never refunds a seat while its process remains alive.
4. `python3 tests/apps/reach/e2e/cleanup.py <context.json> <new-cleanup-evidence-dir>`
   is the independent emergency cleanup entry. It is permitted after clock expiry.
   It closes only declared ACP sessions and the private tmux server, then stops
   only still-live processes with the exact declared actor cwd. Credential copies
   remain private in the run HOME; the cleanup report states that explicitly.

After a recorded environment RED and verified owned cleanup,
`python3 tests/apps/reach/e2e/reset.py <old-context> <new-reset-evidence> <cleanup.json>`
rechecks real processes/closed ACP sessions, unregisters only owned stopped seats,
and retains prior-attempt metadata. It clears stale runtime handles only after those
checks. It never resets the live clock.

If a source repair requires a new archive, use
`python3 tests/apps/reach/e2e/prepare.py <new-archive> <new-context> --reuse-context <old-context> --after-cleanup <cleanup.json>`.
This preserves the old HOME and creates a new empty `home-<digest-prefix>` under
the same run. State, six addresses and six cwd paths are reused; old payload bytes
are never overlaid. Preparation refuses live actors, stale registrations or an
existing target HOME. The failed actors run first in the next preflight. Private
Codex config trusts only the five exact declared actor cwd paths, not `/tmp` or
another shared directory. No global settings or private skills are copied.

The runner stops on an unexpected journey failure. It does not automatically retry
product failures. A real transport failure may receive the one ruled retry only
after explicit triage; fresh work IDs do not reset the clock. Actual quota refusal
stops the affected vendor and asks for one quota check. Capacity is not quota:
the dispatcher allows same-model retries after five minutes, at most three, only
inside the remaining clock. No model switch or paid API fallback is permitted.
Healthy-vendor Chapter0 may complete even when the other vendor is blocked; the
affected vendor's green baseline is required for its own journeys.

`journeys.py` also exposes one explicitly selected mode/fault pair for an admitted
repair run. It checks the exact candidate, tool identities, preflight and current
test hashes before any action. `variants.py` mutates copies only and always restores
the private current link to the retained release. Fresh nonces are required for
restoration trials. During measured rows the observer never sends acceptance,
answers or acknowledgments on behalf of a native participant. Outside measured
rows, explicitly tagged fixture cleanup preserves stale card bytes, publicly
refuses old test work, dismisses reports and proves every owned inbox empty.
Those observer-authored cleanup replies never count as native acceptance effects.

Offline observed-failure regressions run with
`python3 tests/apps/reach/e2e/harness-regressions.py` and
`bash tests/apps/reach/e2e/fixture-cleanup.t`; `calibrate.py` includes both.
They replay actual MIME/tool-command evidence, exercise the live pickup predicate,
and run real public mailbox cleanup with isolated tmux ACK actors, not models.
Executable-variant rows inspect fresh native structured tool commands before
attributing a planted fault. Cached absolute executable paths are refused;
unrecognized shell indirection is not proof of the public entry. No general shell
interpreter or additional installed dispatcher layer is introduced.

## Long-run receipt verification

`python3 tests/apps/reach/e2e/verify.py <archive> <QCG> <ordered-proof-dirs...>`
revalidates actual command records, exit codes, output hashes, exported messages,
native result/pickup evidence, prompt/session histories, fresh nonces and the one
clock. It does not accept `passed` flags as proof and does not call a model.
The ordered directories are recorded in the native `matrix.json`:

| Row | Required trial order |
|---|---|
| QCG-4 | acp none, send-ring, none, reply-ring, none |
| QCG-5 | tmux none, wrong-channel, none, reply-ring, none |
| QCG-6 | call none; timeout-acp none; timeout-tmux none; call-acp call-read; call-tmux call-read; call none |
| QCG-7 | watch none, watch-prompt, none |
| QCG-22 | continuing none, reply-to, none |

QCG-22's blank/invalid Reply-To and ordinary From counterpart also require
`bash tests/apps/reach/reply-routing.t` and the ordinary live exchange rows.
Public300-second negative waits remain300 seconds; the120-second proof-recorder
limit is not permission to shorten them. A verifier refusal means uncovered work,
not a reason to replace raw evidence with a cached Boolean.

Each timeout or output-read-loss transport is a separate240-second subjourney.
The genuine timeout asks the actor to begin an observable task, wait150 seconds,
then emit the requested nonce. The public call keeps its120-second deadline and
must time out first; receiver history and the started file prove accepted work,
and a second bounded read may observe eventual completion. Completion after a
caller timeout is synchronization only, not a product guarantee: cancellation
instead triggers an explicit owned-fixture reset. Failed reset is classified as
environment/fixture recovery, while the timeout oracle remains recorded. No two120-second waits
plus setup are combined into a single240-second aggregate.
