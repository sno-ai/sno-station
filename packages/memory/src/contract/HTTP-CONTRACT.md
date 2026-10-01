# Sno Station Mem sidecar API reference

This is the client-facing HTTP reference for mem-claw, Claude Code, Codex and CLI clients.
The runtime source is authoritative: [inputs.ts](inputs.ts), [results.ts](results.ts),
[routes.ts](routes.ts), [error.ts](error.ts), [discovery.ts](discovery.ts),
[client.ts](client.ts), [memory-routes.ts](../sidecar/memory-routes.ts), and
[server.ts](../sidecar/server.ts). Field tables are generated from `contractJsonSchemas`;
request required-ness is also checked against the live Zod objects.

## Reading the generated tables

Each `<!-- table:NAME -->` marker identifies a strict pipe table checked by
`tests/packages/memory/unit/http-contract-doc-sync.test.ts`.
No Markdown formatting occurs inside checked cells. `&#124;` escapes a pipe.
`$` denotes the whole body; dotted paths are nested fields; `[]` denotes each array item;
`{}` denotes each record value. `<0>`, `<1>`, etc. select union branches in source order:
read the discriminant row in that branch. `Required=yes` is relative to its containing
object or branch, not a demand to supply an optional parent. `Default=-` means no schema
default. A default object `{}` is parsed through its child defaults. `JSON` accepts null,
boolean, finite number, string, arrays and objects recursively. All numbers must be finite.
Constraints use JSON Schema names (`minimum`, `maximum`, `minLength`, `minItems`, etc.).
Custom refinements and runtime behavior are stated in route prose and are not fully
covered by the schema-table test. The test checks all listed memory request and success
response fields, enums, defaults and serializable constraints, plus routes, deadlines,
error status mappings and example schemas. Its route-index test also probes the real loopback HTTP server with an isolated encrypted store.

Examples are complete, realistic wire examples validated against the actual memory
schemas, not claims of a live service run. Response text and generated IDs vary.
No real credentials are included. Use the discovery port in place of `43127`.

## Complete sidecar route index

The server serves exactly these paths. The health path is `/healthz`; every other path requires the `x-sidecar-token` header to equal the `token` in the discovery file, and a missing or wrong token gets HTTP 401 with body `{}` before any routing.
(proved by: `tests/packages/memory/unit/http-contract-doc-sync.test.ts` — `lists exactly all served memory, health and REM route paths`)

<!-- table:all-routes -->
| Method | Path |
| --- | --- |
| GET | /healthz |
| POST | /rem/run |
| GET | /rem/jobs/<id> |
| POST | /v1/init |
| POST | /v1/host-event |
| POST | /v1/get-recall |
| POST | /v1/capture |
| POST | /v1/mutate |
| POST | /v1/inspect |
| POST | /v1/record-usage |
| POST | /v1/on-session-end |
| POST | /v1/static-block |

## Memory route index

All listed methods use POST. Deadlines are server request ceilings, not latency promises.

<!-- table:routes -->
| Contract method | Method | Path | Deadline ms |
| --- | --- | --- | --- |
| init | POST | /v1/init | 30000 |
| hostEvent | POST | /v1/host-event | 30000 |
| getRecall | POST | /v1/get-recall | 120000 |
| capture | POST | /v1/capture | 900000 |
| mutate | POST | /v1/mutate | 900000 |
| inspect | POST | /v1/inspect | 30000 |
| recordUsage | POST | /v1/record-usage | 30000 |
| onSessionEnd | POST | /v1/on-session-end | 900000 |
| staticBlock | POST | /v1/static-block | 30000 |

## init

### Method, path and headers

`POST /v1/init`. Deadline: 30000 ms.

| Header | Required | If omitted or blank |
| --- | --- | --- |
| Content-Type: application/json | Recommended, not enforced | Server still parses the body as JSON |
| x-sno-station-mem-skin | Optional | Missing/blank uses `default` (proved by: `tests/packages/memory/integration/sidecar-no-gates.test.ts` — `selects the default skin for header undefined`; `selects the default skin for header "   "`); a nonblank value is used verbatim |
| x-sidecar-token | Yes | Must equal the `token` in the discovery file; otherwise HTTP 401 with body `{}` |

### Request body

Initializes or replaces the header-selected skin. `registration.skinId` remains a required nonblank input, but the header overrides its value (including the `default` header fallback). No prior registration is required for other calls: installed settings create the runtime on demand. With installed `local-first` settings and an empty store, an unregistered skin calling `inspect` with `op: "list"` and project `global` receives HTTP 200 and `{"degraded":false,"result":{"op":"list","project":"global","entries":[]}}` (proved by: `tests/packages/memory/integration/sidecar-no-gates.test.ts` — `serves HTTP inspection before any init using installed settings`).

`registration` is exactly `{ "skinId": "...", "model": ...? }`. The optional model
provides the host model endpoint. Routing, engine settings, embedding, telemetry and store
path come from the installed `settings.json`; registration rejects extra fields. The client
starts the service with the installed `settings.memoryPackage.path` and
`settings.memoryPackage.node`. Its `connect` call reports missing or invalid settings as
`settings unavailable: <path>: <field>; see https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md` with reason `storage-unavailable`.
The sidecar returns HTTP 503 with that error text when opening the installed settings fails.

Additional refinements: `registration.model.baseUrl` must use HTTP or HTTPS.
`registration.model.model` and `registration.skinId` must contain non-whitespace text;
credential may be empty. Model credentials remain in memory.

Scope requires nonblank `principal`, `project`, `session`. `host.observeSessionUuid`, if supplied, must be a UUID. Host `at` is nonnegative epoch milliseconds. Other host strings may be empty.

<!-- table:request:init -->
| Field | Type | Required | Enum | Default | Constraints |
| --- | --- | --- | --- | --- | --- |
| $ | object | yes | - | - | - |
| scope | object | yes | - | - | - |
| scope.principal | string | yes | - | - | {"minLength":1} |
| scope.project | string | yes | - | - | {"minLength":1} |
| scope.session | string | yes | - | - | {"minLength":1} |
| scope.host | object | no | - | - | - |
| scope.host.observeSessionUuid | string | no | - | - | {"format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}&#124;00000000-0000-0000-0000-000000000000&#124;ffffffff-ffff-ffff-ffff-ffffffffffff)$"} |
| scope.host.agentId | string | no | - | - | - |
| scope.host.sessionKey | string | no | - | - | - |
| scope.host.sessionId | string | no | - | - | - |
| scope.host.sessionTimezone | string | no | - | - | - |
| scope.host.workspace | string | no | - | - | - |
| scope.host.sessionFile | string | no | - | - | - |
| scope.host.boundary | string | no | ["new","reset","session-end"] | - | - |
| scope.host.at | number | no | - | - | {"minimum":0} |
| scope.host.systemCaller | boolean | no | - | - | - |
| registration | object | yes | - | - | {"additionalProperties":false} |
| registration.skinId | string | yes | - | - | {"minLength":1} |
| registration.model | object | no | - | - | - |
| registration.model.baseUrl | string | yes | - | - | {"format":"uri"} |
| registration.model.credential | string | yes | - | - | - |
| registration.model.model | string | yes | - | - | {"minLength":1} |

### Response body

HTTP 200, JSON. The complete successful body is below. The schema also permits the same payload with `degraded:true` and a required closed `reason`; it forbids a reason on success. HTTP exception bodies are smaller and described next.

<!-- table:response:init -->
| Field | Type | Required | Enum | Default | Constraints |
| --- | --- | --- | --- | --- | --- |
| $ | object | yes | - | - | {"additionalProperties":false} |
| principal | string | yes | - | - | {"minLength":1} |
| skinId | string | yes | - | - | {"minLength":1} |
| degraded | boolean | yes | [false] | - | - |

### Errors

Each mapped exception has exactly `{"degraded":true,"reason":"<reason>"}` and the status below.
This is the complete shared mapping, not a claim that every reason is emitted by this route:
principal/store mismatch reasons remain declared but are not admission checks; unreachable/
unresponsive normally describe client connection failures. See the general error semantics.

<!-- table:errors:init -->
| Reason | HTTP status |
| --- | --- |
| sidecar-unreachable | 503 |
| sidecar-unresponsive | 503 |
| principal-mismatch | 403 |
| store-mismatch | 409 |
| no-agent-endpoint | 503 |
| invalid-input | 400 |
| timeout | 504 |
| storage-unavailable | 503 |
| engine-failed | 500 |

Additional transport errors: 413 `{"error":"payload_too_large"}` for a body over
8 MiB; wrong method or unmatched path returns 404 `{"error":"not_found"}`.
504 is the mapped `timeout` response, not a commit or cancellation guarantee.
An outer-server failure can return 500 `{"error":"internal_error"}`.

### Complete request and response example

```http
POST /v1/init HTTP/1.1
Host: 127.0.0.1:43127
Content-Type: application/json
x-sno-station-mem-skin: codex
```

<!-- example:init:request -->
```json
{
  "scope": {
    "principal": "lh",
    "project": "release-notes",
    "session": "session-2026-09-17"
  },
  "registration": {
    "skinId": "codex",
    "model": {
      "baseUrl": "http://127.0.0.1:43128/v1",
      "credential": "runtime-only-token",
      "model": "codex-host"
    }
  }
}
```

Response status: `200 OK`; `Content-Type: application/json`.

<!-- example:init:response -->
```json
{
  "degraded": false,
  "principal": "lh",
  "skinId": "codex"
}
```

## hostEvent

### Method, path and headers

`POST /v1/host-event`. Deadline: 30000 ms.

| Header | Required | If omitted or blank |
| --- | --- | --- |
| Content-Type: application/json | Recommended, not enforced | Server still parses the body as JSON |
| x-sno-station-mem-skin | Optional | Missing/blank uses `default`; a nonblank value is used verbatim |
| x-sidecar-token | Yes | Must equal the `token` in the discovery file; otherwise HTTP 401 with body `{}` |

### Request body

Reports one host-side fact for the skin's observe session: `prompt` is the user's prompt text (the sidecar hashes it after redaction and reports its byte length; the text is never stored or forwarded), `llm` is one host model call with its token counts and wall time in milliseconds, `tool` is one host tool call (its serialized input and output are hashed after redaction, never stored; `latencyMs` is 0 when the host did not measure it), `permission` is one permission decision the host made (the target is hashed after redaction). The sidecar names the observe session for the host session (`scope.host.sessionId`, else `scope.session`) the first time it sees it and emits `session.start`; a caller that names its own `scope.host.observeSessionUuid` keeps that session. `accepted` is false only when the prompt could not be hashed.

Scope requires nonblank `principal`, `project`, `session`. `host.observeSessionUuid`, if supplied, must be a UUID. Host `at` is nonnegative epoch milliseconds. Other host strings may be empty.

<!-- table:request:hostEvent -->
| Field | Type | Required | Enum | Default | Constraints |
| --- | --- | --- | --- | --- | --- |
| $ | object | yes | - | - | - |
| scope | object | yes | - | - | - |
| scope.principal | string | yes | - | - | {"minLength":1} |
| scope.project | string | yes | - | - | {"minLength":1} |
| scope.session | string | yes | - | - | {"minLength":1} |
| scope.host | object | no | - | - | - |
| scope.host.observeSessionUuid | string | no | - | - | {"format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}&#124;00000000-0000-0000-0000-000000000000&#124;ffffffff-ffff-ffff-ffff-ffffffffffff)$"} |
| scope.host.agentId | string | no | - | - | - |
| scope.host.sessionKey | string | no | - | - | - |
| scope.host.sessionId | string | no | - | - | - |
| scope.host.sessionTimezone | string | no | - | - | - |
| scope.host.workspace | string | no | - | - | - |
| scope.host.sessionFile | string | no | - | - | - |
| scope.host.boundary | string | no | ["new","reset","session-end"] | - | - |
| scope.host.at | number | no | - | - | {"minimum":0} |
| scope.host.systemCaller | boolean | no | - | - | - |
| event | union | yes | - | - | - |
| event<0> | object | yes | - | - | - |
| event<0>.kind | string | yes | ["prompt"] | - | - |
| event<0>.prompt | string | yes | - | - | - |
| event<1> | object | yes | - | - | - |
| event<1>.kind | string | yes | ["llm"] | - | - |
| event<1>.model | string | yes | - | - | {"minLength":1} |
| event<1>.promptTokens | integer | yes | - | - | {"minimum":0,"maximum":9007199254740991} |
| event<1>.completionTokens | integer | yes | - | - | {"minimum":0,"maximum":9007199254740991} |
| event<1>.cacheReadTokens | integer | no | - | - | {"minimum":0,"maximum":9007199254740991} |
| event<1>.cacheWriteTokens | integer | no | - | - | {"minimum":0,"maximum":9007199254740991} |
| event<1>.latencyMs | number | yes | - | - | {"minimum":0} |
| event<2> | object | yes | - | - | - |
| event<2>.kind | string | yes | ["tool"] | - | - |
| event<2>.toolName | string | yes | - | - | {"minLength":1} |
| event<2>.decision | string | yes | ["allow","deny"] | - | - |
| event<2>.input | string | yes | - | - | - |
| event<2>.output | string | yes | - | - | - |
| event<2>.latencyMs | number | yes | - | - | {"minimum":0} |
| event<3> | object | yes | - | - | - |
| event<3>.kind | string | yes | ["permission"] | - | - |
| event<3>.permissionKind | string | yes | - | - | {"minLength":1} |
| event<3>.decision | string | yes | ["allow","deny"] | - | - |
| event<3>.target | string | yes | - | - | - |

### Response body

HTTP 200, JSON. The complete successful body is below. The schema also permits the same payload with `degraded:true` and a required closed `reason`; it forbids a reason on success. HTTP exception bodies are smaller and described next.

<!-- table:response:hostEvent -->
| Field | Type | Required | Enum | Default | Constraints |
| --- | --- | --- | --- | --- | --- |
| $ | object | yes | - | - | {"additionalProperties":false} |
| accepted | boolean | yes | - | - | - |
| degraded | boolean | yes | [false] | - | - |

### Errors

Each mapped exception has exactly `{"degraded":true,"reason":"<reason>"}` and the status below.
This is the complete shared mapping, not a claim that every reason is emitted by this route.

<!-- table:errors:hostEvent -->
| Reason | HTTP status |
| --- | --- |
| sidecar-unreachable | 503 |
| sidecar-unresponsive | 503 |
| principal-mismatch | 403 |
| store-mismatch | 409 |
| no-agent-endpoint | 503 |
| invalid-input | 400 |
| timeout | 504 |
| storage-unavailable | 503 |
| engine-failed | 500 |

Additional transport errors: 413 `{"error":"payload_too_large"}` for a body over
8 MiB; wrong method or unmatched path returns 404 `{"error":"not_found"}`.
504 is the mapped `timeout` response, not a commit or cancellation guarantee.
An outer-server failure can return 500 `{"error":"internal_error"}`.

### Complete request and response example

```http
POST /v1/host-event HTTP/1.1
Host: 127.0.0.1:43127
Content-Type: application/json
x-sno-station-mem-skin: codex
```

<!-- example:hostEvent:request -->
```json
{
  "scope": {
    "principal": "lh",
    "project": "release-notes",
    "session": "session-2026-09-17",
    "host": {
      "sessionId": "session-2026-09-17"
    }
  },
  "event": {
    "kind": "llm",
    "model": "openai:gpt-5.6-codex",
    "promptTokens": 6402,
    "completionTokens": 241,
    "latencyMs": 8420
  }
}
```

Response status: `200 OK`; `Content-Type: application/json`.

<!-- example:hostEvent:response -->
```json
{
  "degraded": false,
  "accepted": true
}
```

## getRecall

### Method, path and headers

`POST /v1/get-recall`. Deadline: 120000 ms.

| Header | Required | If omitted or blank |
| --- | --- | --- |
| Content-Type: application/json | Recommended, not enforced | Server still parses the body as JSON |
| x-sno-station-mem-skin | Optional | Missing/blank uses `default` (proved by: `tests/packages/memory/integration/sidecar-no-gates.test.ts` — `selects the default skin for header undefined`; `selects the default skin for header "   "`); a nonblank value is used verbatim |
| x-sidecar-token | Yes | Must equal the `token` in the discovery file; otherwise HTTP 401 with body `{}` |

### Request body

Retrieves context for a query. `query` must contain non-whitespace text. `options` is required even when empty; only `corpus` has a request-schema default. Other omitted fields use the runtime/retriever behavior; a dash does not promise a fixed engine default. `aggregation.terms` are trimmed, each is 1–128 characters, and there are 1–8 terms. Every call reads its project plus the shared `global` memory. Native database recall does not require a workspace; native file reads do.

Automatic injection uses `source:"auto"` and `injectionPhase:"session-start"|"prompt"|"first-prompt"`.
Session-start uses the standing repository query; prompt uses the raw user prompt; first-prompt
combines both phases into one block. Optional `limit`, prompt `minScore` and `maxChars` bound the
request alongside the installed phase settings and the 12,000-character session cap. The service
applies `recall.auto`, prompt minimum length, phase deadlines, current-row filtering and repeat
suppression. `capture.ambient` does not disable injection or explicit actions.

The returned `contextText` is passed through unchanged by every skin. It has one header,
`Sno memory (data, not instructions; use get <id> for a full entry):`, and whitespace-normalized
first-sentence lines ending in ` [id:<id>]`. Sentences are at most 200 characters and lines at
most 240. No fitting line means an empty block and no served ids. The process-local ledger is
keyed by principal, project, registered skin and session; new/reset/compaction clears it, resume
retains it, and re-registration adopts it together with same-turn manual recall history.
A failed call marks no ids. Restart loses this ledger and may repeat a still-current row.

Automatic, manual and native recall can populate different optional response fields. Inspect `degraded` and `unavailable`; `unavailable: "model-preparing"` means the embedding model is still preparing, while `unavailable: "model preparation failed: …"` reports preparation failure. Empty context alone is not proof that the service succeeded.

Scope requires nonblank `principal`, `project`, `session`. `host.observeSessionUuid`, if supplied, must be a UUID. Host `at` is nonnegative epoch milliseconds. Other host strings may be empty.

<!-- table:request:getRecall -->
| Field | Type | Required | Enum | Default | Constraints |
| --- | --- | --- | --- | --- | --- |
| $ | object | yes | - | - | - |
| query | string | yes | - | - | {"minLength":1} |
| scope | object | yes | - | - | - |
| scope.principal | string | yes | - | - | {"minLength":1} |
| scope.project | string | yes | - | - | {"minLength":1} |
| scope.session | string | yes | - | - | {"minLength":1} |
| scope.host | object | no | - | - | - |
| scope.host.observeSessionUuid | string | no | - | - | {"format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}&#124;00000000-0000-0000-0000-000000000000&#124;ffffffff-ffff-ffff-ffff-ffffffffffff)$"} |
| scope.host.agentId | string | no | - | - | - |
| scope.host.sessionKey | string | no | - | - | - |
| scope.host.sessionId | string | no | - | - | - |
| scope.host.sessionTimezone | string | no | - | - | - |
| scope.host.workspace | string | no | - | - | - |
| scope.host.sessionFile | string | no | - | - | - |
| scope.host.boundary | string | no | ["new","reset","session-end"] | - | - |
| scope.host.at | number | no | - | - | {"minimum":0} |
| scope.host.systemCaller | boolean | no | - | - | - |
| options | object | yes | - | - | - |
| options.corpus | string | no | ["memory","wiki","all","sessions"] | "memory" | - |
| options.source | string | no | ["auto","manual","native"] | - | - |
| options.injectionPhase | string | no | ["session-start","prompt","first-prompt"] | - | - |
| options.maxChars | integer | no | - | - | {"minimum":0,"maximum":9007199254740991} |
| options.limit | integer | no | - | - | {"minimum":-9007199254740991,"maximum":9007199254740991} |
| options.minScore | number | no | - | - | - |
| options.category | string | no | ["episodic","profile","persona","lesson","summary","state"] | - | - |
| options.includeMetadata | boolean | no | - | - | - |
| options.includeHistory | boolean | no | - | - | - |
| options.includeRefused | boolean | no | - | - | - |
| options.tokenBudget | integer | no | - | - | {"minimum":-9007199254740991,"maximum":9007199254740991} |
| options.externalReference | string | no | - | - | - |
| options.externalReferenceVisibility | string | no | ["public","private"] | - | - |
| options.aggregation | object | no | - | - | - |
| options.aggregation.operation | string | yes | ["count","first","last","evidence"] | - | - |
| options.aggregation.terms | array | yes | - | - | {"minItems":1,"maxItems":8} |
| options.aggregation.terms[] | string | yes | - | - | {"minLength":1,"maxLength":128} |

### Response body

HTTP 200, JSON. The complete successful body is below. The schema also permits the same payload with `degraded:true` and a required closed `reason`; it forbids a reason on success. HTTP exception bodies are smaller and described next.

<!-- table:response:getRecall -->
| Field | Type | Required | Enum | Default | Constraints |
| --- | --- | --- | --- | --- | --- |
| $ | object | yes | - | - | {"additionalProperties":false} |
| recallId | string | yes | - | - | - |
| contextText | string | yes | - | - | - |
| hits | array | no | - | - | - |
| hits[] | object | yes | - | - | {"additionalProperties":false} |
| hits[].entry | object | yes | - | - | {"additionalProperties":false} |
| hits[].entry.id | string | yes | - | - | {"minLength":1} |
| hits[].entry.factId | string | no | - | - | - |
| hits[].entry.text | string | yes | - | - | - |
| hits[].entry.category | string | yes | ["episodic","profile","persona","lesson","summary","state"] | - | - |
| hits[].entry.projectId | string | yes | - | - | - |
| hits[].entry.importance | number | yes | - | - | - |
| hits[].entry.timestamp | number | yes | - | - | - |
| hits[].entry.timezone | string | yes | - | - | - |
| hits[].entry.metadata | string | yes | - | - | - |
| hits[].entry.contentHash | string | yes | - | - | - |
| hits[].entry.lane | string | yes | ["active","parked","quarantined"] | - | - |
| hits[].entry.rawCandidateJson | string | no | - | - | - |
| hits[].entry.dispositionReason | string | no | - | - | - |
| hits[].entry.dispositionedAt | number | no | - | - | - |
| hits[].score | number | yes | - | - | - |
| hits[].eventIdentity | string | no | - | - | - |
| hits[].scopeRowCount | integer | no | - | - | {"minimum":0,"maximum":9007199254740991} |
| hits[].aggregationIncomplete | boolean | no | - | - | - |
| hits[].sources | object | yes | - | - | {"additionalProperties":false} |
| hits[].sources.vector | object | no | - | - | {"additionalProperties":false} |
| hits[].sources.vector.score | number | yes | - | - | - |
| hits[].sources.vector.rank | integer | yes | - | - | {"minimum":-9007199254740991,"maximum":9007199254740991} |
| hits[].sources.bm25 | object | no | - | - | {"additionalProperties":false} |
| hits[].sources.bm25.score | number | yes | - | - | - |
| hits[].sources.bm25.rank | integer | yes | - | - | {"minimum":-9007199254740991,"maximum":9007199254740991} |
| hits[].sources.fused | object | no | - | - | {"additionalProperties":false} |
| hits[].sources.fused.score | number | yes | - | - | - |
| hits[].sources.reranked | object | no | - | - | {"additionalProperties":false} |
| hits[].sources.reranked.score | number | yes | - | - | - |
| hits[].chunkId | string | no | - | - | - |
| hits[].chunkIndex | integer | no | - | - | {"minimum":-9007199254740991,"maximum":9007199254740991} |
| hits[].bestChunkScore | number | no | - | - | - |
| hits[].snippet | string | no | - | - | - |
| hits[].recallGroupKey | string | no | - | - | - |
| hits[].denseScore | number | no | - | - | - |
| hits[].bm25Score | number | no | - | - | - |
| hits[].fusedScore | number | no | - | - | - |
| hits[].rerankScore | number | no | - | - | - |
| hits[].mmrScore | number | no | - | - | - |
| memoryIds | array | no | - | - | - |
| memoryIds[] | string | yes | - | - | {"minLength":1} |
| toolResult | object | no | - | - | {"additionalProperties":false} |
| toolResult.isError | boolean | no | - | - | - |
| toolResult.content | array | yes | - | - | - |
| toolResult.content[] | object | yes | - | - | {"additionalProperties":false} |
| toolResult.content[].type | string | yes | ["text"] | - | - |
| toolResult.content[].text | string | yes | - | - | - |
| toolResult.details | object | yes | - | - | {"propertyNames":{"type":"string"}} |
| toolResult.details{} | JSON | yes | - | - | - |
| nativeHits | array | no | - | - | - |
| nativeHits[] | object | yes | - | - | {"additionalProperties":false} |
| nativeHits[].path | string | yes | - | - | - |
| nativeHits[].startLine | integer | yes | - | - | {"minimum":-9007199254740991,"maximum":9007199254740991} |
| nativeHits[].endLine | integer | yes | - | - | {"minimum":-9007199254740991,"maximum":9007199254740991} |
| nativeHits[].score | number | yes | - | - | - |
| nativeHits[].vectorScore | number | no | - | - | - |
| nativeHits[].textScore | number | no | - | - | - |
| nativeHits[].snippet | string | yes | - | - | - |
| nativeHits[].source | string | yes | ["memory","sessions"] | - | - |
| nativeHits[].citation | string | no | - | - | - |
| unavailable | string | no | - | - | - |
| degraded | boolean | yes | [false] | - | - |

### Errors

Each mapped exception has exactly `{"degraded":true,"reason":"<reason>"}` and the status below.
This is the complete shared mapping, not a claim that every reason is emitted by this route:
principal/store mismatch reasons remain declared but are not admission checks; unreachable/
unresponsive normally describe client connection failures. See the general error semantics.

<!-- table:errors:getRecall -->
| Reason | HTTP status |
| --- | --- |
| sidecar-unreachable | 503 |
| sidecar-unresponsive | 503 |
| principal-mismatch | 403 |
| store-mismatch | 409 |
| no-agent-endpoint | 503 |
| invalid-input | 400 |
| timeout | 504 |
| storage-unavailable | 503 |
| engine-failed | 500 |

Additional transport errors: 413 `{"error":"payload_too_large"}` for a body over
8 MiB; wrong method or unmatched path returns 404 `{"error":"not_found"}`.
504 is the mapped `timeout` response, not a commit or cancellation guarantee.
An outer-server failure can return 500 `{"error":"internal_error"}`.

### Complete request and response example

```http
POST /v1/get-recall HTTP/1.1
Host: 127.0.0.1:43127
Content-Type: application/json
x-sno-station-mem-skin: codex
```

<!-- example:getRecall:request -->
```json
{
  "query": "When is the release review?",
  "scope": {
    "principal": "lh",
    "project": "release-notes",
    "session": "session-2026-09-17"
  },
  "options": {
    "corpus": "memory",
    "source": "manual",
    "limit": 5
  }
}
```

Response status: `200 OK`; `Content-Type: application/json`.

<!-- example:getRecall:response -->
```json
{
  "degraded": false,
  "recallId": "recall-2026-09-17-001",
  "contextText": "No relevant memories found.",
  "toolResult": {
    "content": [
      {
        "type": "text",
        "text": "No relevant memories found."
      }
    ],
    "details": {
      "count": 0,
      "memories": [],
      "scope": "release-notes"
    }
  }
}
```

## capture

### Method, path and headers

`POST /v1/capture`. Deadline: 900000 ms.

| Header | Required | If omitted or blank |
| --- | --- | --- |
| Content-Type: application/json | Recommended, not enforced | Server still parses the body as JSON |
| x-sno-station-mem-skin | Optional | Missing/blank uses `default` (proved by: `tests/packages/memory/integration/sidecar-no-gates.test.ts` — `selects the default skin for header undefined`; `selects the default skin for header "   "`); a nonblank value is used verbatim |
| x-sidecar-token | Yes | Must equal the `token` in the discovery file; otherwise HTTP 401 with body `{}` |

### Request body

Captures one completed turn. `turnId` must contain non-whitespace text; `rewindEpoch` is a nonnegative integer. Message times are nonnegative finite epoch milliseconds. JSON content can be structured or plain text. No minimum message-array length is imposed by this schema. `committed:true` acknowledges completed synchronous extraction/persistence, not a queued write. `skipped:true` means capture was deliberately disabled, omitted for a subagent, or given an empty conversation. `partial:true` means extraction stored some facts but did not fully complete. A plain `committed:false` remains retryable. A deadline is not a durable commit receipt.

Scope requires nonblank `principal`, `project`, `session`. `host.observeSessionUuid`, if supplied, must be a UUID. Host `at` is nonnegative epoch milliseconds. Other host strings may be empty.

<!-- table:request:capture -->
| Field | Type | Required | Enum | Default | Constraints |
| --- | --- | --- | --- | --- | --- |
| $ | object | yes | - | - | - |
| turn | object | yes | - | - | - |
| turn.turnId | string | yes | - | - | {"minLength":1} |
| turn.rewindEpoch | integer | yes | - | - | {"minimum":0,"maximum":9007199254740991} |
| turn.messages | array | yes | - | - | - |
| turn.messages[] | object | yes | - | - | - |
| turn.messages[].role | string | yes | ["system","developer","user","assistant","tool"] | - | - |
| turn.messages[].content | JSON | yes | - | - | - |
| turn.messages[].at | number | yes | - | - | {"minimum":0} |
| scope | object | yes | - | - | - |
| scope.principal | string | yes | - | - | {"minLength":1} |
| scope.project | string | yes | - | - | {"minLength":1} |
| scope.session | string | yes | - | - | {"minLength":1} |
| scope.host | object | no | - | - | - |
| scope.host.observeSessionUuid | string | no | - | - | {"format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}&#124;00000000-0000-0000-0000-000000000000&#124;ffffffff-ffff-ffff-ffff-ffffffffffff)$"} |
| scope.host.agentId | string | no | - | - | - |
| scope.host.sessionKey | string | no | - | - | - |
| scope.host.sessionId | string | no | - | - | - |
| scope.host.sessionTimezone | string | no | - | - | - |
| scope.host.workspace | string | no | - | - | - |
| scope.host.sessionFile | string | no | - | - | - |
| scope.host.boundary | string | no | ["new","reset","session-end"] | - | - |
| scope.host.at | number | no | - | - | {"minimum":0} |
| scope.host.systemCaller | boolean | no | - | - | - |

### Response body

HTTP 200, JSON. The complete successful body is below. The schema also permits the same payload with `degraded:true` and a required closed `reason`; it forbids a reason on success. HTTP exception bodies are smaller and described next.

<!-- table:response:capture -->
| Field | Type | Required | Enum | Default | Constraints |
| --- | --- | --- | --- | --- | --- |
| $ | object | yes | - | - | {"additionalProperties":false} |
| turnId | string | yes | - | - | {"minLength":1} |
| committed | boolean | yes | - | - | - |
| accepted | boolean | no | - | - | - |
| skipped | boolean | no | [true] | - | - |
| partial | boolean | no | [true] | - | - |
| degraded | boolean | yes | [false] | - | - |

### Errors

Each mapped exception has exactly `{"degraded":true,"reason":"<reason>"}` and the status below.
This is the complete shared mapping, not a claim that every reason is emitted by this route:
principal/store mismatch reasons remain declared but are not admission checks; unreachable/
unresponsive normally describe client connection failures. See the general error semantics.

<!-- table:errors:capture -->
| Reason | HTTP status |
| --- | --- |
| sidecar-unreachable | 503 |
| sidecar-unresponsive | 503 |
| principal-mismatch | 403 |
| store-mismatch | 409 |
| no-agent-endpoint | 503 |
| invalid-input | 400 |
| timeout | 504 |
| storage-unavailable | 503 |
| engine-failed | 500 |

Additional transport errors: 413 `{"error":"payload_too_large"}` for a body over
8 MiB; wrong method or unmatched path returns 404 `{"error":"not_found"}`.
504 is the mapped `timeout` response, not a commit or cancellation guarantee.
An outer-server failure can return 500 `{"error":"internal_error"}`.

### Complete request and response example

```http
POST /v1/capture HTTP/1.1
Host: 127.0.0.1:43127
Content-Type: application/json
x-sno-station-mem-skin: codex
```

<!-- example:capture:request -->
```json
{
  "turn": {
    "turnId": "turn-2026-09-17-001",
    "rewindEpoch": 0,
    "messages": [
      {
        "role": "user",
        "content": "The release review is on Friday.",
        "at": 1789660800000
      }
    ]
  },
  "scope": {
    "principal": "lh",
    "project": "release-notes",
    "session": "session-2026-09-17"
  }
}
```

Response status: `200 OK`; `Content-Type: application/json`.

<!-- example:capture:response -->
```json
{
  "degraded": false,
  "turnId": "turn-2026-09-17-001",
  "committed": true
}
```

## mutate

### Method, path and headers

`POST /v1/mutate`. Deadline: 900000 ms.

| Header | Required | If omitted or blank |
| --- | --- | --- |
| Content-Type: application/json | Recommended, not enforced | Server still parses the body as JSON |
| x-sno-station-mem-skin | Optional | Missing/blank uses `default` (proved by: `tests/packages/memory/integration/sidecar-no-gates.test.ts` — `selects the default skin for header undefined`; `selects the default skin for header "   "`); a nonblank value is used verbatim |
| x-sidecar-token | Yes | Must equal the `token` in the discovery file; otherwise HTTP 401 with body `{}` |

### Request body

Select exactly one operation using the nested `op.op` discriminant. The numbered table branches are: 0 `correct`, 1 `store`, 2 `forget`, 3 `update`, 4 `clear`, 5 `resolveReflection`.

Cross-field constraints (Zod refinements, not expressible in the generated field tables):

- `correct` accepts exactly `{op:"correct",id,content}` with nonblank strings. It reads only the current project and global scope. The service creates a fresh row and closes the old row in one transaction; the successor retains the old project, fact identity, filing and entity links. A failure leaves the old row unchanged. Success contains one text part with the successor id and `details.id`; refusal sets `isError:true` and `details.errorCode`. A closed target returns `already-superseded` with `details.successorId` naming its immediate successor, including on a retry with different text. Identical normalized text or hash collisions in the same project/category, inactive/refused/invalidated rows, reflections and active-task rows are `invalid-input`; an unreadable or missing id is `not-found`. Model preparation is awaited only within the existing mutation deadline.
- `store.content` must contain non-whitespace text. Every stored category in the enum is allowed.
- `forget` requires exactly one of `id`, `query`, `suppressKey`, `suppressContent`. Supplied selectors and both suppress-key strings must contain non-whitespace text. `maxDelete` is a positive integer.
- `update` requires nonblank `id` and at least one of `text`, `category`, `importance`, `metadata`, `timestamp`. Supplied text is nonblank. Timestamp repair is allowed without an operator marker.
- `clear.confirm` is required as a boolean; false is schema-valid. `all` requests all projects without a system-authority admission gate. Tool confirmation semantics still apply.
- `resolveReflection` requires exactly one nonblank `memoryId` or `query`; optional `note` may be empty.

Finite importance/minScore values have no range constraint at this wire boundary; the writer may clamp them. A tool-level refusal can be HTTP 200 with `result.isError:true`; always read the tool result.

Correction failures carry the actual cause in `result.content` and the optional degraded
`error` field; `reason` retains the existing transport classification. The client preserves that
cause in `ContractError.message`. Same-text correction refusals keep `details.errorCode` as
`invalid-input` and return exactly one of these sentences in `result.content`:

- `unchanged: the corrected text equals memory <id>` when the corrected text equals the target.
- `same text already stored as <existingId>; reword the correction, or correct <existingId> if that is the memory you mean` when another current row has the same text.
- `same text is stored as retired memory <existingId>; reword the correction so it can be stored as new` when a retired row has the same text.

Explicit remember returns only its stored id on success. Remembering a retired row's text
returns `isError:true`, `details.errorCode:"invalid-input"`, `details.existingId`, and the third
sentence instead; it leaves both the retired row and its successor unchanged. A correction
successor inherits neither relation rows nor the `relations` metadata key. Explicit manual
recall returns `<id>\t<first sentence [id:<id>]>\n<full text>` for each hit, separated by a blank
line. Get keeps its entry shape. Both explicit paths append `retired; superseded by <id>` to
retired text without changing the stored text, even when that successor no longer exists.
Manual recall includes an invalidated row only when it has a successor; unrelated invalidated
rows remain excluded. Automatic recall excludes closed rows before ranking and limit.

Scope requires nonblank `principal`, `project`, `session`. `host.observeSessionUuid`, if supplied, must be a UUID. Host `at` is nonnegative epoch milliseconds. Other host strings may be empty.

<!-- table:request:mutate -->
| Field | Type | Required | Enum | Default | Constraints |
| --- | --- | --- | --- | --- | --- |
| $ | object | yes | - | - | - |
| op | union | yes | - | - | - |
| op<0> | object | yes | - | - | {"additionalProperties":false} |
| op<0>.op | string | yes | ["correct"] | - | - |
| op<0>.id | string | yes | - | - | {"minLength":1} |
| op<0>.content | string | yes | - | - | {"minLength":1} |
| op<1> | object | yes | - | - | - |
| op<1>.op | string | yes | ["store"] | - | - |
| op<1>.content | string | yes | - | - | {"minLength":1} |
| op<1>.category | string | no | ["episodic","profile","persona","lesson","summary","state"] | - | - |
| op<1>.importance | number | no | - | - | - |
| op<1>.metadata | object | no | - | - | {"propertyNames":{"type":"string"}} |
| op<1>.metadata{} | JSON | yes | - | - | - |
| op<2> | object | yes | - | - | - |
| op<2>.op | string | yes | ["forget"] | - | - |
| op<2>.id | string | no | - | - | {"minLength":1} |
| op<2>.query | string | no | - | - | {"minLength":1} |
| op<2>.suppressKey | object | no | - | - | - |
| op<2>.suppressKey.subject | string | yes | - | - | {"minLength":1} |
| op<2>.suppressKey.attribute | string | yes | - | - | {"minLength":1} |
| op<2>.suppressContent | string | no | - | - | {"minLength":1} |
| op<2>.minScore | number | no | - | - | - |
| op<2>.maxDelete | integer | no | - | - | {"exclusiveMinimum":0,"maximum":9007199254740991} |
| op<2>.confirm | boolean | no | - | - | - |
| op<3> | object | yes | - | - | - |
| op<3>.op | string | yes | ["update"] | - | - |
| op<3>.id | string | yes | - | - | {"minLength":1} |
| op<3>.text | string | no | - | - | {"minLength":1} |
| op<3>.category | string | no | ["episodic","profile","persona","lesson","summary","state"] | - | - |
| op<3>.importance | number | no | - | - | - |
| op<3>.metadata | object | no | - | - | {"propertyNames":{"type":"string"}} |
| op<3>.metadata{} | JSON | yes | - | - | - |
| op<3>.timestamp | integer | no | - | - | {"minimum":0,"maximum":9007199254740991} |
| op<4> | object | yes | - | - | - |
| op<4>.op | string | yes | ["clear"] | - | - |
| op<4>.confirm | boolean | yes | - | - | - |
| op<4>.all | boolean | no | - | - | - |
| op<5> | object | yes | - | - | - |
| op<5>.op | string | yes | ["resolveReflection"] | - | - |
| op<5>.memoryId | string | no | - | - | {"minLength":1} |
| op<5>.query | string | no | - | - | {"minLength":1} |
| op<5>.dryRun | boolean | no | - | - | - |
| op<5>.note | string | no | - | - | - |
| op<5>.limit | integer | no | - | - | {"minimum":-9007199254740991,"maximum":9007199254740991} |
| scope | object | yes | - | - | - |
| scope.principal | string | yes | - | - | {"minLength":1} |
| scope.project | string | yes | - | - | {"minLength":1} |
| scope.session | string | yes | - | - | {"minLength":1} |
| scope.host | object | no | - | - | - |
| scope.host.observeSessionUuid | string | no | - | - | {"format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}&#124;00000000-0000-0000-0000-000000000000&#124;ffffffff-ffff-ffff-ffff-ffffffffffff)$"} |
| scope.host.agentId | string | no | - | - | - |
| scope.host.sessionKey | string | no | - | - | - |
| scope.host.sessionId | string | no | - | - | - |
| scope.host.sessionTimezone | string | no | - | - | - |
| scope.host.workspace | string | no | - | - | - |
| scope.host.sessionFile | string | no | - | - | - |
| scope.host.boundary | string | no | ["new","reset","session-end"] | - | - |
| scope.host.at | number | no | - | - | {"minimum":0} |
| scope.host.systemCaller | boolean | no | - | - | - |

### Response body

HTTP 200, JSON. The complete successful body is below. The schema also permits the same payload with `degraded:true` and a required closed `reason`; it forbids a reason on success. HTTP exception bodies are smaller and described next.

<!-- table:response:mutate -->
| Field | Type | Required | Enum | Default | Constraints |
| --- | --- | --- | --- | --- | --- |
| $ | object | yes | - | - | {"additionalProperties":false} |
| result | object | yes | - | - | {"additionalProperties":false} |
| result.isError | boolean | no | - | - | - |
| result.content | array | yes | - | - | - |
| result.content[] | object | yes | - | - | {"additionalProperties":false} |
| result.content[].type | string | yes | ["text"] | - | - |
| result.content[].text | string | yes | - | - | - |
| result.details | object | yes | - | - | {"propertyNames":{"type":"string"}} |
| result.details{} | JSON | yes | - | - | - |
| degraded | boolean | yes | [false] | - | - |

### Errors

Each mapped exception has exactly `{"degraded":true,"reason":"<reason>"}` and the status below.
This is the complete shared mapping, not a claim that every reason is emitted by this route:
principal/store mismatch reasons remain declared but are not admission checks; unreachable/
unresponsive normally describe client connection failures. See the general error semantics.

<!-- table:errors:mutate -->
| Reason | HTTP status |
| --- | --- |
| sidecar-unreachable | 503 |
| sidecar-unresponsive | 503 |
| principal-mismatch | 403 |
| store-mismatch | 409 |
| no-agent-endpoint | 503 |
| invalid-input | 400 |
| timeout | 504 |
| storage-unavailable | 503 |
| engine-failed | 500 |

Additional transport errors: 413 `{"error":"payload_too_large"}` for a body over
8 MiB; wrong method or unmatched path returns 404 `{"error":"not_found"}`.
504 is the mapped `timeout` response, not a commit or cancellation guarantee.
An outer-server failure can return 500 `{"error":"internal_error"}`.

### Complete request and response example

```http
POST /v1/mutate HTTP/1.1
Host: 127.0.0.1:43127
Content-Type: application/json
x-sno-station-mem-skin: codex
```

<!-- example:mutate:request -->
```json
{
  "op": {
    "op": "store",
    "content": "The release review is on Friday.",
    "category": "episodic",
    "importance": 0.7
  },
  "scope": {
    "principal": "lh",
    "project": "release-notes",
    "session": "session-2026-09-17"
  }
}
```

Response status: `200 OK`; `Content-Type: application/json`.

<!-- example:mutate:response -->
```json
{
  "degraded": false,
  "result": {
    "isError": false,
    "content": [
      {
        "type": "text",
        "text": "mem-release-review"
      }
    ],
    "details": {
      "id": "mem-release-review",
      "scope": "release-notes",
      "category": "episodic"
    }
  }
}
```

## inspect

### Method, path and headers

`POST /v1/inspect`. Deadline: 30000 ms.

| Header | Required | If omitted or blank |
| --- | --- | --- |
| Content-Type: application/json | Recommended, not enforced | Server still parses the body as JSON |
| x-sno-station-mem-skin | Optional | Missing/blank uses `default` (proved by: `tests/packages/memory/integration/sidecar-no-gates.test.ts` — `selects the default skin for header undefined`; `selects the default skin for header "   "`); a nonblank value is used verbatim |
| x-sidecar-token | Yes | Must equal the `token` in the discovery file; otherwise HTTP 401 with body `{}` |

### Request body

Read-only inspection does not enter the recall cache. Branches: 0 `storage`, 1 `stats`, 2 `list`, 3 `get`, 4 `listReflection`.

`stats.scope`, when present, is nonblank; omission requests principal-wide statistics. `get` requires exactly one nonblank `id` or `path`. `from` and `lines` are positive integers. File paths remain subject to native file boundaries. `storage` needs neither registration nor operator admission; a successful result has `failed:false` and the current vector dimension or null. An actual storage read failure is a request error. List responses include the resolved write `project`, even when no entries exist.

The response `result` branches are storage, stats, list/listReflection, and get. Memory entry metadata is a serialized JSON **string**, while mutation metadata is a JSON object.

Scope requires nonblank `principal`, `project`, `session`. `host.observeSessionUuid`, if supplied, must be a UUID. Host `at` is nonnegative epoch milliseconds. Other host strings may be empty.

<!-- table:request:inspect -->
| Field | Type | Required | Enum | Default | Constraints |
| --- | --- | --- | --- | --- | --- |
| $ | object | yes | - | - | - |
| op | union | yes | - | - | - |
| op<0> | object | yes | - | - | - |
| op<0>.op | string | yes | ["storage"] | - | - |
| op<1> | object | yes | - | - | - |
| op<1>.op | string | yes | ["stats"] | - | - |
| op<1>.scope | string | no | - | - | {"minLength":1} |
| op<2> | object | yes | - | - | - |
| op<2>.op | string | yes | ["list"] | - | - |
| op<2>.category | string | no | ["episodic","profile","persona","lesson","summary","state"] | - | - |
| op<2>.limit | integer | no | - | - | {"minimum":-9007199254740991,"maximum":9007199254740991} |
| op<2>.offset | integer | no | - | - | {"minimum":-9007199254740991,"maximum":9007199254740991} |
| op<2>.importanceMin | number | no | - | - | - |
| op<3> | object | yes | - | - | - |
| op<3>.op | string | yes | ["get"] | - | - |
| op<3>.id | string | no | - | - | {"minLength":1} |
| op<3>.path | string | no | - | - | {"minLength":1} |
| op<3>.from | integer | no | - | - | {"exclusiveMinimum":0,"maximum":9007199254740991} |
| op<3>.lines | integer | no | - | - | {"exclusiveMinimum":0,"maximum":9007199254740991} |
| op<4> | object | yes | - | - | - |
| op<4>.op | string | yes | ["listReflection"] | - | - |
| op<4>.limit | integer | no | - | - | {"minimum":-9007199254740991,"maximum":9007199254740991} |
| op<4>.unresolvedOnly | boolean | no | - | - | - |
| scope | object | yes | - | - | - |
| scope.principal | string | yes | - | - | {"minLength":1} |
| scope.project | string | yes | - | - | {"minLength":1} |
| scope.session | string | yes | - | - | {"minLength":1} |
| scope.host | object | no | - | - | - |
| scope.host.observeSessionUuid | string | no | - | - | {"format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}&#124;00000000-0000-0000-0000-000000000000&#124;ffffffff-ffff-ffff-ffff-ffffffffffff)$"} |
| scope.host.agentId | string | no | - | - | - |
| scope.host.sessionKey | string | no | - | - | - |
| scope.host.sessionId | string | no | - | - | - |
| scope.host.sessionTimezone | string | no | - | - | - |
| scope.host.workspace | string | no | - | - | - |
| scope.host.sessionFile | string | no | - | - | - |
| scope.host.boundary | string | no | ["new","reset","session-end"] | - | - |
| scope.host.at | number | no | - | - | {"minimum":0} |
| scope.host.systemCaller | boolean | no | - | - | - |

### Response body

HTTP 200, JSON. The complete successful body is below. The schema also permits the same payload with `degraded:true` and a required closed `reason`; it forbids a reason on success. HTTP exception bodies are smaller and described next.

<!-- table:response:inspect -->
| Field | Type | Required | Enum | Default | Constraints |
| --- | --- | --- | --- | --- | --- |
| $ | object | yes | - | - | {"additionalProperties":false} |
| result | union | yes | - | - | - |
| result<0> | object | yes | - | - | {"additionalProperties":false} |
| result<0>.op | string | yes | ["storage"] | - | - |
| result<0>.dimension | union | yes | - | - | - |
| result<0>.dimension<0> | integer | yes | - | - | {"exclusiveMinimum":0,"maximum":9007199254740991} |
| result<0>.dimension<1> | null | yes | - | - | - |
| result<0>.failed | boolean | yes | - | - | - |
| result<0>.reason | string | no | - | - | - |
| result<1> | object | yes | - | - | {"additionalProperties":false} |
| result<1>.op | string | yes | ["stats"] | - | - |
| result<1>.total | integer | yes | - | - | {"minimum":0,"maximum":9007199254740991} |
| result<1>.projectBreakdown | object | yes | - | - | {"propertyNames":{"type":"string"}} |
| result<1>.projectBreakdown{} | integer | yes | - | - | {"minimum":0,"maximum":9007199254740991} |
| result<1>.categoryBreakdown | object | yes | - | - | {"propertyNames":{"type":"string"}} |
| result<1>.categoryBreakdown{} | integer | yes | - | - | {"minimum":0,"maximum":9007199254740991} |
| result<2> | object | yes | - | - | {"additionalProperties":false} |
| result<2>.op | string | yes | ["list","listReflection"] | - | - |
| result<2>.project | string | yes | - | - | {"minLength":1} |
| result<2>.entries | array | yes | - | - | - |
| result<2>.entries[] | object | yes | - | - | {"additionalProperties":false} |
| result<2>.entries[].id | string | yes | - | - | {"minLength":1} |
| result<2>.entries[].factId | string | no | - | - | - |
| result<2>.entries[].text | string | yes | - | - | - |
| result<2>.entries[].category | string | yes | ["episodic","profile","persona","lesson","summary","state"] | - | - |
| result<2>.entries[].projectId | string | yes | - | - | - |
| result<2>.entries[].importance | number | yes | - | - | - |
| result<2>.entries[].timestamp | number | yes | - | - | - |
| result<2>.entries[].timezone | string | yes | - | - | - |
| result<2>.entries[].metadata | string | yes | - | - | - |
| result<2>.entries[].contentHash | string | yes | - | - | - |
| result<2>.entries[].lane | string | yes | ["active","parked","quarantined"] | - | - |
| result<2>.entries[].rawCandidateJson | string | no | - | - | - |
| result<2>.entries[].dispositionReason | string | no | - | - | - |
| result<2>.entries[].dispositionedAt | number | no | - | - | - |
| result<3> | object | yes | - | - | {"additionalProperties":false} |
| result<3>.op | string | yes | ["get"] | - | - |
| result<3>.entry | union | yes | - | - | - |
| result<3>.entry<0> | object | yes | - | - | {"additionalProperties":false} |
| result<3>.entry<0>.id | string | yes | - | - | {"minLength":1} |
| result<3>.entry<0>.factId | string | no | - | - | - |
| result<3>.entry<0>.text | string | yes | - | - | - |
| result<3>.entry<0>.category | string | yes | ["episodic","profile","persona","lesson","summary","state"] | - | - |
| result<3>.entry<0>.projectId | string | yes | - | - | - |
| result<3>.entry<0>.importance | number | yes | - | - | - |
| result<3>.entry<0>.timestamp | number | yes | - | - | - |
| result<3>.entry<0>.timezone | string | yes | - | - | - |
| result<3>.entry<0>.metadata | string | yes | - | - | - |
| result<3>.entry<0>.contentHash | string | yes | - | - | - |
| result<3>.entry<0>.lane | string | yes | ["active","parked","quarantined"] | - | - |
| result<3>.entry<0>.rawCandidateJson | string | no | - | - | - |
| result<3>.entry<0>.dispositionReason | string | no | - | - | - |
| result<3>.entry<0>.dispositionedAt | number | no | - | - | - |
| result<3>.entry<1> | null | yes | - | - | - |
| result<3>.file | object | no | - | - | {"additionalProperties":false} |
| result<3>.file.text | string | yes | - | - | - |
| result<3>.file.path | string | yes | - | - | - |
| result<3>.file.truncated | boolean | no | - | - | - |
| result<3>.file.from | integer | no | - | - | {"minimum":-9007199254740991,"maximum":9007199254740991} |
| result<3>.file.lines | integer | no | - | - | {"minimum":-9007199254740991,"maximum":9007199254740991} |
| result<3>.file.nextFrom | integer | no | - | - | {"minimum":-9007199254740991,"maximum":9007199254740991} |
| degraded | boolean | yes | [false] | - | - |

### Errors

Each mapped exception has exactly `{"degraded":true,"reason":"<reason>"}` and the status below.
This is the complete shared mapping, not a claim that every reason is emitted by this route:
principal/store mismatch reasons remain declared but are not admission checks; unreachable/
unresponsive normally describe client connection failures. See the general error semantics.

<!-- table:errors:inspect -->
| Reason | HTTP status |
| --- | --- |
| sidecar-unreachable | 503 |
| sidecar-unresponsive | 503 |
| principal-mismatch | 403 |
| store-mismatch | 409 |
| no-agent-endpoint | 503 |
| invalid-input | 400 |
| timeout | 504 |
| storage-unavailable | 503 |
| engine-failed | 500 |

Additional transport errors: 413 `{"error":"payload_too_large"}` for a body over
8 MiB; wrong method or unmatched path returns 404 `{"error":"not_found"}`.
504 is the mapped `timeout` response, not a commit or cancellation guarantee.
An outer-server failure can return 500 `{"error":"internal_error"}`.

### Complete request and response example

```http
POST /v1/inspect HTTP/1.1
Host: 127.0.0.1:43127
Content-Type: application/json
x-sno-station-mem-skin: codex
```

<!-- example:inspect:request -->
```json
{
  "op": {
    "op": "list",
    "limit": 10,
    "offset": 0
  },
  "scope": {
    "principal": "lh",
    "project": "release-notes",
    "session": "session-2026-09-17"
  }
}
```

Response status: `200 OK`; `Content-Type: application/json`.

<!-- example:inspect:response -->
```json
{
  "degraded": false,
  "result": {
    "op": "list",
    "project": "release-notes",
    "entries": []
  }
}
```

## recordUsage

### Method, path and headers

`POST /v1/record-usage`. Deadline: 30000 ms.

| Header | Required | If omitted or blank |
| --- | --- | --- |
| Content-Type: application/json | Recommended, not enforced | Server still parses the body as JSON |
| x-sno-station-mem-skin | Optional | Missing/blank uses `default` (proved by: `tests/packages/memory/integration/sidecar-no-gates.test.ts` — `selects the default skin for header undefined`; `selects the default skin for header "   "`); a nonblank value is used verbatim |
| x-sidecar-token | Yes | Must equal the `token` in the discovery file; otherwise HTTP 401 with body `{}` |

### Request body

Records usage of an explicit nonblank `recallId`. Each memory ID and supplied toolName must be nonblank. `at` is a nonnegative finite epoch-millisecond timestamp. `error` and `result` accept arbitrary JSON; supply the original tool event so error-signal handling can distinguish errors from successful result text. `accepted` reports acceptance; it is not an acknowledgement of remote telemetry delivery.

Scope requires nonblank `principal`, `project`, `session`. `host.observeSessionUuid`, if supplied, must be a UUID. Host `at` is nonnegative epoch milliseconds. Other host strings may be empty.

<!-- table:request:recordUsage -->
| Field | Type | Required | Enum | Default | Constraints |
| --- | --- | --- | --- | --- | --- |
| $ | object | yes | - | - | - |
| recallId | string | yes | - | - | {"minLength":1} |
| signal | object | yes | - | - | - |
| signal.event | string | yes | ["inject","used","rejected","tool-error"] | - | - |
| signal.memoryIds | array | yes | - | - | - |
| signal.memoryIds[] | string | yes | - | - | {"minLength":1} |
| signal.toolName | string | no | - | - | {"minLength":1} |
| signal.text | string | no | - | - | - |
| signal.error | JSON | no | - | - | - |
| signal.result | JSON | no | - | - | - |
| signal.at | number | yes | - | - | {"minimum":0} |
| scope | object | yes | - | - | - |
| scope.principal | string | yes | - | - | {"minLength":1} |
| scope.project | string | yes | - | - | {"minLength":1} |
| scope.session | string | yes | - | - | {"minLength":1} |
| scope.host | object | no | - | - | - |
| scope.host.observeSessionUuid | string | no | - | - | {"format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}&#124;00000000-0000-0000-0000-000000000000&#124;ffffffff-ffff-ffff-ffff-ffffffffffff)$"} |
| scope.host.agentId | string | no | - | - | - |
| scope.host.sessionKey | string | no | - | - | - |
| scope.host.sessionId | string | no | - | - | - |
| scope.host.sessionTimezone | string | no | - | - | - |
| scope.host.workspace | string | no | - | - | - |
| scope.host.sessionFile | string | no | - | - | - |
| scope.host.boundary | string | no | ["new","reset","session-end"] | - | - |
| scope.host.at | number | no | - | - | {"minimum":0} |
| scope.host.systemCaller | boolean | no | - | - | - |

### Response body

HTTP 200, JSON. The complete successful body is below. The schema also permits the same payload with `degraded:true` and a required closed `reason`; it forbids a reason on success. HTTP exception bodies are smaller and described next.

<!-- table:response:recordUsage -->
| Field | Type | Required | Enum | Default | Constraints |
| --- | --- | --- | --- | --- | --- |
| $ | object | yes | - | - | {"additionalProperties":false} |
| accepted | boolean | yes | - | - | - |
| degraded | boolean | yes | [false] | - | - |

### Errors

Each mapped exception has exactly `{"degraded":true,"reason":"<reason>"}` and the status below.
This is the complete shared mapping, not a claim that every reason is emitted by this route:
principal/store mismatch reasons remain declared but are not admission checks; unreachable/
unresponsive normally describe client connection failures. See the general error semantics.

<!-- table:errors:recordUsage -->
| Reason | HTTP status |
| --- | --- |
| sidecar-unreachable | 503 |
| sidecar-unresponsive | 503 |
| principal-mismatch | 403 |
| store-mismatch | 409 |
| no-agent-endpoint | 503 |
| invalid-input | 400 |
| timeout | 504 |
| storage-unavailable | 503 |
| engine-failed | 500 |

Additional transport errors: 413 `{"error":"payload_too_large"}` for a body over
8 MiB; wrong method or unmatched path returns 404 `{"error":"not_found"}`.
504 is the mapped `timeout` response, not a commit or cancellation guarantee.
An outer-server failure can return 500 `{"error":"internal_error"}`.

### Complete request and response example

```http
POST /v1/record-usage HTTP/1.1
Host: 127.0.0.1:43127
Content-Type: application/json
x-sno-station-mem-skin: codex
```

<!-- example:recordUsage:request -->
```json
{
  "recallId": "recall-2026-09-17-001",
  "signal": {
    "event": "inject",
    "memoryIds": [
      "mem-release-review"
    ],
    "at": 1789660800000
  },
  "scope": {
    "principal": "lh",
    "project": "release-notes",
    "session": "session-2026-09-17"
  }
}
```

Response status: `200 OK`; `Content-Type: application/json`.

<!-- example:recordUsage:response -->
```json
{
  "degraded": false,
  "accepted": true
}
```

## onSessionEnd

### Method, path and headers

`POST /v1/on-session-end`. Deadline: 900000 ms.

| Header | Required | If omitted or blank |
| --- | --- | --- |
| Content-Type: application/json | Recommended, not enforced | Server still parses the body as JSON |
| x-sno-station-mem-skin | Optional | Missing/blank uses `default` (proved by: `tests/packages/memory/integration/sidecar-no-gates.test.ts` — `selects the default skin for header undefined`; `selects the default skin for header "   "`); a nonblank value is used verbatim |
| x-sidecar-token | Yes | Must equal the `token` in the discovery file; otherwise HTTP 401 with body `{}` |

### Request body

Runs session-end work using the message schema shared with capture. Host cleanup must not repeat capture. Optional `scope.host.boundary` carries new/reset/session-end; no boundary default is assigned by the input schema. `completed` reports completed session-end handling.

Scope requires nonblank `principal`, `project`, `session`. `host.observeSessionUuid`, if supplied, must be a UUID. Host `at` is nonnegative epoch milliseconds. Other host strings may be empty.

<!-- table:request:onSessionEnd -->
| Field | Type | Required | Enum | Default | Constraints |
| --- | --- | --- | --- | --- | --- |
| $ | object | yes | - | - | - |
| messages | array | yes | - | - | - |
| messages[] | object | yes | - | - | - |
| messages[].role | string | yes | ["system","developer","user","assistant","tool"] | - | - |
| messages[].content | JSON | yes | - | - | - |
| messages[].at | number | yes | - | - | {"minimum":0} |
| scope | object | yes | - | - | - |
| scope.principal | string | yes | - | - | {"minLength":1} |
| scope.project | string | yes | - | - | {"minLength":1} |
| scope.session | string | yes | - | - | {"minLength":1} |
| scope.host | object | no | - | - | - |
| scope.host.observeSessionUuid | string | no | - | - | {"format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}&#124;00000000-0000-0000-0000-000000000000&#124;ffffffff-ffff-ffff-ffff-ffffffffffff)$"} |
| scope.host.agentId | string | no | - | - | - |
| scope.host.sessionKey | string | no | - | - | - |
| scope.host.sessionId | string | no | - | - | - |
| scope.host.sessionTimezone | string | no | - | - | - |
| scope.host.workspace | string | no | - | - | - |
| scope.host.sessionFile | string | no | - | - | - |
| scope.host.boundary | string | no | ["new","reset","session-end"] | - | - |
| scope.host.at | number | no | - | - | {"minimum":0} |
| scope.host.systemCaller | boolean | no | - | - | - |

### Response body

HTTP 200, JSON. The complete successful body is below. The schema also permits the same payload with `degraded:true` and a required closed `reason`; it forbids a reason on success. HTTP exception bodies are smaller and described next.

<!-- table:response:onSessionEnd -->
| Field | Type | Required | Enum | Default | Constraints |
| --- | --- | --- | --- | --- | --- |
| $ | object | yes | - | - | {"additionalProperties":false} |
| completed | boolean | yes | - | - | - |
| degraded | boolean | yes | [false] | - | - |

### Errors

Each mapped exception has exactly `{"degraded":true,"reason":"<reason>"}` and the status below.
This is the complete shared mapping, not a claim that every reason is emitted by this route:
principal/store mismatch reasons remain declared but are not admission checks; unreachable/
unresponsive normally describe client connection failures. See the general error semantics.

<!-- table:errors:onSessionEnd -->
| Reason | HTTP status |
| --- | --- |
| sidecar-unreachable | 503 |
| sidecar-unresponsive | 503 |
| principal-mismatch | 403 |
| store-mismatch | 409 |
| no-agent-endpoint | 503 |
| invalid-input | 400 |
| timeout | 504 |
| storage-unavailable | 503 |
| engine-failed | 500 |

Additional transport errors: 413 `{"error":"payload_too_large"}` for a body over
8 MiB; wrong method or unmatched path returns 404 `{"error":"not_found"}`.
504 is the mapped `timeout` response, not a commit or cancellation guarantee.
An outer-server failure can return 500 `{"error":"internal_error"}`.

### Complete request and response example

```http
POST /v1/on-session-end HTTP/1.1
Host: 127.0.0.1:43127
Content-Type: application/json
x-sno-station-mem-skin: codex
```

<!-- example:onSessionEnd:request -->
```json
{
  "messages": [
    {
      "role": "user",
      "content": "The release review is on Friday.",
      "at": 1789660800000
    }
  ],
  "scope": {
    "principal": "lh",
    "project": "release-notes",
    "session": "session-2026-09-17"
  }
}
```

Response status: `200 OK`; `Content-Type: application/json`.

<!-- example:onSessionEnd:response -->
```json
{
  "degraded": false,
  "completed": true
}
```

## staticBlock

### Method, path and headers

`POST /v1/static-block`. Deadline: 30000 ms.

| Header | Required | If omitted or blank |
| --- | --- | --- |
| Content-Type: application/json | Recommended, not enforced | Server still parses the body as JSON |
| x-sno-station-mem-skin | Optional | Missing/blank uses `default` (proved by: `tests/packages/memory/integration/sidecar-no-gates.test.ts` — `selects the default skin for header undefined`; `selects the default skin for header "   "`); a nonblank value is used verbatim |
| x-sidecar-token | Yes | Must equal the `token` in the discovery file; otherwise HTTP 401 with body `{}` |

### Request body

Returns the current static context text for the selected skin and scope. An empty string is a valid successful response. There are no body fields beyond scope.

Scope requires nonblank `principal`, `project`, `session`. `host.observeSessionUuid`, if supplied, must be a UUID. Host `at` is nonnegative epoch milliseconds. Other host strings may be empty.

<!-- table:request:staticBlock -->
| Field | Type | Required | Enum | Default | Constraints |
| --- | --- | --- | --- | --- | --- |
| $ | object | yes | - | - | - |
| scope | object | yes | - | - | - |
| scope.principal | string | yes | - | - | {"minLength":1} |
| scope.project | string | yes | - | - | {"minLength":1} |
| scope.session | string | yes | - | - | {"minLength":1} |
| scope.host | object | no | - | - | - |
| scope.host.observeSessionUuid | string | no | - | - | {"format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}&#124;00000000-0000-0000-0000-000000000000&#124;ffffffff-ffff-ffff-ffff-ffffffffffff)$"} |
| scope.host.agentId | string | no | - | - | - |
| scope.host.sessionKey | string | no | - | - | - |
| scope.host.sessionId | string | no | - | - | - |
| scope.host.sessionTimezone | string | no | - | - | - |
| scope.host.workspace | string | no | - | - | - |
| scope.host.sessionFile | string | no | - | - | - |
| scope.host.boundary | string | no | ["new","reset","session-end"] | - | - |
| scope.host.at | number | no | - | - | {"minimum":0} |
| scope.host.systemCaller | boolean | no | - | - | - |

### Response body

HTTP 200, JSON. The complete successful body is below. The schema also permits the same payload with `degraded:true` and a required closed `reason`; it forbids a reason on success. HTTP exception bodies are smaller and described next.

<!-- table:response:staticBlock -->
| Field | Type | Required | Enum | Default | Constraints |
| --- | --- | --- | --- | --- | --- |
| $ | object | yes | - | - | {"additionalProperties":false} |
| contextText | string | yes | - | - | - |
| degraded | boolean | yes | [false] | - | - |

### Errors

Each mapped exception has exactly `{"degraded":true,"reason":"<reason>"}` and the status below.
This is the complete shared mapping, not a claim that every reason is emitted by this route:
principal/store mismatch reasons remain declared but are not admission checks; unreachable/
unresponsive normally describe client connection failures. See the general error semantics.

<!-- table:errors:staticBlock -->
| Reason | HTTP status |
| --- | --- |
| sidecar-unreachable | 503 |
| sidecar-unresponsive | 503 |
| principal-mismatch | 403 |
| store-mismatch | 409 |
| no-agent-endpoint | 503 |
| invalid-input | 400 |
| timeout | 504 |
| storage-unavailable | 503 |
| engine-failed | 500 |

Additional transport errors: 413 `{"error":"payload_too_large"}` for a body over
8 MiB; wrong method or unmatched path returns 404 `{"error":"not_found"}`.
504 is the mapped `timeout` response, not a commit or cancellation guarantee.
An outer-server failure can return 500 `{"error":"internal_error"}`.

### Complete request and response example

```http
POST /v1/static-block HTTP/1.1
Host: 127.0.0.1:43127
Content-Type: application/json
x-sno-station-mem-skin: codex
```

<!-- example:staticBlock:request -->
```json
{
  "scope": {
    "principal": "lh",
    "project": "release-notes",
    "session": "session-2026-09-17"
  }
}
```

Response status: `200 OK`; `Content-Type: application/json`.

<!-- example:staticBlock:response -->
```json
{
  "degraded": false,
  "contextText": ""
}
```

## POST /rem/run

### Method, path and headers

`POST /rem/run`. The server has no explicit REM route deadline. A client's own timeout
is separate; the server may still accept or run the job after that client disconnects.

| Header | Required | If omitted or blank |
| --- | --- | --- |
| Content-Type: application/json | Recommended, not enforced | Body is still parsed as JSON |
| x-rem-correlation-id | Optional | Generates `rem-corr-<UUID>`; supplied strings are trimmed |
| x-sidecar-token | Yes | Must equal the `token` in the discovery file; otherwise HTTP 401 with body `{}` |
| x-sno-station-mem-skin | No | Not used on REM routes |

### Request body

Choose exactly one strict object variant. Unknown keys are rejected. There is no default
scope or operation set. A mixed list with **any** unsupported type fails as a whole before
job allocation. Built operation names are `rem-replace` and `rem-update`.

| Variant | Field | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- | --- |
| Single | type | string | yes | none | Nonempty and one of the built names |
| Single | scope | string | yes | none | Trimmed; nonblank |
| Multiple | types | string[] | yes | none | At least one; each nonempty and built |
| Multiple | scope | string | yes | none | Trimmed; nonblank |

Do not send both `type` and `types`. Duplicates are canonicalized. Requests sharing
correlation ID and scope merge operations while the job is queued. A later request after
that job starts can create another job; correlation ID is not permanent idempotency.
Single-type requests schedule execution after 100 ms; `types` requests after 0 ms.

### Response body

HTTP 202, JSON. Completion is asynchronous; poll the job route.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| job_id | string | yes | Job lookup identifier, `rem-wave-<UUID>` |
| waveId | string | yes | Same identifier as job_id |

### Errors

These bodies use `error`, not `degraded` or `reason`. The unsupported-type body additionally contains required `unknownTypes:string[]`, in request order (duplicates retained); it lists the submitted unknown or unbuilt names.

| HTTP status | Body | When |
| --- | --- | --- |
| 400 | {"error":"invalid_request"} | Invalid JSON, shape, blank scope, empty type list or unknown keys |
| 400 | {"error":"unsupported_rem_type","unknownTypes":["<unsupported type>"]} | Any requested operation is unknown or unbuilt; none allocated |
| 413 | {"error":"payload_too_large"} | Streamed body exceeds 8 MiB; none allocated |
| 409 | {"error":"wave_closed"} | Server catch branch if allocation throws wave_closed; current allocator has no such throw |
| 500 | {"error":"internal_error"} | Unhandled server/allocation failure |
| 404 | {"error":"not_found"} | Wrong method or unmatched path |

There is no server-generated 504 REM deadline branch. Later execution failure is a job
record with `state:"failed"` and an optional error string, retrieved with HTTP 200.

### Complete request and response example

```http
POST /rem/run HTTP/1.1
Host: 127.0.0.1:43127
Content-Type: application/json
x-rem-correlation-id: release-maintenance-2026-09-17

{"types":["rem-replace","rem-update"],"scope":"release-notes"}
```

```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{"job_id":"rem-wave-6b201063-a847-4ee4-8a18-636af16b2bf1","waveId":"rem-wave-6b201063-a847-4ee4-8a18-636af16b2bf1"}
```

## GET /rem/jobs/<id>

### Method, path and headers

`GET /rem/jobs/<id>`. Replace `<id>` with the exact job_id. The `x-sidecar-token` header is required; no skin
header is required. Optional `x-rem-correlation-id` affects the request log; when absent,
the job's stored correlation ID is used. It does not replace the ID in the response.
No explicit server route deadline is configured.

### Request body

None. The path suffix is used literally for lookup; an absent/unknown suffix returns 404.

### Response body

HTTP 200 returns the job itself, without a `degraded` envelope. All fields below are wire
fields from `toRemJob` and the validated stats schema in `rem-job-store.ts`.

| Field | Type | Required | Meaning / constraints |
| --- | --- | --- | --- |
| job_id | string | yes | Wave identifier |
| state | string | yes | queued, running, done, failed |
| type | string | yes | First operation in canonical order; inspect requested_operations for all operations |
| scope | string | yes | Submitted trimmed scope |
| started_at | string or null | yes | ISO timestamp after execution begins |
| finished_at | string or null | yes | ISO timestamp at terminal transition |
| correlation_id | string | yes | Submitted trimmed ID or generated ID |
| requested_operations | string[] | yes | Unique operations in canonical execution order |
| error | string | no | Nonempty failure message, not a closed reason enum |
| stats | object | yes | Initially {"operations":0}; fields below |
| stats.operations | integer | yes | Nonnegative applied operation count |
| stats.applied_count | integer | no | Nonnegative applied count |
| stats.actionable_candidate_count | integer | no | Nonnegative actionable count |
| stats.applied_fraction | number or null | no | Fraction in [0,1], or null |
| stats.scan | object | no | Scan summary |
| stats.scan.scope | string | yes in scan | Nonempty scope |
| stats.scan.candidate_count | integer | yes in scan | Nonnegative count |
| stats.scan.stamped_skipped_count | integer | no | Nonnegative count |
| stats.scan.actionable_candidate_count | integer | no | Nonnegative count |
| stats.parse_failure_count | integer | no | Nonnegative count |
| stats.top_refusal_reasons | string[] | no | At most two nonempty strings |
| stats.measured | object | no | Measurements below |
| stats.measured.rows_considered | integer | yes in measured | Nonnegative count |
| stats.measured.pairs_built | integer | no | Nonnegative count |
| stats.measured.pair_cap_binding | boolean | no | Pair cap reached |
| stats.measured.model_calls | integer | yes in measured | Nonnegative count |
| stats.measured.model_tokens | integer | yes in measured | Nonnegative count |
| stats.measured.wall_ms | integer | yes in measured | Nonnegative elapsed milliseconds |
| stats.by_operation | object[] | no | At least one per-operation result when present |
| stats.by_operation[].operation | string | yes | Nonempty operation name |
| stats.by_operation[].applied_count | integer | yes | Nonnegative count |
| stats.by_operation[].actionable_candidate_count | integer | yes | Nonnegative count |
| stats.by_operation[].candidate_count | integer | yes | Nonnegative count |
| stats.by_operation[].parse_failure_count | integer | yes | Nonnegative count |
| stats.by_operation[].top_refusal_reasons | string[] | yes | At most two nonempty strings |
| stats.by_operation[].measured | object | yes | Same fields and required-ness as stats.measured |

### Errors

| HTTP status | Body | When |
| --- | --- | --- |
| 404 | {"error":"job_not_found"} | Unknown job ID, including an empty suffix |
| 404 | {"error":"not_found"} | Wrong method or unmatched route |
| 500 | {"error":"internal_error"} | Unhandled request/store failure |

No body reader runs here, so there is no application 413 response for this GET route.
No explicit application 504 deadline is installed.

### Complete request and response example

```http
GET /rem/jobs/rem-wave-6b201063-a847-4ee4-8a18-636af16b2bf1 HTTP/1.1
Host: 127.0.0.1:43127
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"job_id":"rem-wave-6b201063-a847-4ee4-8a18-636af16b2bf1","state":"queued","type":"rem-replace","scope":"release-notes","started_at":null,"finished_at":null,"stats":{"operations":0},"correlation_id":"release-maintenance-2026-09-17","requested_operations":["rem-replace","rem-update"]}
```

## Transport and discovery

The server binds an ephemeral TCP port on **127.0.0.1**, without TLS or bearer-token admission.
Read `<profile root>/station/sidecar.json` for discovery; do not hardcode a port. It is written atomically with file mode 0600.

| Discovery field | Type and constraints | Meaning now that authentication is absent |
| --- | --- | --- |
| pid | positive integer | OS process ID; useful for detecting a restarted process |
| port | integer 1–65535 | Loopback HTTP port |
| token | 64 lowercase hexadecimal characters | Random ownership marker used to remove only this process's discovery file on exit; not an access credential |

The discovery reader still validates all three fields and rejects unknown fields. A missing
file returns no discovery; malformed or unreadable discovery raises `sidecar-unreachable`.
The health probe still sends `Authorization: Bearer <token>`, but the server does not check it.
It verifies only a successful HTTP status and body `status:"ok"`, not store/principal equality.
Health probe timeout is 5000 ms; startup budget is 30000 ms. These are client limits.
The client spawns a sidecar only when discovery is absent or its pid is dead. A discovery
record with a live pid is waited for, never duplicated: startup retries `checkDiscovery`
every 250 ms within `MEMORY_START_TIMEOUT_MS`, returning the same discovery on success or
raising `sidecar-unresponsive` when the budget expires. The client rereads discovery on calls.
Its HTTP transport uses the per-route deadline, avoiding an implicit 300-second fetch cutoff.

## Starting the sidecar

Source: [client.ts](client.ts), [start.ts](start.ts), [profile.ts](profile.ts).
`connect()` reads `<state dir>/settings.json` and takes the child process executable
and package directory from `memoryPackage.node` and `memoryPackage.path`. A missing or
invalid settings file returns a degraded connection with reason `storage-unavailable`
and `settings unavailable: <path>: <field>; see https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md` in its error text.

When discovery names a live process, the client probes its health for up to 30000 ms.
Without live discovery, it spawns `<memoryPackage.path>/dist/sidecar/main.js` using
`memoryPackage.node`, then waits up to 30000 ms for live discovery. Child output goes
to `<state dir>/sno-station-mem/sidecar-startup.log`. The service reads its routing and
store path from the same installed settings when the memory pool opens.

## Outbound call: the sidecar calling the registered host model

Source: [../model/registered-agent-port.ts](../model/registered-agent-port.ts). This is the
only HTTP request the sidecar makes back toward the client. It is used for every occasion that
routes to the `agent` tier (see `init` → `registration.model`). A client that registers a model
must serve exactly this shape.

Request:

```
POST <registration.model.baseUrl>/chat/completions
Authorization: Bearer <registration.model.credential>
content-type: application/json
```

If `baseUrl` already ends in `/chat/completions` it is used as is; otherwise one trailing slash
is stripped and `/chat/completions` appended. The capture request sends POST, the registered bearer credential, `stream: false`, and system/user messages with nonempty string content (proved by: `tests/packages/memory/integration/sidecar-no-gates.test.ts` — `sends the host model HTTP contract and relays error`; `sends the host model HTTP contract and relays cancelled`). Body:

```json
{
  "model": "<registration.model.model>",
  "stream": false,
  "messages": [
    { "role": "system", "content": "<system prompt, only when the occasion has one>" },
    { "role": "user", "content": "<prompt>" }
  ],
  "max_tokens": 512,
  "chat_template_kwargs": { "enable_thinking": false }
}
```

`max_tokens` and `chat_template_kwargs` are present only when the occasion sets them. The
request carries an abort deadline of 120000 ms (`CALLBACK_TIMEOUT_MS`) unless the occasion
supplies a shorter one; the sidecar's own route deadline may cut it earlier.

Expected success response: HTTP 2xx with an OpenAI-style body; the sidecar reads
`choices[0].message.content` and requires it to be a string. Anything else on a 2xx is treated
as `registered model response is invalid` and the call is recorded as `engine-failed`.

Expected failure response: a non-2xx status. The body may relay a typed failure so the sidecar
can classify it instead of guessing from the status code:

```json
{ "error": { "kind": "cancelled", "reason": "<text>" } }
{ "error": { "kind": "error", "category": "<auth|credential-expired|credential-revoked|exhausted|throttle|transport|unknown>", "message": "<text>" } }
```

Classification into the degraded reasons the memory routes report:

| Host reply | Degraded reason recorded |
| --- | --- |
| `kind: "cancelled"` | `timeout` |
| `kind: "error"` with a terminal category (`auth`, `credential-expired`, `credential-revoked`, `exhausted`) | `no-agent-endpoint` |
| `kind: "error"` with a non-terminal category | `engine-failed` |
| non-2xx without a relayed body, status classified as endpoint refusal | `no-agent-endpoint` |
| non-2xx without a relayed body, other status | `engine-failed` |
| network error or the 120000 ms deadline | `engine-failed` / `timeout` |
| `registration.model` absent for agent-native capture | `no-agent-endpoint` (HTTP 503; proved by: `tests/packages/memory/integration/sidecar-no-gates.test.ts` — `returns a degraded reason when the agent model endpoint is absent`) |

For an agent-native capture, a host HTTP 503 with `{"error":{"kind":"error","category":"exhausted","message":"x"}}` produces HTTP 503 and `{"degraded":true,"reason":"no-agent-endpoint"}` (proved by: `tests/packages/memory/integration/sidecar-no-gates.test.ts` — `sends the host model HTTP contract and relays error`). A host HTTP 503 with `{"error":{"kind":"cancelled","reason":"x"}}` produces HTTP 504 and `{"degraded":true,"reason":"timeout"}` (proved by: `tests/packages/memory/integration/sidecar-no-gates.test.ts` — `sends the host model HTTP contract and relays cancelled`). These are mapped HTTP errors, not necessarily HTTP 200 degraded results. The engine can retry or degrade other failures internally; a completed call forcibly surfaces only `no-agent-endpoint`, while a failed call can surface any recorded reason.

## Request handling: no admission gates

The skin header selects the runtime. Missing or whitespace-only header means `default` (proved by: `tests/packages/memory/integration/sidecar-no-gates.test.ts` — `selects the default skin for header undefined`; `selects the default skin for header "   "`).
There is no principal, operator, configured-scope, prior-registration, product-mode,
owner-calibration, grammar-artifact or kill-switch admission gate. The required scope strings
still must parse. The client replaces submitted principal with its OS username. Logical scopes
and explicit readable scopes are served; workspace-based project mapping remains in use.

Missing or invalid installed settings fail the current HTTP request with status 503 and
`{"degraded":true,"error":"settings unavailable: <path>: <field>; see https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md",
"reason":"settings unavailable: <path>: <field>; see https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md"}`. Recoverable database
setup failures, integrity-check failures, discovery publication failure, journal recovery errors,
and trigger-state read/write failures produce logs rather than a persistent denial of later calls.
A failed runtime open is retried on a later request. HTTP startup does not wait for memory
opening or full integrity checks.

Invalid request JSON/schema, oversized input, unknown REM operations, route deadlines,
and actual engine/model/I/O errors affect the current request. A parsed JSON memory request
opens the runtime before `parseInput` checks its shape; schema validation therefore prevents
method invocation but is not a guarantee of zero initialization side effects. Output validation
failures become `engine-failed`. Init and direct storage inspection return through dedicated
paths rather than the pool's usual output-validation call.

Ordinary memory input objects strip unknown keys. Strict nested objects (marked
`additionalProperties:false`) and REM request objects reject them. This is not a blanket rule
that all extra configuration keys are ignored. Output objects are strict.

Request completion logs include method, path, status, duration and available job/correlation IDs.
5xx logs are errors; 4xx completion logs are informational, while their failure paths also log
errors where implemented. A cancelled response is logged as cancelled. Failures do not set a
store latch. A nonempty incompatible vector table is preserved and logged; vector search is
unavailable for that open while keyword/FTS recall can continue. New opens retry reconciliation.
Startup does not run a full integrity sweep. Failed schema setup is retried by maintenance;
failed FTS repair does not stop later SQL or requests. Audit/journal recovery reads JSONL
incrementally and retains usable earlier rows; recovery does not truncate audit history.

## Body size and deadline behavior

Memory POST and REM POST share `readRequestBody`: the maximum is **8388608 bytes (8 MiB)**,
counted from streamed bytes, not characters or Content-Length. Exactly that size is permitted;
exceeding it returns 413 `{"error":"payload_too_large"}` before method/job invocation.
The reader stops retaining chunks, removes its listeners, and drains input without destroying
the response socket. Content-Type is not used as an admission check.

Memory route deadlines cover body reading, opening the runtime and awaiting invocation.
At deadline, a per-request AbortController aborts the body reader and the route returns
504 `{"degraded":true,"reason":"timeout"}`. Abort checks after body reading and runtime
opening prevent a late invocation. The signal enters recall, capture, mutation and session-end
execution. Response close also aborts the request. Capture, mutation and session-end carry
request-local cancellation through nested calls to model/retrieval signals and write checkpoints.
For capture and mutate paused in embedding before the first write, releasing embedding after HTTP 504 leaves zero new memory rows (proved by: `tests/packages/memory/integration/sidecar-no-gates.test.ts` — `retains timed-out capture until the paused write settles before closing storage`; `retains timed-out mutate until the paused write settles before closing storage`). Each SQL write and reflection/learning file write checks cancellation before starting. A started
SQL transaction or file write finishes; a later write is skipped. The terminal error log records
`outcome: "aborted"` and `writes: N`: completed SQL write statements and file writes, excluding
rolled-back statements. This is not a count of memory rows or a rollback of prior commits.
Runtime opening can finish after the deadline. Do not replay a timed-out write blindly; read
durable state first. The actual task stays tracked until invocation and its cleanup settle,
independently of the 504 response. Handler timers and abort/close listeners are removed when
the HTTP handler finishes.
Shutdown waits at most 5000 ms, logs the unfinished phase, task identities and pending requests,
then closes connections and removes its owned discovery record. Store disposal remains deferred
until the real tasks finish, even if `stop()` has returned; a task that never settles retains its
store until process exit. This is not a write rollback guarantee.

REM submission, REM job reads and health have no corresponding application deadline timer.
Node's HTTP transport limits or client cancellation are separate from this API's 504 behavior.
The old `REM_REQUEST_BODY_LIMIT_BYTES` constant (65536) is not used by the active body reader.

## GET /healthz

### Method, path and headers

`GET /healthz`; no required authentication, skin or Content-Type headers. No body is needed.
The discovery client gives this call 5000 ms; that is not a server 504 timer.

### Request body

None. Health opens the memory pool; it does not
wait for embedding model preparation. If settings cannot be read, it returns HTTP 503
with `{"status":"error","error":"settings unavailable: <path>: <field>; see https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md"}`.

### Response body

HTTP 200, JSON.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| status | string | yes | `ok` or `degraded`; Codex and Claude `doctor` intentionally report `degraded` as unhealthy |
| error | string | no | Model preparation error when status is `degraded` |
| log_level | string | yes | Current shared logger level |
| accessCounters | object | yes | In-process counters; both zero before a memory pool opens |
| accessCounters.engineAccesses | number | yes | Engine entry count |
| accessCounters.storeAccesses | number | yes | Store entry count; direct storage inspection increments only this counter |

These are entry counters, not SQL statement counts or end-to-end success counts.

### Errors

Unhandled failures return 500 `{"error":"internal_error"}`; wrong methods/unmatched paths
return 404 `{"error":"not_found"}`. There is no application 413 or 504 branch on this route.

### Complete request and response example

```http
GET /healthz HTTP/1.1
Host: 127.0.0.1:43127
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"status":"ok","log_level":"info","accessCounters":{"engineAccesses":0,"storeAccesses":0}}
```

## General error and client semantics

Clients can distinguish these three observed failure shapes:

- An agent-native capture without a registered model returns HTTP 503 and `{"degraded":true,"reason":"no-agent-endpoint"}` (proved by: `tests/packages/memory/integration/sidecar-no-gates.test.ts` — `returns a degraded reason when the agent model endpoint is absent`).
- Updating a nonexistent memory returns HTTP 200 with `degraded:false`, `result.isError:true`, `result.details:{}`, and `result.content:[{"type":"text","text":"Memory entry not found: missing-memory"}]` for id `missing-memory` (proved by: `tests/packages/memory/integration/sidecar-no-gates.test.ts` — `returns a tool refusal inside HTTP 200`).
- An unknown route returns HTTP 404 with `{"error":"not_found"}` (proved by: `tests/packages/memory/integration/sidecar-no-gates.test.ts` — `returns an HTTP error body for an unknown route`).

Mapped memory-route exceptions use `{"degraded":true,"reason":"<reason>"}`. A settings
error instead uses the HTTP 503 body shown above, with its text in both `error` and
`reason`. The complete mapping of closed reasons is:

Schema-valid degraded results may additionally include `error`, a string containing the actual
cause. The generated response field tables below each route describe only the successful
`degraded:false` branch, so they omit this field. Preparing/failed manual recall and failed
correction preserve their cause through this degraded field and the client error message.

<!-- table:errors -->
| Reason | HTTP status |
| --- | --- |
| sidecar-unreachable | 503 |
| sidecar-unresponsive | 503 |
| principal-mismatch | 403 |
| store-mismatch | 409 |
| no-agent-endpoint | 503 |
| invalid-input | 400 |
| timeout | 504 |
| storage-unavailable | 503 |
| engine-failed | 500 |

`sidecar-unreachable` and `sidecar-unresponsive` normally describe local client/discovery
failures without an HTTP response. The mapping includes `principal-mismatch` and
`store-mismatch`, but current request admission does not enforce those checks. An actual
missing agent endpoint or unavailable storage can still fail an operation. Unexpected
engine exceptions and invalid engine outputs use `engine-failed`. Invalid JSON/input uses
`invalid-input`; an exceeded memory deadline uses `timeout`.

`ContractError` has `name:"ContractError"` and `degraded:true`; its `reason` is the transport
classification, while `message` preserves the service's optional `error` cause when supplied.
The HTTP client converts non-2xx responses with a recognized reason into that error. A body
with only `error` (including 413) currently becomes `engine-failed` in that client.
`init`, `capture`, `mutate`, `recordUsage` and `onSessionEnd` throw on transport failure.
`getRecall`, `inspect` and `staticBlock` return degraded results: recall has empty recallId
and contextText; staticBlock has empty contextText; inspect returns the operation's empty
shape (storage dimension null/failed true, stats zero breakdowns, get entry null, list empty
entries with the supplied project). `connect` returns a degraded connection on failure.
These client-generated objects differ from the server's minimal exception body. Clients
must not turn degraded reads into successful empty answers. No offline store or write queue
is created when the daemon is unavailable.

## State files and environment names

`SNO_PROFILE_DIR` selects the profile root, default `~/.sno`; paths are resolved absolutely.
Principal is the OS username. All paths below are relative to that root unless absolute.

| State file | Purpose |
| --- | --- |
| station/sidecar.json | Shared discovery record described above |
| settings.json | Installed service, model routing, and storage settings |
| sno-station-mem/sidecar-startup.log | Startup output |
| sno-station-mem/rem-wave-jobs.jsonl | Durable REM wave transitions |
| sno-station-mem/rem-chassis-journal.jsonl | Per-operation REM execution records |
| sno-station-mem/rem-trace.jsonl | REM trace output; shared rotating log sink |
| sno-station-mem/audit.jsonl | Runtime audit and completion recovery records |
| sno-station-mem/backups/ | Maintenance backups |

The client reads `settings.json` and starts the service from `settings.memoryPackage.path`
using `settings.memoryPackage.node`. The sidecar reads its routing and store path from the
same installed settings. A supplied client store path does not override the running service.

| Environment | Meaning |
| --- | --- |
| SNO_PROFILE_DIR | Profile root |
| SNO_STATION_MEM_REM_CONFIG_JSON | Operational REM config; absent/invalid parsed config uses built-in defaults with invalid config logged |
| SNO_STATION_MEM_REM_EXPECTED_DB_PATH | Optional REM persona database path passed to the executor |
| SNO_STATION_MEM_REM_TRACE | Trace enabled by default; 0, false, off disable it (case-insensitive) |
| SNO_STATION_MEM_REM_TEST_HOLD_MS | Nonnegative integer execution hold for tests; invalid logs and uses 0 |
| SNO_STATION_MEM_MAINTENANCE_INTERVAL_MS | Positive integer scheduler override described below |
| SNO_STATION_MEM_REM_CLOCK_OVERRIDE | Clock override parsed as Date; use an ISO instant |
| SNO_STATION_MEM_REM_VOLUME_THRESHOLD | Positive integer volume threshold override |
| SNO_STATION_MEM_NODE_ENV | Package test mode; enables observation loopback validation exception |
| `snoGpu.baseUrl` in `settings.json` | Sno GPU transport endpoint setting |

Package-owned environment names use `SNO_STATION_MEM_`; the Sno GPU endpoint and key
come from `settings.json`. Signed preset/secret identifiers
remain centralized in `model/signed-registry-constants.ts`. This table covers sidecar-facing
controls, not every environment variable used by model/provider libraries.

## Maintenance controls

Maintenance starts when the lazy memory pool first opens. Overrides are read then, not
at initial HTTP bind. A valid interval override controls the tick, first tick, and every
maintenance job interval, including backup and REM trigger checks. Without it, normal
scheduler intervals apply. The default volume threshold is 100 rows. Invalid positive
integer overrides log and are ignored. An invalid clock logs and causes the override reader
to return no overrides, including otherwise supplied interval/volume values.

Each scope gets at most one completed automatic REM pass per local day, from either daily
schedule or volume trigger. Completion records that day in `last_volume_pass_date`, closes
the volume trigger and moves the next daily pass. Lost state cannot prove completion, so
due work can run again. Failed dispatch stays eligible beyond the former three-attempt
limit. Installed operations select what runs; old tick-disable and product-mode admission
checks do not block automatic REM. Trigger-state failures log and proceed with fresh state.
Pause/resume commands and kill-switch activation were removed; old kill-switch files have
no runtime effect. Workspace learning tools remain local file operations.

Retrieval settings `temporalWeighting` and `mmrWindowOnly` default to false. The former
controls historical timestamp/access-based recency, decay and retention scoring; without
it those stages skip while explicit validity filters and maintenance remain. The latter
limits MMR diversification to the first request-limit candidates. These are installed settings, not getRecall options. Change them in `settings.json`.

## Verification and source boundaries

Run from `packages/memory`:

```sh
npx vitest run --config vitest.config.ts ../../tests/packages/memory/unit/http-contract-doc-sync.test.ts
```

The test reads this file; it does not update it or mock schemas. Adding/removing a route,
field, nested variant, enum, serialized constraint, default, or mapped reason requires
updating the corresponding table. It also parses the complete JSON examples through the
live schemas. The route-index case also probes every listed path over loopback HTTP. The cited integration tests prove the specific header, pre-init, failure, deadline, CLI and outbound-call claims above. CLI tests execute the existing `dist/cli.js` artifact; the other new HTTP tests execute source. Existing deadline tests pause embedding and forward to the real implementation; new runtime tests do not mock sidecar internals. Other custom refinements, REM/health field tables, maintenance prose and state-file descriptions still need source review.
