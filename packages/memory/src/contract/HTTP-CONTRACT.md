# Sno Station Mem HTTP contract

Contract revision: 1. Producer requirements version: 4.11.

The authoritative runtime schemas are `inputSchemas` and `outputSchemas`, exported by
`contract/index.ts`. `contractJsonSchemas(method)` publishes the corresponding JSON schemas.
The TypeScript interface is `MemoryContract`. There are eight methods. No queue or deferred
capture acknowledgement exists.

## Transport and authentication

Listen on `127.0.0.1` with an ephemeral TCP port and a random per-boot bearer token.
Discovery is `<profile root>/station/sno-station-mem.json` with `{pid, port, token}`.
The lock is `<profile root>/sno-station-mem/sidecar.lock`.
Every verb request supplies `Authorization: Bearer <token>` and
`x-sno-station-mem-skin: <skinId>`. Authenticate before reading the request body.
The skin identifier in an initialization payload must match its request header.
Verb request bodies are limited to 8 MiB. Health requires the discovery token and adds the OS principal, bound store path and guarded-operation access counters; the counters count entry to the engine/store capability, not SQL statements.
All request and response bodies are JSON. Unknown fields in contract objects are refused.

`scope` requires nonblank `principal`, `project`, and `session` strings. Its optional `host`
object accepts only `agentId`, `sessionKey`, `sessionId`, `sessionTimezone`, `workspace`, `sessionFile`, `boundary`, `at`, and `systemCaller`.
The first six are strings; `boundary` is new/reset/session-end, `at` is an epoch timestamp,
and `systemCaller` is a boolean derived from the existing host operator-admin scope. Unknown host fields are refused. The client obtains the principal from the operating-system user name.
The server refuses another principal before engine or store access. No scope field is defaulted.

`project` is the existing logical workspace key or `agent:<id>` key. The sidecar resolves its
persisted mapping on every verb call and writes to that resolved project. Optional `readable`
lists further logical scopes the call may read (the skin sends the agent's accessible set when
the caller named no scope); the sidecar refuses any `project` or `readable` entry its installed
scope policy does not grant the calling agent, and reads span the admitted set. Initialization does not return a substituted scope. Host identities and
workspace facts are explicit fields; they are never encoded into project/session/skin strings.

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
- `mutate.op`: exactly one of the five shapes below. Field names are wire names; the engine's
  existing validation, authority, clamping and return behavior stay in force.

| op | Additional fields |
|---|---|
| store | content; optional category (episodic/profile), importance, metadata |
| forget | exactly one id/query/suppressKey/suppressContent; optional minScore, maxDelete, confirm; suppressKey is {subject, attribute} |
| update | id; at least one text/category/importance/metadata |
| clear | confirm; optional all; all-project clearing retains its existing system-authority check |
| resolveReflection | exactly one memoryId/query; optional dryRun, note, limit |

- `inspect.op`: stats accepts an optional scope; an omitted scope requires systemCaller and returns principal-wide statistics; list permits category/limit/offset/importanceMin;
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
  listReflection return entries; get returns a nullable entry and optional file excerpt
  `{text,path,truncated?,from?,lines?,nextFrom?}`.
- A failed read must remain visibly degraded. A daemon-down recall returns empty hits and
  reason `sidecar-unreachable`, not a successful empty search.
- Write transport failures throw `ContractError`. Schema failures throw `ContractError`
  with reason `invalid-input` before any side effect. The error carries no submitted payload
  or credential. Invalid engine responses fail as `engine-failed`.

| HTTP status | Error code | Meaning |
|---|---|---|
| 400 | invalid-input | malformed JSON, schema failure or missing skin identity |
| 401 | unauthorized | missing or incorrect token; body not read |
| 403 | principal-mismatch / system-caller-required | foreign principal or missing operator authority refused before access |
| 404 | not_found | unknown path or unknown existing REM job |
| 409 | store-mismatch | caller path differs from the install binding |
| 413 | payload_too_large | request exceeds server body limit |
| 503 | no-agent-endpoint / storage-unavailable / paused | required resource is unavailable |
| 504 | timeout | route ceiling exceeded; no success receipt |
| 500 | engine-failed | execution or output-validation failure |

Closed degraded reasons: sidecar-unreachable, sidecar-unresponsive, principal-mismatch,
store-mismatch, no-agent-endpoint, invalid-input, timeout, storage-unavailable, engine-failed,
paused, system-caller-required. The client never opens a store or queues a write when the daemon fails.

## State and reserved environment names

`SNO_PROFILE_DIR` selects the profile root; its default is `~/.sno`. `GPU_BASE_URL` retains its
existing meaning. `XDG_CONFIG_HOME` remains owned by the external crypto package and is not renamed. The externally owned secret identifier is exported from the single
`model/signed-registry-constants.ts` file together with the signed module/preset identifiers,
anchor and key identifier. These signed values are unchanged. Every other package-owned
environment name begins `SNO_STATION_MEM_`.

`sno-station-mem bind <path>` creates the binding once, refusing an existing binding.
Unbound clients use `<profile root>/sno-station-mem/<principal>/memory.sqlite` without writing a
binding. Bindings live at `<profile root>/station/sno-station-mem-<principal>.binding.json`.
Pause/resume use the library's shared kill-switch file; workspace learning tools remain local
file operations. Neither is a database fallback or an additional HTTP method.

## Installation settings

`bind <path>` accepts optional JSON on stdin with `embedding` and `extractionKeyRef`. It creates `<root>/station/sno-station-mem-<principal>.config.json` at mode 0600 with absolute storePath plus those fields. The key reference is the fixed external extraction secret name from the constants file; key material is rejected. REM resolves that reference from its process environment. This file is independent of per-skin init registrations. The binding is published last; a second binding is refused without changing either existing file.

## Operator storage inspection

`inspect({ op: "storage" }, scope)` is an operator-only diagnostic approved for the host configuration boundary. It requires `scope.host.systemCaller`, checks the OS principal before storage access, and can run before `init` so invalid model settings do not prevent diagnosis. The result is `{ op: "storage", dimension: number | null, failed: boolean, reason?: string }`; the sidecar reads its existing live connection. It creates no extra route or verb.

`recordUsage` additionally accepts optional JSON `error` and `result` fields so the unchanged error-signal handler receives the original tool event, including successful exit-code text, instead of treating every text result as an error.

### Automatic maintenance controls

The sidecar reads `SNO_STATION_MEM_MAINTENANCE_INTERVAL_MS` (positive integer, also the first-tick delay), `SNO_STATION_MEM_REM_CLOCK_OVERRIDE` (ISO instant) and `SNO_STATION_MEM_REM_VOLUME_THRESHOLD` (positive integer) once at boot. Unset values preserve the normal interval, wall clock and100-row threshold. These overrides make the actual scheduler testable; clients never dispatch the acceptance wave.

Installed `remEnhanced.trigger.tick` defaults true. False still evaluates due windows but never dispatches them. Trigger-state version1 now requires the sixth `missed_window` field on each scope: null or `{due_at, trigger: "daily" | "volume", recorded_at}`. A five-field file is rejected as truncated. A successful dispatch clears the recorded miss.
