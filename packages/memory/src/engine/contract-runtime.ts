import { withMemoryOperation, checkMemoryOperation } from "./operation-cancellation";
import { SnoStationMemProviderSearchManager } from "./provider/provider-search-manager";
import { randomUUID } from "node:crypto";
import { MAX_SESSION_RECALL_ENTRIES, MAX_TRACKED_SESSIONS } from "../../config/index";
import { pruneOldestEntries, setLruEntry } from "./shared/lru";
import { resolve } from "node:path";
import {
	ContractError, parseInput, parseOutput, type ContractOutputs, type MemoryContract,
	type ScopeCtx, type Registration, type RecallOptions, type Turn, type Mutation,
	type Inspection, type UsageSignal, type Message,
} from "../contract/index";
import type { StatsResult } from "../store/memory-store-shared";
import type { MemoryStore } from "../store/store";
import type { Embedder } from "./extraction/embedding-provider-client";
import type { MemoryRetriever } from "./retrieval/retriever";
import type { AccessTracker } from "./retrieval/access-tracker";
import type { PluginObservability } from "./observability/adapter";
import type { MemoryTelemetryUsageOutbox } from "./telemetry/memory-telemetry-outbox";
import type { AgentLlmPort } from "../model/agent-llm-port";
import { createLlmClient } from "../model/llm-client";
import type { PluginConfig } from "./shared/types";
import { createScopePolicy, MemoryScopePolicy } from "./security/memory-scope-policy";
import { parseAgentIdFromSessionKey } from "./security/scope-identity";
import { resolveProviderIdentity } from "./provider/provider-registration";
import { onBeforeAgentStart } from "./bindings/sno-station-mem-auto-recall-hook";
import { resolveRuntimeSessionId, clearSessionState } from "./bindings/sno-station-mem-session-state";
import { executeMemoryRecallTool } from "./bindings/memory-recall-tool";
import { buildInsightDistiller } from "./bindings/sno-station-mem-insight-distill-factory";
import { onAgentEnd } from "./bindings/sno-station-mem-ambient-learning-hook";
import { resolveAgentAccess, resolveAgentId } from "./bindings/memory-tool-access";
import type { ToolContext, ToolResult } from "./bindings/memory-tool-schemas";
import { executeMemoryStoreTool } from "./bindings/memory-store-tool";
import { executeMemoryForgetTool } from "./bindings/memory-forget-tool";
import { executeMemoryUpdateTool } from "./bindings/memory-update-tool";
import { executeMemoryReflectionResolveTool } from "./bindings/memory-reflection-resolve-tool";
import { createReflectionStrategyState, type ReflectionStrategyState } from "./reflection/strategy-hook-runner";
import { createRunMemoryReflection, type ReflectionCommandParams } from "./reflection/reflection-command-hooks";
import type { SnoStationMemMemorySearchManager } from "../contract/provider-runtime-types";
import { createReflectionLifecycleHandler1, createReflectionLifecycleHandler2 } from "./reflection/reflection-lifecycle-hooks";
import { createReflectionInjectionHandler1, createReflectionInjectionHandler2, createReflectionInjectionHandler3 } from "./reflection/reflection-injection-hooks";
import type { PluginHookAgentContext } from "./bindings/sno-station-mem-hook-types";

export interface MemoryRuntimeServices {
	store: MemoryStore;
	embedder: Embedder;
	retriever: MemoryRetriever;
	accessTracker: AccessTracker;
	observability: PluginObservability;
	stateDir: string;
	agentPort?: AgentLlmPort;
	telemetryUsage?: MemoryTelemetryUsageOutbox;
	logger: ReflectionCommandParams["logger"];
}

/**
 * A logical scope is a configured or built-in scope name the installed policy grants this agent;
 * a path is never one. A system caller (host operator) may name any valid scope.
 */
function admittedScope(installed: MemoryScopePolicy, scope: string, agentId: string | undefined, systemCaller: boolean): boolean {
	return !/[\\/]/.test(scope) && installed.validateScope(scope) && (systemCaller || installed.isAccessible(scope, agentId));
}

function sumStats(results: StatsResult[]): StatsResult {
	const summed: StatsResult = { total: 0, projectBreakdown: {}, categoryBreakdown: {} };
	for (const result of results) {
		summed.total += result.total;
		for (const [project, count] of Object.entries(result.projectBreakdown)) summed.projectBreakdown[project] = (summed.projectBreakdown[project] ?? 0) + count;
		for (const [category, count] of Object.entries(result.categoryBreakdown)) summed.categoryBreakdown[category] = (summed.categoryBreakdown[category] ?? 0) + count;
	}
	return summed;
}

/** One call's policy: writes land on the resolved project; reads span the readable set the sidecar admitted. */
class CallScopePolicy extends MemoryScopePolicy {
	constructor(private readonly project: string, private readonly readable: string[]) {
		super({ default: project, definitions: Object.fromEntries(readable.map(scope => [scope, {}])) });
	}
	override getAccessibleScopes(): string[] { return [...this.readable]; }
	override getScopeFilter(): string[] { return [...this.readable]; }
	override getDefaultScope(): string { return this.project; }
	override getAllScopes(): string[] { return [...this.readable]; }
	override isAccessible(): boolean { return true; }
	override validateScope(): boolean { return true; }
}

type RecallState = Pick<NonNullable<ToolContext["recallSession"]>, "history"> & {
	turns: Map<string, number>;
};

export class MemoryContractRuntime implements MemoryContract {
	private registration: Registration | undefined;
	private readonly providers = new Map<string, SnoStationMemProviderSearchManager>();
	private readonly reflectionStates = new Map<string, ReflectionStrategyState>();
	private readonly recall: RecallState = { history: new Map(), turns: new Map() };
	constructor(private readonly services: MemoryRuntimeServices) {}

	async close(): Promise<void> {
		for (const provider of this.providers.values()) await provider.close();
		this.providers.clear();
		this.reflectionStates.clear();
	}

	async init(scope: ScopeCtx, registration: Registration): Promise<ContractOutputs["init"]> {
		const input = parseInput("init", { scope, registration });
		await this.close();
		this.registration = input.registration;
		this.reflectionStates.clear();
		await this.project(input.scope);
		return { degraded: false, principal: scope.principal, skinId: registration.skinId };
	}

	private configured(): { registration: Registration; config: PluginConfig } {
		if (!this.registration) throw new ContractError("invalid-input");
		return { registration: this.registration, config: { ...this.registration.settings, ...this.registration.routing } };
	}

	/** Host identities are normalised the way the tools always did: blank or the literal "undefined" is missing. */
	private agentId(scope: ScopeCtx): string | undefined {
		if (scope.host) return resolveAgentId(scope.host.agentId, parseAgentIdFromSessionKey(scope.host.sessionKey?.trim() ? scope.host.sessionKey : scope.session))
			?? this.configured().registration.skinId;
		return parseAgentIdFromSessionKey(scope.session) ?? this.configured().registration.skinId;
	}

	/** Resolve the requested write project and read projects for this call. */
	private async scopePolicy(scope: ScopeCtx): Promise<CallScopePolicy> {
		const project = await this.project(scope);
		const readable = [project];
		for (const requested of scope.readable ?? []) {
			if (requested === scope.project) continue;
			if (!readable.includes(requested)) readable.push(requested);
		}
		return new CallScopePolicy(project, readable);
	}

	private async project(scope: ScopeCtx): Promise<string> {
		const { config } = this.configured();
		if (!scope.host?.workspace || admittedScope(createScopePolicy(config.scopes), scope.project, this.agentId(scope), scope.host.systemCaller === true)) return scope.project;
		if (resolve(scope.project) !== resolve(scope.host.workspace)) return scope.project;
		const agentId = this.agentId(scope) ?? this.configured().registration.skinId;
		const resolved = await resolveProviderIdentity({
			cfg: { agents: { entries: { [agentId]: { workspace: scope.host.workspace } } } },
			config, store: this.services.store, agentId,
		});
		return resolved.identity.projectId;
	}

	private async provider(scope: ScopeCtx): Promise<SnoStationMemMemorySearchManager> {
		const projectId = await this.project(scope);
		const agentId = this.agentId(scope) ?? this.configured().registration.skinId;
		const key = JSON.stringify([scope.principal, projectId, agentId, scope.host?.workspace]);
		let provider = this.providers.get(key);
		if (!provider) {
			provider = new SnoStationMemProviderSearchManager({ store: this.services.store,
				identity: { userId: scope.principal, projectId, agentId }, workspaceDir: scope.host?.workspace });
			this.providers.set(key, provider);
		}
		return provider;
	}

	private hostContext(scope: ScopeCtx): PluginHookAgentContext {
		return { agentId: this.agentId(scope), sessionKey: scope.host?.sessionKey?.trim() ? scope.host.sessionKey : scope.session,
			sessionId: scope.host?.sessionId, sessionTimezone: scope.host?.sessionTimezone,
			workspaceDir: scope.host?.workspace };
	}

	private async reflection(scope: ScopeCtx): Promise<ReflectionStrategyState> {
		const scopePolicy = await this.scopePolicy(scope);
		// The state carries its policy, so a call with a different readable set never reuses another's.
		const key = JSON.stringify([scopePolicy.getDefaultScope(), [...scopePolicy.getAccessibleScopes()].sort()]);
		const existing = this.reflectionStates.get(key);
		if (existing) return existing;
		const state = createReflectionStrategyState(this.configured().config, {
			store: this.services.store, embedder: this.services.embedder,
			scopePolicy, parseAgentIdFromSessionKey,
			agentPort: this.services.agentPort, telemetryUsage: this.services.telemetryUsage,
		});
		this.reflectionStates.set(key, state);
		return state;
	}

	private async toolContext(scope: ScopeCtx): Promise<ToolContext> {
		const { config, registration } = this.configured();
		return {
			...this.services,
			scopePolicy: await this.scopePolicy(scope),
			agentId: this.agentId(scope), workspaceDir: scope.host?.workspace,
			systemCaller: scope.host?.systemCaller === true,
			sessionTimezone: scope.host?.sessionTimezone, language: config.language,
			selfImprovementEnabled: config.selfImprovement.enabled,
			profileToolLlm: createLlmClient({ ...config.extraction.llm, routing: registration.routing, agentPort: this.services.agentPort }),
			llmRouting: registration.routing,
			clearReflectionSliceCache: () => { for (const state of this.reflectionStates.values()) state.command.clearAllSliceCache(); },
		};
	}

	async capture(turn: Turn, scope: ScopeCtx, signal?: AbortSignal): Promise<ContractOutputs["capture"]> {
		return withMemoryOperation("capture", signal, async () => {
		parseInput("capture", { turn, scope });
		const { config } = this.configured();
		const context = await this.toolContext(scope);
		checkMemoryOperation();
		const runtimeContext = this.services;
		const distiller = buildInsightDistiller(runtimeContext, config, this.services.store, this.services.embedder,
			this.services.observability, () => undefined, this.services.stateDir, this.services.agentPort);
		const outcome = await onAgentEnd(runtimeContext, config, this.services.store, this.services.embedder, context.scopePolicy, distiller,
			{ success: true, messages: turn.messages.map(({ at, ...message }) => ({ ...message, timestamp: at })) },
			this.hostContext(scope),
			this.services.stateDir);
		// committed is legal only after extraction and persistence both completed.
		if (outcome === "failed") throw new ContractError("engine-failed");
		return { degraded: false, turnId: turn.turnId, committed: outcome === "success" };
		});
	}

	async getRecall(query: string, scope: ScopeCtx, options: RecallOptions, signal?: AbortSignal): Promise<ContractOutputs["getRecall"]> {
		const input = parseInput("getRecall", { query, scope, options });
		const context = await this.toolContext(input.scope);
		signal?.throwIfAborted();
		const recallId = randomUUID();
		if (input.options.source === "native") {
			if (input.options.corpus === "wiki" || input.options.corpus === "sessions") {
				return { degraded: false, recallId, contextText: "", unavailable: `${input.options.corpus} corpus not available from this provider` };
			}
			const manager = await this.provider(input.scope);
			const nativeHits = await manager.search(input.query, {
				maxResults: input.options.limit, minScore: input.options.minScore, sources: ["memory"], signal,
			});
			return { degraded: false, recallId, contextText: "", nativeHits };
		}
		if (input.options.source === "manual") {
			const host = this.hostContext(input.scope);
			const state = this.recall;
			const sessionId = resolveRuntimeSessionId(host);
			const turn = state.turns.get(sessionId);
			const result = await executeMemoryRecallTool({ ...context,
				sessionKey: host.sessionKey,
				...(turn !== undefined && { recallSession: { sessionId, turn, history: state.history } }),
			}, resolveAgentAccess(context.agentId, context.agentId), recallId, {
				query: input.query, scope: context.scopePolicy.getAccessibleScopes().length > 1 ? undefined : context.scopePolicy.getDefaultScope(), top_k: input.options.limit,
				min_score: input.options.minScore, category: input.options.category,
				include_metadata: input.options.includeMetadata, include_history: input.options.includeHistory,
				include_refused: input.options.includeRefused, token_budget: input.options.tokenBudget,
				external_reference: input.options.externalReference,
				external_reference_visibility: input.options.externalReferenceVisibility,
				aggregation: input.options.aggregation,
			}, { name: "memory_recall", label: "Memory Recall", description: "", signal });
			signal?.throwIfAborted();
			if (turn !== undefined && Array.isArray(result.details.memories)) {
				const history = state.history.get(sessionId) ?? new Map<string, number>();
				for (const row of result.details.memories) {
					if (typeof row === "object" && row !== null && "id" in row && typeof row.id === "string") {
						history.set(row.id, turn);
					}
				}
				pruneOldestEntries(history, MAX_SESSION_RECALL_ENTRIES);
				setLruEntry(state.history, sessionId, history, MAX_TRACKED_SESSIONS);
			}
			return parseOutput("getRecall", { degraded: false, recallId,
				contextText: result.content.map(part => part.text).join("\n\n"),
				toolResult: JSON.parse(JSON.stringify(result)) });
		}
		const host = this.hostContext(input.scope);
		const state = this.recall;
		const result = await onBeforeAgentStart(this.services, this.configured().config,
			this.services.retriever, this.services.store, context.scopePolicy,
			state.history, state.turns, { prompt: input.query }, host, this.services.stateDir, this.services.telemetryUsage, signal);
		signal?.throwIfAborted();
		const session = resolveRuntimeSessionId(host);
		const turn = state.turns.get(session);
		const memoryIds = result?.prependContext ? [...(state.history.get(session) ?? [])]
			.filter(([, lastTurn]) => lastTurn === turn).map(([id]) => id) : [];
		return { degraded: false, recallId, contextText: result?.prependContext ?? "", memoryIds };
	}

	async mutate(op: Mutation, scope: ScopeCtx, signal?: AbortSignal): Promise<ContractOutputs["mutate"]> {
		return withMemoryOperation("mutate", signal, async () => {
		parseInput("mutate", { op, scope });
		const context = await this.toolContext(scope);
		checkMemoryOperation();
		const access = resolveAgentAccess(context.agentId, context.agentId);
		const project = context.scopePolicy.getDefaultScope();
		let result: ToolResult;
		switch (op.op) {
			case "store": result = await executeMemoryStoreTool(context, access, randomUUID(), { ...op, scope: project }); break;
			case "forget": result = await executeMemoryForgetTool(context, access, randomUUID(), {
				...op, scope: op.suppressKey || op.suppressContent || context.scopePolicy.getAccessibleScopes().length === 1 ? project : undefined,
				suppress_key: op.suppressKey, suppress_content: op.suppressContent,
				min_score: op.minScore, max_delete: op.maxDelete,
			}); break;
			case "update": result = await executeMemoryUpdateTool(context, access, randomUUID(), { ...op, scope: project }); break;
			case "resolveReflection": result = await executeMemoryReflectionResolveTool(context, access, randomUUID(), { ...op, memory_id: op.memoryId, dry_run: op.dryRun, scope: project }); break;
			case "clear": {
				const deleted = await this.services.store.bulkDelete(op.all ? {} : { projectId: project });
				result = { content: [{ type: "text", text: `Deleted ${deleted.deleted} memories.` }], details: { ...deleted } };
				break;
			}
		}
		for (const state of this.reflectionStates.values()) state.command.clearAllSliceCache();
		return parseOutput("mutate", { degraded: false, result: JSON.parse(JSON.stringify(result)) });
		});
	}

	async inspect(op: Inspection, scope: ScopeCtx): Promise<ContractOutputs["inspect"]> {
		parseInput("inspect", { op, scope });
		if (op.op === "stats" && !op.scope) {
			return { degraded: false, result: { op: "stats", ...await this.services.store.stats() } };
		}
		const policy = await this.scopePolicy(scope);
		const project = policy.getDefaultScope();
		const readable = policy.getAccessibleScopes();
		switch (op.op) {
			case "storage": return { degraded: false, result: { op: "storage", dimension: this.services.store.db.vectorDimension, failed: false } };
			case "stats": {
				const counted = await Promise.all(readable.map(scopeId => this.services.store.stats(scopeId)));
				return { degraded: false, result: { op: "stats", ...sumStats(counted) } };
			}
			case "list": return { degraded: false, result: { op: "list", project, entries: await this.services.store.list({ ...op, projectIdFilter: readable, importanceMin: op.importanceMin }) } };
			case "listReflection": return { degraded: false, result: { op: "listReflection", project, entries: await this.services.store.listReflectionItems({ ...op, projectIdFilter: readable }) } };
			case "get": {
				if (op.path) {
					const manager = await this.provider(scope);
					const file = await manager.readFile({ relPath: op.path, from: op.from, lines: op.lines });
					return { degraded: false, result: { op: "get", entry: null, file } };
				}
				const entry = op.id ? this.services.store.getById(op.id) : undefined;
				return { degraded: false, result: { op: "get", entry: entry && readable.includes(entry.projectId) ? entry : null } };
			}
		}
	}

	async recordUsage(recallId: string, signal: UsageSignal, scope: ScopeCtx): Promise<ContractOutputs["recordUsage"]> {
		parseInput("recordUsage", { recallId, signal, scope });
		const project = await this.project(scope);
		const ids = signal.memoryIds.filter(id => this.services.store.getById(id)?.projectId === project);
		if (signal.event === "used") {
			this.services.accessTracker.recordAccess(ids);
			await this.services.accessTracker.flush();
		}
		if (signal.event === "tool-error" && this.configured().config.sessionStrategy === "memoryReflection") {
			const state = await this.reflection(scope);
			createReflectionLifecycleHandler1(state.lifecycle)(
				{ toolName: signal.toolName, error: signal.error ?? signal.text, result: signal.result }, this.hostContext(scope));
		}
		return { degraded: false, accepted: true };
	}

	async onSessionEnd(messages: Message[], scope: ScopeCtx, signal?: AbortSignal): Promise<ContractOutputs["onSessionEnd"]> {
		return withMemoryOperation("onSessionEnd", signal, async () => {
		parseInput("onSessionEnd", { messages, scope });
		checkMemoryOperation();
		const state = this.recall;
		const host = this.hostContext(scope);
		clearSessionState(resolveRuntimeSessionId(host), state.history, state.turns);
		if (host.sessionId !== undefined) clearSessionState(host.sessionId, state.history, state.turns);
		await this.services.accessTracker.flush();
		checkMemoryOperation();
		if (this.configured().config.sessionStrategy === "memoryReflection") {
			const state = await this.reflection(scope);
			if (scope.host?.boundary === "new" || scope.host?.boundary === "reset") {
				await createRunMemoryReflection({ ...state.command, logger: this.services.logger })({
					sessionKey: scope.host.sessionKey ?? scope.session, action: scope.host.boundary, timestamp: scope.host.at,
					context: { workspaceDir: scope.host.workspace, previousSessionEntry: {
						sessionId: scope.host.sessionId, sessionFile: scope.host.sessionFile,
					} },
				});
			} else {
				createReflectionLifecycleHandler2(state.lifecycle)(undefined, host);
			}
		}
		return { degraded: false, completed: true };
		});
	}

	async staticBlock(scope: ScopeCtx): Promise<ContractOutputs["staticBlock"]> {
		parseInput("staticBlock", { scope });
		await this.project(scope);
		if (this.configured().config.sessionStrategy !== "memoryReflection") return { degraded: false, contextText: "" };
		const { injection } = await this.reflection(scope);
		const context = this.hostContext(scope);
		const blocks: string[] = [];
		// Match the host hook priorities: derived (15), slice (14), inherited (12).
		if (injection.reflectionCfg.injectMode === "inheritance+derived") {
			const result = await createReflectionInjectionHandler2(injection)(undefined, context);
			if (result) blocks.push(result.prependContext);
		}
		if (injection.reflectionCfg.injectIntoPrompt) {
			const result = await createReflectionInjectionHandler3(injection)(undefined, context);
			if (result) blocks.push(result.prependContext);
		}
		if (["inheritance-only", "inheritance+derived"].includes(injection.reflectionCfg.injectMode)) {
			const result = await createReflectionInjectionHandler1(injection)(undefined, context);
			if (result) blocks.push(result.prependContext);
		}
		return { degraded: false, contextText: blocks.join("\n\n") };
	}
}
