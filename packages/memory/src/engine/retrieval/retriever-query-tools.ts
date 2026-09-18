/** @file retriever-query-tools.ts
 * @purpose Handles aborts and expiry filtering.
 * @boundary Prototype-mounted MemoryRetriever methods; no constructor state ownership.
 */

import type { RetrievalContext } from "./retrieval-config";
import { MemoryRetriever, type MemoryRetrieverInternals } from "./retriever-core";
import type { MemorySearchResult, RetrievalResult } from "./retriever-dependencies";
import { isMemoryExpired, parseInsightMetadata } from "./retriever-dependencies";

Object.assign(MemoryRetriever.prototype, {
	throwIfAborted(this: MemoryRetrieverInternals, context: RetrievalContext): void {
		if (!context.signal?.aborted) return;
		const reason = context.signal.reason;
		throw reason instanceof Error ? reason : new Error("retrieval aborted");
	},

	filterExpired(this: MemoryRetrieverInternals, results: RetrievalResult[]): RetrievalResult[] {
		// Handle the absent-value case explicitly before the happy path depends on it.
		if (!this.config.temporalExpiry) return results;
		// Isolate the retrieval ranking operation that can fail because of runtime I/O or input shape.
		return results.filter((r) => !this.isEntryExpired(r.entry));
	},

	filterExpiredCandidates(
		this: MemoryRetrieverInternals,
		results: MemorySearchResult[],
	): MemorySearchResult[] {
		// Handle the absent-value case explicitly before the happy path depends on it.
		if (!this.config.temporalExpiry) return results;
		// Isolate the retrieval ranking operation that can fail because of runtime I/O or input shape.
		return results.filter((r) => !this.isEntryExpired(r.entry));
	},

	isEntryExpired(
		this: MemoryRetrieverInternals,
		entry: MemorySearchResult["entry"] | RetrievalResult["entry"],
	): boolean {
		// Isolate the retrieval ranking operation that can fail because of runtime I/O or input shape.
		const metadata = parseInsightMetadata(entry.metadata, entry);
		// Centralize the retrieval scoring fallback value at the boundary of this helper.
		return isMemoryExpired(metadata);
	},
});
