import { dirname, join } from "node:path";

/** Implements as non empty string as the local session summary storage operation. */
function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length ? trimmed : undefined;
}

/**
 * Implements derive open memory home from workspace path as the local session summary storage
 * operation.
 */
function deriveSnoStationMemHomeFromWorkspacePath(workspacePath: string): string | undefined {
	// Compute the normalized normalized once so later session memory checks use one value.
	const normalized = workspacePath.trim().replace(/[\\/]+$/, "");
	if (!normalized) return undefined;
	// Compute the normalized matched once so later session memory checks use one value.
	const matched = normalized.match(/^(.*?)[\\/]workspace(?:[\\/].*)?$/);
	if (!matched?.[1]) return undefined;
	const home = matched[1].trim();
	return home.length ? home : undefined;
}

/**
 * Implements derive open memory home from session file path as the local session summary storage
 * operation.
 */
function deriveSnoStationMemHomeFromSessionFilePath(sessionFilePath: string): string | undefined {
	const normalized = sessionFilePath.trim();
	if (!normalized) return undefined;
	const matched = normalized.match(/^(.*?)[\\/]agents[\\/][^\\/]+[\\/]sessions(?:[\\/][^\\/]+)?$/);
	if (!matched?.[1]) return undefined;
	const home = matched[1].trim();
	return home.length ? home : undefined;
}

function readConfiguredAgents(agents: Record<string, unknown> | undefined): unknown[] {
	const entries = agents?.entries;
	if (entries && typeof entries === "object" && !Array.isArray(entries)) {
		const serializedAgents = Object.entries(entries as Record<string, unknown>);
		if (serializedAgents.length > 0) {
			return serializedAgents
				.filter(
					([id, entry]) =>
						id.length > 0 && entry !== null && typeof entry === "object" && !Array.isArray(entry),
				)
				.map(([id, entry]) => ({ ...(entry as Record<string, unknown>), id }));
		}
	}

	const list = agents?.list;
	return Array.isArray(list) ? list : [];
}

/** Implements list configured agent ids as the local session summary storage operation. */
function listConfiguredAgentIds(cfg: unknown): string[] {
	try {
		const root = cfg as Record<string, unknown>;
		// Compute the normalized agents once so later session memory checks use one value.
		const agents = root.agents as Record<string, unknown> | undefined;
		// Compute the normalized list once so later session memory checks use one value.
		const list = readConfiguredAgents(agents);

		const ids: string[] = [];
		for (const item of list) {
			if (!item || typeof item !== "object") continue;
			const id = asNonEmptyString((item as Record<string, unknown>).id);
			if (id) ids.push(id);
		}
		return ids;
	} catch {
		// Unknown config shape means there are no readable agent overrides.
		return [];
	}
}

type SessionEntryRecord = Record<string, unknown>;
type AddStringValue = (value: string | undefined) => void;

function listSessionEntries(context: Record<string, unknown>): SessionEntryRecord[] {
	const previousSessionEntry = (context.previousSessionEntry || {}) as SessionEntryRecord;
	const sessionEntry = (context.sessionEntry || {}) as SessionEntryRecord;
	return [previousSessionEntry, sessionEntry];
}

function addSessionEntryDirs(sessionEntries: SessionEntryRecord[], addDir: AddStringValue): void {
	for (const entry of sessionEntries) {
		const file = asNonEmptyString(entry.sessionFile as unknown);
		if (file) addDir(dirname(file));
		addDir(asNonEmptyString(entry.sessionsDir as unknown));
		addDir(asNonEmptyString(entry.sessionDir as unknown));
	}
}

function addSessionEntryHomes(sessionEntries: SessionEntryRecord[], addHome: AddStringValue): void {
	for (const entry of sessionEntries) {
		const entryFile = asNonEmptyString(entry.sessionFile as unknown);
		if (entryFile) addHome(deriveSnoStationMemHomeFromSessionFilePath(entryFile));
	}
}

function addConfiguredWorkspaceHomes(cfg: unknown, addHome: AddStringValue): void {
	try {
		const root = cfg as Record<string, unknown>;
		const agents = root.agents as Record<string, unknown> | undefined;
		const defaults = agents?.defaults as Record<string, unknown> | undefined;
		const defaultWorkspace = asNonEmptyString(defaults?.workspace);
		if (defaultWorkspace) addHome(deriveSnoStationMemHomeFromWorkspacePath(defaultWorkspace));

		for (const item of readConfiguredAgents(agents)) {
			if (!item || typeof item !== "object") continue;
			const workspace = asNonEmptyString((item as Record<string, unknown>).workspace);
			if (workspace) addHome(deriveSnoStationMemHomeFromWorkspacePath(workspace));
		}
	} catch {
		// Invalid config files are ignored for session-summary discovery.
	}
}

function addReflectionAgentIds(
	params: ReflectionSessionSearchParams,
	sessionEntries: SessionEntryRecord[],
	addAgentId: AddStringValue,
): void {
	addAgentId(params.sourceAgentId);
	addAgentId(asNonEmptyString(params.context.agentId as unknown));
	for (const entry of sessionEntries) {
		addAgentId(asNonEmptyString(entry.agentId as unknown));
	}
	for (const configuredId of listConfiguredAgentIds(params.cfg)) {
		addAgentId(configuredId);
	}
	addAgentId("main");
}

function isSafeAgentId(agentId: string): boolean {
	return agentId !== "." && agentId !== ".." && !agentId.includes("/") && !agentId.includes("\\");
}

export interface ReflectionSessionSearchParams {
	context: Record<string, unknown>;
	cfg: unknown;
	workspaceDir: string;
	currentSessionFile?: string;
	sourceAgentId?: string;
}

/**
 * Resolves reflection session search dirs with the fallback order required by session summary
 * storage.
 */
export function resolveReflectionSessionSearchDirs(
	params: ReflectionSessionSearchParams,
): string[] {
	const out: string[] = [];
	const seen = new Set<string>();

	/** Adds dir to the local session summary storage accumulator. */
	const addDir = (value: string | undefined) => {
		const dir = asNonEmptyString(value);
		if (!dir || seen.has(dir)) return;
		seen.add(dir);
		out.push(dir);
	};
	const snoStationMemHomes: string[] = [];
	/** Adds home to the local session summary storage accumulator. */
	const addHome = (value: string | undefined) => {
		const home = asNonEmptyString(value);
		if (!home || snoStationMemHomes.includes(home)) return;
		snoStationMemHomes.push(home);
	};
	const agentIds: string[] = [];
	/** Adds agent id to the local session summary storage accumulator. */
	const addAgentId = (value: string | undefined) => {
		const agentId = asNonEmptyString(value);
		if (!agentId || !isSafeAgentId(agentId) || agentIds.includes(agentId)) return;
		agentIds.push(agentId);
	};

	const sessionEntries = listSessionEntries(params.context);

	if (params.currentSessionFile) addDir(dirname(params.currentSessionFile));
	addSessionEntryDirs(sessionEntries, addDir);
	addDir(join(params.workspaceDir, "sessions"));

	addHome(asNonEmptyString(process.env.SNO_STATION_MEM_HOME));
	addHome(deriveSnoStationMemHomeFromWorkspacePath(params.workspaceDir));
	if (params.currentSessionFile) {
		addHome(deriveSnoStationMemHomeFromSessionFilePath(params.currentSessionFile));
	}
	addSessionEntryHomes(sessionEntries, addHome);
	addConfiguredWorkspaceHomes(params.cfg, addHome);
	addReflectionAgentIds(params, sessionEntries, addAgentId);

	for (const home of snoStationMemHomes) {
		for (const agentId of agentIds) {
			addDir(join(home, "agents", agentId, "sessions"));
		}
	}

	return out;
}
