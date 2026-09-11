import { FIXED_MEMORY_ROW_PATH_PATTERN, FIXED_PROTOCOL_VALUE_74 } from "../../model/signed-registry-constants";
/** @file provider-search-manager.ts
 * @purpose Implements SnoStationMem memory provider search/read against sno-station-mem rows.
 * @boundary Enforces project-scoped provider identity before exposing generated files.
 */

import type {
	SnoStationMemMemoryEmbeddingProbeResult as MemoryEmbeddingProbeResult,
	SnoStationMemMemoryProviderStatus as MemoryProviderStatus,
	SnoStationMemMemoryReadResult as MemoryReadResult,
	SnoStationMemMemorySearchManager as MemorySearchManager,
	SnoStationMemMemorySearchResult as MemorySearchResult,
	SnoStationMemMemorySearchRuntimeDebug as MemorySearchRuntimeDebug,
	SnoStationMemMemorySource as MemorySource,
	SnoStationMemMemorySyncProgressUpdate as MemorySyncProgressUpdate,
} from "../../contract/provider-runtime-types";
import { MAX_LIST_LIMIT } from "../../../config/index";
import { parseInsightMetadata } from "../extraction/memory-metadata-codec";
import {
	listCanonicalMemoryFiles,
	readCanonicalMemoryFile,
	searchCanonicalMemoryFiles,
	type CanonicalMemoryDiagnostics,
} from "./canonical-memory-corpus";
import {
	isProviderRowId,
	providerRowPath,
	renderProviderRowMemory,
} from "./provider-row-renderer";
import type { ProviderIdentity } from "./provider-types";
import type { MemoryEntry, MemorySearchResult as StoreSearchResult } from "../shared/types";
import { clampInt } from "../shared/utils";
import type { MemoryStore } from "../../store/store";
import { randomUUID } from "node:crypto";
import { createLogger, currentLogContext, privateLogReference, withLogContext } from "@snoai/utils/logger";
const diagnosticLog = createLogger("sno-station-mem:provider-search-manager");

const ROW_PATH_RE =
	FIXED_MEMORY_ROW_PATH_PATTERN;
const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_READ_LINES = 200;
const MAX_READ_LINES = 2_000;
const EMBEDDING_FAILURE_RETRY_MS = 30_000;

export interface SnoStationMemProviderSearchManagerOptions {
	store: MemoryStore;
	identity: ProviderIdentity;
	workspaceDir?: string;
}

function scoreAtLeast(score: number, minScore: number): boolean {
	return Number.isFinite(score) && score >= minScore;
}

function lineBound(text: string, from?: number, lines?: number): Omit<MemoryReadResult, "path"> {
	const allLines = text.split("\n");
	const start = clampInt(from ?? 1, 1, Math.max(allLines.length, 1));
	const requested = clampInt(lines ?? DEFAULT_READ_LINES, 1, MAX_READ_LINES);
	const endExclusive = Math.min(start - 1 + requested, allLines.length);
	const truncated = endExclusive < allLines.length;
	return {
		text: allLines.slice(start - 1, endExclusive).join("\n"),
		truncated,
		from: start,
		lines: requested,
		...(truncated ? { nextFrom: endExclusive + 1 } : {}),
	};
}

function mapSearchResult(result: StoreSearchResult, source: "semantic" | "keyword"): MemorySearchResult {
	const rendered = renderProviderRowMemory(result.entry);
	const snippet = result.snippet && result.snippet.length > 0 ? result.snippet : result.entry.text;
	return {
		path: providerRowPath(result.entry.id),
		startLine: 1,
		endLine: rendered.split("\n").length,
		score: result.score,
		...(source === "semantic" ? { vectorScore: result.score } : { textScore: result.score }),
		snippet,
		source: "memory",
		citation: providerRowPath(result.entry.id),
	};
}

function readCount(value: unknown): number {
	if (!value || typeof value !== "object") return 0;
	const count = (value as { count?: unknown }).count;
	return typeof count === "number" ? count : 0;
}

export class SnoStationMemProviderSearchManager implements MemorySearchManager {
	private cachedEmbeddingAvailability: MemoryEmbeddingProbeResult | null = null;
	private embeddingRetryAfterMs = 0;
	private readonly authorizedCanonicalPaths = new Set<string>();
	private closed = false;

	constructor(private readonly options: SnoStationMemProviderSearchManagerOptions) {}

	async search(
		query: string,
		opts: {
			maxResults?: number;
			minScore?: number;
			onDebug?: (debug: MemorySearchRuntimeDebug) => void;
			sources?: MemorySource[];
			signal?: AbortSignal;
		} = {},
	): Promise<MemorySearchResult[]> {
		return withLogContext({ operation_id: currentLogContext().operation_id ?? randomUUID() }, async () => {
		const started = performance.now();
		let outcome = "failed";
		let fallback = "none";
		let semanticCount: number | undefined;
		let keywordCount: number | undefined;
		let served: MemorySearchResult[] = [];
		let failure: unknown;
		const canonicalDiagnostics: CanonicalMemoryDiagnostics = { io_failure_count: 0, unavailable_file_count: 0 };
		try {
		this.assertOpen();
		if (opts.signal?.aborted) throw new Error("Provider memory search aborted");
		if (opts.sources && !opts.sources.includes("memory")) {
			outcome = "skipped";
			return [];
		}
		const maxResults = clampInt(opts.maxResults ?? DEFAULT_SEARCH_LIMIT, 1, MAX_LIST_LIMIT);
		const minScore = opts.minScore ?? 0;
		const searchOptions = {
			limit: maxResults,
			minScore,
			projectIdFilter: [this.options.identity.projectId],
			excludeInvalidatedBefore: Date.now(),
			includeRefused: true,
		};
		opts.onDebug?.({ backend: "qmd", effectiveMode: "sno-station-mem-row-semantic" });

		let rowResults: MemorySearchResult[] = [];
		const cachedEmbeddingFailure = Date.now() < this.embeddingRetryAfterMs;
		if (!(await this.probeVectorAvailability()) || cachedEmbeddingFailure) {
			fallback = cachedEmbeddingFailure ? "cached_embedding_failure" : "vector_unavailable";
			opts.onDebug?.({
				backend: "qmd",
				effectiveMode: "sno-station-mem-row-keyword",
				fallback: "semantic-unavailable",
			});
		} else {
			try {
				const vector = await this.options.store.embedder.embed(query);
				this.cachedEmbeddingAvailability = {
					ok: true,
					checked: true,
					cached: false,
					checkedAtMs: Date.now(),
				};
				this.embeddingRetryAfterMs = 0;
				const semantic = await this.options.store.searchSemantic(vector, searchOptions);
				semanticCount = semantic.length;
				const filteredSemantic = this.filterAuthorized(semantic, minScore);
				if (filteredSemantic.length > 0) {
					rowResults = filteredSemantic.map((result) => mapSearchResult(result, "semantic"));
				}
			} catch (error) {
				failure = error;
				fallback = "semantic_failed";
				const checkedAtMs = Date.now();
				this.cachedEmbeddingAvailability = {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
					checked: true,
					cached: false,
					checkedAtMs,
				};
				this.embeddingRetryAfterMs = checkedAtMs + EMBEDDING_FAILURE_RETRY_MS;
				opts.onDebug?.({
					backend: "qmd",
					effectiveMode: "sno-station-mem-row-keyword",
					fallback: "semantic-unavailable",
				});
			}
		}

		if (rowResults.length === 0) {
			if (fallback === "none") fallback = "semantic_empty";
			const keyword = await this.options.store.searchKeyword(query, searchOptions);
			keywordCount = keyword.length;
			rowResults = this.filterAuthorized(keyword, minScore).map((result) =>
				mapSearchResult(result, "keyword"),
			);
		}
		const canonicalResults = await this.searchCanonical(query, maxResults, minScore, canonicalDiagnostics);
		served = [...rowResults, ...canonicalResults]
			.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
			.slice(0, maxResults);
		outcome = fallback === "semantic_failed" || fallback === "cached_embedding_failure" || canonicalDiagnostics.io_failure_count > 0 ? "partial" : served.length ? "success" : "empty_success";
		return served;
		} catch (error) {
			failure = error;
			outcome = opts.signal?.aborted ? "cancelled" : "failed";
			throw error;
		} finally {
			diagnosticLog[outcome === "failed" ? "error" : "info"]("Provider memory search completed", {
				outcome, fallback_reason: fallback, error: failure, duration_ms: performance.now() - started,
				input_size: query.length, scope_count: 1, semantic_candidate_count: semanticCount ?? "unavailable",
				keyword_candidate_count: keywordCount ?? "unavailable", served_count: served.length,
				canonical_io_failure_count: canonicalDiagnostics.io_failure_count, canonical_unavailable_file_count: canonicalDiagnostics.unavailable_file_count,
				canonical_available: this.options.workspaceDir !== undefined,
				served_ids: served.flatMap((row) => { const id = ROW_PATH_RE.exec(row.path)?.[1]; return id ? [id] : []; }).slice(0, 128),
				store_reference: privateLogReference(this.options.store.dbPath),
			}, { event_name: "memory.provider.search.completed", file: "packages/sno-station-mem/src/engine/provider/provider-search-manager.ts", function: "SnoStationMemProviderSearchManager.search", site_id: "memory.provider.search.completed" });
		}
		});
	}

	async readFile(params: { relPath: string; from?: number; lines?: number }): Promise<MemoryReadResult> {
		return withLogContext({ operation_id: currentLogContext().operation_id ?? randomUUID() }, async () => {
		const started = performance.now();
		let outcome = "failed";
		let failure: unknown;
		let reason = "read_failed";
		const canonicalDiagnostic: { reason?: string; error?: unknown } = {};
		try {
		this.assertOpen();
		const match = ROW_PATH_RE.exec(params.relPath);
		const memoryId = match?.[1];
		if (memoryId) {
			const entry = this.options.store.getById(memoryId);
			if (!this.isAuthorizedEntry(entry)) {
				outcome = "refused";
				reason = entry === undefined ? "row_missing" : "row_not_authorized";
				throw new Error("Provider memory row not found or not authorized");
			}
			const bounded = lineBound(renderProviderRowMemory(entry), params.from, params.lines);
			outcome = "success";
			reason = "row_read";
			return {
				...bounded,
				path: providerRowPath(entry.id),
			};
		}
		const canonical = await this.readAuthorizedCanonical(params, canonicalDiagnostic);
		outcome = "success";
		reason = "canonical_read";
		return {
			text: canonical.text,
			path: canonical.path,
			...(canonical.truncated ? { truncated: canonical.truncated } : {}),
			...(canonical.from ? { from: canonical.from } : {}),
			...(canonical.lines ? { lines: canonical.lines } : {}),
			...(canonical.nextFrom ? { nextFrom: canonical.nextFrom } : {}),
		};
		} catch (error) {
			failure = error;
			if (canonicalDiagnostic.reason) {
				reason = canonicalDiagnostic.reason;
				outcome = reason === "canonical_not_authorized" ? "refused" : "failed";
				failure = canonicalDiagnostic.error ?? error;
			}
			throw error;
		} finally {
			diagnosticLog[outcome === "failed" ? "error" : "info"]("Provider memory read completed", {
				outcome, reason_code: reason, error: failure, duration_ms: performance.now() - started,
				artifact_reference: privateLogReference(params.relPath),
			}, { event_name: "memory.provider.read.completed", file: "packages/sno-station-mem/src/engine/provider/provider-search-manager.ts", function: "SnoStationMemProviderSearchManager.readFile", site_id: "memory.provider.read.completed" });
		}
		});
	}

	status(): MemoryProviderStatus {
		const started = performance.now();
		try {
		this.assertOpen();
		const vectorStoreAvailable = this.hasVectorStore();
		const embeddingAvailable = this.cachedEmbeddingAvailability?.ok === true;
		const semanticAvailable = vectorStoreAvailable && embeddingAvailable;
		const memoryCount = readCount(
			this.options.store.sqlite
				.prepare("SELECT COUNT(*) AS count FROM nodix_memories WHERE project_id = ?")
				.get(this.options.identity.projectId),
		);
		const chunkCount = readCount(
			this.options.store.sqlite
				.prepare(
					"SELECT COUNT(*) AS count FROM nodix_memory_chunks c JOIN nodix_memories m ON m.id = c.memory_id WHERE m.project_id = ?",
				)
				.get(this.options.identity.projectId),
		);
		diagnosticLog.debug("Provider memory status read", { outcome: "success", memory_count: memoryCount,
			chunk_count: chunkCount, vector_available: vectorStoreAvailable, embedding_available: embeddingAvailable,
			duration_ms: performance.now() - started },
			{ event_name: "memory.provider.status.completed", file: "packages/sno-station-mem/src/engine/provider/provider-search-manager.ts", function: "SnoStationMemProviderSearchManager.status", site_id: "memory.provider.status.completed" });
		return {
			backend: "qmd",
			provider: FIXED_PROTOCOL_VALUE_74,
			model: this.options.store.embedder.model,
			files: memoryCount,
			chunks: chunkCount,
			dbPath: this.options.store.dbPath,
			...(this.options.workspaceDir ? { workspaceDir: this.options.workspaceDir } : {}),
			sources: ["memory"],
			sourceCounts: [{ source: "memory", files: memoryCount, chunks: chunkCount }],
			fts: { enabled: true, available: this.options.store.hasFtsSupport },
			vector: {
				enabled: true,
				storeAvailable: vectorStoreAvailable,
				semanticAvailable,
				available: semanticAvailable,
				dims: this.options.store.vectorDim,
				...(this.cachedEmbeddingAvailability?.ok === false
					? { loadError: this.cachedEmbeddingAvailability.error ?? "embedding unavailable" }
					: {}),
			},
			custom: {
				userId: this.options.identity.userId,
				projectId: this.options.identity.projectId,
				agentId: this.options.identity.agentId,
			},
		};
		} catch (error) {
			diagnosticLog.error("Provider memory status failed", { outcome: "failed", error, duration_ms: performance.now() - started },
				{ event_name: "memory.provider.status.completed", file: "packages/sno-station-mem/src/engine/provider/provider-search-manager.ts", function: "SnoStationMemProviderSearchManager.status", site_id: "memory.provider.status.failed" });
			throw error;
		}
	}

	async sync(
		params: {
			reason?: string;
			force?: boolean;
			sessionFiles?: string[];
			progress?: (update: MemorySyncProgressUpdate) => void;
		} = {},
	): Promise<void> {
		this.assertOpen();
		if (!this.options.workspaceDir) {
			params.progress?.({ completed: 1, total: 1, label: "sno-station-mem rows are live" });
			return;
		}
		const canonicalFiles = await listCanonicalMemoryFiles(this.options.workspaceDir);
		for (const file of canonicalFiles) {
			this.authorizedCanonicalPaths.add(file.path);
		}
		params.progress?.({
			completed: canonicalFiles.length,
			total: canonicalFiles.length,
			label: "canonical memory files indexed",
		});
	}

	getCachedEmbeddingAvailability(): MemoryEmbeddingProbeResult | null {
		return this.cachedEmbeddingAvailability;
	}

	async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
		this.assertOpen();
		const checkedAtMs = Date.now();
		try {
			await this.options.store.embedder.embed("provider availability probe");
			this.cachedEmbeddingAvailability = {
				ok: true,
				checked: true,
				cached: false,
				checkedAtMs,
			};
			this.embeddingRetryAfterMs = 0;
		} catch (error) {
			this.cachedEmbeddingAvailability = {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
				checked: true,
				cached: false,
				checkedAtMs,
			};
			this.embeddingRetryAfterMs = checkedAtMs + EMBEDDING_FAILURE_RETRY_MS;
		}
		return this.cachedEmbeddingAvailability;
	}

	async probeVectorStoreAvailability(): Promise<boolean> {
		return this.probeVectorAvailability();
	}

	async probeVectorAvailability(): Promise<boolean> {
		this.assertOpen();
		return this.hasVectorStore();
	}

	async close(): Promise<void> {
		const alreadyClosed = this.closed;
		this.closed = true;
		diagnosticLog.debug("Provider memory manager closed", { outcome: "success", already_closed: alreadyClosed },
			{ event_name: "memory.provider.manager.closed", file: "packages/sno-station-mem/src/engine/provider/provider-search-manager.ts", function: "SnoStationMemProviderSearchManager.close", site_id: "memory.provider.manager.closed" });
	}

	private hasVectorStore(): boolean {
		const row = this.options.store.sqlite
			.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = 'nodix_memory_chunk_vectors' LIMIT 1")
			.get();
		return !!row;
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("Provider memory manager is closed");
	}

	private filterAuthorized(results: StoreSearchResult[], minScore: number): StoreSearchResult[] {
		return results.filter(
			(result) =>
				this.isAuthorizedEntry(result.entry) &&
				isProviderRowId(result.entry.id) &&
				scoreAtLeast(result.score, minScore),
		);
	}

	private isAuthorizedEntry(entry: MemoryEntry | undefined): entry is MemoryEntry {
		// A refusal mark says the row was not profile material; it is still the user's own
		// sentence and is served by default (owner ruling 2026-09-01, PRD 130 DEC-9).
		if (entry?.projectId !== this.options.identity.projectId) {
			return false;
		}
		try {
			return parseInsightMetadata(entry.metadata, entry).invalidated_at === undefined;
		} catch {
			return false;
		}
	}

	private async searchCanonical(
		query: string,
		maxResults: number,
		minScore: number,
		diagnostics?: CanonicalMemoryDiagnostics,
	): Promise<MemorySearchResult[]> {
		if (!this.options.workspaceDir) return [];
		const results = await searchCanonicalMemoryFiles({
			diagnostics,
			workspaceDir: this.options.workspaceDir,
			query,
			maxResults,
		});
		const filtered = results.filter((result) => scoreAtLeast(result.score, minScore));
		for (const result of filtered) {
			this.authorizedCanonicalPaths.add(result.path);
		}
		return filtered;
	}

	private async readAuthorizedCanonical(params: {
		relPath: string;
		from?: number;
		lines?: number;
	}, diagnostics?: { reason?: string; error?: unknown }): Promise<Awaited<ReturnType<typeof readCanonicalMemoryFile>>> {
		if (!this.options.workspaceDir || !this.authorizedCanonicalPaths.has(params.relPath)) {
			if (diagnostics) diagnostics.reason = "canonical_not_authorized";
			throw new Error("Provider canonical memory file not found or not authorized");
		}
		try {
			return await readCanonicalMemoryFile({
				workspaceDir: this.options.workspaceDir,
				relPath: params.relPath,
				from: params.from,
				lines: params.lines,
			});
		} catch (error) {
			if (diagnostics) {
				diagnostics.reason = "canonical_read_unavailable";
				diagnostics.error = error;
			}
			throw new Error("Provider canonical memory file not found or not authorized");
		}
	}
}
