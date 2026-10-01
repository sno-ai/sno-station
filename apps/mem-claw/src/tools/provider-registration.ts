import { classifyWorkspaceMemoryPaths } from "./workspace-provenance";
import { listSnoStationMemProviderPublicArtifacts } from "./provider-public-artifacts";
import { getSnoStationMemStateDir } from "@snoai/memory/internal/engine/operations/runtime-audit-log";
import { ContractError } from "@snoai/memory/client";
import { existsSync } from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { AnyAgentTool, MemoryPluginCapability, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { SnoStationMemMemoryCapability, SnoStationMemMemoryRuntime } from "./openclaw-memory-contracts";
import { resolveWorkspace, type MemoryConnection, type HostMemoryContext } from "../install/memory-connection";
import { executeMemoryGetTool, executeMemoryRecallTool, toolHostContext } from "./http-memory-tools";
import { APP_NAME } from "../constants";

type MemoryPromptSectionBuilder = NonNullable<MemoryPluginCapability["promptBuilder"]>;

function createPromptBuilder(): MemoryPromptSectionBuilder {
	return ({ availableTools }) => {
		if (!availableTools.has("memory_search") && !availableTools.has("memory_get")) return [];
		return ["## Memory",
			"Use memory_search or memory_recall to recall prior facts; use memory_get with an id for the full entry. Retired entries are history, never current recommendations.",
			"Correct a wrong identified memory with memory_correct. Recall first when the user identifies a remembered fact but its id is not visible. Leave an unidentified new or changed fact to turn capture. Background and plugin code never call correct; no model delete action exists.",
			"If correction says already-superseded, your new wording was not applied. Get or recall the named successor, then correct that id only if the wording still differs.", ""];
	};
}

function providerContext(api: OpenClawPluginApi, value: unknown): HostMemoryContext {
	const context = toolHostContext(value);
	if (context.agentId || context.sessionKey) return context;
	const agents = configuredAgents(api.config);
	if (agents.length !== 1) return context;
	return { ...context, agentId: agents[0]?.id };
}

function createProviderMemorySearchTool(api: OpenClawPluginApi, connection: MemoryConnection,
	context: unknown): AnyAgentTool {
	const access = providerContext(api, context);
	return {
		name: "memory_search", label: "Memory Recall",
		description: "Recall relevant memories, including visibly retired history. Recall first when an identified memory's id is not visible.",
		parameters: { type: "object", properties: { query: { type: "string" } },
			required: ["query"], additionalProperties: false },
		execute: (id, params) => executeMemoryRecallTool({ connection, stateDir: getSnoStationMemStateDir() },
			access, id, params),
	};
}

function createProviderMemoryGetTool(api: OpenClawPluginApi, connection: MemoryConnection,
	context: unknown): AnyAgentTool {
	const access = providerContext(api, context);
	return {
		name: "memory_get", label: "Memory Get",
		description: "Get the full memory by id. A retired memory includes its immediate successor id and is historical context.",
		parameters: { type: "object", properties: { id: { type: "string" } },
			required: ["id"], additionalProperties: false },
		execute: (id, params) => executeMemoryGetTool({ connection, stateDir: getSnoStationMemStateDir() },
			access, id, params),
	};
}

function configuredAgents(cfg: OpenClawConfig): Array<{ id: string; workspace?: string }> {
	const entries = cfg.agents?.entries;
	if (entries && Object.keys(entries).length) {
		return Object.entries(entries).map(([id, entry]) => ({ id, workspace: entry.workspace }));
	}
	return cfg.agents?.list ?? [];
}

function createHttpRuntime(connection: MemoryConnection): SnoStationMemMemoryRuntime {
	return {
		classifyWorkspaceMemoryPaths,
		resolveMemoryBackendConfig: () => ({ backend: "qmd" }),
		async getMemorySearchManager({ cfg, agentId }) {
			const workspace = resolveWorkspace(cfg, { agentId });
			const scope = await connection.scope({ agentId, workspaceDir: workspace });
			const client = await connection.ready();
			return { manager: {
				async search(query, options) {
					const result = await client.getRecall(query, scope, { source: "native",
						corpus: options?.sources?.includes("memory") ? "memory" : "all",
						limit: options?.maxResults, minScore: options?.minScore });
					if (result.degraded) throw new ContractError(result.reason, result.error);
					if (result.unavailable) throw new ContractError("engine-failed", result.unavailable);
					return result.nativeHits ?? [];
				},
				async readFile(params) {
					const result = await client.inspect({ op: "get", path: params.relPath,
						from: params.from, lines: params.lines }, scope);
					if (result.degraded) throw new ContractError(result.reason, result.error);
					if (result.result.op !== "get" || !result.result.file) throw new ContractError("engine-failed");
					return result.result.file;
				},
				status: () => ({ backend: "qmd", provider: APP_NAME,
					workspaceDir: workspace, dbPath: client.storePath }),
				async probeEmbeddingAvailability() {
					return { ok: false, checked: false, error: "Embedding availability is owned by the memory service; this interface does not expose a probe." };
				},
				async probeVectorAvailability() { return false; },
			} };
		},
	};
}

export function registerSnoStationMemProviderCapability(params: {
	api: OpenClawPluginApi; connection: MemoryConnection;
}): void {
	const runtime = createHttpRuntime(params.connection);
	const capability: SnoStationMemMemoryCapability = {
		promptBuilder: createPromptBuilder(), supportsPrivateTranscriptRecall: false, runtime,
		publicArtifacts: {
			async listArtifacts({ cfg }) {
				const artifacts = [];
				for (const agent of configuredAgents(cfg)) {
					const workspaceDir = resolveWorkspace(cfg, { agentId: agent.id });
					if (!existsSync(workspaceDir)) continue;
					artifacts.push(...await listSnoStationMemProviderPublicArtifacts({
						connection: params.connection, context: { agentId: agent.id, workspaceDir },
						agentId: agent.id, workspaceDir, stateDir: getSnoStationMemStateDir(),
					}));
				}
				return artifacts;
			},
		},
	};
	params.api.registerMemoryCapability(capability as MemoryPluginCapability);
	params.api.registerTool(ctx => createProviderMemorySearchTool(params.api, params.connection, ctx),
		{ names: ["memory_search"] });
	params.api.registerTool(ctx => createProviderMemoryGetTool(params.api, params.connection, ctx),
		{ names: ["memory_get"] });
}
