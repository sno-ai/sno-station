# Memory precision real-agent drivers

These test-only drivers implement the PRD's ordered owner acceptance journey. They never
copy or clean the live store, install globally, or modify product source. They use existing
Sno package installers, `real-sno.mjs`, `profile-cleanup.mjs`, the settings fixture,
installed-hook recorder, real memory client and Claude host-model runner.

Run from the repository root, using the already prepared environment:

```sh
export MP_SOURCE_HOME="$HOME"
export MP_WORK_ROOT=<the scratch directory allocated for this run>
mkdir -p "$MP_WORK_ROOT/home"
export TMPDIR="$MP_WORK_ROOT"
export TMP="$MP_WORK_ROOT"
export TEMP="$MP_WORK_ROOT"
export HOME="$MP_WORK_ROOT/home"
export XDG_CACHE_HOME="$MP_WORK_ROOT/cache"
export SNO_PROFILE_DIR="$MP_SOURCE_HOME/.cache/mp-e2e/profile"
export SNO_USAGE_CLASS=research
export SNO_BINARY="$MP_SOURCE_HOME/.local/bin/sno"
export MP_CONVERSATION=<path to one real Claude Code session .jsonl>
```

For step 9, omit `MP_CONVERSATION`. The prepared `SNO_PROFILE_DIR/settings.json`
provides model settings only; the driver creates an empty profile, store, npm prefix,
agent homes and one throwaway repository under `TMPDIR`. It does not read the owner's
live profile or identity, and does not copy its store. Agent credentials come from
`MP_SOURCE_HOME/.claude/.credentials.json` and `MP_SOURCE_HOME/.codex/auth.json`;
owner instruction files are deliberately not copied, so they cannot supply the rule
being tested. Hooks use this tree's built packages, just as step 6 does. Do not run
`sno setup`, `sno update`, or stop any existing service for step 9.

For steps that use a copied profile (not step 9), before using it, stop any already-running copy-profile service by the
PID recorded in `$SNO_PROFILE_DIR/station/sidecar.json` and wait for it to exit. That
process keeps its old machine identity after `identity.json` changes. The driver does
not stop it automatically; never use pattern-based process killing.

Each command below uses those exact environment variables. Estimate before starting a
command; execute it individually, rather than launching the whole sequence as a suite.
Every driver defaults to a 265-second execution budget (`MP_BUDGET_MS=265000`), leaving
cleanup/report time within 300 seconds; the outer `timeout 285` also bounds a failed runner.
Set `MP_BUDGET_MS` in milliseconds to override the overall budget. Capture waits derive
from its deadline; individual command, host callback and readiness limits are also capped
by the remaining budget. Increase the outer timeout to allow cleanup when extending it.
A timeout fails the
step, retaining partial observations, and does not mean that the product has no rows.
The historical conversation is resumable: each invocation remains bounded, and success requires every original batch, including those completed in earlier invocations.

| PRD step | Command | Estimated wall time | What it does |
| --- | --- | --- | --- |
| Already-made copy | `timeout 285 node --import tsx tests/apps/memory-precision/e2e-agent/run.mjs 1` | 5 seconds | Read-only count of the prepared encrypted copy; does not recreate it or attest the dispatcher's backup method. |
| Cleaned copy | `timeout 285 node --import tsx tests/apps/memory-precision/e2e-agent/run.mjs 2 PLAN [PLAN...]` | 10 seconds | Read plans in apply order and the cleaned database; use each row's last judgment for label/origin/destination, global if any plan moved it, all planned deletions, and the first plan's backup. Verify surviving owner-rule ids, labels, moves, planned deletions, duplicate count and reopened backup count. **Never invokes plan/apply.** |
| Real loaded-file comparison | `timeout 285 node --import tsx tests/apps/memory-precision/e2e-agent/run.mjs 3a` | 1 minute | Start isolated Claude and Codex sessions in the real repository; compare persisted hook-computed files against Claude loading events and Codex session instruction bytes. |
| One nightly comparison | `MP_BUDGET_MS=560000 timeout 600 node --import tsx tests/apps/memory-precision/e2e-agent/run.mjs 3` | Up to 10 minutes | After dispatcher cleanup, register the observed lists against the copy through recall, remove only its daily nightly marker, invoke the existing daily REM entry once, inspect persisted judgments. The existing daily entry also attempts its bounded cleanup; unresolved rows may add calls. |
| Actual session-start delivery | `timeout 285 node --import tsx tests/apps/memory-precision/e2e-agent/run.mjs 4` | 1 minute | After nightly comparison, use the same isolated instruction-file homes against the cleaned copy; save actual transcript blocks and check shared rule, eligible project rule/pitfall and project commitment when present, no lines starting `Open task: `, complete rows, unique text and <=1000 tokens. |
| Per-message delivery | `timeout 285 node --import tsx tests/apps/memory-precision/e2e-agent/run.mjs 5` | 2 minutes | Resume the exact two sessions saved by step 4, ask release/tone questions, save newly delivered blocks and assert complete stored-row text. |
| New Claude capture | `timeout 285 node --import tsx tests/apps/memory-precision/e2e-agent/run.mjs 6 claude` | Estimated 3–5 minutes | Real session and hooks in an empty isolated profile, GPU capture and persisted-row checks; snapshot captured rows, invoke the existing daily REM entry once for the source project, assert no throw and unchanged ids/text/projects/lanes/kinds/origins, then verify shared-preference delivery through real Claude and Codex starts in a second repository. |
| New Codex capture | `timeout 285 node --import tsx tests/apps/memory-precision/e2e-agent/run.mjs 6 codex` | Estimated 4–6 minutes | Same capture → nightly preservation → receiver journey, with real Codex as the source agent. |
| New Cursor capture | `timeout 285 node --import tsx tests/apps/memory-precision/e2e-agent/run.mjs 6 cursor` | Estimated 4–6 minutes; callbacks may take longer | Same capture → nightly preservation → receiver journey, with Cursor project hooks and copied Cursor credentials in an isolated home; reads first-prompt delivery through native hook/session observations. |
| Everyday chat | `timeout 285 node --import tsx tests/apps/memory-precision/e2e-agent/run.mjs 7` | 2 minutes | Original chat capture instruction, real GPU extraction and real Claude host enrichment; read back chat mode and personal occurrences/feelings/day plans. |
| Historical work conversation | `timeout 285 node --import tsx tests/apps/memory-precision/e2e-agent/run.mjs 8` | 4 minutes, may time out | Restore unique messages and real human turns from JSONL using the existing Claude classifier; use the existing worker batch selector and real host enrichment; assert allowed labels, complete sentences on review, fewer than half the original 777 rows, and no known activity phrasings, including completed-and-merged tasks. |
| Real-agent duplicate and changed value | `MP_BUDGET_MS=900000 timeout 960 node --import tsx tests/apps/memory-precision/e2e-agent/run.mjs 9` | Estimated 8–15 minutes | Two new Claude sessions state the Chinese reply rule in different words; two new Codex sessions change port 8070 to 8090. Await each real capture, assert one open rule and retirement of the old port, observe new Claude/Codex deliveries, record their port answers, and run the installed mem-claude doctor. |

Step 9 runs on Linux and accesses its scratch directory through `/proc/<driver PID>/cwd`
to keep the sidecar's Unix socket path below the platform limit; the files still live
under `TMPDIR`. This addresses the observed `EINVAL` on a long allocated scratch path.
Step 9 defaults to a 900,000 ms driver budget. The outer 960-second timeout reserves
cleanup time. Individual CLI calls are capped at 110 seconds, capture waits at 240
seconds and the remaining driver budget. It stops only its own CLI process groups
and workers/sidecar identified by PID files in its newly created profile. It removes
that profile, prefix and agent homes, including copied credentials, on completion.
Its evidence is `ai-doc/ACTIVE/PRD/Precision-Memory/evidence/e2e-real-agents/9.json`:
stored rows after each statement, semantic judgments, observed deliveries, answers,
doctor output, timing and assertion failures. It excludes credentials, raw native
transcripts and raw service logs. The judge is a real Claude CLI with hooks disabled
and session persistence off; it classifies meaning rather than using keyword rules.
All model calls use provider defaults; the driver does not set temperature to zero.
The run does not invoke a night: it records whether one ran, checks the doctor's
service-rendered number lines if present, and otherwise records that no night ran.
Product assertion failures stop the journey; fix only harness defects before retrying,
with at most three executions in total.

Hermes/OpenClaw plugin checks remain in the existing focused files documented by
`memory-precision-tests-report.md`; this driver does not rerun them or claim a new pass.

Copied mode parses the prepared settings through the product's `settingsSchema`, filling
model-call defaults without writing back to `settings.json`. Before connecting, it aligns
only `machine_uuid` in `$SNO_PROFILE_DIR/identity.json` with
`$MP_SOURCE_HOME/.sno/identity.json`, preserving every other test-profile field and never
copying the owner's secret. A changed identity file is written with mode `0600`.
Evidence records `identityAlignment` as `updated` or `already-matched`, without either
identity file or its values. Before step 3 invokes the
daily entry, it deletes only `memory-precision-last-night` from the copied store so an
earlier attempt today cannot skip this run. Evidence records `nightlyMarkerRemoved`;
the `memory-precision-backup` marker is retained.

For each of Claude and Codex, session-start delivery must include at least one eligible
row from the resolved project if any exist: active `rule` or `pitfall`, with no
`asserted_by`, `superseded_by` or `invalidated_at` marker. If that project also has an
active `commitment` row meeting the same eligibility conditions, the block must include
at least one such row by its `[id:<id>]`. No delivered line may start with `Open task: `;
the todo table must not reach session start. Evidence records the resolved project,
eligible rule/pitfall row ids and eligible commitment row ids for each agent.
Existing checks remain in place.

Cursor ambient capture can need several 60–106-second host-model callbacks. To run only
its step 6 once with a 15-minute budget, use the environment above and:

```sh
MP_BUDGET_MS=900000 timeout 960 node --import tsx tests/apps/memory-precision/e2e-agent/run.mjs 6 cursor
```

Step 6 waits for capture until 30 seconds before the driver's overall deadline, reserving
the remainder for the nightly run, receiver sessions and cleanup. The added nightly run
may require raising `MP_BUDGET_MS` and the outer timeout, including for Claude and Codex.
Cursor evidence includes its actual worker
PID, command, `HOME`, `SNO_PROFILE_DIR` and `PATH`. Cleanup stops every harness worker in
the isolated profile before stopping the sidecar.

## Evidence and limits

Each step writes `ai-doc/ACTIVE/PRD/memory-precision/evidence/e2e-2026-11-11/<step>.json`
(or `6-claude.json`, `6-codex.json`, `6-cursor.json`). Files contain raw delivered session
text, observed hook input/output, computed lists, stored rows and labels, mode, model
HTTP attempts and responses, real host model calls, elapsed time, failures and human
reading questions. Credentials/settings are never copied into evidence. Agent homes
and transcripts remain under the cache for review; temporary profiles and their owned
processes are cleaned. The prepared copy/profile is retained.

The GPU forwarding observer forwards the original request and records metadata/status,
not authorization headers. Product transport remains responsible for source, workload,
research usage class and per-attempt request ids. Counts are observed HTTP attempts, including
failures; real host callbacks and completed host transport requests are recorded separately.
On interruption these may differ because a callback can still be finishing or be cancelled
before making a model request; they are not billing or successful-inference counts. Agent conversation usage is in the
saved native CLI outputs, not counted as GPU extraction requests.

Claude's instruction observer only appends its raw input. Codex records one combined
AGENTS instruction message: directory headings identify project files, while full byte
matches identify the user-level prefix. Evidence records content offsets for every
computed file; no computed byte is accepted on the basis of the computation alone.
Neither Cursor's nor Hermes's real loaded-file set is claimed verified by step 3a.

Reading remains necessary for sentence completeness, semantic duplication of loaded
files, whether a delivered line is useful, and whether a recalled rule answers the
question. Regex activity checks are supporting signals on work rows only; they do not
reject chat occurrences. A numeric interpretation of “far fewer” is explicitly less
than half of 777, never zero rows. Tests enter existing public/runtime boundaries and
import no function or constant introduced by the precision implementation.

Step 8 writes a private `reextract-state.json` under its cache directory after each
completed batch. Its evidence gives the exact path. Continue with the same environment:

```sh
timeout 285 node --import tsx tests/apps/memory-precision/e2e-agent/run.mjs 8 <run directory>/reextract-state.json
```

The state contains the temporary root, project, source path, conversation id and completed
batch count, without credentials. The database survives profile cleanup under that root;
the next invocation reconstructs its isolated settings and model observer. A partially
written interrupted batch is replayed through ordinary work capture and its duplicate
handling. No batch is counted until capture and retirement have completed. Keep the JSON
from each invocation when continuing; its model-call count covers that invocation only.
This checkpoint addresses the observed 99-batch historical input exceeding one bounded run.
