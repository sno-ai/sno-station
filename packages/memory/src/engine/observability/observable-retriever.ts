/** @file observable-retriever.ts
 * @purpose Emits strict runtime audits and best-effort telemetry around memory retrieval.
 * @boundary Runtime audits fail closed; process telemetry never affects retrieval.
 */

import type { JsonObject } from "@snoai/sno-observe";
import type { Embedder, EmbeddingConfig } from "../extraction/embedding-provider-client";
import { getSnoStationMemStateDir, runWithMemoryAudit } from "../operations/runtime-audit-log";
import {
	DEFAULT_RETRIEVAL_CONFIG,
	MemoryRetriever,
	type RetrievalConfig,
	type RetrievalContext,
} from "../retrieval/retriever";
import type { RetrievalResult } from "../shared/types";
import type { MemoryStore } from "../../store/store";
import { observeBackgroundCooldownKey, type PluginObservability } from "./adapter";
import { countEmbeddingTokens, countManyEmbeddingTokens } from "./token-counter";

type SessionUuidProvider = () => string | undefined;
type RetrievalTraceResult = Awaited<ReturnType<MemoryRetriever["retrieveWithTrace"]>>;

export class ObservableMemoryRetriever extends MemoryRetriever {
	constructor(
		store: MemoryStore,
		embedder: Embedder,
		logger: { warn: (message: string, fields?: Record<string, unknown>) => void } | undefined,
		config: RetrievalConfig | undefined = DEFAULT_RETRIEVAL_CONFIG,
		private readonly observability: PluginObservability,
		private readonly sessionUuidProvider: SessionUuidProvider,
		private readonly embeddingConfig: Pick<EmbeddingConfig, "provider" | "model">,
	) {
		super(store, embedder, logger, config);
	}

	override async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
		return this.observeRead(context, "retrieve", () => super.retrieve(context));
	}

	override async retrieveWithTrace(context: RetrievalContext): Promise<RetrievalTraceResult> {
		const started = Date.now();
		try {
			const result = await auditRetrieval("retrieveWithTrace", context, () =>
				super.retrieveWithTrace(context),
			);
			const sessionUuid = this.sessionUuidProvider();
			this.observability.trackBestEffort(
				"memory.read",
				() => this.emitRead(context, result.results, started, sessionUuid),
				{
					cooldownKey: observeBackgroundCooldownKey("memory.read", sessionUuid),
				},
			);
			return result;
		} catch (error) {
			await this.observability.emitError("retriever_throw", error, this.sessionUuidProvider());
			throw error;
		}
	}

	private async observeRead(
		context: RetrievalContext,
		operationName: string,
		operation: () => Promise<RetrievalResult[]>,
	): Promise<RetrievalResult[]> {
		const started = Date.now();
		try {
			const results = await auditRetrieval(operationName, context, operation);
			const sessionUuid = this.sessionUuidProvider();
			this.observability.trackBestEffort(
				"memory.read",
				() => this.emitRead(context, results, started, sessionUuid),
				{
					cooldownKey: observeBackgroundCooldownKey("memory.read", sessionUuid),
				},
			);
			return results;
		} catch (error) {
			await this.observability.emitError("retriever_throw", error, this.sessionUuidProvider());
			throw error;
		}
	}

	private async emitRead(
		context: RetrievalContext,
		results: RetrievalResult[],
		started: number,
		sessionUuid: string | undefined,
	): Promise<void> {
		const queryHash = this.observability.hashText(context.query);
		if (!queryHash) return;
		const queryTokens = await countEmbeddingTokens(context.query, this.embeddingConfig);
		const resultTokens = await countManyEmbeddingTokens(
			results.map((result) => result.entry.text),
			this.embeddingConfig,
		);
		await this.observability.emit({
			eventType: "memory.read",
			sessionUuid,
			payload: {
				query_hash: queryHash,
				query_tokens: queryTokens.count,
				k: context.limit,
				hit_count: results.length,
				result_tokens: resultTokens.count,
				latency_ms: Date.now() - started,
				tokens_method: queryTokens.method,
			} satisfies JsonObject,
		});
	}
}

function auditRetrieval<T>(
	operation: string,
	context: RetrievalContext,
	run: () => Promise<T>,
): Promise<T> {
	const scopes = context.scopeFilter ?? [];
	const scope = scopes.length === 1 ? (scopes[0] ?? "all") : scopes.length > 1 ? "multiple" : "all";
	return runWithMemoryAudit({
		stateDir: getSnoStationMemStateDir(),
		event: "memory_searched",
		operation,
		scope,
		startedDetails: {
			scope: scopes,
			query_kind: context.source ?? "unknown",
			requested_count: context.limit,
		},
		run,
		completedDetails: (result) => {
			const results = retrievalResults(result);
			return {
				scope: scopes,
				query_kind: context.source ?? "unknown",
				requested_count: context.limit,
				result_count: results.length,
				memory_ids: results.map((entry) => entry.entry.id),
			};
		},
	});
}

function retrievalResults(result: unknown): RetrievalResult[] {
	if (Array.isArray(result)) return result as RetrievalResult[];
	if (
		typeof result === "object" &&
		result !== null &&
		"results" in result &&
		Array.isArray(result.results)
	) {
		return result.results as RetrievalResult[];
	}
	return [];
}
