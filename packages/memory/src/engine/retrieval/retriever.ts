/** @file retriever.ts
 * @purpose Public MemoryRetriever entrypoint and side-effect method composition.
 * @boundary Re-export only; implementation lives in focused retrieval modules.
 */

import "./retriever-query-tools";
import "./retriever-search-modes";
import "./retriever-rerank";
import "./retriever-scoring-pipeline";
import "./retriever-execution";

export * from "./retrieval-config";
export { collectParallelStage } from "./retrieval-scoring-utils";
export * from "./retriever-core";
