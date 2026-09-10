# Source Layout

This directory is organized by runtime responsibility. Keep new files inside the
directory that owns the behavior, and update this map when a responsibility moves.

| Directory | Owns | Key Files | Maintenance Notes |
| --- | --- | --- | --- |
| `plugin/` | Host integration, plugin lifecycle, CLI registration, memory tool registration, and user-facing plugin commands. | `sno-station-mem-plugin-runtime.ts`, `memory-tool-registration.ts`, `memory-management-cli.ts`, `sno-station-mem-command-registration.ts` | This is the composition boundary. It may depend on every domain directory, but domain directories should not depend on `plugin/`. |
| `storage/` | SQLite setup, schema, database connection safety, persistence, backup, and storage-path validation. | `store.ts`, `schema.ts`, `connection.ts`, `sqlite-runtime.ts`, `backup.ts` | Keep database shape and storage invariants here so retrieval, extraction, and reflection consume a stable store API. |
| `retrieval/` | Query normalization, intent analysis, memory search, ranking signals, retrieval tracing, and access reinforcement. | `retriever.ts`, `retrieval-gate.ts`, `intent-analyzer.ts`, `access-tracker.ts` | Retrieval should decide what memories are useful for the current turn; it should not perform capture or mutate schema. |
| `extraction/` | Conversation capture, insight distillation, embeddings, chunking, deduplication, noise filtering, metadata, temporal inference, and session compression. | `memory-extraction-pipeline.ts`, `capture-policy-detector.ts`, `embedding-provider-client.ts`, `memory-metadata-codec.ts`, `memory-noise-classifier.ts` | Extraction converts runtime text into clean memory candidates and metadata before storage writes. |
| `reflection/` | Reflection scheduling, reflection item/event storage helpers, reflection metadata, retry policy, cache, ranking, and slice construction. | `daily-log-generator.ts`, `strategy-hook-runner.ts`, `memory-entry-projector.ts`, `derived-line-cache.ts`, `markdown-slice-parser.ts` | Reflection owns higher-order learning loops and should keep its retry/cache behavior explicit because it runs outside the immediate capture path. |
| `operations/` | Operational controls and background maintenance: audit files, cost estimates, decay, tiering, self-improvement files, and session-memory writes. | `runtime-audit-log.ts`, `daily-spend-estimator.ts`, `selective-forgetting-scorer.ts`, `memory-tier-promoter.ts`, `model-pricing-catalog.json` | Put non-interactive maintenance and operator-visible runtime accounting here. Domain modules may call these helpers, but they should remain side-effect-aware. |
| `security/` | Scope isolation, redaction, reflection error-signal hashing, and multi-agent scope helpers. | `scopes.ts`, `redact.ts`, `error-signals.ts`, `multi-agent-scope.ts` | Security helpers must stay small, deterministic, and easy to audit because they protect tenant boundaries and sensitive content. |
| `shared/` | Cross-domain types, errors, general utilities, LRU helpers, and the LLM client facade. | `types.ts`, `errors.ts`, `utils.ts`, `lru.ts`, `llm-client.ts` | Keep this directory low-level. Avoid importing domain directories from `shared/` so dependency direction stays clear. |

## Placement Rules

- Add host-facing setup, registration, or command code to `plugin/`.
- Add persistence, migration, or database-shape code to `storage/`.
- Add query-time search, ranking, tracing, or access-signal code to `retrieval/`.
- Add memory candidate creation, embedding, cleanup, or metadata inference to `extraction/`.
- Add reflection-specific scheduling, storage adapters, ranking, and retry behavior to `reflection/`.
- Add background maintenance, audit/cost accounting, decay, tiering, and local learning files to `operations/`.
- Add tenant isolation, redaction, identity, and sensitive-signal handling to `security/`.
- Add only dependency-light primitives to `shared/`.

## Dependency Direction

`plugin/` composes the system. Domain directories may depend on `shared/`,
`security/`, `storage/`, and selected operational helpers, but should avoid
depending on `plugin/`. When a new dependency crosses domains, prefer a narrow
type or helper export over importing an entire runtime module.
