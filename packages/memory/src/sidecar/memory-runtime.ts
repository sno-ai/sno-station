import { randomUUID } from "node:crypto";
import { readMemorySnapshotPayload, type SnapshotReason } from "../engine/observability/memory-snapshot";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createLogger } from "@snoai/utils/logger";
import { ContractError, parseInput, parseOutput, type ContractMethod, type ContractOutputs, type Registration, type ScopeCtx } from "../contract/index";
import { pluginConfigSchema, type PluginConfig } from "../contract/config/plugin-config-schema";
import { MemoryContractRuntime } from "../engine/contract-runtime";
import { getBindingPath, getInstallationConfigPath, getPrincipal, getSnoStationMemStateDir, readBoundStorePath } from "../engine/shared/paths";
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
import { startMaintenanceTimer, type MaintenanceTimerHandle } from "../store/maintenance";
import { RegisteredAgentPort } from "../model/registered-agent-port";
import { MEMORY_USAGE_FLUSH_INTERVAL_MS } from "./config";

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
		if (existsSync(getBindingPath()) && !existsSync(configPath)) throw new ContractError("storage-unavailable");
		const installed = existsSync(configPath) ? readSnoStationMemConfig(configPath).plugins?.entries?.[PLUGIN_ENTRY_KEY]?.config : undefined;
		const config = pluginConfigSchema.parse({ ...installed, dbPath: storePath });
		await initSqliteRuntime();
		await mkdir(dirname(storePath), { recursive: true, mode: 0o700 });
		const stateDir = getSnoStationMemStateDir();
		const observability = new PluginObservability(config, stateDir, engineLogger);
		const embedder = new ObservableEmbedder(config.embedding, stateDir, observability, () => undefined);
		const store = new ObservableMemoryStore({ dbPath: storePath, vectorDim: embedder.dimensions, embedder, memoryTelemetry: config.memoryTelemetry }, observability, () => undefined, config.embedding);
		const pool = new MemoryRuntimePool(storePath, store, config, observability, embedder);
		pool.maintenance = startMaintenanceTimer({ store, dbPath: storePath, stateDir,
			backupDir: join(stateDir, "backups"), usageOutbox: pool.usageOutbox });
		pool.startUsageTimer();
		return pool;
	}

	private async register(scope: ScopeCtx, registration: Registration): Promise<ContractOutputs["init"]> {
		const config: PluginConfig = { ...registration.settings, ...registration.routing };
		// One principal has one vector space; a second skin cannot silently change its model.
		if (!isDeepStrictEqual(config.embedding, this.config.embedding) || !isDeepStrictEqual(config.memoryTelemetry, this.config.memoryTelemetry)) throw new ContractError("invalid-input");
		if (config.dbPath && config.dbPath !== this.storePath) throw new ContractError("store-mismatch");
		// Without an endpoint, rem-enhanced keeps the existing GPU fallback. Agent-native must expose refusal.
		const agentPort = registration.model || config.mode === "agent-native" ? new RegisteredAgentPort(registration.model) : undefined;
		const observability = new PluginObservability(config, this.stateDir, engineLogger);
		const embedder = new ObservableEmbedder(config.embedding, this.stateDir, observability, () => undefined);
		const retriever = new ObservableMemoryRetriever(this.store, embedder, engineLogger, { ...DEFAULT_RETRIEVAL_CONFIG, ...config.retrieval }, observability, () => undefined, config.embedding);
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
			const previous = this.skins.get(registration.skinId);
			this.skins.set(registration.skinId, entry);
			await this.snapshot(entry, "startup");
			if (previous) { previous.retired = true; if (previous.active === 0) await this.dispose(previous); }
			return result;
		} catch (error) { await this.dispose(entry); throw error; }
	}

	async invoke(method: ContractMethod, raw: unknown, skinId: string): Promise<ContractOutputs[ContractMethod]> {
		const input = parseInput(method, raw);
		if (input.scope.principal !== this.principal) throw new ContractError("principal-mismatch");
		if (method === "inspect" && parseInput("inspect", raw).op.op === "storage") {
			if (!input.scope.host?.systemCaller) throw new ContractError("system-caller-required");
			this.counters.storeAccesses++;
			return { degraded: false, result: { op: "storage", dimension: readChunkVecTableState(this.store.sqlite)?.dimension ?? null, failed: this.store.sqlite.isFailed(), reason: this.store.sqlite.getFailureReason() } };
		}
		if (method === "init") {
			const init = parseInput("init", raw);
			if (init.registration.skinId !== skinId) throw new ContractError("invalid-input");
			this.counters.engineAccesses++;
			this.counters.storeAccesses++;
			return this.register(init.scope, init.registration);
		}
		const entry = this.skins.get(skinId);
		if (!entry) throw new ContractError("invalid-input");
		entry.active++;
		this.counters.engineAccesses++;
		this.counters.storeAccesses++;
		try {
			const call = () => this.call(entry.runtime, method, raw);
			const result = parseOutput(method, await (entry.agentPort ? entry.agentPort.run(call) : call()));
			if (method === "onSessionEnd") await this.snapshot(entry, "session_end");
			return result;
		}
		finally { entry.active--; if (entry.retired && entry.active === 0) await this.dispose(entry); }
	}

	private async call(runtime: MemoryContractRuntime, method: Exclude<ContractMethod, "init">, raw: unknown): Promise<ContractOutputs[ContractMethod]> {
		switch (method) {
			case "capture": { const p = parseInput(method, raw); return runtime.capture(p.turn, p.scope); }
			case "getRecall": { const p = parseInput(method, raw); return runtime.getRecall(p.query, p.scope, p.options); }
			case "mutate": { const p = parseInput(method, raw); return runtime.mutate(p.op, p.scope); }
			case "inspect": { const p = parseInput(method, raw); return runtime.inspect(p.op, p.scope); }
			case "recordUsage": { const p = parseInput(method, raw); return runtime.recordUsage(p.recallId, p.signal, p.scope); }
			case "onSessionEnd": { const p = parseInput(method, raw); return runtime.onSessionEnd(p.messages, p.scope); }
			case "staticBlock": { const p = parseInput(method, raw); return runtime.staticBlock(p.scope); }
		}
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
		for (const entry of this.owned) await this.dispose(entry);
		this.skins.clear();
		await this.usageFlush;
		await this.store.close();
		await this.embedder.dispose();
		await this.observability.shutdown();
	}
}
