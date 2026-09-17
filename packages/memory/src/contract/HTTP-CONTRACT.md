# Sno Station Mem HTTP contract

Contract revision: 1. Producer requirements version: 4.11.

The authoritative runtime schemas are `inputSchemas` and `outputSchemas`, exported by
`contract/index.ts`. `contractJsonSchemas(method)` publishes the corresponding JSON schemas.
The TypeScript interface is `MemoryContract`. There are eight methods. No queue or deferred
capture acknowledgement exists.

## Transport and request handling

Listen on `127.0.0.1` with an ephemeral TCP port. There is no bearer-token admission check
or single-instance lock. Memory routes and `/rem/run` accept at most 8 MiB per request
(`MEMORY_BODY_LIMIT_BYTES`), counted as streamed bytes. An oversized body receives
413 `{error:"payload_too_large"}` and an error-level log; it creates no work.
Memory routes enforce their `MEMORY_ROUTES[method].timeoutMs` deadline over body reading,
runtime opening and invocation. An exceeded deadline returns 504
`{degraded:true,reason:"timeout"}` and an error-level log for that request only. Discovery remains
`<profile root>/station/sidecar.json` with `{pid, port, token}`; the random token identifies
which process owns discovery cleanup, not permission to make requests.

The optional `x-sno-station-mem-skin` header identifies the skin. A missing header uses the
`default` skin. A skin can call before registration: installed settings create its runtime.
Explicit registration can subsequently supply its host model callback. The header selects
registration identity. Principal, operator and configured-scope checks do not deny requests.
The installed store's embedding settings, telemetry settings and path win over conflicting
registration settings; the conflict is logged at error level.

All request and response bodies are JSON. Parsing errors affect that request alone. Extra request and settings fields are ignored instead of refusing an otherwise usable request.
`scope` carries `principal`, `project`, and `session`; optional `host` carries host identities,
workspace facts, session timing and observation identifiers. A project path matching the
host workspace uses the existing persisted mapping. Logical scopes and explicit `readable`
scopes are served without admission checks.

Health returns the OS principal, bound path and engine/store entry counts. It does not wait
for the store to open, audit recovery, model warmup, integrity checks or job-journal replay.
An underlying I/O or model operation can fail its own request. Such errors are logged and
do not latch the store or deny later requests. A failed memory-runtime open is retried on the
next request. The gateway retries failed registration automatically and registers again when
the sidecar discovery port or process changes. Discovery checking, stale callback/client
cleanup and re-registration share one promise, so concurrent callers await the same recovery.

Database setup failures log the step and error without blocking HTTP startup. Unfinished
steps retry on each maintenance pass until successful; another store open also attempts setup.
Requests touching missing schema fail individually and loudly. A nonempty vector table with
an incompatible dimension or missing partition key is preserved, logged at error level and
marked unavailable for vector search for that open. Semantic search logs the unavailable
branch and contributes no hits; keyword/FTS recall remains available. Every new store open
retries reconciliation and verification; compatible vectors become searchable again.

Registration requires `skinId`, authoritative `routing`, and `settings`. Settings retain the
existing non-routing plugin configuration: embedding, retrieval, scope policy, provider identity,
capture, reflection, telemetry, and the other existing configuration fields. The existing component validators check settings. Raw configuration normalization runs once
in the skin, before transfer; normalized settings are not fed through that raw parser again. Settings cannot introduce
another mode or route override. Each skin's registration remains separate.

Recall options include `corpus: memory|wiki|all|sessions`, defaulting to `memory`. Native
file reads use the explicit host workspace. Existing corpus refusals and file boundaries remain
observable; they are not converted into successful empty database results.

## Routes

All `/v1/` routes use POST and return 200 with their schema-validated result on completion.
Timeouts below are ceilings, not measured latency promises. Initial ceilings conservatively
cover the existing synchronous extraction/reflection paths; the phase-A integration receipt
records the first development-machine measurement and phase E rechecks the deployed boundary.

| Route | Input fields beside scope | Successful result fields beside degraded:false | Timeout (ms) |
|---|---|---|---|
| `/v1/init` | registration | principal, skinId | 30000 |
| `/v1/get-recall` | query, options | recallId, contextText; optional hits, memoryIds, toolResult, nativeHits, unavailable | 120000 |
| `/v1/capture` | turn | turnId, committed | 900000 |
| `/v1/mutate` | op | result: ToolResponse | 900000 |
| `/v1/inspect` | op | result: InspectData | 30000 |
| `/v1/record-usage` | recallId, signal | accepted | 30000 |
| `/v1/on-session-end` | messages | completed | 900000 |
| `/v1/static-block` | none | contextText | 30000 |

The existing three HTTP routes remain:

| Method and route | Request | Response | Request timeout (ms) |
|---|---|---|---|
| GET `/healthz` | bearer token; no body | existing health JSON | 5000 |
| POST `/rem/run` | `{type, scope}` or `{types, scope}` | existing 202 job acknowledgement | 30000 |
| GET `/rem/jobs/<id>` | bearer token; no body | existing job record or not-found error | 30000 |

The pre-change server has two REM routes and one health route. The requirements' phrase
“three REM routes” is read as preserving all three existing routes; no extra REM route is invented.
An invalid `/rem/run` request shape (including absent/blank scope or an empty type list)
returns 400 `{error:"invalid_request"}` without allocating a job. Unknown or unbuilt operation
types are dropped with an error-level log. If no supported operation remains, the response is
400 `{error:"unsupported_rem_type"}` and no job is created. Mixed requests execute only the
supported operations explicitly submitted. No default scope or full operation set is substituted.
REM completion remains asynchronous behind its job record. Capture completion is synchronous:
`committed:true` is legal only after extraction and persistence have completed.
A timeout never reports that a write was committed or safely cancelled. Do not blindly replay
a timed-out mutation; use its normal read path to establish the durable state.

## Request shapes

- `registration`: `{skinId, routing, settings, model?}`. `routing` uses the existing routing schema,
  including `mode`, `remEnhanced.occasions`, `agentNative.flavor` and `language`. `model`, when
  supplied, is `{baseUrl, credential, model}`. Each initialization replaces only the calling
  skin's registration. Credentials are held in memory and never logged.
- `turn`: `{turnId, rewindEpoch, messages}`. The identifier is supplied by the host and is
  stable across retries. The epoch is a nonnegative integer. Each message has
  `{role, content, at}`; role is system/developer/user/assistant/tool, content is JSON, and at
  is a nonnegative finite epoch timestamp in milliseconds.
- Recall `options`: optional source (auto/manual/native), limit, minScore, category, includeMetadata,
  includeHistory, includeRefused, tokenBudget, externalReference, externalReferenceVisibility,
  and aggregation `{operation, terms}`. The options object itself is required. An empty object
  selects the existing retriever defaults. Aggregation operations remain count/first/last/evidence.
By default, relevance-ranked recall does not use a row's timestamp or last-access time
to boost or suppress its score. Operator retrieval config `temporalWeighting` defaults to
`false`; setting it to `true` enables the historical recency, time-decay, and retention
stages with their existing tuning and lifecycle controls. When disabled, all three stages
record skip reason `temporalWeighting`. Importance weighting, optional length normalization,
score floors, explicit validity filters, and lifecycle maintenance keep their existing behavior.
Operator config `mmrWindowOnly` also defaults to `false`. When enabled, MMR only reorders
the first request-limit candidates in the reranked stream; candidates outside that window
cannot displace its members through diversification. These are operator configuration
fields, not additional recall request options.
The strict `apps/mem-claw/openclaw.plugin.json` retrieval schema has not yet been extended
with these switches; it rejects them at the plugin configuration boundary. The switches
are currently available through engine/sidecar configuration, pending a plugin-manifest update.

- `mutate.op`: exactly one of the five shapes below. Field names are wire names; the engine's
  existing validation, authority, clamping and return behavior stay in force.

| op | Additional fields |
|---|---|
| store | content; optional stored category, importance, metadata |
| forget | exactly one id/query/suppressKey/suppressContent; optional minScore, maxDelete, confirm; suppressKey is {subject, attribute} |
| update | id; at least one text/category/importance/metadata |
| clear | confirm; optional all; all-project clearing has no system-authority gate |
| resolveReflection | exactly one memoryId/query; optional dryRun, note, limit |

- `inspect.op`: stats accepts an optional scope; an omitted scope returns principal-wide statistics; list permits category/limit/offset/importanceMin;
  get requires exactly one id/path and permits from/lines for a file excerpt; listReflection
  permits limit/unresolvedOnly. These reads never enter the recall cache.
- Usage `signal`: `{event, memoryIds, at, toolName?, text?}`, where event is
  inject/used/rejected/tool-error. `recallId` is explicit. Session-end messages use the same
  message schema as capture. Host cleanup must not cause a second capture.

## Response shapes and errors

Every method result contains `degraded:boolean`. A degraded result must contain one closed
`reason`. A successful result cannot contain a failure reason.

- Recall hits preserve the existing `RetrievalResult`, including its full memory entry,
  score, sources, chunk identity, snippet, group identity and optional aggregation indicators.
- `ToolResponse` preserves `{content:[{type:"text",text}], details, isError?}` with JSON details.
- `InspectData` is discriminated by op: stats returns total and both breakdowns; list and
  listReflection return entries plus the resolved write `project`; get returns a nullable entry and optional file excerpt
  `{text,path,truncated?,from?,lines?,nextFrom?}`.
- A failed read must remain visibly degraded. A daemon-down recall returns empty hits and
  reason `sidecar-unreachable`, not a successful empty search.
- Write transport failures throw `ContractError`. Schema failures throw `ContractError`
  with reason `invalid-input` before any side effect. The error carries no submitted payload
  or credential. Invalid engine responses fail as `engine-failed`.

| HTTP status | Error code | Meaning |
|---|---|---|
| 400 | invalid-input | this request could not be parsed |
| 400 | invalid_request / unsupported_rem_type | unusable REM request; no job allocated |
| 413 | payload_too_large | memory or REM body exceeds 8 MiB; no work created |
| 504 | timeout | memory route deadline exceeded; underlying work may still complete |
| 404 | not_found | unknown path or unknown existing REM job |
| 503 | no-agent-endpoint / storage-unavailable | this operation could not obtain its required resource |
| 500 | engine-failed | execution or output-validation failure |

Closed degraded reasons: sidecar-unreachable, sidecar-unresponsive, principal-mismatch,
store-mismatch, no-agent-endpoint, invalid-input, timeout, storage-unavailable, engine-failed. The client never opens a store or queues a write when the daemon fails.

## State and reserved environment names

`SNO_PROFILE_DIR` selects the profile root; its default is `~/.sno`. `GPU_BASE_URL` retains its
existing meaning. `XDG_CONFIG_HOME` remains owned by the external crypto package and is not renamed. The externally owned secret identifier is exported from the single
`model/signed-registry-constants.ts` file together with the signed module/preset identifiers,
anchor and key identifier. These signed values are unchanged. Every other package-owned
environment name begins `SNO_STATION_MEM_`.

`sno-station-mem bind <path>` creates the binding once, refusing an existing binding.
Unbound clients use `<profile root>/sno-station-mem/<principal>/memory.sqlite` without writing a
binding. Bindings live at `<profile root>/station/sno-station-mem-<principal>.binding.json`.
Pause/resume commands and kill-switch activation were removed. Existing kill-switch files have no runtime effect. Workspace learning tools remain local file operations.

## Installation settings

`bind <path>` accepts optional JSON on stdin with `embedding` and `extractionKeyRef`. It creates `<root>/station/sno-station-mem-<principal>.config.json` at mode 0600 with absolute storePath plus those fields. The key reference is the fixed external extraction secret name from the constants file; key material is rejected. REM resolves that reference from its process environment. This file is independent of per-skin init registrations. The binding is published last; a second binding is refused without changing either existing file.

## Operator storage inspection

`inspect({ op: "storage" }, scope)` reports the current store dimension without principal,
operator or registration admission. Its `failed` field is false: there is no stored failure
latch. Actual read failures are reported as operation errors, never a fabricated healthy read.

`recordUsage` additionally accepts optional JSON `error` and `result` fields so the unchanged error-signal handler receives the original tool event, including successful exit-code text, instead of treating every text result as an error.

### Automatic maintenance controls

The sidecar reads `SNO_STATION_MEM_MAINTENANCE_INTERVAL_MS` (positive integer; it becomes the tick, the first-tick delay and every maintenance job's interval, backup and REM trigger check included), `SNO_STATION_MEM_REM_CLOCK_OVERRIDE` (ISO instant) and `SNO_STATION_MEM_REM_VOLUME_THRESHOLD` (positive integer) once at boot. Unset values preserve the normal interval, wall clock and100-row threshold. These overrides make the actual scheduler testable; clients never dispatch the acceptance wave. Each scope gets at most one automatic REM pass per local day, whichever trigger (daily schedule or volume) comes first: a completed pass of either kind records that day in `last_volume_pass_date`, which closes the volume trigger and moves the daily pass to the next day's schedule.

Automatic REM does not honor the old tick-disable or product-mode admission checks. Installed operations select what runs. Trigger-state read/write errors produce error events and due work continues with fresh state. Failed dispatch attempts remain eligible after the former three-attempt limit. The once-per-local-day rule for completed work remains the scheduling rule. A lost state file cannot prove a prior completion, so due work can run again.

## Startup, integrity and JSONL recovery

Schema setup and migrations log their failures and continue. Startup does not run a full
integrity sweep. Scheduled checks can rebuild a damaged derived FTS index, but an unsuccessful
check or rebuild does not stop SQL, maintenance, or later requests. No kill-switch file is
written or honored.

Audit and REM journal recovery read JSONL incrementally. Unreadable files and invalid journal
rows produce error events. Earlier valid records remain usable. Audit history is retained,
including every `rem_*` recovery record; there is no destructive startup truncation. Trace
logging uses the shared rotating file sink and does not read the trace into one string.
REM requests do not require enablement artifacts, owner-calibration declarations or grammar
admission. Missing operational settings use the built-in defaults.

The scheduled integrity sweep opens an FTS read cursor and checks integrity in the same
read transaction. This refreshes the observer connection after another connection changes
FTS segments. A stale in-memory segment list must not be reported as durable corruption.
Native database recall can run without a host workspace. A workspace is needed only to read
an actual file from that workspace. Explicit row updates, including timestamp repairs, do not
require an operator marker. Store requests can name any stored memory category; category
metadata is still used by the corresponding writer.
