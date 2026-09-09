/** @file openclaw-memory-contracts.ts
 * @purpose Owns the memory-manager fields mem-claw implements for OpenClaw.
 * @boundary Structural types only; no host runtime behavior lives here.
 */


export type OpenClawMemorySource = "memory" | "sessions";

export type OpenClawMemorySearchResult = {
	path: string;
	startLine: number;
	endLine: number;
	score: number;
	vectorScore?: number;
	textScore?: number;
	snippet: string;
	source: OpenClawMemorySource;
	citation?: string;
};

export type OpenClawMemoryReadResult = {
	text: string;
	path: string;
	truncated?: boolean;
	from?: number;
	lines?: number;
	nextFrom?: number;
};

export type OpenClawMemoryEmbeddingProbeResult = {
	ok: boolean;
	error?: string;
	checked?: boolean;
	cached?: boolean;
	checkedAtMs?: number;
};

export type OpenClawMemorySearchRuntimeDebug = {
	backend: "qmd";
	effectiveMode?: string;
	fallback?: string;
};

export type OpenClawMemorySyncProgressUpdate = {
	completed: number;
	total: number;
	label?: string;
};

export type OpenClawMemoryProviderStatus = {
	backend: "qmd";
	provider: string;
	model?: string;
	files?: number;
	chunks?: number;
	workspaceDir?: string;
	dbPath?: string;
	sources?: OpenClawMemorySource[];
	sourceCounts?: Array<{
		source: OpenClawMemorySource;
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

export interface OpenClawMemorySearchManager {
	search(
		query: string,
		opts?: {
			maxResults?: number;
			minScore?: number;
			onDebug?: (debug: OpenClawMemorySearchRuntimeDebug) => void;
			sources?: OpenClawMemorySource[];
			signal?: AbortSignal;
		},
	): Promise<OpenClawMemorySearchResult[]>;
	readFile(params: {
		relPath: string;
		from?: number;
		lines?: number;
	}): Promise<OpenClawMemoryReadResult>;
	status(): OpenClawMemoryProviderStatus;
	sync?(params?: {
		reason?: string;
		force?: boolean;
		sessionFiles?: string[];
		progress?: (update: OpenClawMemorySyncProgressUpdate) => void;
	}): Promise<void>;
	getCachedEmbeddingAvailability?(): OpenClawMemoryEmbeddingProbeResult | null;
	probeEmbeddingAvailability(): Promise<OpenClawMemoryEmbeddingProbeResult>;
	probeVectorStoreAvailability?(): Promise<boolean>;
	probeVectorAvailability(): Promise<boolean>;
	close?(): Promise<void>;
}

export type OpenClawMemoryRuntime = {
	getMemorySearchManager(params: {
		cfg: ProviderHostConfig;
		agentId: string;
		purpose?: "default" | "status" | "cli";
		inspectSources?: boolean;
	}): Promise<{
		manager: OpenClawMemorySearchManager | null;
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
