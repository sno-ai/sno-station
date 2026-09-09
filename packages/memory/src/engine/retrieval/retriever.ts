/** @file retriever.ts
 * @purpose Public MemoryRetriever entrypoint and side-effect method composition.
 * @boundary Re-export only; implementation lives in focused retrieval modules.
 */

import "@/retrieval/retriever-query-tools";
import "@/retrieval/retriever-search-modes";
import "@/retrieval/retriever-rerank";
import "@/retrieval/retriever-scoring-pipeline";
import "@/retrieval/retriever-execution";

export * from "@/retrieval/retrieval-config";
export { collectParallelStage } from "@/retrieval/retrieval-scoring-utils";
export * from "@/retrieval/retriever-core";
