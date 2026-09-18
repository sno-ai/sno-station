/** @file sno-station-mem-memory-contracts.ts
 * @purpose Owns the memory-manager fields sno-station-mem implements for SnoStationMem.
 * @boundary Structural types only; no host runtime behavior lives here.
 */


export type SnoStationMemMemorySource = "memory" | "sessions";

export type SnoStationMemMemorySearchResult = {
	path: string;
	startLine: number;
	endLine: number;
	score: number;
	vectorScore?: number;
	textScore?: number;
	snippet: string;
	source: SnoStationMemMemorySource;
	citation?: string;
};

export type SnoStationMemMemoryReadResult = {
	text: string;
	path: string;
	truncated?: boolean;
	from?: number;
	lines?: number;
	nextFrom?: number;
};

export type SnoStationMemMemoryEmbeddingProbeResult = {
	ok: boolean;
	error?: string;
	checked?: boolean;
	cached?: boolean;
	checkedAtMs?: number;
};

export type SnoStationMemMemorySearchRuntimeDebug = {
	backend: "qmd";
	effectiveMode?: string;
	fallback?: string;
};

export type SnoStationMemMemorySyncProgressUpdate = {
	completed: number;
	total: number;
	label?: string;
};

export type SnoStationMemMemoryProviderStatus = {
	backend: "qmd";
	provider: string;
	model?: string;
	files?: number;
	chunks?: number;
	workspaceDir?: string;
	dbPath?: string;
	sources?: SnoStationMemMemorySource[];
	sourceCounts?: Array<{
		source: SnoStationMemMemorySource;
		files: number;
		chunks: number;
	}>;
	fts?: {
		enabled: boolean;
		available: boolean;
	};
	vector?: {
		enabled: boolean;
		storeAvailable?: boolean;
		semanticAvailable?: boolean;
		available?: boolean;
		loadError?: string;
		dims?: number;
	};
	custom?: Record<string, unknown>;
};

export interface SnoStationMemMemorySearchManager {
	search(
		query: string,
		opts?: {
			maxResults?: number;
			minScore?: number;
			onDebug?: (debug: SnoStationMemMemorySearchRuntimeDebug) => void;
			sources?: SnoStationMemMemorySource[];
			signal?: AbortSignal;
		},
	): Promise<SnoStationMemMemorySearchResult[]>;
	readFile(params: {
		relPath: string;
		from?: number;
		lines?: number;
	}): Promise<SnoStationMemMemoryReadResult>;
	status(): SnoStationMemMemoryProviderStatus;
	sync?(params?: {
		reason?: string;
		force?: boolean;
		sessionFiles?: string[];
		progress?: (update: SnoStationMemMemorySyncProgressUpdate) => void;
	}): Promise<void>;
	getCachedEmbeddingAvailability?(): SnoStationMemMemoryEmbeddingProbeResult | null;
	probeEmbeddingAvailability(): Promise<SnoStationMemMemoryEmbeddingProbeResult>;
	probeVectorStoreAvailability?(): Promise<boolean>;
	probeVectorAvailability(): Promise<boolean>;
	close?(): Promise<void>;
}

export type SnoStationMemMemoryRuntime = {
	getMemorySearchManager(params: {
		cfg: ProviderHostConfig;
		agentId: string;
		purpose?: "default" | "status" | "cli";
		inspectSources?: boolean;
	}): Promise<{
		manager: SnoStationMemMemorySearchManager | null;
		error?: string;
	}>;
	resolveMemoryBackendConfig(params: {
		cfg: ProviderHostConfig;
		agentId: string;
	}): { backend: "qmd" };
	closeMemorySearchManager?(params: {
		cfg: ProviderHostConfig;
		agentId: string;
	}): Promise<void>;
	closeAllMemorySearchManagers?(): Promise<void>;
};


export type ProviderHostConfig = { agents?: { entries?: Record<string, { workspace?: string }>; list?: Array<{ id: string; workspace?: string }>; defaults?: { workspace?: string } } };
