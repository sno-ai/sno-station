import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
	ContractError, parseInput, parseOutput, type ContractOutputs, type MemoryContract,
	type ScopeCtx, type Registration, type RecallOptions, type Turn, type Mutation,
	type Inspection, type UsageSignal, type Message,
} from "../contract/index";
import type { MemoryStore } from "../store/store";
import type { Embedder } from "./extraction/embedding-provider-client";
import type { MemoryRetriever } from "./retrieval/retriever";
import type { AccessTracker } from "./retrieval/access-tracker";
import type { PluginObservability } from "./observability/adapter";
import type { MemoryTelemetryUsageOutbox } from "./telemetry/memory-telemetry-outbox";
import type { AgentLlmPort } from "../model/agent-llm-port";
import { createLlmClient } from "../model/llm-client";
import type { PluginConfig } from "./shared/types";
import { MemoryScopePolicy } from "./security/memory-scope-policy";
import { parseAgentIdFromSessionKey } from "./security/scope-identity";
import { resolveProviderIdentity, createMemoryRuntime } from "./provider/provider-registration";
import { onBeforeAgentStart } from "./bindings/sno-station-mem-auto-recall-hook";
import { resolveRuntimeSessionId, clearSessionState } from "./bindings/sno-station-mem-session-state";
import { executeMemoryRecallTool } from "./bindings/memory-recall-tool";
import { buildInsightDistiller } from "./bindings/sno-station-mem-insight-distill-factory";
import { onAgentEnd } from "./bindings/sno-station-mem-ambient-learning-hook";
import { resolveAgentAccess } from "./bindings/memory-tool-access";
import type { ToolContext, ToolResult } from "./bindings/memory-tool-schemas";
import { executeMemoryStoreTool } from "./bindings/memory-store-tool";
import { executeMemoryForgetTool } from "./bindings/memory-forget-tool";
import { executeMemoryUpdateTool } from "./bindings/memory-update-tool";
import { executeMemoryReflectionResolveTool } from "./bindings/memory-reflection-resolve-tool";
import { createReflectionStrategyState, type ReflectionStrategyState } from "./reflection/strategy-hook-runner";
import { createRunMemoryReflection, type ReflectionCommandParams } from "./reflection/reflection-command-hooks";
import type { OpenClawMemoryRuntime, OpenClawMemorySearchManager } from "../contract/provider-runtime-types";
import { createReflectionLifecycleHandler1, createReflectionLifecycleHandler2 } from "./reflection/reflection-lifecycle-hooks";
import { createReflectionInjectionHandler1, createReflectionInjectionHandler2, createReflectionInjectionHandler3 } from "./reflection/reflection-injection-hooks";
import type { PluginHookAgentContext } from "./bindings/sno-station-mem-hook-types";
import { isKillSwitchActive } from "./operations/runtime-audit-log";

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

/** The contract supplies one already resolved project, without ambient scope expansion. */
class BoundProjectPolicy extends MemoryScopePolicy {
	constructor(private readonly project: string) {
		super({ default: project, definitions: { [project]: {} } });
	}
	override getAccessibleScopes(): string[] { return [this.project]; }
	override getScopeFilter(): string[] { return [this.project]; }
	override getDefaultScope(): string { return this.project; }
	override getAllScopes(): string[] { return [this.project]; }
	override isAccessible(scope: string): boolean { return scope === this.project; }
	override validateScope(scope: string): boolean { return scope === this.project; }
}

export class MemoryContractRuntime implements MemoryContract {
	private registration: Registration | undefined;
	private providerRuntime: OpenClawMemoryRuntime | undefined;
	private readonly reflectionStates = new Map<string, ReflectionStrategyState>();
	private readonly recallStates = new Map<string, { history: Map<string, Map<string, number>>; turns: Map<string, number> }>();
	constructor(private readonly services: MemoryRuntimeServices) {}

	async init(scope: ScopeCtx, registration: Registration): Promise<ContractOutputs["init"]> {
		const input = parseInput("init", { scope, registration });
		await this.providerRuntime?.closeAllMemorySearchManagers?.();
		this.registration = input.registration;
		this.providerRuntime = createMemoryRuntime({ config: this.configured().config, store: this.services.store, stateDir: this.services.stateDir });
		this.reflectionStates.clear();
		this.recallStates.clear();
		await this.project(input.scope);
		return { degraded: false, principal: scope.principal, skinId: registration.skinId };
	}

	private configured(): { registration: Registration; config: PluginConfig } {
		if (!this.registration) throw new ContractError("invalid-input");
		return { registration: this.registration, config: { ...this.registration.settings, ...this.registration.routing } };
	}

	private agentId(scope: ScopeCtx): string | undefined {
		if (scope.host) return scope.host.agentId ?? parseAgentIdFromSessionKey(scope.host.sessionKey ?? scope.session);
		return parseAgentIdFromSessionKey(scope.session) ?? this.configured().registration.skinId;
	}

	private async project(scope: ScopeCtx): Promise<string> {
		const { config } = this.configured();
		if (!scope.host?.workspace || /^(?:agent|reflection|custom|project|user):/.test(scope.project) || scope.project === "global") return scope.project;
		if (resolve(scope.project) !== resolve(scope.host.workspace)) throw new ContractError("invalid-input");
		const agentId = this.agentId(scope);
		if (!agentId) throw new ContractError("invalid-input");
		const resolved = await resolveProviderIdentity({
			cfg: { agents: { entries: { [agentId]: { workspace: scope.host.workspace } } } },
			config, store: this.services.store, agentId,
		});
		return resolved.identity.projectId;
	}

	private async provider(scope: ScopeCtx): Promise<OpenClawMemorySearchManager> {
		const agentId = this.agentId(scope);
		if (!agentId || !scope.host?.workspace || !this.providerRuntime) throw new ContractError("invalid-input");
		const cfg = { agents: { entries: { [agentId]: { workspace: scope.host.workspace } } } };
		const resolved = await resolveProviderIdentity({ cfg, agentId, config: this.configured().config, store: this.services.store });
		if (resolved.identity.projectId !== await this.project(scope)) throw new ContractError("invalid-input");
		const result = await this.providerRuntime.getMemorySearchManager({ cfg, agentId });
		if (!result.manager) throw new ContractError("storage-unavailable");
		return result.manager;
	}

	private hostContext(scope: ScopeCtx): PluginHookAgentContext {
		return { agentId: this.agentId(scope), sessionKey: scope.host?.sessionKey ?? scope.session,
			sessionId: scope.host?.sessionId, sessionTimezone: scope.host?.sessionTimezone,
			workspaceDir: scope.host?.workspace };
	}

	private recallState(project: string): { history: Map<string, Map<string, number>>; turns: Map<string, number> } {
		let state = this.recallStates.get(project);
		if (!state) {
			state = { history: new Map(), turns: new Map() };
			this.recallStates.set(project, state);
		}
		return state;
	}

	private async reflection(scope: ScopeCtx): Promise<ReflectionStrategyState> {
		const project = await this.project(scope);
		const existing = this.reflectionStates.get(project);
		if (existing) return existing;
		const state = createReflectionStrategyState(this.configured().config, {
			store: this.services.store, embedder: this.services.embedder,
			scopePolicy: new BoundProjectPolicy(project), parseAgentIdFromSessionKey,
			agentPort: this.services.agentPort, telemetryUsage: this.services.telemetryUsage,
		});
		this.reflectionStates.set(project, state);
		return state;
	}

	private async toolContext(scope: ScopeCtx): Promise<ToolContext> {
		const { config, registration } = this.configured();
		return {
			...this.services,
			scopePolicy: new BoundProjectPolicy(await this.project(scope)),
			agentId: this.agentId(scope), workspaceDir: scope.host?.workspace,
			sessionTimezone: scope.host?.sessionTimezone, language: config.language,
			selfImprovementEnabled: config.selfImprovement.enabled,
			profileToolLlm: createLlmClient({ ...config.extraction.llm, routing: registration.routing, agentPort: this.services.agentPort }),
			llmRouting: registration.routing,
			clearReflectionSliceCache: () => { for (const state of this.reflectionStates.values()) state.command.clearAllSliceCache(); },
		};
	}

	async capture(turn: Turn, scope: ScopeCtx): Promise<ContractOutputs["capture"]> {
		parseInput("capture", { turn, scope });
		const { config } = this.configured();
		const context = await this.toolContext(scope);
		if (isKillSwitchActive(this.services.stateDir)) throw new ContractError("paused");
		const runtimeContext = this.services;
		const distiller = buildInsightDistiller(runtimeContext, config, this.services.store, this.services.embedder,
			this.services.observability, () => undefined, this.services.stateDir, this.services.agentPort);
		await onAgentEnd(runtimeContext, config, this.services.store, this.services.embedder, context.scopePolicy, distiller,
			{ success: true, messages: turn.messages.map(({ at, ...message }) => ({ ...message, timestamp: at })) },
			this.hostContext(scope),
			this.services.stateDir);
		return { degraded: false, turnId: turn.turnId, committed: true };
	}

	async getRecall(query: string, scope: ScopeCtx, options: RecallOptions): Promise<ContractOutputs["getRecall"]> {
		const input = parseInput("getRecall", { query, scope, options });
		const context = await this.toolContext(input.scope);
		const recallId = randomUUID();
		if (input.options.source === "native") {
			if (input.options.corpus === "wiki" || input.options.corpus === "sessions") {
				return { degraded: false, recallId, contextText: "", unavailable: `${input.options.corpus} corpus not available from this provider` };
			}
			const manager = await this.provider(input.scope);
			const nativeHits = await manager.search(input.query, {
				maxResults: input.options.limit, minScore: input.options.minScore, sources: ["memory"],
			});
			return { degraded: false, recallId, contextText: "", nativeHits };
		}
		if (input.options.source === "manual") {
			const result = await executeMemoryRecallTool(context, resolveAgentAccess(context.agentId, context.agentId), recallId, {
				query: input.query, scope: context.scopePolicy.getDefaultScope(), limit: input.options.limit,
				min_score: input.options.minScore, category: input.options.category,
				include_metadata: input.options.includeMetadata, include_history: input.options.includeHistory,
				include_refused: input.options.includeRefused, token_budget: input.options.tokenBudget,
				external_reference: input.options.externalReference,
				external_reference_visibility: input.options.externalReferenceVisibility,
				aggregation: input.options.aggregation,
			}, { name: "memory_recall", label: "Memory Recall", description: "" });
			return parseOutput("getRecall", { degraded: false, recallId,
				contextText: result.content.map(part => part.text).join("\n\n"),
				toolResult: JSON.parse(JSON.stringify(result)) });
		}
		const host = this.hostContext(input.scope);
		const state = this.recallState(context.scopePolicy.getDefaultScope());
		const result = await onBeforeAgentStart(this.services, this.configured().config,
			this.services.retriever, this.services.store, context.scopePolicy,
			state.history, state.turns, { prompt: input.query }, host, this.services.stateDir, this.services.telemetryUsage);
		const session = resolveRuntimeSessionId(host);
		const turn = state.turns.get(session);
		const memoryIds = result?.prependContext ? [...(state.history.get(session) ?? [])]
			.filter(([, lastTurn]) => lastTurn === turn).map(([id]) => id) : [];
		return { degraded: false, recallId, contextText: result?.prependContext ?? "", memoryIds };
	}

	async mutate(op: Mutation, scope: ScopeCtx): Promise<ContractOutputs["mutate"]> {
		parseInput("mutate", { op, scope });
		if (op.op === "clear" && op.all && !scope.host?.systemCaller) throw new ContractError("system-caller-required");
		const context = await this.toolContext(scope);
		const access = resolveAgentAccess(context.agentId, context.agentId);
		const project = context.scopePolicy.getDefaultScope();
		let result: ToolResult;
		switch (op.op) {
			case "store": result = await executeMemoryStoreTool(context, access, randomUUID(), { ...op, scope: project }); break;
			case "forget": result = await executeMemoryForgetTool(context, access, randomUUID(), {
				...op, scope: project, suppress_key: op.suppressKey, suppress_content: op.suppressContent,
				min_score: op.minScore, max_delete: op.maxDelete,
			}); break;
			case "update": result = await executeMemoryUpdateTool(context, access, randomUUID(), { ...op, scope: project }); break;
			case "resolveReflection": result = await executeMemoryReflectionResolveTool(context, access, randomUUID(), { ...op, memory_id: op.memoryId, dry_run: op.dryRun, scope: project }); break;
			case "clear": {
				if (!op.confirm) throw new ContractError("invalid-input");
				const deleted = await this.services.store.bulkDelete(op.all ? {} : { projectId: project });
				result = { content: [{ type: "text", text: `Deleted ${deleted.deleted} memories.` }], details: { ...deleted } };
				break;
			}
		}
		for (const state of this.reflectionStates.values()) state.command.clearAllSliceCache();
		return parseOutput("mutate", { degraded: false, result: JSON.parse(JSON.stringify(result)) });
	}

	async inspect(op: Inspection, scope: ScopeCtx): Promise<ContractOutputs["inspect"]> {
		parseInput("inspect", { op, scope });
		if (op.op === "stats" && !op.scope) {
			if (!scope.host?.systemCaller) throw new ContractError("system-caller-required");
			return { degraded: false, result: { op: "stats", ...await this.services.store.stats() } };
		}
		const project = await this.project(scope);
		switch (op.op) {
			case "stats": {
				if (op.scope !== scope.project && op.scope !== project) throw new ContractError("invalid-input");
				return { degraded: false, result: { op: "stats", ...await this.services.store.stats(project) } };
			}
			case "list": return { degraded: false, result: { op: "list", entries: await this.services.store.list({ ...op, projectId: project, importanceMin: op.importanceMin }) } };
			case "listReflection": return { degraded: false, result: { op: "listReflection", entries: await this.services.store.listReflectionItems({ ...op, projectIdFilter: [project] }) } };
			case "get": {
				if (op.path) {
					const manager = await this.provider(scope);
					const file = await manager.readFile({ relPath: op.path, from: op.from, lines: op.lines });
					return { degraded: false, result: { op: "get", entry: null, file } };
				}
				const entry = op.id ? this.services.store.getById(op.id) : undefined;
				return { degraded: false, result: { op: "get", entry: entry?.projectId === project ? entry : null } };
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
				{ toolName: signal.toolName, error: signal.text }, this.hostContext(scope));
		}
		return { degraded: false, accepted: true };
	}

	async onSessionEnd(messages: Message[], scope: ScopeCtx): Promise<ContractOutputs["onSessionEnd"]> {
		parseInput("onSessionEnd", { messages, scope });
		const project = await this.project(scope);
		const state = this.recallStates.get(project);
		if (state) clearSessionState(resolveRuntimeSessionId(this.hostContext(scope)), state.history, state.turns);
		await this.services.accessTracker.flush();
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
				createReflectionLifecycleHandler2(state.lifecycle)(undefined, this.hostContext(scope));
			}
		}
		return { degraded: false, completed: true };
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
