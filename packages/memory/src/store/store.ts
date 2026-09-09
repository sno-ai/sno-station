/** @file store.ts
 * @purpose Public MemoryStore entrypoint and side-effect method composition.
 * @boundary Re-export only; implementation lives in focused storage modules.
 */

import "./memory-store-row-codec";
import "./memory-store-backfill";
import "./memory-store-lookup-api";
import "./memory-store-relation-api";
import "./memory-store-atomic-extraction-ledger-api";
import "./memory-store-atomic-extraction-write-api";
import "./memory-store-suppression-api";
import "./memory-store-fact-surface-api";
import "./memory-store-atomic-entity-api";
import "./memory-store-atomic-time-api";
import "./memory-store-unplaced-api";
import "./memory-store-extraction-timestamp-api";
import "./memory-store-task-lifecycle-timestamp-api";
import "./memory-store-task-lifecycle-api";
import "./memory-store-todo-api";
import "./memory-store-task-lifecycle-migration-api";
import "./memory-store-persistence-api";
import "./memory-store-update-api";
import "./memory-store-rem-api";
import "./memory-store-import-api";
import "./memory-store-chunk-search";
import "./memory-store-search-api";
import "./memory-store-vector-api";
import "./memory-store-read-api";
import "./memory-store-admin-api";

export * from "./memory-store-base";
export { buildTaskLifecycleMigrationManifest } from "./memory-store-task-lifecycle-migration-api";
export { normalizeMemoryRelationPredicate } from "./memory-store-relation-api";
export { repairAtomicExtractionParameters } from "./memory-store-atomic-extraction-ledger-api";
export { hashMemorySuppressionContent } from "./memory-store-suppression-api";
export { ATOMIC_FACT_SURFACE_LANE } from "./memory-store-fact-surface-api";
