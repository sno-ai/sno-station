/** @file store.ts
 * @purpose Public MemoryStore entrypoint and side-effect method composition.
 * @boundary Re-export only; implementation lives in focused storage modules.
 */

import "@/storage/memory-store-row-codec";
import "@/storage/memory-store-backfill";
import "@/storage/memory-store-lookup-api";
import "@/storage/memory-store-relation-api";
import "@/storage/memory-store-atomic-extraction-ledger-api";
import "@/storage/memory-store-atomic-extraction-write-api";
import "@/storage/memory-store-suppression-api";
import "@/storage/memory-store-fact-surface-api";
import "@/storage/memory-store-atomic-entity-api";
import "@/storage/memory-store-atomic-time-api";
import "@/storage/memory-store-unplaced-api";
import "@/storage/memory-store-extraction-timestamp-api";
import "@/storage/memory-store-task-lifecycle-timestamp-api";
import "@/storage/memory-store-task-lifecycle-api";
import "@/storage/memory-store-todo-api";
import "@/storage/memory-store-task-lifecycle-migration-api";
import "@/storage/memory-store-persistence-api";
import "@/storage/memory-store-update-api";
import "@/storage/memory-store-rem-api";
import "@/storage/memory-store-import-api";
import "@/storage/memory-store-chunk-search";
import "@/storage/memory-store-search-api";
import "@/storage/memory-store-vector-api";
import "@/storage/memory-store-read-api";
import "@/storage/memory-store-admin-api";

export * from "@/storage/memory-store-base";
export { buildTaskLifecycleMigrationManifest } from "@/storage/memory-store-task-lifecycle-migration-api";
export { normalizeMemoryRelationPredicate } from "@/storage/memory-store-relation-api";
export { repairAtomicExtractionParameters } from "@/storage/memory-store-atomic-extraction-ledger-api";
export { hashMemorySuppressionContent } from "@/storage/memory-store-suppression-api";
export { ATOMIC_FACT_SURFACE_LANE } from "@/storage/memory-store-fact-surface-api";
