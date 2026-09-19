import { isDeepStrictEqual } from "node:util";
import { DEFAULT_LOCALE } from "../engine/i18n/locales";
import { readMaintenanceOverrides } from "./config";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readMemorySnapshotPayload, type SnapshotReason } from "../engine/observability/memory-snapshot";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "@snoai/utils/logger";
import { parseInput, parseOutput, type ContractMethod, type ContractOutputs, type Registration, type ScopeCtx } from "../contract/index";
import { pluginConfigSchema, type PluginConfig } from "../../config/plugin-config-schema";
import { MemoryContractRuntime } from "../engine/contract-runtime";
import { getInstallationConfigPath, getPrincipal, getSnoStationMemStateDir, readBoundStorePath } from "../engine/shared/paths";
import { readSnoStationMemConfig, PLUGIN_ENTRY_KEY } from "../engine/bindings/embedder-config-files";
import { ObservableEmbedder } from "../engine/observability/observable-embedder";
import { ObservableMemoryStore } from "../engine/observability/observable-memory-store";
import { ObservableMemoryRetriever } from "../engine/observability/observable-retriever";
import { PluginObservability } from "../engine/observability/adapter";
import { AccessTracker } from "../engine/retrieval/access-tracker";
import { DEFAULT_RETRIEVAL_CONFIG } from "../engine/retrieval/retriever";
import { createTierPromoter } from "../engine/operations/memory-tier-promoter";
import { MemoryTelemetryUsageOutbox } from "../engine/telemetry/memory-telemetry-outbox";
import { readChunkVecTableState } from "../store/connection";
import { initSqliteRuntime } from "../store/sqlite-runtime";
import { startMaintenanceTimer, uniformMaintenanceIntervals, type MaintenanceTimerHandle } from "../store/maintenance";
import { RegisteredAgentPort } from "../model/registered-agent-port";
import { withProviderResponses } from "../model/llm-provider-transport";
import type { ProviderResponseTrace } from "../model/llm-client-types";
import { MEMORY_USAGE_FLUSH_INTERVAL_MS } from "./config";
import { clearRegisteredRemTicks, setRegisteredRemTick } from "./rem-trigger";

/** The skin's observe session for the request in flight; store, embedder and retriever events carry it. */
const observeSession = new AsyncLocalStorage<string | undefined>();
const observeSessionUuid = (): string | undefined => observeSession.getStore();

const log = createLogger("sno-station-mem:runtime");
function engineLog(level: "info" | "warn" | "error" | "debug", message: string): void {
	log[level]("Memory engine message", { message }, {
		event_name: "memory.sidecar.engine.message", file: "packages/sno-station-mem/src/sidecar/memory-runtime.ts",
		function: "engineLog", site_id: "memory.sidecar.engine.message",
	});
}
const engineLogger = {
	info: (message: string): void => engineLog("info", message),
	warn: (message: string): void => engineLog("warn", message),
	error: (message: string): void => engineLog("error", message),
	debug: (message: string): void => engineLog("debug", message),
};
interface SkinRuntime {
	runtime: MemoryContractRuntime;
	tracker: AccessTracker;
	observability: PluginObservability;
	active: number;
	retired: boolean;
	embedder: ObservableEmbedder;
	agentPort?: RegisteredAgentPort;
}

export class MemoryRuntimePool {
	readonly principal: string = getPrincipal();
	readonly stateDir: string = getSnoStationMemStateDir();
	readonly counters: { engineAccesses: number; storeAccesses: number } = { engineAccesses: 0, storeAccesses: 0 };
	private readonly skins = new Map<string, SkinRuntime>();
	private readonly owned = new Set<SkinRuntime>();
	private maintenance: MaintenanceTimerHandle | undefined;
	private usageTimer: NodeJS.Timeout | undefined;
	private usageFlush: Promise<unknown> | undefined;
	private readonly usageOutbox: MemoryTelemetryUsageOutbox;
	private constructor(
		readonly storePath: string,
		readonly store: ObservableMemoryStore,
		readonly config: PluginConfig,
		private readonly observability: PluginObservability,
		private readonly embedder: ObservableEmbedder,
	) { this.usageOutbox = new MemoryTelemetryUsageOutbox({ sqlite: store.sqlite, dbPath: storePath }); }

	static async open(): Promise<MemoryRuntimePool> {
		const storePath = await readBoundStorePath();
		const configPath = getInstallationConfigPath();
		let config = pluginConfigSchema.parse({ dbPath: storePath });
		try {
			if (!existsSync(configPath)) engineLogger.error("memory.installation.config.missing");
			if (existsSync(configPath)) {
				const installed = readSnoStationMemConfig(configPath).plugins?.entries?.[PLUGIN_ENTRY_KEY]?.config;
				config = pluginConfigSchema.parse({ ...installed, dbPath: storePath });
			}
		} catch (error) { engineLogger.error(String(error)); }
		await initSqliteRuntime();
		await mkdir(dirname(storePath), { recursive: true, mode: 0o700 });
		const stateDir = getSnoStationMemStateDir();
		const observability = new PluginObservability(config, stateDir, engineLogger);
		const embedder = new ObservableEmbedder(config.embedding, stateDir, observability, observeSessionUuid);
		const store = new ObservableMemoryStore({ dbPath: storePath, vectorDim: embedder.dimensions, embedder, memoryTelemetry: config.memoryTelemetry }, observability, observeSessionUuid, config.embedding);
		const pool = new MemoryRuntimePool(storePath, store, config, observability, embedder);
		const maintenance = readMaintenanceOverrides();
		pool.maintenance = startMaintenanceTimer({ store, dbPath: storePath, stateDir, remClock: maintenance.now, remVolumeThreshold: maintenance.volumeThreshold,
			backupDir: join(stateDir, "backups"), usageOutbox: pool.usageOutbox }, maintenance.intervalMs, maintenance.intervalMs,
			maintenance.intervalMs === undefined ? undefined : uniformMaintenanceIntervals(maintenance.intervalMs));
		pool.startUsageTimer();
		return pool;
	}

	private async register(scope: ScopeCtx, registration: Registration): Promise<ContractOutputs["init"]> {
		if (!isDeepStrictEqual(registration.settings.embedding, this.config.embedding) ||
			!isDeepStrictEqual(registration.settings.memoryTelemetry, this.config.memoryTelemetry) ||
			(registration.settings.dbPath && registration.settings.dbPath !== this.storePath)) {
			engineLogger.error("memory.registration.configuration.mismatch");
		}
		const config: PluginConfig = { ...registration.settings, ...registration.routing,
			embedding: this.config.embedding, memoryTelemetry: this.config.memoryTelemetry, dbPath: this.storePath };
		registration = { ...registration, settings: { ...registration.settings,
			embedding: config.embedding, memoryTelemetry: config.memoryTelemetry, dbPath: this.storePath } };
		// Without an endpoint, rem-enhanced keeps the existing GPU fallback. Agent-native must expose refusal.
		const agentPort = registration.model || config.mode === "agent-native" ? new RegisteredAgentPort(registration.model) : undefined;
		const observability = new PluginObservability(config, this.stateDir, engineLogger);
		const embedder = new ObservableEmbedder(config.embedding, this.stateDir, observability, observeSessionUuid);
		const retriever = new ObservableMemoryRetriever(this.store, embedder, engineLogger, { ...DEFAULT_RETRIEVAL_CONFIG, ...config.retrieval }, observability, observeSessionUuid, config.embedding);
		const tracker = new AccessTracker({ store: this.store, recallLifecycle: config.recallLifecycle });
		retriever.setAccessTracker(tracker);
		retriever.setRecallLifecycle(config.recallLifecycle);
		retriever.setTierPromoter(createTierPromoter());
		const runtime = new MemoryContractRuntime({ store: this.store, embedder, retriever, accessTracker: tracker, observability,
			stateDir: this.stateDir, agentPort, logger: engineLogger, telemetryUsage: this.usageOutbox });
		const entry: SkinRuntime = { runtime, tracker, observability, embedder, agentPort, active: 0, retired: false };
		this.owned.add(entry);
		try {
			const result = await runtime.init(scope, registration);
			// Keep the serving entry until the successor can use the shared model.
			const previous = this.skins.get(registration.skinId);
			this.skins.set(registration.skinId, entry);
			await this.snapshot(entry, "startup");
			if (previous) { previous.retired = true; if (previous.active === 0) await this.dispose(previous); }
			setRegisteredRemTick(registration.skinId, config.remEnhanced.trigger?.tick);
			return result;
		} catch (error) { await this.dispose(entry); throw error; }
	}

	async invoke(method: ContractMethod, raw: unknown, skinId: string, signal?: AbortSignal): Promise<ContractOutputs[ContractMethod]> {
		signal?.throwIfAborted();
		const input = parseInput(method, raw);
		if (method === "inspect" && parseInput("inspect", raw).op.op === "storage") {
			this.counters.storeAccesses++;
			return { degraded: false, result: { op: "storage", dimension: readChunkVecTableState(this.store.sqlite)?.dimension ?? null, failed: false } };
		}
		if (method === "init") {
			const init = parseInput("init", raw);
			this.counters.engineAccesses++;
			this.counters.storeAccesses++;
			return this.register(init.scope, { ...init.registration, skinId });
		}
		let entry = this.skins.get(skinId);
		if (!entry) {
			const { mode, remEnhanced, agentNative, language, ...settings } = this.config;
			await this.register(input.scope, { skinId, settings, routing: { mode, remEnhanced, agentNative, language: language ?? DEFAULT_LOCALE } });
			entry = this.skins.get(skinId);
		}
		if (!entry) throw new Error("memory.skin.registration.failed");
		signal?.throwIfAborted();
		entry.active++;
		this.counters.engineAccesses++;
		this.counters.storeAccesses++;
		const responses: ProviderResponseTrace[] = [];
		try {
			const call = () => observeSession.run(input.scope.host?.observeSessionUuid, () => withProviderResponses(responses, () => this.call(entry.runtime, method, raw, signal)));
			const result = parseOutput(method, await (entry.agentPort ? entry.agentPort.run(call) : call()));
			if (method === "onSessionEnd") await this.snapshot(entry, "session_end");
			return result;
		}
		finally {
			await this.emitProviderUsage(entry, input.scope, responses);
			// The skin owns cost.summary; the sidecar's tallies are never read, so drop them per call.
			const session = input.scope.host?.observeSessionUuid;
			if (session) { this.observability.aggregator.delete(session); entry.observability.aggregator.delete(session); }
			entry.active--; if (entry.retired && entry.active === 0) await this.dispose(entry);
		}
	}

	private async call(runtime: MemoryContractRuntime, method: Exclude<ContractMethod, "init">, raw: unknown, signal?: AbortSignal): Promise<ContractOutputs[ContractMethod]> {
		signal?.throwIfAborted();
		switch (method) {
			case "capture": { const p = parseInput(method, raw); return runtime.capture(p.turn, p.scope, signal); }
			case "getRecall": { const p = parseInput(method, raw); return runtime.getRecall(p.query, p.scope, p.options, signal); }
			case "mutate": { const p = parseInput(method, raw); return runtime.mutate(p.op, p.scope, signal); }
			case "inspect": { const p = parseInput(method, raw); return runtime.inspect(p.op, p.scope); }
			case "recordUsage": { const p = parseInput(method, raw); return runtime.recordUsage(p.recallId, p.signal, p.scope); }
			case "onSessionEnd": { const p = parseInput(method, raw); return runtime.onSessionEnd(p.messages, p.scope, signal); }
			case "staticBlock": { const p = parseInput(method, raw); return runtime.staticBlock(p.scope); }
		}
	}

	private async emitProviderUsage(entry: SkinRuntime, scope: ScopeCtx, responses: ProviderResponseTrace[]): Promise<void> {
		if (!scope.host?.observeSessionUuid) return;
		await entry.observability.trackBestEffort("provider usage", async () => {
			for (const response of responses) {
				if (!response.usage || !response.model || response.durationMs === undefined) continue;
				await entry.observability.emit({ eventType: "llm.call", sessionUuid: scope.host?.observeSessionUuid,
					payload: { model: `${response.provider}:${response.model}`, prompt_tokens: response.usage.inputTokens,
						completion_tokens: response.usage.outputTokens, token_source: "plugin_internal_paid",
						latency_ms: Math.round(response.durationMs), cache_read_tokens: 0, cache_write_tokens: 0 } });
			}
			if (responses.length) await entry.observability.flush({ force: true, timeoutMs: 5_000 });
		});
	}

	private async snapshot(entry: SkinRuntime, reason: SnapshotReason): Promise<void> {
		await entry.observability.trackBestEffort("memory snapshot", async () => {
			const payload = await readMemorySnapshotPayload(this.storePath, this.config, randomUUID(), reason, this.store.sqlite);
			await entry.observability.emit({ eventType: "memory.snapshot", payload });
		});
	}

	private async dispose(entry: SkinRuntime): Promise<void> {
		if (!this.owned.delete(entry)) return;
		await entry.runtime.close();
		await entry.tracker.destroy();
		await entry.embedder.dispose();
		await entry.observability.shutdown();
	}

	private startUsageTimer(): void {
		this.usageTimer = setInterval(() => {
			if (this.usageFlush) return;
			this.usageFlush = this.usageOutbox.flushPendingAsync().catch((error: unknown) => {
				log.warn("Memory usage delivery failed", { error }, {
					event_name: "memory.sidecar.usage.failed", file: "packages/sno-station-mem/src/sidecar/memory-runtime.ts",
					function: "<anonymous callback>", site_id: "memory.sidecar.usage.failed",
				});
			}).finally(() => { this.usageFlush = undefined; });
		}, MEMORY_USAGE_FLUSH_INTERVAL_MS);
		this.usageTimer.unref();
	}

	stopTimers(): void {
		this.maintenance?.stop();
		if (this.usageTimer) clearInterval(this.usageTimer);
	}

	async close(): Promise<void> {
		this.stopTimers();
		clearRegisteredRemTicks();
		for (const entry of this.owned) await this.dispose(entry);
		this.skins.clear();
		await this.usageFlush;
		await this.store.close();
		await this.embedder.dispose();
		await this.observability.shutdown();
	}
}
